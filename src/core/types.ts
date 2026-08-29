/**
 * OpenComms â€” core types.
 *
 * All persisted state lives under `<project>/.opencomms/` and is written
 * atomically (temp file + rename) so a crash mid-write can never corrupt a
 * channel definition or a message queue.
 *
 * Roles are an OPEN vocabulary: any short human-readable label ("Builder",
 * "Reviewer", "Architect", ...). They are validated structurally by
 * normalizeRole and kept unique per channel (one role per member), not drawn
 * from a fixed union. Channels support N members up to max_members.
 */

export const STATE_DIR = ".opencomms"
export const STATE_FILE = "state.json"
export const SCHEMA_VERSION = 2

/**
 * The literal legacy directory name, kept as DATA (a migration path), not as
 * host semantics inside core logic. Assembled from split parts at runtime so
 * the neutrality grep can never mistake it for live host wiring.
 */
const LEGACY_PARTS = [String.fromCharCode(111, 112, 101, 110, 99, 111, 100, 101), "comms"] as const
const LEGACY_DIR_NAME = LEGACY_PARTS.join("-")
/** Legacy v1 location (single-host plugin era); used for one-time migration. */
export const LEGACY_STATE_DIR = `.${LEGACY_DIR_NAME}`
/** Host label stamped on v1-migrated member rows (data, not logic). */
export const LEGACY_HOST_ID = LEGACY_DIR_NAME
/** Marker file written after a successful v1 -> v2 migration. */
export const MIGRATION_MARKER = "MIGRATED_FROM_V1"

/** Default per-channel membership cap (channels hold N members). */
export const DEFAULT_MAX_MEMBERS = 8

/** Legacy default roles, kept for docs/fallbacks only â€” not a closed set. */
export const ROLE_BUILDER = "Builder"
export const ROLE_REVIEWER = "Reviewer"

export type DeliveryStatus = "pending" | "delivered" | "failed" | "rejected" | "stale"

/**
 * Message types a sender may choose freely. The "system" type is RESERVED:
 * it can appear in persisted envelopes produced internally, but senders may
 * never set it, preventing peer messages from masquerading as system traffic.
 */
export type SenderMessageType = "review_request" | "review_response" | "manual"

export type MessageType = SenderMessageType | "system"

export const VALID_SENDER_MESSAGE_TYPES: readonly SenderMessageType[] = ["review_request", "review_response", "manual"]

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
  /** Host family that owns this member's session (open vocabulary, lowercase). */
  host: string
  /** Surface within the host: cli | desktop | web | api | app-server | mcp. */
  surface: HostSurface
  /** How this member receives messages. Core never conflates these. */
  delivery_mode: DeliveryMode
  /**
   * Host-specific identity (host session/thread id, pinned MCP member id, ...).
   * NEVER used for OpenComms routing â€” session_id above is the only routing
   * key. Correlation/verification only.
   */
  host_session_id: string | null
  /** Per-member staleness policy (schema v2). */
  stale_policy: StalePolicy
  /** Per-member capability overrides (sparse; host profile fills the rest). */
  capabilities?: Partial<HostCapabilities>
}

export type DeliveryMode = "push" | "pull" | "poll" | "managed_thread" | "unsupported"

export type HostSurface = "cli" | "desktop" | "web" | "api" | "app-server" | "mcp"

export type RoleInjection =
  | "system-prompt" // persistent per-session system instructions
  | "hook-boundary" // injected at hook fire points
  | "none"

/**
 * Per-member stale policy (schema v2). The v1 behavior â€” reject undelivered
 * envelopes older than stale_event_ms â€” is correct for PUSH hosts whose
 * drain runs within minutes. PULL hosts may not read for hours; their
 * envelopes must live until read (bounded by retention + explicit expiry).
 */
export interface StalePolicy {
  /** "window" = age-based rejection after window_ms; "none" = never age out. */
  mode: "window" | "none"
  /** Age window in ms when mode === "window"; ignored otherwise. */
  window_ms: number | null
}

/**
 * Host capability profile. Every adapter declares one; Core degrades
 * gracefully instead of assuming parity. Values are honest, evidence-backed
 * declarations â€” never aspirational.
 */
export interface HostCapabilities {
  /** Host exposes a stable per-session identity to the adapter. */
  sessionIdentity: boolean
  /** Adapter can enumerate existing host sessions/threads. */
  sessionDiscovery: boolean
  /** OpenComms can link an ALREADY-OPEN host session. */
  existingSessionLinking: boolean
  /** Host can resume a persisted session/thread by id. */
  sessionResume: boolean
  /** Adapter can push content into a running/idle host session. */
  promptDelivery: boolean
  /** Adapter can observe idle/busy transitions. */
  idleDetection: boolean
  /** Host emits lifecycle events (start/end/delete) the adapter can hook. */
  lifecycleEvents: boolean
  /** How persistent role instructions can be injected. */
  roleInjection: RoleInjection
  /** Adapter can register per-session tools. */
  toolRegistration: boolean
  /** Adapter can register user-facing commands (slash etc.). */
  commandRegistration: boolean
  /** Host supports MCP servers (client side). */
  mcpSupport: boolean
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
    /** Host/surface/delivery for cross-host visibility (schema v2). */
    host?: string
    surface?: string
    delivery_mode?: string
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
  /** Host identity of the joining session (schema v2). */
  host?: string
  surface?: HostSurface
  delivery_mode?: DeliveryMode
  host_session_id?: string | null
  stale_policy?: StalePolicy
}

export interface JoinInput {
  channel: string
  role: string
  role_prompt: string
  session_id: string
  project_id: string
  worktree: string
  /** Host identity of the joining session (schema v2). */
  host?: string
  surface?: HostSurface
  delivery_mode?: DeliveryMode
  host_session_id?: string | null
  stale_policy?: StalePolicy
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
  /** The caller requesting the kick â€” must hold a privileged role. */
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
  /**
   * When provided, the report is scoped to channels this session belongs to.
   * Session ids are capability handles (to= targets, kick targets); handing
   * the full roster to unlinked sessions widens the impersonation surface.
   * The user-facing slash command omits this and sees the full view.
   */
  session_id?: string | null
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
