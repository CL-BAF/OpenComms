/**
 * AgentRuntime abstraction (M1; docs/orchestrator-design.md §3).
 *
 * Host-neutral lifecycle contract for orchestrator-managed agents. Every
 * runtime implements the SAME op set — create (quiet, role prompt), resume
 * (existing session), deliver (framed batch), abort, status, stop — shaped
 * by the spike-proven OpenCode serve sequence and the documented claude-code
 * / codex CLIs (research report §1A–1C).
 *
 * Rules anchored in the M0 spike (docs/spike-spawn-opencode.md):
 *  - Models are ALWAYS pinned and pre-verified; server defaults fail or hang.
 *  - Turn-waits are timeout-based (never open-ended).
 *  - Status is event-driven (SSE); status() is a best-effort snapshot only.
 *  - Child processes are spawned argv-only (no shell); secrets are env-only.
 *  - Delivery preserves OpenComms untrusted framing — one protocol surface
 *    local vs remote (MessageEnvelope content moves verbatim).
 */

import type { AgentRecord, AgentRuntimeStatus } from "./state.js"

/** Least-privilege spawn inputs (all validated by the API layer first). */
export interface SpawnRequest {
  agent_id: string
  name: string
  role: string
  role_prompt: string
  worktree: string
  /** "provider/model"; REQUIRED for runtimes whose server default is unverified. */
  model?: string
  provider_config?: Record<string, unknown>
}

/** Machine-readable result of create(). */
export interface SpawnResult {
  /** Runtime-native session/thread id (persisted as AgentRecord.host_session_id). */
  host_session_id: string
  /** Redacted argv for the record (secrets replaced). */
  spawn_cmd_redacted: string
}

/**
 * A live handle to ONE managed agent. Implementations must never fake
 * success: deliver/abort/stop report honest outcomes (same rule as the
 * adapter contract in src/hosts/contract.ts).
 */
export interface AgentHandle {
  /** Hand one FRAMED batch to the agent (OpenComms framing, envelope intact). */
  deliver(framed: string): Promise<"delivered" | "failed">
  /** Best-effort interrupt of the current turn. */
  abort(): Promise<void>
  /** Best-effort status snapshot (event stream remains the authority). */
  status(): Promise<{ status: AgentRuntimeStatus; detail?: string }>
  /**
   * Structured permission-prompt drain (M2 §9b-4). Returns null when the
   * runtime's host exposes no permission API — callers must treat null as
   * "unsupported", never as "no pending prompts".
   */
  permissionsDrain?(): Promise<PendingPermission[] | null>
  /** Answer ONE pending permission prompt (operator-only action upstream). */
  permissionsRespond?(permissionId: string, response: PermissionResponse): Promise<{ ok: boolean; message: string }>
  /** Process-level termination; force escalates after a grace period. */
  stop(force?: boolean): Promise<void>
}

/**
 * A pending host permission prompt (M2 §9b-4). Shaped by the opencode
 * permission endpoint (POST /session/:id/permissions/:permissionID);
 * other runtimes map their native prompts onto this shape.
 */
export interface PendingPermission {
  permission_id: string
  /** Runtime-native request payload (tool name, args summary, etc.). */
  request: unknown
}

/** Response for a permission prompt ("allow" | "deny" per host vocabulary). */
export type PermissionResponse = "allow" | "deny"

export interface AgentHandle {
  /** Hand one FRAMED batch to the agent (OpenComms framing, envelope intact). */
  deliver(framed: string): Promise<"delivered" | "failed">
  /** Best-effort interrupt of the current turn. */
  abort(): Promise<void>
  /** Best-effort status snapshot (event stream remains the authority). */
  status(): Promise<{ status: AgentRuntimeStatus; detail?: string }>
  /**
   * Structured permission-prompt drain (M2 §9b-4). Returns null when the
   * runtime's host exposes no permission API — callers must treat null as
   * "unsupported", never as "no pending prompts".
   */
  permissionsDrain?(): Promise<Array<PendingPermission> | null>
  /** Answer ONE pending permission prompt (operator-only action upstream). */
  permissionsRespond?(permissionId: string, response: PermissionResponse): Promise<{ ok: boolean; message: string }>
  /** Process-level termination; force escalates after a grace period. */
  stop(force?: boolean): Promise<void>
}

export interface RuntimeDetectResult {
  available: boolean
  version?: string
  detail?: string
  /** Provider/model catalog for the runtimes listing endpoint (cached by caller). */
  providers?: Array<{ provider: string; models: string[] }>
}

export interface AgentRuntime {
  readonly runtime: string
  readonly host: string
  detect(): Promise<RuntimeDetectResult> | RuntimeDetectResult
  create(
    req: SpawnRequest,
  ): Promise<{ ok: true; result: SpawnResult; handle: AgentHandle } | { ok: false; message: string }>
  resume(rec: AgentRecord): Promise<{ ok: true; handle: AgentHandle } | { ok: false; message: string }>
  /** Stop everything this runtime owns on the node (serve shutdown, etc.). */
  shutdownNode(): Promise<void>
}

type Factory = () => AgentRuntime
const registry = new Map<string, Factory>()

/** Register a runtime factory (idempotent; last wins is a test-only need). */
export function registerRuntime(runtime: string, factory: Factory): void {
  registry.set(runtime, factory)
}

export function getRuntime(runtime: string): AgentRuntime | null {
  const factory = registry.get(runtime)
  return factory ? factory() : null
}

export function registeredRuntimes(): string[] {
  return [...registry.keys()]
}
