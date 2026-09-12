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
import {
  localNodeIdFor,
  newAgentId,
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

/** Envelope contract v0.0: { ok: true, data } / { ok: false, message }. */
export interface ApiResult {
  ok: boolean
  message: string
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
    input: { channel: string; content: string; message_type: "review_request" },
    senderSessionId: string,
  ) => { ok: boolean; message: string }
  saveChannelEngineState: (state: unknown) => void
}

/** Validation failure shape (contract §6: 400/403/404/409/500). */
const fail = (message: string): ApiResult => ({ ok: false, message })
const pass = <T>(message: string, data?: T): ApiResult => ({ ok: true, message, data })

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

/**
 * Create a per-agent worktree dir (skip cleanly when it already exists —
 * reconcile path from design §7.3). Git worktree ADD is the operator's /
 * runtime's later step; M1 creates the directory scaffolding and records it.
 */
function ensureAgentWorktree(projectDir: string, agentId: string): string {
  const dir = join(projectDir, ".opencomms", "agents", agentId, "worktree")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
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

  /** GET /api/orchestrator/nodes/{id}/runtimes — local node only in M1. */
  async listRuntimes(nodeId: string): Promise<ApiResult> {
    const state = this.deps.loadOrchestrator()
    const node = state.nodes.find((n) => n.id === nodeId)
    if (!node) return fail(`Unknown node "${nodeId}".`)
    if (node.kind !== "local") {
      return fail("Remote-node runtime listing lands with M3 (nodes are opt-in and never assumed).")
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
    return pass("ok", [{ runtime: "opencode", providers }])
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
        node_id: a.node_id,
        designated: a.designated ?? null,
        channel_ids: a.channel_ids,
        last_heartbeat: a.last_heartbeat,
        spawn_cmd_redacted: redactValue(a.spawn_cmd_redacted, secrets),
        worktree: a.worktree,
        model: a.model,
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
    const role = typeof body["role"] === "string" ? body["role"].trim() : ""
    const rolePrompt = typeof body["role_prompt"] === "string" ? body["role_prompt"].trim() : ""
    if (!name) return fail("Agent name is required.")
    if (!role) return fail("Role is required.")
    if (!/^[A-Za-z][A-Za-z0-9 _-]{0,31}$/.test(role)) {
      return fail('Role must be 1-32 characters: letters first, then letters, digits, spaces, "-" or "_".')
    }
    if (!rolePrompt) return fail("A role prompt is required.")
    const runtimeId = typeof body["host"] === "string" ? body["host"].toLowerCase() : "opencode"
    if (runtimeId !== "opencode") {
      return fail(`Runtime "${runtimeId}" is not available on this node yet. M1 supports: opencode.`)
    }
    const designated = body["designated"] === "lead" ? ("lead" as const) : null
    const node = state0.nodes.find(
      (n) => n.id === (typeof body["node_id"] === "string" ? body["node_id"] : state0.local_node_id),
    )
    if (!node || node.kind !== "local") {
      return fail("M1 spawns on the local node only; remote nodes are explicit opt-in (M3).")
    }
    // Contract v0.3 §9: exactly ONE designated lead per project, immutable.
    const existingLead = designatedLead(state0)
    if (designated === "lead" && existingLead) {
      return {
        ok: false,
        message: `A designated Lead already exists (${existingLead.id}); exactly one agent per project may hold designated:"lead".`,
      }
    }
    // Model pinning is binding (M0 spike evidence): invalid/missing pins are
    // rejected unless the operator explicitly relies on the configured serve
    // model (OPENCOMMS_ORCH_SERVE_MODEL), which detect() has verified.
    const requestedModel = typeof body["model"] === "string" ? body["model"].trim() : undefined
    const configuredModel = this.deps.serveModel()
    if (requestedModel && !parseModelPin(requestedModel)) {
      return fail('Model must be "provider/model".')
    }
    if (!requestedModel && !configuredModel) {
      return fail(
        'A verified model pin is required (spike rule: server defaults fail or hang). Configure the orchestrator serve model or pass model="provider/model".',
      )
    }
    const resolvedModel = requestedModel ?? configuredModel ?? null
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

    const spawnedId = await this.deps.withLock(() => {
      const state = this.deps.loadOrchestrator()
      if (state.agents.length >= 64) return { ok: false as const, message: "Agent cap reached (64) for this project." }
      if (designated === "lead" && designatedLead(state)) {
        return { ok: false as const, message: "A designated Lead already exists; exactly one per project." }
      }
      const id = newAgentId()
      const worktree = ensureAgentWorktree(this.deps.projectDir, id)
      const spawnRedacted = `${resolveOpencodeBinary()} serve --port <orchestrator> --hostname 127.0.0.1 (password via env only)`
      const record: AgentRecord = {
        id,
        name,
        host: "opencode",
        role,
        role_prompt: rolePrompt,
        runtime: "opencode",
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
      }
      state.agents.push(record)
      this.deps.saveOrchestrator(state)
      return { ok: true as const, id }
    })
    if (!spawnedId.ok) return fail(spawnedId.message)
    // Real runtime spawn AFTER the record is durably "starting" (crash-safe:
    // a lost spawn leaves a stale row the reconcile path marks honestly).
    const runtime = this.deps.createRuntime
      ? this.deps.createRuntime()
      : createOpencodeRuntime({
          projectDir: this.deps.projectDir,
          port: this.deps.servePort(),
          env: {
            ...process.env,
            OPENCOMMS_ORCH_SERVE_PASSWORD: this.deps.servePassword(),
            OPENCOMMS_ORCH_SERVE_MODEL: resolvedModel ?? "",
          },
        })
    const spawned = await runtime.create({
      agent_id: spawnedId.id,
      name,
      role,
      role_prompt: rolePrompt,
      worktree: agentWorktreeDir(this.deps.projectDir, spawnedId.id),
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
      worktree: agentWorktreeDir(this.deps.projectDir, spawnedId.id),
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
    const runtime = this.deps.createRuntime
      ? this.deps.createRuntime()
      : createOpencodeRuntime({
          projectDir: this.deps.projectDir,
          port: this.deps.servePort(),
          env: {
            ...process.env,
            OPENCOMMS_ORCH_SERVE_PASSWORD: this.deps.servePassword(),
            OPENCOMMS_ORCH_SERVE_MODEL: agent.model ?? "",
          },
        })
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
        if (force) {
          await resumed.handle.abort()
          stopDetail = "forced: abort issued, marked stopped immediately"
        } else {
          await resumed.handle.stop()
          stopDetail = "graceful: turn aborted + session stopped"
        }
      } else {
        stopDetail = `resume failed (${resumed.message}); marking stopped from record state`
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
    const runtime = this.deps.createRuntime
      ? this.deps.createRuntime()
      : createOpencodeRuntime({
          projectDir: this.deps.projectDir,
          port: this.deps.servePort(),
          env: {
            ...process.env,
            OPENCOMMS_ORCH_SERVE_PASSWORD: this.deps.servePassword(),
            OPENCOMMS_ORCH_SERVE_MODEL: agent.model ?? "",
          },
        })
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
    // Resume failed → re-create from the PERSISTED spawn fields and persist
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
        if (!state.trust.approved_node_ids.includes(nodeId)) state.trust.approved_node_ids.push(nodeId)
        state.trust.pending_pairing_requests = state.trust.pending_pairing_requests.filter((r) => r.node_id !== nodeId)
      } else {
        target.status = "offline"
        target.approved_at = null
        target.approved_by = null
        state.trust.approved_node_ids = state.trust.approved_node_ids.filter((id) => id !== nodeId)
        for (const agent of state.agents) {
          if (agent.node_id === nodeId) agent.status = "failed"
        }
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
    if (!agent.host_session_id) return fail(`Agent ${agent.name} has no live session.`)
    const runtime = this.deps.createRuntime
      ? this.deps.createRuntime()
      : createOpencodeRuntime({
          projectDir: this.deps.projectDir,
          port: this.deps.servePort(),
          env: {
            ...process.env,
            OPENCOMMS_ORCH_SERVE_PASSWORD: this.deps.servePassword(),
            OPENCOMMS_ORCH_SERVE_MODEL: agent.model ?? "",
          },
        })
    const resumed = await runtime.resume(agent)
    if (!resumed.ok) return fail(resumed.message)
    if (!resumed.handle.permissionsDrain) return fail(`Runtime "${agent.runtime}" exposes no permission API.`)
    const pending = await resumed.handle.permissionsDrain()
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
    if (!agent.host_session_id) return fail(`Agent ${agent.name} has no live session.`)
    const runtime = this.deps.createRuntime
      ? this.deps.createRuntime()
      : createOpencodeRuntime({
          projectDir: this.deps.projectDir,
          port: this.deps.servePort(),
          env: {
            ...process.env,
            OPENCOMMS_ORCH_SERVE_PASSWORD: this.deps.servePassword(),
            OPENCOMMS_ORCH_SERVE_MODEL: agent.model ?? "",
          },
        })
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

    const state = this.deps.loadOrchestrator()
    const agent = state.agents.find((a) => a.id === agentId)
    if (!agent) return fail(`Unknown agent "${agentId}".`)
    if (agent.status !== "running" && agent.status !== "idle") {
      return fail(`Agent ${agent.name} is ${agent.status}; only running/idle agents can be assigned tasks.`)
    }
    if (agent.host_session_id === null) {
      return fail(`Agent ${agent.name} has no live session (not spawned or stopped).`)
    }

    // Send via the engine under the channel-state lock (same mutation path
    // as any other operator send; the task id travels in the correlation).
    const taskId = newTaskId()
    const operatorSessionId = `operator-${agent.node_id}`
    const sent = await this.deps.withLock(() => {
      const channelState = this.deps.loadChannelEngineState()
      const composed = `${title}\n\n${taskBody}\n\n[task ${taskId}]`
      const result = this.deps.engineSend(
        channelState,
        {
          channel,
          content: composed,
          message_type: "review_request",
        },
        operatorSessionId,
      )
      if (!result.ok) return result
      this.deps.saveChannelEngineState(channelState)
      return result
    })
    if (!sent.ok) return fail(sent.message)
    this.deps.feed.emit({
      type: "task_assigned",
      message: `Task ${taskId} (${title}) assigned to ${agent.name} via channel ${channel}.`,
      agent_id: agent.id,
      task_id: taskId,
      kind: "channel_notice",
    })
    return pass(`Task ${taskId} assigned to ${agent.name}.`, { task_id: taskId, agent_id: agent.id, channel })
  }

  /**
   * GET /api/orchestrator/tasks — honest derivation from channel state
   * (design §9b-3): tasks are envelopes with `[task tsk_*]` markers; acked =
   * the agent replied in the same correlation chain; delivered = handed to
   * the host; queued = pending. No separate task store in M2.
   */
  listTasks(): ApiResult {
    const engineState = this.deps.loadChannelEngineState()
    const tasks: Array<{
      task_id: string
      agent_id: string | null
      channel: string
      title: string
      status: "queued" | "delivered" | "acked"
      message_id: string
      assigned_at: number
    }> = []
    for (const msg of Object.values(engineState.messages)) {
      if (msg.message_type !== "review_request") continue
      const match = /\[task (tsk_[0-9a-f]{24})\]\s*$/.exec(msg.content)
      if (!match) continue
      const taskId = match[1] as string
      const title = msg.content.split("\n")[0]?.slice(0, 200) ?? ""
      const agent = this.deps
        .loadOrchestrator()
        .agents.find((a) => a.host_session_id !== null && msg.recipient_session_id === a.host_session_id)
      // Acked = any later envelope in the SAME correlation chain authored by
      // the recipient (their reply), or an explicit review_response reply.
      const acked = Object.values(engineState.messages).some(
        (m) =>
          m.correlation_id === msg.correlation_id &&
          m.sender_session_id === msg.recipient_session_id &&
          (m.message_type === "review_response" || m.hop_count > 0),
      )
      tasks.push({
        task_id: taskId,
        agent_id: agent?.id ?? null,
        channel: msg.channel_id,
        title,
        status: acked ? "acked" : msg.delivery_status === "delivered" ? "delivered" : "queued",
        message_id: msg.message_id,
        assigned_at: msg.timestamp,
      })
    }
    tasks.sort((a, b) => b.assigned_at - a.assigned_at)
    return pass("ok", { tasks })
  }
}

/** Task ids mirror the agt_/node_ pattern. */
export function newTaskId(): string {
  const bytes = new Uint8Array(12)
  for (let i = 0; i < 12; i++) bytes[i] = Math.floor(Math.random() * 256)
  return `tsk_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
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
