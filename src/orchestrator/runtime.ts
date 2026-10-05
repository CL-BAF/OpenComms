/**
 * Lifecycle contract for explicitly managed agents.
 * Status comes from the host or an owned ACP request; delivery preserves untrusted framing.
 * Processes use argv and env-only secrets. OpenCode models are pinned; ACP keeps its host model.
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

export interface SpawnResult {
  /** Runtime-native session/thread id (persisted as AgentRecord.host_session_id). */
  host_session_id: string
  /** Redacted argv for the record (secrets replaced). */
  spawn_cmd_redacted: string
}

/** One managed agent; delivery, interruption and stop must report host outcomes. */
export interface AgentHandle {
  /** Hand one FRAMED batch to the agent (OpenComms framing, envelope intact). */
  deliver(framed: string): Promise<"delivered" | "failed" | "uncertain">
  /** Best-effort interrupt of the current turn. */
  abort(): Promise<void>
  /** Best-effort status snapshot (event stream remains the authority). */
  status(): Promise<{ status: AgentRuntimeStatus; detail?: string }>
  /** null means unsupported host permissions, never an empty approval list. */
  permissionsDrain?(): Promise<PendingPermission[] | null>
  /** Answer ONE pending permission prompt (operator-only action upstream). */
  permissionsRespond?(permissionId: string, response: PermissionResponse): Promise<{ ok: boolean; message: string }>
  /** Stop this agent; force behavior depends on the host. */
  stop(force?: boolean): Promise<void>
}

/**
 * A pending host permission prompt. OpenCode uses /permission and
 * /permission/:requestID/reply; ACP maps session/request_permission here.
 */
export interface PendingPermission {
  permission_id: string
  /** Runtime-native request payload (tool name, args summary, etc.). */
  request: unknown
}

export type PermissionResponse = "allow" | "deny"

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

/** Register a runtime factory, replacing any existing registration. */
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
