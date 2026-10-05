/**
 * Project-local orchestrator.json is separate from channel state.
 * Writes atomically replace files under a shared cross-process lock; validation fails closed.
 * Agent ids are keys; host session ids are delivery attributes. The local node is implicit.
 * The owner token never appears in read APIs or agent-facing tools.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  copyFileSync,
  constants,
} from "node:fs"
import { join } from "node:path"
import { replaceStateFile } from "../core/atomic-file.js"
import { randomBytes, createHash } from "node:crypto"
import {
  TASK_SCHEMA_VERSION,
  MAX_TASKS,
  MAX_CONTEXT_RECORDS,
  validTask,
  validContext,
  type TaskRecord,
  type ProjectContextRecord,
} from "./tasks.js"
import {
  TEAM_TEMPLATE_SCHEMA_VERSION,
  MAX_TEAM_TEMPLATES,
  validTeamTemplate,
  type TeamTemplate,
} from "./team-templates.js"

export const ORCHESTRATOR_FILE = "orchestrator.json"
export const ORCHESTRATOR_SCHEMA_VERSION = 1
const ORCHESTRATOR_LOCK = ".orchestrator.lock"
/** Same lock discipline as the state store (src/core/store.ts). */
export const ORCH_LOCK_TIMEOUT_MS = 5_000
export const ORCH_LOCK_STALE_MS = 15_000

export const MAX_ORCHESTRATOR_EVENTS = 500

export const MAX_ORCHESTRATOR_AGENTS = 64

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function newAgentId(): string {
  return `agt_${randomBytes(12).toString("hex")}`
}
export function newNodeId(): string {
  return `node_${randomBytes(12).toString("hex")}`
}
/** Stable local-node id: derived from the worktree path (same dir = same id). */
export function localNodeIdFor(worktree: string): string {
  return `node_local_${createHash("sha256").update(worktree).digest("hex").slice(0, 16)}`
}

/** One-per-project random secret for owner-only approve/revoke calls. */
export function newConfirmToken(): string {
  return randomBytes(24).toString("base64url")
}

/**
 * Show the short-lived, one-time code to the owner; persist only its hash.
 * The alphabet omits ambiguous characters for out-of-band manual entry.
 */
export function newPairingCode(): { raw: string; hash: string } {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
  const bytes = randomBytes(8)
  let raw = ""
  for (const b of bytes) raw += alphabet[b % alphabet.length]
  return { raw, hash: createHash("sha256").update(raw).digest("hex") }
}

export const PAIRING_CODE_TTL_MS = 10 * 60_000

export type AgentRuntimeStatus = "starting" | "running" | "idle" | "stale" | "stopped" | "failed"

export type OrchestrationEventKind = "orchestration" | "channel_notice"

export interface OrchestrationEvent {
  seq: number
  at: number
  kind: OrchestrationEventKind
  type: string
  message: string
  agent_id: string | null
  node_id: string | null
  task_id: string | null
}

export interface NodeCapabilities {
  max_agents: number
  runtimes: string[]
  headless: boolean
}

export interface NodeRecord {
  id: string
  name: string
  kind: "local" | "remote"
  platform: string
  status: "online" | "offline" | "pending_approval"
  capabilities: NodeCapabilities
  approved_at: number | null
  approved_by: "owner" | null
  /** Operator-controlled restart; no automatic respawn. */
  restart_policy: "manual" | "auto"
  /** Pinned node public-key fingerprint. */
  fingerprint: string | null

  enrolled_at: number | null

  last_seen: number | null
  /** Persistent or ephemeral tier determines the credential window. */
  trust_tier: "persistent" | "ephemeral"
  /** Grants are checked for each action. */
  grants: string[]
  /** Renewal requires pairing-grade authentication. */
  credential_expires_at: number | null
}

export interface AgentRecord {
  id: string
  name: string
  host: string
  role: string
  role_prompt: string
  runtime: string
  node_id: string
  worktree: string
  status: AgentRuntimeStatus
  /** Bounded, redacted recovery detail from the latest managed observation. */
  status_detail?: string | null
  host_session_id: string | null
  spawn_cmd_redacted: string
  /** At most one immutable designated lead per project. */
  designated: "lead" | null
  channel_ids: string[]
  last_heartbeat: number | null
  created_at: number
  restart_count: number
  model: string | null
  /** Optional idempotency journal for explicitly managed creation. */
  operation_id?: string
  operation_fingerprint?: string
  required_capabilities?: string[]
}

export interface TrustState {
  /** Owner-only confirm token (approve/revoke). NEVER returned by read APIs. */
  owner_confirm_token: string
  approved_node_ids: string[]
  pending_pairing_requests: Array<{ node_id: string; requested_at: number }>
  /** Out-of-band, one-time codes; expiry prevents certificate issuance. */
  pairing_codes: Array<{ code_hash: string; node_name: string; expires_at: number; used_at: number | null }>
}

export interface OrchestratorState {
  orchestrator_schema_version: number
  local_node_id: string
  nodes: NodeRecord[]
  agents: AgentRecord[]
  events: OrchestrationEvent[]
  events_cursor: number
  serve: { port: number | null; password_redacted: boolean }
  trust: TrustState
  /** Additive versioned extension of the existing orchestration store. */
  task_schema_version: number
  tasks: TaskRecord[]
  project_context: ProjectContextRecord[]
  team_template_schema_version: number
  team_templates: TeamTemplate[]
  /** Durable operator emergency state, scoped to this project. */
  coordination?: { stopped: boolean; emergency_paused_channels: string[] }
}

export function emptyOrchestratorState(worktree: string): OrchestratorState {
  const localNode: NodeRecord = {
    id: localNodeIdFor(worktree),
    name: "local",
    kind: "local",
    platform: process.platform,
    status: "online",
    capabilities: { max_agents: 8, runtimes: [], headless: false },
    approved_at: Date.now(),
    approved_by: "owner",
    restart_policy: "manual",
    fingerprint: null,
    enrolled_at: null,
    last_seen: null,
    trust_tier: "persistent",
    grants: ["spawn", "tasks"],
    credential_expires_at: null,
  }
  return {
    orchestrator_schema_version: ORCHESTRATOR_SCHEMA_VERSION,
    local_node_id: localNode.id,
    nodes: [localNode],
    agents: [],
    events: [],
    events_cursor: 0,
    serve: { port: null, password_redacted: true },
    task_schema_version: TASK_SCHEMA_VERSION,
    tasks: [],
    project_context: [],
    team_template_schema_version: TEAM_TEMPLATE_SCHEMA_VERSION,
    team_templates: [],
    trust: {
      owner_confirm_token: newConfirmToken(),
      approved_node_ids: [],
      pending_pairing_requests: [],
      pairing_codes: [],
    },
  }
}

const AGENT_ID_PATTERN = /^agt_[0-9a-f]{24}$/
const NODE_ID_PATTERN = /^node_[A-Za-z0-9_-]{1,64}$/
const ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/
const AGENT_STATUSES: readonly string[] = ["starting", "running", "idle", "stale", "stopped", "failed"]

function isValidNode(n: unknown): boolean {
  if (!isRecord(n)) return false
  const policy = n["restart_policy"]
  const tier = n["trust_tier"]
  return (
    typeof n["id"] === "string" &&
    NODE_ID_PATTERN.test(n["id"]) &&
    typeof n["name"] === "string" &&
    (n["kind"] === "local" || n["kind"] === "remote") &&
    typeof n["platform"] === "string" &&
    (n["status"] === "online" || n["status"] === "offline" || n["status"] === "pending_approval") &&
    isRecord(n["capabilities"]) &&
    (policy === undefined || policy === "manual" || policy === "auto") &&
    (typeof n["fingerprint"] === "string" || n["fingerprint"] === null) &&
    (typeof n["enrolled_at"] === "number" || n["enrolled_at"] === null) &&
    (typeof n["last_seen"] === "number" || n["last_seen"] === null) &&
    (tier === undefined || tier === "persistent" || tier === "ephemeral") &&
    (n["grants"] === undefined || (Array.isArray(n["grants"]) && n["grants"].every((g) => typeof g === "string"))) &&
    (typeof n["credential_expires_at"] === "number" || n["credential_expires_at"] === null)
  )
}

function isValidAgent(a: unknown): boolean {
  if (!isRecord(a)) return false
  const designated = a["designated"]
  return (
    typeof a["id"] === "string" &&
    AGENT_ID_PATTERN.test(a["id"]) &&
    typeof a["name"] === "string" &&
    typeof a["host"] === "string" &&
    typeof a["role"] === "string" &&
    ROLE_PATTERN.test(a["role"]) &&
    typeof a["runtime"] === "string" &&
    typeof a["node_id"] === "string" &&
    NODE_ID_PATTERN.test(a["node_id"]) &&
    typeof a["worktree"] === "string" &&
    typeof a["status"] === "string" &&
    AGENT_STATUSES.includes(a["status"]) &&
    (a["status_detail"] === undefined ||
      a["status_detail"] === null ||
      (typeof a["status_detail"] === "string" && a["status_detail"].length <= 2_000)) &&
    (typeof a["host_session_id"] === "string" || a["host_session_id"] === null) &&
    typeof a["spawn_cmd_redacted"] === "string" &&
    (designated === "lead" || designated === null) &&
    Array.isArray(a["channel_ids"]) &&
    (a["operation_id"] === undefined ||
      (typeof a["operation_id"] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(a["operation_id"]))) &&
    (a["operation_fingerprint"] === undefined ||
      (typeof a["operation_fingerprint"] === "string" && /^[0-9a-f]{64}$/.test(a["operation_fingerprint"]))) &&
    (a["required_capabilities"] === undefined ||
      (Array.isArray(a["required_capabilities"]) &&
        a["required_capabilities"].length <= 16 &&
        a["required_capabilities"].every(
          (cap: unknown) => typeof cap === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(cap),
        )))
  )
}

function isValidEvent(e: unknown): boolean {
  if (!isRecord(e)) return false
  return (
    typeof e["seq"] === "number" &&
    typeof e["at"] === "number" &&
    (e["kind"] === "orchestration" || e["kind"] === "channel_notice") &&
    typeof e["type"] === "string" &&
    typeof e["message"] === "string" &&
    (typeof e["task_id"] === "string" || e["task_id"] === null)
  )
}

/**
 * Fail-closed validation (mirrors src/core/store.ts validateState): a forged
 * or stale orchestrator file is rejected outright, never partially trusted.
 */
export function validateOrchestratorState(
  parsed: unknown,
): { ok: true; state: OrchestratorState } | { ok: false; reason: string } {
  if (!isRecord(parsed)) return { ok: false, reason: "orchestrator root is not an object" }
  if (parsed["orchestrator_schema_version"] !== ORCHESTRATOR_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `orchestrator_schema_version mismatch: expected ${ORCHESTRATOR_SCHEMA_VERSION}, got ${String(parsed["orchestrator_schema_version"])}`,
    }
  }
  const nodes = parsed["nodes"]
  const agents = parsed["agents"]
  const events = parsed["events"]
  const trust = parsed["trust"]
  if (!Array.isArray(nodes) || !nodes.every((n) => isValidNode(n))) {
    return { ok: false, reason: "nodes has invalid shape" }
  }
  if (!Array.isArray(agents) || agents.length > MAX_ORCHESTRATOR_AGENTS || !agents.every((a) => isValidAgent(a))) {
    return { ok: false, reason: "agents has invalid shape" }
  }
  // At most one agent may be designated lead.
  const designatedLeads = (agents as unknown[]).filter(
    (a) => isRecord(a) && (a as unknown as AgentRecord).designated === "lead",
  )
  if (designatedLeads.length > 1) return { ok: false, reason: "multiple designated lead agents" }
  if (!Array.isArray(events) || !events.every((e) => isValidEvent(e))) {
    return { ok: false, reason: "events has invalid shape" }
  }
  if (!isRecord(trust) || typeof trust["owner_confirm_token"] !== "string") {
    return { ok: false, reason: "trust has invalid shape" }
  }
  if (!isRecord(parsed["serve"])) return { ok: false, reason: "serve is not an object" }
  const taskVersion = parsed["task_schema_version"]
  const coordination = parsed["coordination"]
  if (
    coordination !== undefined &&
    (!isRecord(coordination) ||
      typeof coordination["stopped"] !== "boolean" ||
      !Array.isArray(coordination["emergency_paused_channels"]) ||
      coordination["emergency_paused_channels"].length > 256 ||
      !coordination["emergency_paused_channels"].every(
        (name: unknown) => typeof name === "string" && /^[a-z0-9][a-z0-9-_]{0,63}$/.test(name),
      ))
  )
    return { ok: false, reason: "coordination has invalid shape" }
  if (
    parsed["team_template_schema_version"] !== undefined &&
    parsed["team_template_schema_version"] !== TEAM_TEMPLATE_SCHEMA_VERSION
  )
    return { ok: false, reason: "team_template_schema_version mismatch" }
  const templates = parsed["team_templates"]
  if (
    templates !== undefined &&
    (!Array.isArray(templates) ||
      templates.length > MAX_TEAM_TEMPLATES ||
      !templates.every(validTeamTemplate) ||
      new Set(templates.map((t) => (t as TeamTemplate).id)).size !== templates.length)
  )
    return { ok: false, reason: "team_templates has invalid shape" }
  if (taskVersion !== undefined && taskVersion !== TASK_SCHEMA_VERSION)
    return { ok: false, reason: "task_schema_version mismatch" }
  if (
    parsed["tasks"] !== undefined &&
    (!Array.isArray(parsed["tasks"]) || parsed["tasks"].length > MAX_TASKS || !parsed["tasks"].every(validTask))
  )
    return { ok: false, reason: "tasks has invalid shape" }
  if (
    parsed["project_context"] !== undefined &&
    (!Array.isArray(parsed["project_context"]) ||
      parsed["project_context"].length > MAX_CONTEXT_RECORDS ||
      !parsed["project_context"].every(validContext))
  )
    return { ok: false, reason: "project_context has invalid shape" }
  if (
    Array.isArray(parsed["tasks"]) &&
    new Set(parsed["tasks"].map((t) => (t as TaskRecord).task_id)).size !== parsed["tasks"].length
  )
    return { ok: false, reason: "duplicate task ids" }
  return { ok: true, state: parsed as unknown as OrchestratorState }
}

/** Backfill optional fields on freshly-read state (additive evolution). */
export function backfillOrchestratorState(state: OrchestratorState): void {
  state.task_schema_version ??= TASK_SCHEMA_VERSION
  state.tasks ??= []
  state.project_context ??= []
  state.team_template_schema_version ??= TEAM_TEMPLATE_SCHEMA_VERSION
  state.team_templates ??= []
  for (const agent of state.agents) {
    if (agent.designated === undefined) agent.designated = null
    if (!Array.isArray(agent.channel_ids)) agent.channel_ids = []
    if (typeof agent.last_heartbeat !== "number") agent.last_heartbeat = null
    if (typeof agent.restart_count !== "number" || !Number.isFinite(agent.restart_count)) agent.restart_count = 0
    if (typeof agent.model !== "string") agent.model = null
  }
  for (const node of state.nodes) {
    // Legacy nodes retain manual restart.
    if (node.restart_policy !== "manual" && node.restart_policy !== "auto") node.restart_policy = "manual"
    // Legacy identities default to ungranted; only the local node receives full grants.
    if (typeof node.fingerprint !== "string") node.fingerprint = null
    if (typeof node.enrolled_at !== "number") node.enrolled_at = null
    if (typeof node.last_seen !== "number") node.last_seen = null
    if (node.trust_tier !== "persistent" && node.trust_tier !== "ephemeral")
      node.trust_tier = node.kind === "local" ? "persistent" : "ephemeral"
    if (!Array.isArray(node.grants)) node.grants = node.kind === "local" ? ["spawn", "tasks"] : []
    if (typeof node.credential_expires_at !== "number") node.credential_expires_at = null
  }
  if (!Array.isArray(state.trust.pending_pairing_requests)) state.trust.pending_pairing_requests = []
  if (!Array.isArray(state.trust.approved_node_ids)) state.trust.approved_node_ids = []
  if (!Array.isArray((state.trust as unknown as Record<string, unknown>)["pairing_codes"])) {
    ;(state.trust as unknown as Record<string, unknown>)["pairing_codes"] = []
  }
  if (state.serve === undefined || state.serve === null) state.serve = { port: null, password_redacted: true }
}

export interface OrchestratorStoreDeps {
  /** Share StateStore locking; never nest store lock scopes. */
  withLock<T>(fn: () => T): Promise<T>
}

/**
 * Use the shared StateStore lock when provided, otherwise .orchestrator.lock.
 * Reads stay lock-free because saves atomically replace the file.
 */
export class OrchestratorStore {
  readonly dir: string
  readonly file: string
  readonly projectDir: string
  private lockPath: string
  private sharedLock: ((fn: () => unknown) => Promise<unknown>) | null

  constructor(projectDir: string, sharedLock: { withLock<T>(fn: () => T): Promise<T> } | null = null) {
    this.projectDir = projectDir
    this.dir = join(projectDir, ".opencomms")
    this.file = join(this.dir, ORCHESTRATOR_FILE)
    this.lockPath = join(this.dir, ORCHESTRATOR_LOCK)
    this.sharedLock = sharedLock ? (fn) => sharedLock.withLock(fn) : null
  }

  /** Exclusive cross-process lock; delegates to StateStore.withLock when wired. */
  async withLock<T>(fn: () => T): Promise<T> {
    if (this.sharedLock) {
      // StateStore locks are not reentrant; both stores must share one lock scope.
      return this.sharedLock(fn) as Promise<T>
    }
    return this.ownLock(fn)
  }

  private async ownLock<T>(fn: () => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true })
    const deadline = Date.now() + ORCH_LOCK_TIMEOUT_MS
    let fd: number
    for (;;) {
      try {
        fd = openSync(this.lockPath, "wx")
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > ORCH_LOCK_STALE_MS) {
            try {
              unlinkSync(this.lockPath)
            } catch {
              /* raced break; retry loop re-checks */
            }
          }
        } catch {
          /* vanished; retry */
        }
        if (Date.now() >= deadline) {
          throw new Error("OpenComms: timed out waiting for the orchestrator lock (.orchestrator.lock).")
        }
        await sleepAsync(10)
      }
    }
    try {
      writeFileSync(fd, `${process.pid}@${Date.now()}`, "utf8")
      return fn()
    } finally {
      closeSync(fd)
      try {
        unlinkSync(this.lockPath)
      } catch {
        /* best effort */
      }
    }
  }

  load(): OrchestratorState {
    const state = this.readStateFile()
    if (state) return state
    const fresh = emptyOrchestratorState(this.projectDir)
    this.save(fresh)
    return fresh
  }

  private readStateFile(): OrchestratorState | null {
    if (!existsSync(this.file)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"))
      const result = validateOrchestratorState(parsed)
      if (!result.ok) {
        // Preserve rejected/forward-version data before fail-closed recovery.
        copyFileSync(
          this.file,
          join(this.dir, `orchestrator.rejected.${Date.now()}.${randomBytes(4).toString("hex")}.json`),
          constants.COPYFILE_EXCL,
        )
        const base = emptyOrchestratorState(this.projectDir)
        base.events.push({
          seq: 1,
          at: Date.now(),
          kind: "orchestration",
          type: "state_rejected",
          message: `Orchestrator state rejected (${result.reason}); rebuilt with fresh state.`,
          agent_id: null,
          node_id: null,
          task_id: null,
        })
        this.save(base)
        return base
      }
      backfillOrchestratorState(result.state)
      return result.state
    } catch (error) {
      const base = emptyOrchestratorState(this.projectDir)
      base.events.push({
        seq: 1,
        at: Date.now(),
        kind: "orchestration",
        type: "state_unreadable",
        message: `Orchestrator state unreadable; rebuilt: ${(error as Error).message}`,
        agent_id: null,
        node_id: null,
        task_id: null,
      })
      this.save(base)
      return base
    }
  }

  save(state: OrchestratorState): void {
    mkdirSync(this.dir, { recursive: true })
    // First write of the additive task extension preserves the exact legacy
    // orchestration document. Channel messages remain untouched and legacy
    // acknowledgements migrate only as delivery, never execution evidence.
    // Malformed bytes must be preserved before ANY overwrite, including
    // later recoveries after the one-time legacy migration backup exists.
    if (existsSync(this.file)) {
      let old: unknown
      try {
        old = JSON.parse(readFileSync(this.file, "utf8"))
      } catch {
        copyFileSync(
          this.file,
          join(this.dir, `orchestrator.unreadable.${Date.now()}.${randomBytes(4).toString("hex")}.json`),
          constants.COPYFILE_EXCL,
        )
      }
      if (
        isRecord(old) &&
        !existsSync(join(this.dir, "orchestrator.pre-tasks-v1.json")) &&
        old["orchestrator_schema_version"] === ORCHESTRATOR_SCHEMA_VERSION &&
        old["task_schema_version"] === undefined
      ) {
        try {
          copyFileSync(this.file, join(this.dir, "orchestrator.pre-tasks-v1.json"), constants.COPYFILE_EXCL)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
      }
    }
    const tmp = join(this.dir, `.orchestrator.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
    replaceStateFile(this.file, tmp, JSON.stringify(state, null, 2))
  }

  /** Load, mutate, save under the lock. The mutation runs synchronously. */
  async update(mutate: (state: OrchestratorState) => void): Promise<OrchestratorState> {
    return this.withLock(() => {
      const state = this.load()
      mutate(state)
      this.save(state)
      return state
    })
  }
}

export function nextEventSeq(state: OrchestratorState): number {
  const last = state.events[state.events.length - 1]
  return (last?.seq ?? 0) + 1
}

export function pushEvent(state: OrchestratorState, event: Omit<OrchestrationEvent, "seq" | "at">): void {
  state.events.push({ ...event, seq: nextEventSeq(state), at: Date.now() })
  if (state.events.length > MAX_ORCHESTRATOR_EVENTS) {
    state.events = state.events.slice(-MAX_ORCHESTRATOR_EVENTS)
  }
}

export function eventsSince(state: OrchestratorState, since: number): OrchestrationEvent[] {
  return state.events.filter((e) => e.seq > since)
}
