/**
 * Host-neutral adapter contract (Stage 2).
 *
 * Adapters implement this interface and contain ONLY host translation logic.
 * Core never imports adapters; adapters import Core. Every capability is
 * explicit — Core degrades gracefully instead of assuming parity.
 */

import type { HostCapabilities, MessageEnvelope } from "../core/types.js"

/** Where an adapter runs / how it identifies members. */
export type HostId =
  "opencode" | "claude-code" | "claude-desktop" | "codex" | "chatgpt" | "chatgpt-codex" | (string & {})

/** Explicit delivery outcome — adapters never fake success. */
export interface DeliveryOutcome {
  status: "delivered" | "failed" | "requeued" | "unsupported"
  /** Human-readable detail for diagnostics / status / errors. */
  detail?: string
}

/** Identity the adapter reports for the CURRENT host session/thread. */
export interface SessionIdentity {
  /** OpenComms routing key (opaque). */
  session_id: string
  host: HostId
  /** Host-specific id (Claude session uuid, Codex thread id, ...). */
  host_session_id: string | null
}

/** Context given to initialize(). */
export interface AdapterContext {
  /** Absolute project/workspace directory the adapter operates in. */
  projectDir: string
  /** Host-reported project id, when the host provides one. */
  projectId?: string
  /** Worktree path when the host distinguishes it from projectDir. */
  worktree?: string
}

/** Optional adapter hook for host lifecycle events. */
export type LifecycleEvent =
  | { kind: "session-start"; session_id: string }
  | { kind: "session-end"; session_id: string }
  | { kind: "idle"; session_id: string }
  | { kind: "busy"; session_id: string }

export interface OpenCommsHostAdapter {
  readonly id: HostId
  readonly capabilities: HostCapabilities

  /** Prepare the adapter. MUST fail closed when identity cannot be verified. */
  initialize(ctx: AdapterContext): Promise<void>

  /** Identity of the CURRENT session, or null when the host exposes none. */
  getCurrentSession?(): Promise<SessionIdentity | null>

  /**
   * Verify a session id against the host.
   * true = verified; false = verified NOT valid; null = CANNOT VERIFY.
   * Core treats null as FAIL CLOSED (refuse membership mutations).
   */
  verifySession?(sessionId: string): Promise<boolean | null>

  /** PUSH delivery of a message batch into the member's session. */
  deliverMessage?(sessionId: string, batch: MessageEnvelope[]): Promise<DeliveryOutcome>

  /** PULL: retrieve the member's pending messages (marks them delivered). */
  pullMessages?(sessionId: string, limit?: number): Promise<MessageEnvelope[]>

  /** Subscribe to host lifecycle events. Returns an unsubscribe function. */
  subscribeLifecycle?(cb: (event: LifecycleEvent) => void): () => void

  /** Release resources; idempotent. */
  shutdown(): Promise<void>
}
