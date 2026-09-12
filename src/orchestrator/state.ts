/**
 * Orchestrator persistent state.
 *
 * Stored at `<project>/.opencomms/orchestrator.json` BESIDE the channel state
 * (Lead Decision Log 2026-09-11) so channel-schema evolution never touches
 * orchestration. Same discipline as `StateStore`: atomic temp+rename saves,
 * an exclusive cross-process lockfile (`.orchestrator.lock`, same stale-break
 * and timeout semantics as the state lock), fail-closed shape validation, and
 * corrupt/tampered files rejected to a fresh store with the reason recorded.
 *
 * Keys: agents are `agt_*` (PRIMARY key; Lead decision 2026-09-11(3)); the
 * runtime-native session id (`host_session_id`, e.g. OpenCode `ses_*`) is an
 * attribute for delivery routing, never a key. Nodes are `node_*`; the local
 * node is implicit and always present.
 *
 * Trust (contract v0.1 security note, binding): approve/revoke are
 * unauthenticated-hostile by design. The store holds a per-project
 * `confirm_token` generated at creation, surfaced to the HUMAN via GUI/CLI
 * settings only; it is never returned by any read API and never accepted
 * from agent-facing tool arguments.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import { randomBytes, createHash } from "node:crypto"

export const ORCHESTRATOR_FILE = "orchestrator.json"
export const ORCHESTRATOR_SCHEMA_VERSION = 1
const ORCHESTRATOR_LOCK = ".orchestrator.lock"
/** Same lock discipline as the state store (src/core/store.ts). */
export const ORCH_LOCK_TIMEOUT_MS = 5_000
export const ORCH_LOCK_STALE_MS = 15_000
/** Event ring cap (mirrors state.errors cap discipline). */
export const MAX_ORCHESTRATOR_EVENTS = 500
/** Cap on persisted agent rows (operator scale guard, matches member caps). */
export const MAX_ORCHESTRATOR_AGENTS = 64

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** ID generators mirror the engine's ocm_/chn_/cor_ pattern. */
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
  /**
   * M2 restart policy (design §9b-2): operator-controlled; M2 ships
   * "manual" ONLY (no auto-respawn). The hook exists so M3 can flip it
   * per-node without a migration.
   */
  restart_policy: "manual" | "auto"
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
  host_session_id: string | null
  spawn_cmd_redacted: string
  /** Contract v0.3 §9: exactly ONE agent per project may hold "lead". Immutable. */
  designated: "lead" | null
  channel_ids: string[]
  last_heartbeat: number | null
  created_at: number
  restart_count: number
  model: string | null
}

export interface TrustState {
  /** Owner-only confirm token (approve/revoke). NEVER returned by read APIs. */
  owner_confirm_token: string
  approved_node_ids: string[]
  pending_pairing_requests: Array<{ node_id: string; requested_at: number }>
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
  }
  return {
    orchestrator_schema_version: ORCHESTRATOR_SCHEMA_VERSION,
    local_node_id: localNode.id,
    nodes: [localNode],
    agents: [],
    events: [],
    events_cursor: 0,
    serve: { port: null, password_redacted: true },
    trust: {
      owner_confirm_token: newConfirmToken(),
      approved_node_ids: [],
      pending_pairing_requests: [],
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
  return (
    typeof n["id"] === "string" &&
    NODE_ID_PATTERN.test(n["id"]) &&
    typeof n["name"] === "string" &&
    (n["kind"] === "local" || n["kind"] === "remote") &&
    typeof n["platform"] === "string" &&
    (n["status"] === "online" || n["status"] === "offline" || n["status"] === "pending_approval") &&
    isRecord(n["capabilities"]) &&
    (policy === undefined || policy === "manual" || policy === "auto")
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
    (typeof a["host_session_id"] === "string" || a["host_session_id"] === null) &&
    typeof a["spawn_cmd_redacted"] === "string" &&
    (designated === "lead" || designated === null) &&
    Array.isArray(a["channel_ids"])
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
  // One role cannot be held by two agents with the same designated marker:
  // at most ONE designated:"lead" row may exist (contract v0.3 §9).
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
  return { ok: true, state: parsed as unknown as OrchestratorState }
}

/** Backfill optional fields on freshly-read state (additive evolution). */
export function backfillOrchestratorState(state: OrchestratorState): void {
  for (const agent of state.agents) {
    if (agent.designated === undefined) agent.designated = null
    if (!Array.isArray(agent.channel_ids)) agent.channel_ids = []
    if (typeof agent.last_heartbeat !== "number") agent.last_heartbeat = null
    if (typeof agent.restart_count !== "number" || !Number.isFinite(agent.restart_count)) agent.restart_count = 0
    if (typeof agent.model !== "string") agent.model = null
  }
  for (const node of state.nodes) {
    // M2 restart_policy backfill: old nodes default to "manual" (binding).
    if (node.restart_policy !== "manual" && node.restart_policy !== "auto") node.restart_policy = "manual"
  }
  if (!Array.isArray(state.trust.pending_pairing_requests)) state.trust.pending_pairing_requests = []
  if (!Array.isArray(state.trust.approved_node_ids)) state.trust.approved_node_ids = []
  if (state.serve === undefined || state.serve === null) state.serve = { port: null, password_redacted: true }
}

export interface OrchestratorStoreDeps {
  /** Injected lock (reuses the EXISTING StateStore.withLock to avoid two lock implementations). */
  withLock<T>(fn: () => T): Promise<T>
}

/**
 * Persistence for orchestrator state. The lock is DELEGATED to the existing
 * StateStore cross-process lock (one lock discipline per .opencomms dir);
 * a separate .orchestrator.lock is only used when no StateStore is available
 * (pure CLI paths). Bare reads stay lock-free: saves are atomic renames.
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
    this.sharedLock = sharedLock as unknown as ((fn: () => unknown) => Promise<unknown>) | null
  }

  /** Exclusive cross-process lock; delegates to StateStore.withLock when wired. */
  async withLock<T>(fn: () => T): Promise<T> {
    if (this.sharedLock) {
      // Never nest: StateStore.withLock is re-entrant-unsafe by design, so
      // callers of BOTH stores must take ONE lock scope at a time (the API
      // layer enforces that; see orchestrator/api.ts).
      return this.sharedLock(fn) as Promise<T>
    }
    return this.ownLock(fn)
  }

  private async ownLock<T>(fn: () => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true })
    const deadline = Date.now() + ORCH_LOCK_TIMEOUT_MS
    for (;;) {
      try {
        const fd = openSync(this.lockPath, "wx")
        writeFileSync(fd, `${process.pid}@${Date.now()}`, "utf8")
        closeSync(fd)
        break
      } catch {
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
      return fn()
    } finally {
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
    const tmp = join(this.dir, `.orchestrator.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8")
    try {
      renameSync(tmp, this.file)
    } catch {
      // Windows AV/OneDrive races: bounded blocking retry (same discipline as
      // StateStore.save), then direct write as a last resort.
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        renameSync(tmp, this.file)
      } catch (second) {
        try {
          writeFileSync(this.file, JSON.stringify(state, null, 2), "utf8")
        } catch {
          throw new Error(`OpenComms: failed to persist orchestrator state (${(second as Error).message})`)
        }
      }
    }
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

/** Next sequence number for the event ring. */
export function nextEventSeq(state: OrchestratorState): number {
  const last = state.events[state.events.length - 1]
  return (last?.seq ?? 0) + 1
}

/** Append an event, capping the ring (newest kept). */
export function pushEvent(state: OrchestratorState, event: Omit<OrchestrationEvent, "seq" | "at">): void {
  state.events.push({ ...event, seq: nextEventSeq(state), at: Date.now() })
  if (state.events.length > MAX_ORCHESTRATOR_EVENTS) {
    state.events = state.events.slice(-MAX_ORCHESTRATOR_EVENTS)
  }
}

/** Events after a cursor (cursor = last seq the client saw). */
export function eventsSince(state: OrchestratorState, since: number): OrchestrationEvent[] {
  return state.events.filter((e) => e.seq > since)
}
