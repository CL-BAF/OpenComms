/**
 * OpenComms — core types.
 *
 * All persisted state lives under `<project>/.opencode-comms/` and is written
 * atomically (temp file + rename) so a crash mid-write can never corrupt a
 * channel definition or a message queue.
 *
 * Roles are an OPEN vocabulary: any short human-readable label ("Builder",
 * "Reviewer", "Architect", ...). They are validated structurally by
 * normalizeRole and kept unique per channel (one role per member), not drawn
 * from a fixed union. Channels support N members up to max_members.
 */

export const STATE_DIR = ".opencode-comms"
export const STATE_FILE = "state.json"
export const SCHEMA_VERSION = 1

/** Default per-channel membership cap (channels hold N members). */
export const DEFAULT_MAX_MEMBERS = 8

/** Legacy default roles, kept for docs/fallbacks only — not a closed set. */
export const ROLE_BUILDER = "Builder"
export const ROLE_REVIEWER = "Reviewer"

export type DeliveryStatus =
  | "pending"
  | "delivered"
  | "failed"
  | "rejected"
  | "stale"

/**
 * Message types a sender may choose freely. The "system" type is RESERVED:
 * it can appear in persisted envelopes produced internally, but senders may
 * never set it, preventing peer messages from masquerading as system traffic.
 */
export type SenderMessageType =
  | "review_request"
  | "review_response"
  | "manual"

export type MessageType = SenderMessageType | "system"

export const VALID_SENDER_MESSAGE_TYPES: readonly SenderMessageType[] = [
  "review_request",
  "review_response",
  "manual",
]

export interface MessageEnvelope {
  message_id: string
  channel_id: string
  sender_session_id: string
  sender_role: string
  recipient_session_id: string
  recipient_role: string
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
  /** Open vocabulary role label, unique within the channel. */
  role: string
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
  /** Membership cap for this channel (>= 2). */
  max_members: number
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
  /** Chess-clock timer: tracks cumulative active time per member. */
  timer: ChannelTimer
}

export interface ChannelTimer {
  /** Which member (session id) is currently on the clock, null when stopped. */
  active_member_id: string | null
  /** Epoch ms when the current active segment started, or null when stopped. */
  segment_started_at: number | null
  /** Cumulative active ms keyed by member session id (excludes running segment). */
  elapsed_ms: Record<string, number>
  /** Optional hard cap in ms; agents can query it and self-limit. */
  limit_ms: number | null
  /** Session id the limit applies to (null = total across all members). */
  limit_member_id: string | null
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
  max_members: number
  members: Array<{
    session_id: string
    role: string
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
  /**
   * Explicit recipient: another member's session id OR their unique role
   * label (case-insensitive). Omit on a two-member channel to target the
   * single peer; required on channels with 3+ members unless broadcast=true.
   */
  to?: string | null
  /** Deliver to every other member of the channel instead of one target. */
  broadcast?: boolean
}

export interface CreateInput {
  channel: string
  role: string
  role_prompt: string
  session_id: string
  project_id: string
  worktree: string
  max_members?: number
}

export interface JoinInput {
  channel: string
  role: string
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

export interface KickInput {
  channel: string
  /** The caller requesting the kick — must hold a privileged role. */
  session_id: string
  /** Exactly one of these identifies the member to remove. */
  target_session_id?: string | null
  target_role?: string | null
}

export interface InboxInput {
  channel: string
  session_id: string
  limit?: number
}

export interface HistoryInput {
  channel: string
  /** History reads are member-only: content stays inside the channel. */
  session_id: string
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
  /** For set_limit/switch: target member by session id or role label. */
  to?: string | null
}

export interface ToolResult {
  ok: boolean
  message: string
  data?: unknown
}
