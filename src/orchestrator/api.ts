/**
 * Orchestrator API (M1) — loopback HTTP handlers for contract v0.3
 * (docs/orchestrator-api.md). Runs IN-PROCESS inside the `opencomms gui`
 * server (ADR-0005 leaning; Tauri sidecar argv unchanged).
 *
 * M1 scope (Lead tasking): local node only; agents create/status/stop/
 * restart-stub; designated:"lead" one-per-project enforcement; runtimes
 * listing; trust store + confirm-token gate; additive SSE topic wiring is
 * provided by the feed (events.ts) and the server broadcast.
 *
 * Security invariants (Reviewer checklist, binding):
 *  - approve/revoke REQUIRE the owner confirm token (wrong/absent => 403 +
 *    audit event). Never readable via GET. Agent-facing tools have no path
 *    to these routes.
 *  - REDACTION BY VALUE: the serve password (and any token-bearing string)
 *    is replaced with "[REDACTED]" in every persisted record — matched
 *    literally, never by flag name. A unit test asserts the password value
 *    appears in NO persisted field.
 *  - Spawn commands are argv-only (no shell); secrets travel in env only.
 *  - The serve password never enters role prompts, logs, or the API surface.
 */

import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { randomBytes, createHash } from "node:crypto"
import {
  localNodeIdFor,
  newAgentId,
  newConfirmToken,
  newNodeId,
  newPairingCode,
  PAIRING_CODE_TTL_MS,
  pushEvent,
  validateOrchestratorState,
  type AgentRecord,
  type NodeRecord,
  type OrchestratorState,
  type OrchestrationEvent,
} from "./state.js"
import { listEvents, type OrchestratorFeed } from "./events.js"
import type { AgentRuntime, SpawnRequest } from "./runtime.js"
import { registeredRuntimes } from "./runtime.js"
import { createOpencodeRuntime, parseModel, resolveOpencodeBinary } from "./runtimes/opencode.js"
import { createAcpRuntime } from "./runtimes/acp.js"
import { createManagedWorktree } from "./worktrees.js"
import { managedCapabilities, requiredCapabilityIssue } from "./managed-capabilities.js"
import { NodeCertificateAuthority, fingerprintForPublicKeyPem } from "./node-ca.js"
import {
  taskViews,
  transitionTaskRecord,
  dependencyBlockers,
  ownershipConflicts,
  stringList,
  validContext,
  newContextId,
  MAX_TASKS,
  MAX_CONTEXT_RECORDS,
  MAX_TASK_REASSIGNMENTS,
  type TaskRecord,
  type TaskReassignment,
  type ProjectContextRecord,
} from "./tasks.js"
import { MAX_TEAM_TEMPLATES, newTeamTemplateId, validTeamTemplate, type TeamTemplate } from "./team-templates.js"

/** Envelope contract v0.0: { ok: true, data } / { ok: false, message }. */
export interface ApiResult {
  ok: boolean
  message: string
  code?: string
  data?: unknown
}

/** Default per-agent worktree root (Decision Log 2026-09-11, Option A). */
export function agentWorktreeDir(projectDir: string, agentId: string): string {
  return join(projectDir, ".opencomms", "agents", agentId, "worktree")
}

export interface OrchestratorApiDeps {
  projectDir: string
  /** In-memory ONLY: never persisted, never returned, never logged. */
  servePassword: () => string
  serveModel: () => string | undefined
  withLock: <T>(fn: () => T) => Promise<T>
  loadOrchestrator: () => OrchestratorState
  saveOrchestrator: (state: OrchestratorState) => void
  /** Additive SSE broadcast hook (events feed + server). */
  feed: OrchestratorFeed
  /** The chosen shared-serve port (recorded on the node record). */
  servePort: () => number
  /** Real project id when the host provides one; null = degraded sentinel mode. */
  projectId: () => string | null
  runtimes?: Record<string, () => { runtime: string; host: string }>
  turnTimeoutMs?: number
  pollMs?: number
  /**
   * Injected runtime factory (tests pass a fake; production defaults to the
   * real opencode runtime). Keeps the create/stop paths testable without a
   * live serve while the production behavior stays unchanged.
   */
  createRuntime?: () => AgentRuntime
  /**
   * Channel-engine surface for task assignment (M2 §9b-3): the orchestrator
   * sends AS the operator session via the SAME engine mutation path as any
   * other send. The GUI wiring supplies the real engine fns; tests inject.
   */
  loadChannelEngineState: () => {
    queues?: Record<string, string[]>
    messages: Record<
      string,
      {
        message_id: string
        channel_id: string
        sender_session_id: string
        recipient_session_id: string
        timestamp: number
        message_type: string
        content: string
        hop_count: number
        correlation_id: string
        delivery_status: string
      }
    >
  }
  engineSend: (
    state: unknown,
    input: { channel: string; content: string; message_type: "review_request"; to?: string },
    senderSessionId: string,
  ) => { ok: boolean; message: string }
  saveChannelEngineState: (state: unknown) => void
  /** M3 CA factory (tests inject; production derives from projectDir). */
  ca?: () => NodeCertificateAuthority
}

/** Validation failure shape (contract §6: 400/403/404/409/500). */
const fail = (message: string): ApiResult => ({ ok: false, message })
const pass = <T>(message: string, data?: T): ApiResult => ({ ok: true, message, data })

export function permissionCapability(
  agent: AgentRecord,
  localNodeId: string,
): { state: "supported" | "unsupported" | "temporarily_unavailable"; reason?: string } {
  if (agent.node_id !== localNodeId)
    return {
      state: "unsupported",
      reason:
        "Remote permission control is unsupported: this coordinator has no authenticated remote runtime dispatch. Review the request on its actual host.",
    }
  if (!["opencode", "acp"].includes(agent.runtime))
    return {
      state: "unsupported",
      reason: `Runtime "${agent.runtime}" exposes no supported managed permission transport.`,
    }
  if (!["running", "idle"].includes(agent.status) || !agent.host_session_id)
    return {
      state: "temporarily_unavailable",
      reason: `Agent ${agent.name} is ${agent.status} or has no live session; reconnect or explicitly resume it before reviewing permissions.`,
    }
  return { state: "supported" }
}

/** Check values, never field names, before task/context data can be persisted. */
function containsCredential(value: unknown, secret: string): boolean {
  if (!secret) return false
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === "string" && item.includes(secret)) return true
    if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item)
      pending.push(...Object.values(item))
    }
  }
  return false
}

/**
 * M4 §9c-6 / condition C — the ONE server-side enforcement point for
 * remote actions (M1 pattern: server-side, never GUI-side).
 *
 * Ordered checks, each failure naming WHICH check failed (audit evidence):
 *   1. node-approved  — remote, approval set, not revoked, in approved list
 *   2. credential-valid — expiry stamped AND in the future (composed with
 *      the CA isRevoked gate, which the transport also enforces)
 *   3. grant-present — node.grants contains the action's grant label
 *
 * Design: docs/orchestrator-design.md §9c-6; Reviewer's four deny cases
 * (unapproved / expired / revoked / ungranted) + pass case are test-
 * asserted. The channel engine stays node-blind — this gate lives only in
 * the orchestrator layer.
 */
export type RemoteAction = "spawn" | "tasks"

export function assertRemoteActionAllowed(
  state: OrchestratorState,
  input: { node_id: string; action: RemoteAction },
  deps: { ca?: NodeCertificateAuthority; projectDir?: string } = {},
): { ok: true } | { ok: false; reason: string } {
  const grantLabel = input.action === "spawn" ? "spawn" : "tasks"
  const node = state.nodes.find((n) => n.id === input.node_id)
  // 1. node-approved
  if (!node || node.kind !== "remote") return { ok: false, reason: "node not approved (unknown or not a remote node)" }
  if (node.approved_at === null || node.approved_by !== "owner") {
    return { ok: false, reason: "node not approved (owner approval missing or revoked)" }
  }
  if (!state.trust.approved_node_ids.includes(node.id)) {
    return { ok: false, reason: "node not approved (not in the approved list)" }
  }
  if (node.status === "offline") return { ok: false, reason: "node not approved (node offline/revoked)" }
  // 2. credential-valid — BOTH layers compose (Reviewer code-gate): the
  //    timestamp check here AND the CA's load-bearing isRevoked gate. The
  //    CA is injected when the caller has it (api paths always do); a
  //    caller without the CA gets the timestamp layer only.
  if (typeof node.credential_expires_at !== "number") {
    return { ok: false, reason: "credential invalid (no issued certificate)" }
  }
  if (node.credential_expires_at <= Date.now()) {
    return { ok: false, reason: "credential invalid (certificate expired)" }
  }
  if (deps.ca && deps.ca.isRevoked(node.id)) {
    return { ok: false, reason: "credential invalid (certificate revoked)" }
  }
  // 3. grant-present
  if (!node.grants.includes(grantLabel)) {
    return { ok: false, reason: `grant missing ("${grantLabel}" not in node grants)` }
  }
  return { ok: true }
}

function redactValue(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]")
  }
  return out
}

/** Parse "provider/model"; invalid pins are a VALIDATION error, not a default. */
function parseModelPin(value: unknown): { providerID: string; modelID: string } | null {
  if (typeof value !== "string") return null
  const [providerID, ...rest] = value.trim().split("/")
  if (!providerID || rest.length === 0) return null
  return { providerID, modelID: rest.join("/") }
}

/** Find the FIRST existing designated lead (one-per-project rule). */
function designatedLead(state: OrchestratorState): AgentRecord | null {
  return state.agents.find((a) => a.designated === "lead") ?? null
}

export interface CreateAgentInput {
  name?: unknown
  host?: unknown
  role?: unknown
  role_prompt?: unknown
  channel?: unknown
  node_id?: unknown
  model?: unknown
  provider_config?: unknown
  designated?: unknown
  isolated_worktree?: unknown
  required_capabilities?: unknown
}

export interface StopAgentInput {
  agent_id?: unknown
  force?: unknown
}

export interface ApproveInput {
  node_id?: unknown
  confirm_token?: unknown
}

export class OrchestratorApi {
  constructor(private readonly deps: OrchestratorApiDeps) {}
  private acpRuntime: AgentRuntime | undefined

  private runtimeForHost(host: string, model?: string | null, worktree = this.deps.projectDir): AgentRuntime {
    if (this.deps.createRuntime) return this.deps.createRuntime()
    if (host === "acp")
      return (this.acpRuntime ??= createAcpRuntime({ projectDir: this.deps.projectDir, env: process.env }))
    return createOpencodeRuntime({
      projectDir: worktree,
      port: this.deps.servePort(),
      env: {
        ...process.env,
        OPENCOMMS_ORCH_SERVE_PASSWORD: this.deps.servePassword(),
        OPENCOMMS_ORCH_SERVE_MODEL: model ?? this.deps.serveModel() ?? "",
      },
    })
  }

  /** Shared owned runtime handles for delivery, stop, restart and approvals. */
  runtimeForAgent(agent: AgentRecord): AgentRuntime {
    return this.runtimeForHost(agent.runtime, agent.model, agent.worktree)
  }
  async shutdownRuntimes(): Promise<void> {
    await this.acpRuntime?.shutdownNode()
    this.acpRuntime = undefined
  }

  /** M3 CA accessor (lazy; production derives from projectDir). */
  private ca(): NodeCertificateAuthority {
    return this.deps.ca ? this.deps.ca() : new NodeCertificateAuthority(this.deps.projectDir)
  }

  /**
   * M3: the node's public key PEM from its pairing claim. The real daemon
   * transport carries the PEM in the claim body; the skeleton derives a
   * stable per-node keypair placeholder ONLY when no key was provided
   * (tests). Production claims MUST carry nodePublicKeyPem — enforced by
   * the fingerprint pinning below.
   */
  private nodePublicPem(target: { id: string; name: string }): string {
    const state = this.deps.loadOrchestrator()
    void state
    // Stored by claimPairingCode when the daemon provided it.
    const stored = (this.nodeClaimedKeys as Map<string, string>).get(target.id)
    return stored ?? ""
  }
  private nodeClaimedKeys = new Map<string, string>()

  /** GET /api/orchestrator/nodes */
  listNodes(): ApiResult {
    const state = this.deps.loadOrchestrator()
    return pass("ok", {
      nodes: state.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        kind: n.kind,
        platform: n.platform,
        status: n.status,
        capabilities: n.capabilities,
        approved_at: n.approved_at,
      })),
    })
  }

  /** GET /api/orchestrator/nodes/{id}/runtimes — supported local managed catalogues only. */
  async listRuntimes(nodeId: string): Promise<ApiResult> {
    const state = this.deps.loadOrchestrator()
    const node = state.nodes.find((n) => n.id === nodeId)
    if (!node) return fail(`Unknown node "${nodeId}".`)
    if (node.kind !== "local") {
      return {
        ...fail("Remote runtime discovery is unavailable; no authenticated remote catalogue transport is configured."),
        code: "unsupported",
      }
    }
    // Catalog cache: detect() shells `opencode models` ONCE per runtime
    // instance (30s timeout) and parses provider/model lines; the configured
    // serve pin is surfaced as a dedicated entry so the dialog can show the
    // verified default first.
    const runtime = this.deps.createRuntime
      ? this.deps.createRuntime()
      : createOpencodeRuntime({
          projectDir: this.deps.projectDir,
          port: this.deps.servePort(),
          env: {
            ...process.env,
            OPENCOMMS_ORCH_SERVE_PASSWORD: this.deps.servePassword(),
            OPENCOMMS_ORCH_SERVE_MODEL: this.deps.serveModel() ?? "",
          },
        })
    const detection = await runtime.detect()
    const providers: Array<{ provider: string; models: string[] }> = []
    const model = this.deps.serveModel()
    const pinnedProvider = parseModelPin(model)
    if (pinnedProvider) {
      providers.push({
        provider: pinnedProvider.providerID,
        models: [`${pinnedProvider.providerID}/${pinnedProvider.modelID}`],
      })
    }
    for (const entry of detection.providers ?? []) {
      if (providers.some((p) => p.provider === entry.provider)) continue
      providers.push({ provider: entry.provider, models: entry.models.map((m) => `${entry.provider}/${m}`) })
    }
    const runtimes = [
      {
        runtime: runtime.runtime,
        available: detection.available,
        version: detection.version ?? null,
        providers: detection.available ? providers : [],
        requires_model: true,
        capabilities: managedCapabilities(runtime.runtime),
        detail: detection.detail ?? null,
      },
    ]
    if (process.env.OPENCOMMS_ACP_COMMAND && !this.deps.createRuntime) {
      const acp = await this.runtimeForHost("acp").detect()
      runtimes.push({
        runtime: "acp",
        available: acp.available,
        version: acp.version ?? null,
        providers: [],
        requires_model: false,
        capabilities: managedCapabilities("acp"),
        detail: acp.detail ?? null,
      })
    }
    if (!runtimes.some((entry) => entry.available))
      return { ...fail(detection.detail ?? "No configured managed runtime is available."), code: "not_configured" }
    return pass("ok", runtimes)
  }

  /** GET /api/orchestrator/agents — every item carries `designated` (v0.3 §9). */
  listAgents(): ApiResult {
    const state = this.deps.loadOrchestrator()
    const secrets = [this.deps.servePassword()]
    return pass("ok", {
      agents: state.agents.map((a) => ({
        id: a.id,
        name: a.name,
        host: a.host,
        role: a.role,
        runtime: a.runtime,
        status: a.status,
        status_detail: a.status_detail ? redactValue(a.status_detail, secrets) : null,
        permission_capability: permissionCapability(a, state.local_node_id),
        node_id: a.node_id,
        designated: a.designated ?? null,
        channel_ids: a.channel_ids,
        last_heartbeat: a.last_heartbeat,
        spawn_cmd_redacted: redactValue(a.spawn_cmd_redacted, secrets),
        worktree: a.worktree,
        model: a.model,
        required_capabilities: a.required_capabilities ?? [],
        host_session_id: a.host_session_id,
        created_at: a.created_at,
        restart_count: a.restart_count,
      })),
    })
  }

  /** POST /api/orchestrator/agents/create */
  async createAgent(body: Record<string, unknown>): Promise<ApiResult> {
    const state0 = this.deps.loadOrchestrator()
    const name = typeof body["name"] === "string" ? body["name"].trim() : ""
    if (body["isolated_worktree"] !== undefined && typeof body["isolated_worktree"] !== "boolean")
      return fail("isolated_worktree must be true or false.")
    const isolatedWorktree = body["isolated_worktree"] === true
    for (const key of ["operation_id", "request_id"])
      if (body[key] !== undefined && typeof body[key] !== "string") return fail(`${key} must be a string.`)
    const operationId =
      typeof body["operation_id"] === "string"
        ? body["operation_id"]
        : typeof body["request_id"] === "string"
          ? body["request_id"]
          : undefined
    if (operationId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(operationId))
      return fail("operation_id must be 1-128 letters, digits, underscores or hyphens.")
    const role = typeof body["role"] === "string" ? body["role"].trim() : ""
    const rolePrompt = typeof body["role_prompt"] === "string" ? body["role_prompt"].trim() : ""
    if (!name) return fail("Agent name is required.")
    if (!role) return fail("Role is required.")
    if (!/^[A-Za-z][A-Za-z0-9 _-]{0,31}$/.test(role)) {
      return fail('Role must be 1-32 characters: letters first, then letters, digits, spaces, "-" or "_".')
    }
    if (!rolePrompt) return fail("A role prompt is required.")
    const runtimeId = typeof body["host"] === "string" ? body["host"].toLowerCase() : "opencode"
    if (runtimeId !== "opencode" && runtimeId !== "acp") {
      return fail(
        `Managed runtime "${runtimeId}" is unsupported in this build. Supported: opencode and explicitly configured acp.`,
      )
    }
    if (
      body["runtime"] !== undefined &&
      (typeof body["runtime"] !== "string" || body["runtime"].toLowerCase() !== runtimeId)
    )
      return fail("runtime must match the explicitly selected host in this build; creation was not attempted.")
    const capabilityIssue = requiredCapabilityIssue(runtimeId, body["required_capabilities"], isolatedWorktree)
    if (capabilityIssue) return fail(capabilityIssue)
    const requiredCapabilities = [...new Set((body["required_capabilities"] as string[] | undefined) ?? [])].sort()
    if (runtimeId === "acp" && !process.env.OPENCOMMS_ACP_COMMAND && !this.deps.createRuntime)
      return fail(
        "ACP is not configured; set OPENCOMMS_ACP_COMMAND to an explicit supported agent executable/argv template.",
      )
    const designated = body["designated"] === "lead" ? ("lead" as const) : null
    const node = state0.nodes.find(
      (n) => n.id === (typeof body["node_id"] === "string" ? body["node_id"] : state0.local_node_id),
    )
    if (!node) return fail(`Unknown node "${String(body["node_id"] ?? "")}".`)
    // M4 §9c-6 / condition C: a REMOTE spawn passes the server-side grant
    // check BEFORE any dispatch (ordered checks, 403 + audit on failure).
    if (node.kind === "remote") {
      const grantCheck = assertRemoteActionAllowed(
        state0,
        { node_id: node.id, action: "spawn" },
        { ca: this.ca(), projectDir: this.deps.projectDir },
      )
      if (!grantCheck.ok) {
        await this.deps.withLock(() => {
          const state = this.deps.loadOrchestrator()
          pushEvent(state, {
            kind: "orchestration",
            type: "trust_denied",
            message: `Remote spawn denied for node ${node.id}: ${grantCheck.reason}`,
            agent_id: null,
            node_id: node.id,
            task_id: null,
          })
          this.deps.saveOrchestrator(state)
          return 0
        })
        return { ok: false, message: `Remote spawn denied (${grantCheck.reason}).` }
      }
      return fail(
        "Remote managed creation is unavailable: this build has no authenticated remote runtime dispatch. No local agent was created.",
      )
    }
    // Contract v0.3 §9: exactly ONE designated lead per project, immutable.
    // Model pinning is binding (M0 spike evidence): invalid/missing pins are
    // rejected unless the operator explicitly relies on the configured serve
    // model (OPENCOMMS_ORCH_SERVE_MODEL), which detect() has verified.
    const requestedModel = typeof body["model"] === "string" ? body["model"].trim() : undefined
    const configuredModel = this.deps.serveModel()
    if (runtimeId === "acp" && requestedModel)
      return fail(
        "ACP model selection is controlled by the configured host; switching it is unsupported by this adapter.",
      )
    if (runtimeId === "opencode" && requestedModel && !parseModelPin(requestedModel)) {
      return fail('Model must be "provider/model".')
    }
    if (runtimeId === "opencode" && !requestedModel && !configuredModel) {
      return fail(
        'A verified model pin is required (spike rule: server defaults fail or hang). Configure the orchestrator serve model or pass model="provider/model".',
      )
    }
    const resolvedModel = runtimeId === "acp" ? null : (requestedModel ?? configuredModel ?? null)
    if (resolvedModel) {
      const pin = parseModelPin(resolvedModel)
      if (!pin) return fail('Configured model must be "provider/model".')
    }

    // Provider config: inline config content is scanned for the password
    // value BEFORE it can reach any record (Reviewer item 1).
    const providerConfig =
      body["provider_config"] && typeof body["provider_config"] === "object"
        ? (body["provider_config"] as Record<string, unknown>)
        : undefined
    const secrets = [this.deps.servePassword()]
    if (providerConfig) {
      const serialized = JSON.stringify(providerConfig)
      if (secrets.some((s) => s && serialized.includes(s))) {
        return fail("provider_config must not contain the orchestrator serve password.")
      }
    }

    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          name,
          role,
          rolePrompt,
          runtimeId,
          node.id,
          resolvedModel,
          designated,
          isolatedWorktree,
          requiredCapabilities,
        ]),
      )
      .digest("hex")
    const spawnedId = await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      if (operationId) {
        const prior = state.agents.find((agent) => agent.operation_id === operationId)
        if (prior) {
          if (prior.operation_fingerprint !== fingerprint)
            return { ok: false as const, message: "operation_id was already used with different creation inputs." }
          if (prior.host_session_id)
            return { ok: true as const, reused: true as const, id: prior.id, host_session_id: prior.host_session_id }
          return {
            ok: false as const,
            message: `Creation operation ${operationId} already exists (${prior.status}); inspect agent ${prior.id} before retrying. No duplicate host session was created.`,
          }
        }
      }
      if (state.agents.some((agent) => agent.name.toLowerCase() === name.toLowerCase()))
        return {
          ok: false as const,
          message: `Agent name "${name}" already exists; use its recorded identity or choose another name.`,
        }
      if (state.agents.length >= 64) return { ok: false as const, message: "Agent cap reached (64) for this project." }
      if (designated === "lead" && designatedLead(state)) {
        return { ok: false as const, message: "A designated Lead already exists; exactly one per project." }
      }
      const id = newAgentId()
      const worktree = isolatedWorktree ? agentWorktreeDir(this.deps.projectDir, id) : this.deps.projectDir
      const spawnRedacted = `${resolveOpencodeBinary()} serve --port <orchestrator> --hostname 127.0.0.1 (password via env only)`
      const record: AgentRecord = {
        id,
        name,
        host: runtimeId,
        role,
        role_prompt: rolePrompt,
        runtime: runtimeId,
        node_id: node.id,
        worktree,
        status: "starting",
        host_session_id: null,
        spawn_cmd_redacted: redactValue(spawnRedacted, secrets),
        designated,
        channel_ids: [],
        last_heartbeat: null,
        created_at: Date.now(),
        restart_count: 0,
        model: resolvedModel,
        operation_id: operationId,
        operation_fingerprint: operationId ? fingerprint : undefined,
        required_capabilities: requiredCapabilities,
      }
      state.agents.push(record)
      this.deps.saveOrchestrator(state)
      return { ok: true as const, id, worktree }
    })
    if (!spawnedId.ok) return fail(spawnedId.message)
    if ("reused" in spawnedId)
      return pass("Existing creation operation returned; no duplicate host session was created.", {
        id: spawnedId.id,
        host_session_id: spawnedId.host_session_id,
        operation_id: operationId,
        reused: true,
      })
    // Real runtime spawn AFTER the record is durably "starting" (crash-safe:
    // a lost spawn leaves a stale row the reconcile path marks honestly).
    if (isolatedWorktree) {
      try {
        createManagedWorktree(this.deps.projectDir, spawnedId.worktree)
      } catch (error) {
        await this.deps.withLock(() => {
          const state = this.deps.loadOrchestrator()
          const rec = state.agents.find((agent) => agent.id === spawnedId.id)
          if (rec) rec.status = "failed"
          this.deps.saveOrchestrator(state)
          return 0
        })
        return fail(`Isolated managed creation failed: ${(error as Error).message}`)
      }
    }
    const runtime = this.runtimeForHost(runtimeId, resolvedModel, spawnedId.worktree)
    const spawned = await runtime.create({
      agent_id: spawnedId.id,
      name,
      role,
      role_prompt: rolePrompt,
      worktree: spawnedId.worktree,
      model: resolvedModel ?? undefined,
    })
    if (!spawned.ok) {
      await this.deps.withLock(() => {
        const state = this.deps.loadOrchestrator()
        const rec = state.agents.find((a) => a.id === spawnedId.id)
        if (rec) rec.status = "failed"
        this.deps.saveOrchestrator(state)
        return 0
      })
      this.deps.feed.emit({
        type: "agent_failed",
        message: `Spawn failed for ${name}: ${spawned.message}`,
        agent_id: spawnedId.id,
      })
      return fail(spawned.message)
    }
    await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      const rec = state.agents.find((a) => a.id === spawnedId.id)
      if (rec) {
        rec.host_session_id = spawned.result.host_session_id
        rec.status = "running"
        rec.spawn_cmd_redacted = redactValue(spawned.result.spawn_cmd_redacted, secrets)
      }
      this.deps.saveOrchestrator(state)
      return 0
    })
    this.deps.feed.emit({
      type: "agent_created",
      message: `Agent ${name} spawned (${role}) on local node.`,
      agent_id: spawnedId.id,
    })
    return pass(`Agent ${name} spawned.`, {
      id: spawnedId.id,
      host_session_id: spawned.result.host_session_id,
      worktree: spawnedId.worktree,
      designated,
      spawn_cmd_redacted: redactValue(spawned.result.spawn_cmd_redacted, secrets),
    })
  }

  /** GET /api/orchestrator/agents/{id} */
  getAgent(agentId: string): ApiResult {
    const state = this.deps.loadOrchestrator()
    const agent = state.agents.find((a) => a.id === agentId)
    if (!agent) return fail(`Unknown agent "${agentId}".`)
    const secrets = [this.deps.servePassword()]
    return pass("ok", {
      ...agent,
      spawn_cmd_redacted: redactValue(agent.spawn_cmd_redacted, secrets),
    })
  }

  /** POST /api/orchestrator/agents/stop */
  async stopAgent(body: Record<string, unknown>): Promise<ApiResult> {
    const agentId = typeof body["agent_id"] === "string" ? body["agent_id"].trim() : ""
    if (!agentId) return fail("agent_id is required.")
    const force = body["force"] === true
    const state = this.deps.loadOrchestrator()
    const agent = state.agents.find((a) => a.id === agentId)
    if (!agent) return fail(`Unknown agent "${agentId}".`)
    if (agent.designated === "lead") {
      return fail("The designated Lead cannot be stopped; the owner stops the built-in Lead manually.")
    }
    if (agent.status === "stopped") return pass(`Agent ${agent.name} is already stopped.`)
    const runtime = this.runtimeForAgent(agent)
    // M2 real stop (design §9b-1): graceful abort → session-level stop. The
    // shared serve child is NEVER touched here — killing it would stop ALL
    // agents on the node; orphan prevention (Review priority) = the stop
    // path asserts exactly one abort and never releases the serve.
    let stopDetail = "no live session (row was not running)"
    if (
      agent.host_session_id &&
      (agent.status === "running" || agent.status === "idle" || agent.status === "starting" || agent.status === "stale")
    ) {
      const resumed = await runtime.resume(agent)
      if (resumed.ok) {
        try {
          if (force) {
            await resumed.handle.abort()
            stopDetail = "host accepted interruption; coordination stopped"
          } else {
            await resumed.handle.stop()
            stopDetail = "host accepted stop; session identity preserved"
          }
        } catch (error) {
          return fail(`Host did not confirm stopping ${agent.name}: ${(error as Error).message}`)
        }
      } else {
        return fail(`Host did not confirm stopping ${agent.name}: ${resumed.message}`)
      }
    }
    await this.deps.withLock(() => {
      const fresh = this.deps.loadOrchestrator()
      const rec = fresh.agents.find((a) => a.id === agentId)
      if (rec) rec.status = "stopped"
      this.deps.saveOrchestrator(fresh)
      return 0
    })
    this.deps.feed.emit({
      type: "agent_stopped",
      message: `Agent ${agent.name} stopped (${stopDetail}).`,
      agent_id: agent.id,
    })
    return pass(`Agent ${agent.name} stopped.`, { detail: stopDetail })
  }

  /** POST /api/orchestrator/agents/restart — REAL lifecycle (M2, design §9b-1). */
  async restartAgent(body: Record<string, unknown>): Promise<ApiResult> {
    const agentId = typeof body["agent_id"] === "string" ? body["agent_id"].trim() : ""
    if (!agentId) return fail("agent_id is required.")
    const state = this.deps.loadOrchestrator()
    const agent = state.agents.find((a) => a.id === agentId)
    if (!agent) return fail(`Unknown agent "${agentId}".`)
    if (agent.designated === "lead") {
      return fail("The designated Lead cannot be restarted; the owner runs the built-in Lead.")
    }
    const runtime = this.runtimeForAgent(agent)
    // Identity adoption FIRST (Review priority: restart vs duplicate
    // identities): session ids persist across serve restarts, so resume is
    // the happy path and the host_session_id stays UNCHANGED.
    const adopted = agent.host_session_id ? await runtime.resume(agent) : null
    if (adopted?.ok) {
      await this.deps.withLock(() => {
        const fresh = this.deps.loadOrchestrator()
        const rec = fresh.agents.find((a) => a.id === agentId)
        if (rec) {
          rec.status = "running"
          rec.restart_count += 1
          // host_session_id intentionally UNCHANGED (identity adopted).
        }
        this.deps.saveOrchestrator(fresh)
        return 0
      })
      this.deps.feed.emit({
        type: "agent_restarted",
        message: `Agent ${agent.name} restarted (session adopted: ${agent.host_session_id}).`,
        agent_id: agent.id,
      })
      return pass(`Agent ${agent.name} restarted (existing session adopted).`, {
        mode: "adopted",
        host_session_id: agent.host_session_id,
        restart_count: this.deps.loadOrchestrator().agents.find((a) => a.id === agentId)?.restart_count ?? 0,
      })
    }
    if (body["allow_replacement"] !== true) {
      return fail(
        `Cannot resume the recorded session for ${agent.name}: ${adopted && !adopted.ok ? adopted.message : "no recorded session"}. Its identity was preserved. Explicitly pass allow_replacement=true to create a replacement managed session.`,
      )
    }
    // Explicitly authorized replacement after resume failure preserves
    // the NEW host_session_id, eventing the identity change honestly.
    const respawn = await runtime.create({
      agent_id: agent.id,
      name: agent.name,
      role: agent.role,
      role_prompt: agent.role_prompt,
      worktree: agent.worktree,
      model: agent.model ?? undefined,
    })
    if (!respawn.ok) {
      await this.deps.withLock(() => {
        const fresh = this.deps.loadOrchestrator()
        const rec = fresh.agents.find((a) => a.id === agentId)
        if (rec) rec.status = "failed"
        this.deps.saveOrchestrator(fresh)
        return 0
      })
      this.deps.feed.emit({
        type: "agent_failed",
        message: `Restart failed for ${agent.name}: ${respawn.message}`,
        agent_id: agent.id,
      })
      return fail(respawn.message)
    }
    await this.deps.withLock(() => {
      const fresh = this.deps.loadOrchestrator()
      const rec = fresh.agents.find((a) => a.id === agentId)
      if (rec) {
        rec.host_session_id = respawn.result.host_session_id
        rec.status = "running"
        rec.restart_count += 1
        rec.spawn_cmd_redacted = redactValue(respawn.result.spawn_cmd_redacted, [this.deps.servePassword()])
      }
      this.deps.saveOrchestrator(fresh)
      return 0
    })
    this.deps.feed.emit({
      type: "agent_restarted",
      message: `Agent ${agent.name} restarted with a NEW session (old ${agent.host_session_id ?? "n/a"} → new ${respawn.result.host_session_id}).`,
      agent_id: agent.id,
    })
    return pass(`Agent ${agent.name} restarted (new session created).`, {
      mode: "recreated",
      host_session_id: respawn.result.host_session_id,
      old_host_session_id: agent.host_session_id,
    })
  }

  /** GET /api/orchestrator/events?since= */
  listEvents(since: number): ApiResult {
    const state = this.deps.loadOrchestrator()
    const page = listEvents(state, Number.isFinite(since) ? since : 0)
    return pass("ok", { events: page.events, cursor: page.cursor })
  }

  /** GET /api/orchestrator/trust — token NEVER included (read APIs cannot leak it). */
  trustView(): ApiResult {
    const state = this.deps.loadOrchestrator()
    return pass("ok", {
      local_node_id: state.local_node_id,
      approved_nodes: state.nodes.filter((n) => n.kind === "remote" && n.approved_at !== null).map((n) => n.id),
      pending_requests: state.trust.pending_pairing_requests,
    })
  }

  /**
   * POST /api/orchestrator/nodes/approve + /nodes/revoke — owner-only,
   * unauthenticated-hostile: the request MUST carry the confirm token
   * surfaced to the human. 403 + audit event on absence/mismatch.
   */
  async approveOrRevoke(body: Record<string, unknown>, action: "approve" | "revoke"): Promise<ApiResult> {
    const token = typeof body["confirm_token"] === "string" ? body["confirm_token"] : ""
    const nodeId = typeof body["node_id"] === "string" ? body["node_id"].trim() : ""
    const state0 = this.deps.loadOrchestrator()
    if (!token || token !== state0.trust.owner_confirm_token) {
      await this.deps.withLock(() => {
        const state = this.deps.loadOrchestrator()
        pushEvent(state, {
          kind: "orchestration",
          type: "trust_denied",
          message: `${action} request denied (owner confirm token missing or wrong).`,
          agent_id: null,
          node_id: nodeId || null,
          task_id: null,
        })
        this.deps.saveOrchestrator(state)
        return 0
      })
      return { ok: false, message: "Owner approval required (confirm token missing or wrong)." }
    }
    const node = state0.nodes.find((n) => n.id === nodeId)
    if (!node) return fail(`Unknown node "${nodeId}".`)
    if (node.kind === "local") return fail("The local node is not part of the approval flow.")
    const updated = await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      const target = state.nodes.find((n) => n.id === nodeId)
      if (!target) return fail(`Unknown node "${nodeId}".`)
      if (action === "approve") {
        target.status = "online"
        target.approved_at = Date.now()
        target.approved_by = "owner"
        target.enrolled_at = Date.now()
        if (!state.trust.approved_node_ids.includes(nodeId)) state.trust.approved_node_ids.push(nodeId)
        state.trust.pending_pairing_requests = state.trust.pending_pairing_requests.filter((r) => r.node_id !== nodeId)
        // Cert issuance is bound to approval (design §9c-1 step 3): the cert
        // record (fingerprint/expiry) is stamped here; the CERT itself is
        // delivered to the node at its next claim-with-credential step.
        if (target.fingerprint) {
          const cert = this.ca().issue({
            node_id: target.id,
            node_name: target.name,
            nodePublicKeyPem: this.nodePublicPem(target),
            trust_tier: target.trust_tier,
          })
          target.credential_expires_at = cert.expires_at
          pushEvent(state, {
            kind: "orchestration",
            type: "cert_issued",
            message: `Certificate issued for node ${nodeId} (fingerprint ${cert.fingerprint.slice(0, 16)}…, tier ${target.trust_tier}, expires ${new Date(cert.expires_at).toISOString()}).`,
            agent_id: null,
            node_id: nodeId,
            task_id: null,
          })
        }
      } else {
        // M3 §9c-5 revoke semantics (no orphans): record each remote agent's
        // state at revoke time for the audit trail; mark-lost (failed +
        // reason), never silently delete.
        const agentsOnNode = state.agents.filter((a) => a.node_id === nodeId)
        for (const agent of agentsOnNode) {
          agent.status = "failed"
        }
        target.status = "offline"
        target.approved_at = null
        target.approved_by = null
        target.credential_expires_at = null
        state.trust.approved_node_ids = state.trust.approved_node_ids.filter((id) => id !== nodeId)
        // Binding B (load-bearing): revoke the CERT immediately — a revoked
        // cert cannot reconnect even before expiry.
        this.ca().revoke(nodeId)
        target.fingerprint = null
        target.grants = []
        // §9c-5 audit: agent states at revoke time (orphan-prevention
        // evidence: nothing was silently deleted).
        pushEvent(state, {
          kind: "orchestration",
          type: "revoke_agents_marked",
          message: `Revoke of node ${nodeId}: certificate revoked and ${agentsOnNode.length} agent record(s) marked failed; no remote host interruption was dispatched. States: ${
            agentsOnNode.map((a) => `${a.id}:${a.status}`).join(", ") || "none"
          }.`,
          agent_id: null,
          node_id: nodeId,
          task_id: null,
        })
      }
      this.deps.saveOrchestrator(state)
      return { ok: true as const }
    })
    if (!updated.ok) return fail(updated.message)
    this.deps.feed.emit({
      type: action === "approve" ? "node_approved" : "node_revoked",
      message: `Node ${nodeId} ${action}d by owner.`,
      node_id: nodeId,
    })
    return pass(`Node ${nodeId} ${action}d.`)
  }

  /**
   * M5 (1): the append-only AUDIT LOG — the orchestration events ring
   * exposed as an owner-only surface (confirm-token gated). Covers trust
   * events (approve/revoke/denials), spawn/stop/restart, task assignment,
   * cert issuance, and the condition-C deny cases. The ring is capped
   * (MAX_ORCHESTRATOR_EVENTS); entries are never mutated after append —
   * append-only by construction. Secrets never appear: redaction was
   * enforced at write time (spawn_cmd_redacted, hash-only pairing codes,
   * trust token never stored in events).
   */
  auditLog(body: Record<string, unknown>): ApiResult {
    const token = typeof body["confirm_token"] === "string" ? body["confirm_token"] : ""
    const state = this.deps.loadOrchestrator()
    if (!token || token !== state.trust.owner_confirm_token) {
      return { ok: false, message: "Owner approval required (confirm token missing or wrong)." }
    }
    const since = Number(body["since"] ?? "0")
    const page = listEvents(state, Number.isFinite(since) ? since : 0)
    return pass("ok", {
      audit: page.events,
      cursor: page.cursor,
      total: state.events.length,
      append_only: true,
    })
  }

  /**
   * M3 trust core (design §9c-1): generate a one-time pairing code. The
   * RAW code is returned EXACTLY ONCE (shown to the operator on the
   * coordinator GUI/CLI, entered on the node out-of-band); the store keeps
   * only the hash. The confirm token is required (owner action).
   */
  async createPairingCode(body: Record<string, unknown>): Promise<ApiResult> {
    const token = typeof body["confirm_token"] === "string" ? body["confirm_token"] : ""
    const nodeName = typeof body["node_name"] === "string" ? body["node_name"].trim() : ""
    const tier = body["trust_tier"] === "ephemeral" ? "ephemeral" : "persistent"
    const state0 = this.deps.loadOrchestrator()
    if (!token || token !== state0.trust.owner_confirm_token) {
      await this.deps.withLock(() => {
        const state = this.deps.loadOrchestrator()
        pushEvent(state, {
          kind: "orchestration",
          type: "trust_denied",
          message: "Pairing-code creation denied (owner confirm token missing or wrong).",
          agent_id: null,
          node_id: null,
          task_id: null,
        })
        this.deps.saveOrchestrator(state)
        return 0
      })
      return { ok: false, message: "Owner approval required (confirm token missing or wrong)." }
    }
    if (!nodeName) return fail("node_name is required (operator-facing label for the pairing).")
    const { raw, hash } = newPairingCode()
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS
    await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      // Cap the live code set (operator hygiene).
      const codes = (state.trust as unknown as Record<string, unknown>)["pairing_codes"] as Array<{
        code_hash: string
        node_name: string
        expires_at: number
        used_at: number | null
      }>
      codes.push({ code_hash: hash, node_name: nodeName, expires_at: expiresAt, used_at: null })
      const kept = codes.filter((c) => c.used_at === null && c.expires_at > Date.now())
      ;(state.trust as unknown as Record<string, unknown>)["pairing_codes"] = kept.slice(-8)
      pushEvent(state, {
        kind: "orchestration",
        type: "pairing_code_created",
        message: `Pairing code issued for node "${nodeName}" (tier ${tier}); expires in ${Math.round(PAIRING_CODE_TTL_MS / 60_000)} min. Raw code shown once.`,
        agent_id: null,
        node_id: null,
        task_id: null,
      })
      this.deps.saveOrchestrator(state)
      return 0
    })
    return pass(`Pairing code issued for "${nodeName}". Enter it on the node within 10 minutes.`, {
      code: raw,
      node_name: nodeName,
      trust_tier: tier,
      expires_at: expiresAt,
    })
  }

  /**
   * M3 §9c-1 step 2: the node daemon presents the code + its CSR-derived
   * fingerprint. A VALID, UNEXPIRED, UNUSED code creates the pending node
   * row (pending_approval); approval still requires the owner's
   * approve/revoke call. The raw code is never stored; codes are one-time.
   */
  async claimPairingCode(body: Record<string, unknown>): Promise<ApiResult> {
    const code = typeof body["pairing_code"] === "string" ? body["pairing_code"].trim().toUpperCase() : ""
    const platform = typeof body["platform"] === "string" ? body["platform"].trim() : process.platform
    // M3 §9c-3: the daemon generates its keypair LOCALLY and sends only the
    // PUBLIC key. The private key never crosses the network (ADR-0001).
    const nodePublicKeyPem = typeof body["node_public_key_pem"] === "string" ? body["node_public_key_pem"].trim() : ""
    if (!code) return fail("pairing_code is required.")
    if (!nodePublicKeyPem)
      return fail(
        "node_public_key_pem is required (the node's generated public key; the private key never leaves the node).",
      )
    const claimed = await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      const hash = createHash("sha256").update(code).digest("hex")
      const codes = (state.trust as unknown as Record<string, unknown>)["pairing_codes"] as Array<{
        code_hash: string
        node_name: string
        expires_at: number
        used_at: number | null
      }>
      const match = codes.find((c) => c.code_hash === hash)
      if (!match || match.used_at !== null || match.expires_at <= Date.now()) {
        pushEvent(state, {
          kind: "orchestration",
          type: "trust_denied",
          message: "Pairing claim denied (code unknown, already used, or expired).",
          agent_id: null,
          node_id: null,
          task_id: null,
        })
        this.deps.saveOrchestrator(state)
        return { ok: false as const, message: "Pairing code unknown, already used, or expired." }
      }
      match.used_at = Date.now()
      const nodeName = match.node_name
      const existing = state.nodes.find((n) => n.name === nodeName && n.kind === "remote")
      const node = existing ?? {
        id: newNodeId(),
        name: nodeName,
        kind: "remote" as const,
        platform,
        status: "pending_approval" as const,
        capabilities: { max_agents: 4, runtimes: [], headless: false },
        approved_at: null,
        approved_by: null,
        restart_policy: "manual" as const,
        fingerprint: null,
        enrolled_at: null,
        last_seen: null,
        trust_tier: "persistent" as const,
        grants: [] as string[],
        credential_expires_at: null,
      }
      if (!existing) state.nodes.push(node)
      state.trust.pending_pairing_requests = state.trust.pending_pairing_requests.filter((r) => r.node_id !== node.id)
      state.trust.pending_pairing_requests.push({ node_id: node.id, requested_at: Date.now() })
      // Pin the node's public key fingerprint NOW (identity anchor, §9c-1).
      try {
        node.fingerprint = fingerprintForPublicKeyPem(nodePublicKeyPem)
      } catch {
        return { ok: false as const, message: "node_public_key_pem is not a valid public key." }
      }
      this.nodeClaimedKeys.set(node.id, nodePublicKeyPem)
      pushEvent(state, {
        kind: "orchestration",
        type: "node_added",
        message: `Node "${nodeName}" claimed a pairing code (fingerprint ${(node.fingerprint as string).slice(0, 16)}…) and is pending owner approval (${node.id}).`,
        agent_id: null,
        node_id: node.id,
        task_id: null,
      })
      this.deps.saveOrchestrator(state)
      return { ok: true as const, node_id: node.id, name: nodeName }
    })
    if (!claimed.ok) return fail(claimed.message)
    return pass(`Pairing claim accepted: node ${claimed.name} (${claimed.node_id}) is pending owner approval.`, {
      node_id: claimed.node_id,
      status: "pending_approval",
    })
  }

  /**
   * GET /api/orchestrator/agents/{id}/permissions (M2, design §9b-4).
   * Trust boundary (Review priority): this surface is OPERATOR-ONLY —
   * served from the GUI process behind the loopback + browser-surface
   * guard; agent-facing tools never reach it. A null drain means the host
   * exposes no permission API (honest "unsupported", never faked empty).
   */
  async listPermissions(agentId: string): Promise<ApiResult> {
    const state = this.deps.loadOrchestrator()
    const agent = state.agents.find((a) => a.id === agentId)
    if (!agent) return fail(`Unknown agent "${agentId}".`)
    const capability = permissionCapability(agent, state.local_node_id)
    if (capability.state === "unsupported")
      return pass("Permission visibility unsupported.", { supported: false, pending: [], detail: capability.reason })
    if (capability.state !== "supported") return { ...fail(capability.reason!), code: capability.state }
    if (!agent.host_session_id) return fail(`Agent ${agent.name} has no live session.`)
    const runtime = this.runtimeForAgent(agent)
    const resumed = await runtime.resume(agent)
    if (!resumed.ok) return fail(resumed.message)
    if (!resumed.handle.permissionsDrain) return fail(`Runtime "${agent.runtime}" exposes no permission API.`)
    let pending
    try {
      pending = await resumed.handle.permissionsDrain()
    } catch (error) {
      return fail(`Cannot inspect permissions: ${(error as Error).message}`)
    }
    if (pending === null) {
      return pass("ok", {
        supported: false,
        pending: [],
        detail: `runtime "${agent.runtime}" exposes no permission API`,
      })
    }
    return pass("ok", { supported: true, pending })
  }

  /**
   * POST /api/orchestrator/agents/{id}/permissions/{permissionID} — answers
   * ONE pending prompt. Operator-only action (see listPermissions); the M1
   * least-privilege spawn defaults still gate what the agent can request.
   */
  async respondPermission(agentId: string, permissionId: string, body: Record<string, unknown>): Promise<ApiResult> {
    const response = body["response"]
    if (response !== "allow" && response !== "deny") {
      return fail('response must be "allow" or "deny".')
    }
    const state = this.deps.loadOrchestrator()
    const agent = state.agents.find((a) => a.id === agentId)
    if (!agent) return fail(`Unknown agent "${agentId}".`)
    const capability = permissionCapability(agent, state.local_node_id)
    if (capability.state !== "supported") return { ...fail(capability.reason!), code: capability.state }
    if (!agent.host_session_id) return fail(`Agent ${agent.name} has no live session.`)
    const runtime = this.runtimeForAgent(agent)
    const resumed = await runtime.resume(agent)
    if (!resumed.ok) return fail(resumed.message)
    if (!resumed.handle.permissionsRespond) return fail(`Runtime "${agent.runtime}" exposes no permission API.`)
    const result = await resumed.handle.permissionsRespond(permissionId, response)
    if (result.ok) {
      this.deps.feed.emit({
        type: "agent_status",
        message: `Permission ${permissionId} ${response}ed for ${agent.name} (operator).`,
        agent_id: agent.id,
      })
    }
    return result.ok ? pass(result.message) : fail(result.message)
  }

  /** Sentinel stamping (Reviewer item 3): REAL project id when available. */
  projectIdForChannel(): string {
    return this.deps.projectId() ?? "gui-local-project"
  }

  /**
   * POST /api/orchestrator/tasks/assign (M2, design §9b-3).
   *
   * Trust boundary (Review priority): the task body is UNTRUSTED content —
   * it rides the EXISTING message engine as review_request semantics sent
   * AS the operator session, framed identically to peer mail. The
   * orchestrator is just another channel participant, never a privileged
   * injection path: no new message type, no new delivery route, engine
   * invariants (dedup, rate limit, hops, framing) apply unchanged.
   */
  async assignTask(body: Record<string, unknown>): Promise<ApiResult> {
    const agentId = typeof body["agent_id"] === "string" ? body["agent_id"].trim() : ""
    if (!agentId) return fail("agent_id is required.")
    const task = body["task"] && typeof body["task"] === "object" ? (body["task"] as Record<string, unknown>) : null
    if (!task) return fail("task object is required ({ title, body, channel }).")
    const title = typeof task["title"] === "string" ? task["title"].trim() : ""
    const taskBody = typeof task["body"] === "string" ? task["body"].trim() : ""
    const channel = typeof task["channel"] === "string" ? task["channel"].trim() : ""
    if (!title) return fail("task.title is required.")
    if (!taskBody) return fail("task.body is required.")
    if (!channel) return fail("task.channel is required (the agent's channel).")
    if (title.length > 200) return fail("task.title must be 200 characters or fewer.")
    if (taskBody.length > 90_000)
      return fail("task.body must be 90,000 characters or fewer (engine 100k cap minus framing).")
    for (const key of ["dependencies", "acceptance_criteria", "ownership"] as const) {
      if (task[key] !== undefined && !stringList(task[key]))
        return fail(`task.${key} must be a bounded list of non-empty strings.`)
    }
    if (task["scope"] !== undefined && (typeof task["scope"] !== "string" || task["scope"].length > 4_000))
      return fail("task.scope must be 4,000 characters or fewer.")
    const maxReviewRounds = task["max_review_rounds"] ?? 3
    if (!Number.isInteger(maxReviewRounds) || Number(maxReviewRounds) < 1 || Number(maxReviewRounds) > 20)
      return fail("task.max_review_rounds must be an integer from 1 to 20.")
    const requestId = body["request_id"] ?? null
    if (requestId !== null && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)))
      return fail("request_id must contain 1–128 letters, digits, underscores or hyphens.")
    const metadata = {
      agent_id: agentId,
      title,
      body: taskBody,
      channel,
      scope: (task["scope"] as string | undefined) ?? taskBody.slice(0, 4_000),
      dependencies: [...new Set((task["dependencies"] as string[] | undefined) ?? [])],
      acceptance_criteria: [...new Set((task["acceptance_criteria"] as string[] | undefined) ?? [])],
      ownership: [...new Set((task["ownership"] as string[] | undefined) ?? [])],
      max_review_rounds: Number(maxReviewRounds),
    }
    const requestFingerprint = createHash("sha256").update(JSON.stringify(metadata)).digest("hex")
    if (containsCredential(metadata, this.deps.servePassword()))
      return fail("Task content must not contain the coordinator credential; remove it before assigning work.")

    const state = this.deps.loadOrchestrator()
    if (requestId !== null) {
      if (state.tasks?.some((t) => t.reassignments?.some((r) => r.request_id === requestId)))
        return fail("request_id was already used for a task handoff; use a distinct assignment operation id.")
      const previous = taskViews(state.tasks ?? [], this.deps.loadChannelEngineState().messages, state.agents).find(
        (t) => t.request_id === requestId,
      )
      if (previous) {
        if (previous.request_fingerprint !== requestFingerprint)
          return fail("request_id was already used for a different assignment.")
        if (previous.dispatch_state === "dispatching" && previous.message_id === null)
          return fail(
            `Task ${previous.task_id} has an uncertain dispatch outcome; inspect its messages before creating another assignment.`,
          )
        if (previous.dispatch_state === "failed")
          return fail(`Task ${previous.task_id} assignment failed: ${previous.blocker}`)
        return pass(`Task ${previous.task_id} already assigned; no duplicate message sent.`, {
          task_id: previous.task_id,
          task: previous,
          replayed: true,
        })
      }
    }
    const agent = state.agents.find((a) => a.id === agentId)
    if (!agent) return fail(`Unknown agent "${agentId}".`)
    // M4 §9c-6 / condition C: a task to an agent on a REMOTE node passes
    // the server-side grant check BEFORE any dispatch.
    const agentNode = state.nodes.find((n) => n.id === agent.node_id)
    if (agentNode && agentNode.kind === "remote") {
      const grantCheck = assertRemoteActionAllowed(
        state,
        { node_id: agentNode.id, action: "tasks" },
        { ca: this.ca(), projectDir: this.deps.projectDir },
      )
      if (!grantCheck.ok) {
        await this.deps.withLock(() => {
          const fresh = this.deps.loadOrchestrator()
          pushEvent(fresh, {
            kind: "orchestration",
            type: "trust_denied",
            message: `Remote task assignment denied for node ${agentNode.id}: ${grantCheck.reason}`,
            agent_id: agent.id,
            node_id: agentNode.id,
            task_id: null,
          })
          this.deps.saveOrchestrator(fresh)
          return 0
        })
        return { ok: false, message: `Remote task assignment denied (${grantCheck.reason}).` }
      }
    }
    if (agent.status !== "running" && agent.status !== "idle") {
      return fail(`Agent ${agent.name} is ${agent.status}; only running/idle agents can be assigned tasks.`)
    }
    if (agent.host_session_id === null) {
      return fail(`Agent ${agent.name} has no live session (not spawned or stopped).`)
    }

    // Journal the operation BEFORE the side effect. An interrupted dispatch
    // stays visibly uncertain; an idempotency key never blindly repeats it.
    const assigned = await this.deps.withLock(() => {
      const fresh = this.deps.loadOrchestrator()
      const channelState = this.deps.loadChannelEngineState()
      fresh.tasks = taskViews(fresh.tasks ?? [], channelState.messages, fresh.agents)
      if (requestId !== null && fresh.tasks.some((t) => t.reassignments?.some((r) => r.request_id === requestId)))
        return fail("request_id was already used for a task handoff; use a distinct assignment operation id.")
      const previous = requestId === null ? undefined : fresh.tasks.find((t) => t.request_id === requestId)
      if (previous) {
        if (previous.request_fingerprint !== requestFingerprint)
          return fail("request_id was already used for a different assignment.")
        if (previous.dispatch_state === "dispatching" && previous.message_id === null)
          return fail(
            `Task ${previous.task_id} has an uncertain dispatch outcome; inspect its messages before creating another assignment.`,
          )
        if (previous.dispatch_state === "failed")
          return fail(`Task ${previous.task_id} assignment failed: ${previous.blocker}`)
        return pass(`Task ${previous.task_id} already assigned; no duplicate message sent.`, {
          task_id: previous.task_id,
          task: previous,
          replayed: true,
        })
      }
      if (fresh.tasks.length >= MAX_TASKS)
        return fail(`Task limit reached (${MAX_TASKS}); retain existing task evidence before creating further work.`)
      const currentAgent = fresh.agents.find((a) => a.id === agentId)
      if (!currentAgent || !["running", "idle"].includes(currentAgent.status) || currentAgent.host_session_id === null)
        return fail("Agent changed or disconnected; reload and reconnect before assigning work.")
      const currentNode = fresh.nodes.find((n) => n.id === currentAgent.node_id)
      if (!currentNode) return fail("Agent node is unavailable; reconnect before assigning work.")
      if (currentNode.kind === "remote") {
        const allowed = assertRemoteActionAllowed(
          fresh,
          { node_id: currentNode.id, action: "tasks" },
          { ca: this.ca(), projectDir: this.deps.projectDir },
        )
        if (!allowed.ok) return fail(`Remote task assignment denied (${allowed.reason}).`)
      }
      const now = Date.now()
      const taskRecord: TaskRecord = {
        ...metadata,
        task_id: newTaskId(),
        owner: agentId,
        recipient_session_id: currentAgent.host_session_id,
        ownership_mode: "advisory",
        execution_state: "ready",
        delivery_state: "unknown",
        acknowledged_at: null,
        dispatch_state: "dispatching",
        blocker: null,
        message_id: null,
        related_message_ids: [],
        artifacts: [],
        evidence: [],
        review: null,
        review_rounds: 0,
        assigned_at: now,
        updated_at: now,
        revision: 1,
        request_id: requestId as string | null,
        request_fingerprint: requestFingerprint,
        legacy: false,
      }
      const blockers = dependencyBlockers(taskRecord, fresh.tasks)
      if (blockers.length)
        return fail(`Dependencies must be verified complete before assignment: ${blockers.join(", ")}.`)
      const conflicts = ownershipConflicts(taskRecord.ownership, fresh.tasks)
      if (conflicts.length && task["allow_ownership_conflict"] !== true)
        return fail(
          `Advisory ownership overlaps active tasks ${conflicts.join(", ")}; review the overlap and explicitly set allow_ownership_conflict to continue.`,
        )
      fresh.tasks.push(taskRecord)
      this.deps.saveOrchestrator(fresh)
      try {
        const criteria = taskRecord.acceptance_criteria.length
          ? `\n\nAcceptance criteria:\n${taskRecord.acceptance_criteria.map((c) => `- ${c}`).join("\n")}`
          : ""
        const composed = `${title}\n\n${taskBody}${criteria}\n\n[task ${taskRecord.task_id}]`
        const result = this.deps.engineSend(
          channelState,
          {
            channel,
            content: composed,
            message_type: "review_request",
            to: currentAgent.host_session_id,
          },
          `operator-${currentAgent.node_id}`,
        )
        if (!result.ok) {
          taskRecord.dispatch_state = "failed"
          taskRecord.delivery_state = "failed"
          taskRecord.execution_state = "failed"
          taskRecord.blocker = redactValue(result.message, [this.deps.servePassword()])
          this.deps.saveOrchestrator(fresh)
          return fail(`${result.message} (task ${taskRecord.task_id})`)
        }
        this.deps.saveChannelEngineState(channelState)
        taskRecord.dispatch_state = "sent"
        taskRecord.execution_state = "assigned"
        taskRecord.delivery_state = "queued"
        fresh.tasks = taskViews(fresh.tasks, this.deps.loadChannelEngineState().messages, fresh.agents)
        this.deps.saveOrchestrator(fresh)
        return pass(`Task ${taskRecord.task_id} assigned to ${currentAgent.name}.`, {
          task_id: taskRecord.task_id,
          agent_id: currentAgent.id,
          channel,
          task: fresh.tasks.find((t) => t.task_id === taskRecord.task_id),
          ownership_conflicts: conflicts,
        })
      } catch {
        return fail(
          `Task ${taskRecord.task_id} dispatch outcome is uncertain; inspect queued messages before retrying. Use the same request_id to avoid duplicate work.`,
        )
      }
    })
    if (!assigned.ok || (assigned.data as { replayed?: boolean } | undefined)?.replayed) return assigned
    const taskId = (assigned.data as { task_id: string }).task_id
    this.deps.feed.emit({
      type: "task_assigned",
      message: `Task ${taskId} (${title}) assigned to ${agent.name} via channel ${channel}.`,
      agent_id: agent.id,
      task_id: taskId,
      kind: "channel_notice",
    })
    return assigned
  }

  /**
   * Delivery is derived from envelopes; execution comes ONLY from durable
   * backend transitions. Legacy replies never imply successful execution.
   */
  listTasks(): ApiResult {
    const state = this.deps.loadOrchestrator()
    const engineState = this.deps.loadChannelEngineState()
    const tasks = taskViews(state.tasks ?? [], engineState.messages, state.agents).map((t) => ({
      ...t,
      // Backward compatible delivery alias; clients must label it Delivery.
      status: t.delivery_state === "acknowledged" ? "acked" : t.delivery_state,
      dependency_blockers: dependencyBlockers(t, state.tasks ?? []),
      ownership_conflicts: ownershipConflicts(t.ownership, state.tasks ?? [], t.task_id),
    }))
    return pass("ok", { tasks })
  }

  getTask(taskId: string): ApiResult {
    const listed = this.listTasks().data as { tasks: TaskRecord[] }
    const task = listed.tasks.find((t) => t.task_id === taskId)
    if (!task) return fail(`Unknown task "${taskId}".`)
    const messages = this.deps.loadChannelEngineState().messages
    return pass("ok", { task, messages: task.related_message_ids.map((id) => messages[id]).filter(Boolean) })
  }

  async transitionTask(taskId: string, body: Record<string, unknown>): Promise<ApiResult> {
    if (containsCredential(body, this.deps.servePassword()))
      return fail("Task reports must not contain the coordinator credential; remove it before recording evidence.")
    const result = await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      state.tasks = taskViews(state.tasks ?? [], this.deps.loadChannelEngineState().messages, state.agents)
      if (state.tasks.length > MAX_TASKS)
        return fail(
          `Task limit reached (${MAX_TASKS}); existing task evidence is retained, but additional legacy records cannot be persisted.`,
        )
      const task = state.tasks.find((t) => t.task_id === taskId)
      if (!task) return fail(`Unknown task "${taskId}".`)
      if (task.reassignments?.some((r) => r.dispatch_state === "dispatching"))
        return fail("Task handoff outcome is uncertain; inspect its delivery before updating execution.")
      const error = transitionTaskRecord(task, body, state.tasks)
      if (error) return fail(`${error} (task ${taskId})`)
      this.deps.saveOrchestrator(state)
      return pass(`Task ${taskId} is ${task.execution_state}.`, { task })
    })
    if (result.ok) this.deps.feed.emit({ type: "task_execution_changed", message: result.message, task_id: taskId })
    return result
  }

  /** Explicit operator handoff. No automatic fallback, worker replacement, or replay of uncertain delivery. */
  async reassignTask(taskId: string, body: Record<string, unknown>): Promise<ApiResult> {
    if (body["actor_id"] !== "operator") return fail("Only the local operator can reassign a task.")
    const agentId = typeof body["agent_id"] === "string" ? body["agent_id"].trim() : ""
    const requestId = typeof body["request_id"] === "string" ? body["request_id"] : ""
    const reason = typeof body["reason"] === "string" ? body["reason"].trim() : ""
    if (!agentId || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) || !reason || reason.length > 4_000)
      return fail(
        "Reassignment requires agent_id, request_id (1–128 identifier characters), expected_revision, and an actionable reason (1–4,000 characters).",
      )
    if (
      body["channel"] !== undefined &&
      (typeof body["channel"] !== "string" || !body["channel"].trim() || body["channel"].length > 200)
    )
      return fail("channel must name an existing linked channel.")
    if (containsCredential(body, this.deps.servePassword()))
      return fail("Task handoffs must not contain coordinator credentials.")
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          task_id: taskId,
          agent_id: agentId,
          channel: body["channel"] ?? null,
          expected_revision: body["expected_revision"],
          reason,
          handoff_confirmed: body["handoff_confirmed"] === true,
          allow_ownership_conflict: body["allow_ownership_conflict"] === true,
        }),
      )
      .digest("hex")
    const result = await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      const engine = this.deps.loadChannelEngineState()
      state.tasks = taskViews(state.tasks ?? [], engine.messages, state.agents)
      if (state.tasks.length > MAX_TASKS)
        return fail(
          `Task limit reached (${MAX_TASKS}); retain existing history before persisting additional legacy tasks.`,
        )
      const task = state.tasks.find((t) => t.task_id === taskId)
      if (!task) return fail(`Unknown task "${taskId}".`)
      for (const existing of state.tasks) {
        const previous = existing.reassignments?.find((r) => r.request_id === requestId)
        if (previous) {
          if (existing.task_id !== taskId || previous.request_fingerprint !== fingerprint)
            return fail("request_id was already used for a different handoff.")
          if (previous.dispatch_state === "dispatching")
            return fail(`Task ${taskId} handoff outcome is uncertain; inspect host messages before replay.`)
          if (previous.dispatch_state === "failed") return fail(`Task ${taskId} handoff failed: ${previous.blocker}`)
          return pass("Task handoff already recorded; no duplicate work sent.", {
            task: existing,
            reassignment: previous,
            replayed: true,
          })
        }
        if (existing.request_id === requestId)
          return fail("request_id was already used for a task assignment; use a distinct handoff operation id.")
      }
      if (body["expected_revision"] !== task.revision)
        return fail(`Task changed; reload revision ${task.revision} before reassigning.`)
      if (task.reassignments?.some((r) => r.dispatch_state === "dispatching"))
        return fail("Prior handoff outcome is uncertain; inspect delivery before issuing another handoff.")
      if (!["assigned", "blocked", "review"].includes(task.execution_state))
        return fail(
          `Task ${taskId} is ${task.execution_state}; hand off only assigned, blocked, or review work after stopping active execution.`,
        )
      if ((task.reassignments?.length ?? 0) >= MAX_TASK_REASSIGNMENTS)
        return fail(
          `Task handoff limit reached (${MAX_TASK_REASSIGNMENTS}); preserve this history and scope follow-up work.`,
        )
      if (task.owner === agentId) return fail("Task is already owned by this agent.")
      if (
        task.delivery_state === "in_flight" ||
        task.related_message_ids.some((id) => engine.messages[id]?.delivery_status === "in_flight")
      )
        return fail("Host acceptance is uncertain for in-flight work; reconcile that delivery before reassigning.")
      if (
        (task.execution_state !== "assigned" || !["queued", "failed", "stale"].includes(task.delivery_state)) &&
        body["handoff_confirmed"] !== true
      )
        return fail(
          "Confirm the previous owner has stopped this work with handoff_confirmed before transferring a received assignment.",
        )
      const agent = state.agents.find((a) => a.id === agentId)
      if (!agent || !["running", "idle"].includes(agent.status) || !agent.host_session_id)
        return fail("Choose a running or idle agent with a live linked host session.")
      const node = state.nodes.find((n) => n.id === agent.node_id)
      if (!node) return fail("Destination agent node is unavailable.")
      if (node.kind === "remote") {
        const allowed = assertRemoteActionAllowed(
          state,
          { node_id: node.id, action: "tasks" },
          { ca: this.ca(), projectDir: this.deps.projectDir },
        )
        if (!allowed.ok) return fail(`Remote task handoff denied (${allowed.reason}).`)
      }
      const blockers = dependencyBlockers(task, state.tasks)
      if (blockers.length) return fail(`Dependencies must be verified complete before handoff: ${blockers.join(", ")}.`)
      const conflicts = ownershipConflicts(task.ownership, state.tasks, taskId)
      if (conflicts.length && body["allow_ownership_conflict"] !== true)
        return fail(
          `Advisory ownership overlaps ${conflicts.join(", ")}; review it and explicitly set allow_ownership_conflict to continue.`,
        )
      const channel = typeof body["channel"] === "string" ? body["channel"].trim() : task.channel
      const now = Date.now()
      const handoff: TaskReassignment = {
        request_id: requestId,
        request_fingerprint: fingerprint,
        from_owner: task.owner,
        from_recipient_session_id: task.recipient_session_id,
        from_channel: task.channel,
        from_message_id: task.message_id,
        from_execution_state: task.execution_state,
        from_review: structuredClone(task.review),
        from_blocker: task.blocker,
        to_owner: agentId,
        to_recipient_session_id: agent.host_session_id,
        to_channel: channel,
        reason,
        handoff_confirmed: body["handoff_confirmed"] === true,
        at: now,
        dispatch_state: "dispatching",
        message_id: null,
        blocker: null,
      }
      task.reassignments ??= []
      task.reassignments.push(handoff)
      this.deps.saveOrchestrator(state)
      try {
        const beforeIds = new Set(Object.keys(engine.messages))
        const criteria = task.acceptance_criteria.length
          ? `\n\nAcceptance criteria:\n${task.acceptance_criteria.map((c) => `- ${c}`).join("\n")}`
          : ""
        const content = `${task.title}\n\n${task.body}${criteria}\n\nOperator handoff from ${task.owner ?? "unknown"} to ${agent.id}: ${reason}\nOperation: ${requestId}\nRead prior evidence, ownership, and context using task_get(${taskId}) and project_context.\n\n[task ${taskId}]`
        const sent = this.deps.engineSend(
          engine,
          { channel, content, message_type: "review_request", to: agent.host_session_id },
          `operator-${agent.node_id}`,
        )
        if (!sent.ok) {
          handoff.dispatch_state = "failed"
          handoff.blocker = redactValue(sent.message, [this.deps.servePassword()])
          this.deps.saveOrchestrator(state)
          return fail(`Handoff refused: ${handoff.blocker}. Previous ownership retained.`)
        }
        const message = Object.values(engine.messages).find(
          (m) => !beforeIds.has(m.message_id) && m.recipient_session_id === agent.host_session_id,
        )
        if (!message)
          return fail(
            `Task ${taskId} handoff outcome is uncertain; no envelope identity was returned. Inspect messages before retrying.`,
          )
        handoff.message_id = message.message_id
        task.agent_id = agentId
        task.owner = agentId
        task.recipient_session_id = agent.host_session_id
        task.channel = channel
        task.message_id = message.message_id
        task.related_message_ids = [...new Set([...task.related_message_ids, message.message_id])].slice(-256)
        task.execution_state = "ready"
        task.delivery_state = "unknown"
        task.acknowledged_at = null
        task.dispatch_state = "dispatching"
        task.blocker = "Handoff dispatch pending; inspect delivery if this operation is interrupted."
        task.review = null
        task.revision += 1
        task.updated_at = now
        this.deps.saveOrchestrator(state)
        // Queue cancellation and new dispatch commit atomically in the same
        // engine save. Prior envelopes remain inspectable in task history.
        if (handoff.from_message_id && engine.messages[handoff.from_message_id]?.delivery_status === "pending") {
          engine.messages[handoff.from_message_id]!.delivery_status = "rejected"
          if (engine.queues)
            engine.queues[handoff.from_recipient_session_id] = (
              engine.queues[handoff.from_recipient_session_id] ?? []
            ).filter((id) => id !== handoff.from_message_id)
        }
        this.deps.saveChannelEngineState(engine)
        handoff.dispatch_state = "sent"
        task.dispatch_state = "sent"
        task.execution_state = "assigned"
        task.delivery_state = "queued"
        task.blocker = null
        this.deps.saveOrchestrator(state)
        return pass(`Task ${taskId} handed to ${agent.name}; existing ownership and evidence retained.`, {
          task,
          reassignment: handoff,
          ownership_conflicts: conflicts,
        })
      } catch {
        return fail(
          `Task ${taskId} handoff outcome is uncertain; inspect task messages before retrying with the same request_id.`,
        )
      }
    })
    if (result.ok && !(result.data as { replayed?: boolean } | undefined)?.replayed)
      this.deps.feed.emit({ type: "task_reassigned", message: result.message, task_id: taskId, agent_id: agentId })
    return result
  }

  listContext(query = ""): ApiResult {
    const q = query.trim().toLowerCase().slice(0, 200)
    const records = (this.deps.loadOrchestrator().project_context ?? []).filter(
      (r) => !q || `${r.title} ${r.body} ${r.kind} ${r.status}`.toLowerCase().includes(q),
    )
    return pass("ok", { records, project: this.deps.projectDir })
  }

  /** Saved intent does not claim host availability or authorize launching agents. */
  listTeamTemplates(): ApiResult {
    return pass("ok", { templates: this.deps.loadOrchestrator().team_templates ?? [] })
  }

  async saveTeamTemplate(body: Record<string, unknown>): Promise<ApiResult> {
    if (containsCredential(body, this.deps.servePassword()))
      return fail("Team templates must not contain coordinator credentials.")
    const id = body["id"] ?? newTeamTemplateId()
    const now = Date.now()
    const candidate: unknown = {
      id,
      revision: 1,
      name: body["name"],
      description: body["description"] ?? "",
      entries: body["entries"],
      budgets: body["budgets"],
      created_at: now,
      updated_at: now,
    }
    if (!validTeamTemplate(candidate))
      return fail(
        "Template requires a name, 1–8 unique roles/entry ids, bounded prompts, host/runtime, model pin or null, capability requirements, and valid budgets.",
      )
    const result = await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      state.team_templates ??= []
      const previous = state.team_templates.find((t) => t.id === id)
      if (body["id"] !== undefined && !previous)
        return fail(`Unknown team template "${String(id)}"; save without id to create a template.`)
      if (previous && body["expected_revision"] !== previous.revision)
        return fail(`Template changed; reload revision ${previous.revision} before saving.`)
      if (!previous && state.team_templates.length >= MAX_TEAM_TEMPLATES)
        return fail(`Team template limit reached (${MAX_TEAM_TEMPLATES}).`)
      const template: TeamTemplate = {
        ...candidate,
        revision: previous ? previous.revision + 1 : 1,
        created_at: previous?.created_at ?? now,
      }
      state.team_templates = previous
        ? state.team_templates.map((t) => (t.id === id ? template : t))
        : [...state.team_templates, template]
      this.deps.saveOrchestrator(state)
      return pass("Team template saved. Select link or launch explicitly for each entry when applying it.", {
        template,
      })
    })
    if (result.ok)
      this.deps.feed.emit({ type: "team_template_changed", message: "Team template saved; no sessions launched." })
    return result
  }

  async deleteTeamTemplate(templateId: string, body: Record<string, unknown>): Promise<ApiResult> {
    const result = await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      const template = state.team_templates?.find((t) => t.id === templateId)
      if (!template) return fail(`Unknown team template "${templateId}".`)
      if (body["expected_revision"] !== template.revision)
        return fail(`Template changed; reload revision ${template.revision} before deleting.`)
      state.team_templates = state.team_templates.filter((t) => t.id !== templateId)
      this.deps.saveOrchestrator(state)
      return pass("Saved team template deleted. Existing sessions and tasks remain available.")
    })
    if (result.ok) this.deps.feed.emit({ type: "team_template_changed", message: "Saved team template deleted." })
    return result
  }

  async addContext(body: Record<string, unknown>): Promise<ApiResult> {
    if (containsCredential(body, this.deps.servePassword()))
      return fail("Project context must not contain the coordinator credential.")
    const entry: unknown = { ...body, id: newContextId(), created_at: Date.now(), references: body["references"] ?? [] }
    if (!validContext(entry))
      return fail(
        "Context requires a supported kind/status, title, body and bounded references; verified findings require evidence references.",
      )
    const result = await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      state.project_context ??= []
      if (state.project_context.length >= MAX_CONTEXT_RECORDS)
        return fail(`Project context limit reached (${MAX_CONTEXT_RECORDS}).`)
      state.project_context.push(entry as ProjectContextRecord)
      this.deps.saveOrchestrator(state)
      return pass("Project context recorded.", { record: entry })
    })
    if (result.ok) this.deps.feed.emit({ type: "project_context_changed", message: "Project context recorded." })
    return result
  }

  contextHandoff(): ApiResult {
    const state = this.deps.loadOrchestrator()
    const tasks = taskViews(state.tasks ?? [], this.deps.loadChannelEngineState().messages, state.agents)
    return pass("ok", {
      project: this.deps.projectDir,
      context: (state.project_context ?? []).slice(-12).map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        title: r.title,
        summary: r.body.slice(0, 320),
        references: r.references.slice(0, 4),
      })),
      active_tasks: tasks
        .filter((t) => !["verified_complete", "failed", "cancelled"].includes(t.execution_state))
        .slice(0, 12)
        .map((t) => ({
          task_id: t.task_id,
          title: t.title,
          owner: t.owner,
          execution_state: t.execution_state,
          blocker: t.blocker,
        })),
      detail_routes: { context: "/api/orchestrator/context", tasks: "/api/orchestrator/tasks" },
    })
  }
}

/** Task ids mirror the agt_/node_ pattern (crypto randomBytes, Reviewer P3). */
export function newTaskId(): string {
  return `tsk_${randomBytes(12).toString("hex")}`
}

export function agentSpawnCmdRedacted(state: OrchestratorState): string {
  void state
  return resolveOpencodeBinary()
}

export function localNode(state: OrchestratorState): NodeRecord | null {
  return state.nodes.find((n) => n.id === state.local_node_id) ?? null
}

export function validateForTests(parsed: unknown): { ok: boolean; reason?: string } {
  const result = validateOrchestratorState(parsed)
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}

export type { AgentRecord, NodeRecord, OrchestratorState, OrchestrationEvent }
