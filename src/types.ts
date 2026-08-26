/**
 * OpenComms — core types.
 *
 * All persisted state lives under `<project>/.opencode-comms/` and is written
 * atomically (temp file + rename) so a crash mid-write can never corrupt a
 * channel definition or a message queue.
 */

export const STATE_DIR = ".opencode-comms"
export const STATE_FILE = "state.json"
export const SCHEMA_VERSION = 1

export const ROLE_BUILDER = "Builder"
export const ROLE_REVIEWER = "Reviewer"

export const VALID_ROLES = [ROLE_BUILDER, ROLE_REVIEWER] as const
export type Role = (typeof VALID_ROLES)[number]

export type DeliveryStatus =
  | "pending"
  | "delivered"
  | "failed"
  | "rejected"
  | "stale"

export type MessageType =
  | "review_request"
  | "review_response"
  | "manual"
  | "system"

export interface MessageEnvelope {
  message_id: string
  channel_id: string
  sender_session_id: string
  sender_role: Role
  recipient_session_id: string
  recipient_role: Role
  timestamp: number
  message_type: MessageType
  content: string
  reply_to: string | null
  hop_count: number
  delivery_status: DeliveryStatus
  correlation_id: string
  delivered_at: number | null
  attempts: number
}

export interface Member {
  session_id: string
  role: Role
  role_prompt: string
  joined_at: number
  /** Set when the linked session no longer exists after a restart. */
  stale: boolean
  stale_at: number | null
}

export interface Channel {
  id: string
  name: string
  project_id: string
  worktree: string
  created_at: number
  paused: boolean
  paused_at: number | null
  members: Member[]
  /** Per-channel rate limiting: window start (ms) and message count. */
  rate: { window_start: number; count: number }
  /** Delivery cooldown: next allowed delivery timestamp per recipient. */
  cooldown_until: Record<string, number>
  /** Deduplication: content hash -> last seen timestamp. */
  seen_content: Record<string, number>
  /** Correlation ids that have already been processed. */
  processed_correlations: string[]
  /** Max hops a message chain may travel before being rejected. */
  max_hops: number
  /** Max messages per rate window. */
  rate_limit: number
  /** Cooldown between deliveries to the same recipient, in ms. */
  delivery_cooldown_ms: number
  /** Stale events (older than this, in ms) are rejected. */
  stale_event_ms: number
  /** Chess-clock timer: tracks cumulative per-role active time. */
  timer: ChannelTimer
}

export interface ChannelTimer {
  /** Which role is currently on the clock, or null when stopped. */
  active_role: Role | null
  /** Epoch ms when the current active segment started, or null when stopped. */
  segment_started_at: number | null
  /** Cumulative active ms per role (excludes the in-progress segment). */
  elapsed_ms: Record<Role, number>
  /** Optional hard cap in ms; agents can query it and self-limit. */
  limit_ms: number | null
  /** Which role the limit applies to (null = total across both). */
  limit_role: Role | null
}

export interface State {
  schema_version: number
  channels: Record<string, Channel>
  messages: Record<string, MessageEnvelope>
  /** Per-recipient FIFO queues of message ids. */
  queues: Record<string, string[]>
  /** message_id -> set of session ids that already received it. */
  delivered_to: Record<string, string[]>
  errors: Array<{ at: number; message: string }>
}

export interface ChannelSummary {
  id: string
  name: string
  project_id: string
  worktree: string
  created_at: number
  paused: boolean
  members: Array<{
    session_id: string
    role: Role
    stale: boolean
    joined_at: number
  }>
  queue_lengths: Record<string, number>
  last_message_at: number | null
}

export interface StatusReport {
  channels: ChannelSummary[]
  total_messages: number
  pending_messages: number
  errors: Array<{ at: number; message: string }>
}

export interface SendInput {
  channel: string
  type?: MessageType
  content: string
  reply_to?: string | null
}

export interface CreateInput {
  channel: string
  role: Role
  role_prompt: string
  session_id: string
  project_id: string
  worktree: string
}

export interface JoinInput {
  channel: string
  role: Role
  role_prompt: string
  session_id: string
  project_id: string
  worktree: string
}

export interface UpdateRoleInput {
  channel: string
  session_id: string
  role_prompt: string
}

export interface PauseInput {
  channel: string
  session_id: string
}

export interface ResumeInput {
  channel: string
  session_id: string
}

export interface DisconnectInput {
  channel: string
  session_id: string
}

export interface InboxInput {
  channel: string
  session_id: string
  limit?: number
}

export interface HistoryInput {
  channel: string
  limit?: number
}

export interface StatusInput {
  channel?: string
}

export interface TimerInput {
  channel: string
  session_id: string
  action: "start" | "stop" | "switch" | "reset" | "status" | "set_limit" | "clear_limit"
  limit_ms?: number | null
  limit_role?: Role | null
}

export interface ToolResult {
  ok: boolean
  message: string
  data?: unknown
}
