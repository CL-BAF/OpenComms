/**
 * OpenComms — core engine.
 *
 * Pure-ish logic over the persisted State. All functions are deterministic
 * and synchronous; the plugin layer wraps them with the injected OpenCode
 * client for session lookups and delivery.
 */

import { createHash, randomUUID } from "node:crypto"
import {
  ROLE_BUILDER,
  ROLE_REVIEWER,
  type Channel,
  type ChannelSummary,
  type CreateInput,
  type DeliveryStatus,
  type DisconnectInput,
  type HistoryInput,
  type InboxInput,
  type JoinInput,
  type MessageEnvelope,
  type MessageType,
  type PauseInput,
  type ResumeInput,
  type Role,
  type SendInput,
  type State,
  type StatusInput,
  type StatusReport,
  type ToolResult,
  type UpdateRoleInput,
} from "./types.js"

export const DEFAULT_MAX_HOPS = 4
export const DEFAULT_RATE_LIMIT = 20
export const DEFAULT_DELIVERY_COOLDOWN_MS = 1_000
export const DEFAULT_STALE_EVENT_MS = 5 * 60_000

export function normalizeChannelName(name: string): string {
  return name.trim().toLowerCase()
}

export function normalizeRole(role: string): Role | null {
  const trimmed = role.trim()
  if (trimmed.toLowerCase() === ROLE_BUILDER.toLowerCase()) return ROLE_BUILDER
  if (trimmed.toLowerCase() === ROLE_REVIEWER.toLowerCase()) return ROLE_REVIEWER
  return null
}

/**
 * Pure check for invariant #1: OpenComms only links root OpenCode sessions.
 * Returns a rejection message when the session is a child (has a parentID),
 * or null when it is a root session. The plugin layer supplies the parentID
 * fetched asynchronously from the OpenCode client; this function stays
 * deterministic and synchronous.
 */
export function assertRootSession(parentID: string | undefined | null, sessionId: string): string | null {
  if (parentID && parentID.length > 0) {
    return `Session ${sessionId} is a child session (parent ${parentID}). OpenComms only links root sessions; use a root session to create or join a channel.`
  }
  return null
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32)
}

export function newMessageId(): string {
  return `ocm_${randomUUID().replace(/-/g, "")}`
}

export function newChannelId(): string {
  return `chn_${randomUUID().replace(/-/g, "")}`
}

export function newCorrelationId(): string {
  return `cor_${randomUUID().replace(/-/g, "")}`
}

function ok(message: string, data?: unknown): ToolResult {
  return { ok: true, message, data }
}

function fail(message: string): ToolResult {
  return { ok: false, message }
}

function findChannel(state: State, name: string): Channel | undefined {
  return state.channels[normalizeChannelName(name)]
}

function memberOf(channel: Channel, sessionId: string) {
  return channel.members.find((m) => m.session_id === sessionId)
}

function peerOf(channel: Channel, sessionId: string) {
  return channel.members.find((m) => m.session_id !== sessionId)
}

export function createChannel(state: State, input: CreateInput): ToolResult {
  const name = normalizeChannelName(input.channel)
  if (!name) return fail("Channel name is required.")
  if (name.length > 64) return fail("Channel name must be 64 characters or fewer.")
  if (!input.session_id) return fail("Session id is required.")
  if (!input.project_id) return fail("Project id is required.")
  if (!input.worktree) return fail("Worktree is required.")
  if (!input.role_prompt.trim()) return fail("A role prompt is required.")

  const existing = findChannel(state, name)
  if (existing) {
    return fail(
      `Channel "${input.channel}" already exists. Use /OpenComms Join to join it, or /OpenComms Status to inspect it.`,
    )
  }

  const channel: Channel = {
    id: newChannelId(),
    name,
    project_id: input.project_id,
    worktree: input.worktree,
    created_at: Date.now(),
    paused: false,
    paused_at: null,
    members: [
      {
        session_id: input.session_id,
        role: input.role,
        role_prompt: input.role_prompt,
        joined_at: Date.now(),
        stale: false,
        stale_at: null,
      },
    ],
    rate: { window_start: Date.now(), count: 0 },
    cooldown_until: {},
    seen_content: {},
    processed_correlations: [],
    max_hops: DEFAULT_MAX_HOPS,
    rate_limit: DEFAULT_RATE_LIMIT,
    delivery_cooldown_ms: DEFAULT_DELIVERY_COOLDOWN_MS,
    stale_event_ms: DEFAULT_STALE_EVENT_MS,
  }

  state.channels[name] = channel
  return ok(
    `Channel "${input.channel}" created. This session (${input.session_id}) is registered as ${input.role}.`,
    { channel_id: channel.id, role: input.role, session_id: input.session_id },
  )
}

export function joinChannel(state: State, input: JoinInput): ToolResult {
  const name = normalizeChannelName(input.channel)
  const channel = findChannel(state, name)
  if (!channel) {
    return fail(
      `Channel "${input.channel}" does not exist. Create it first with /OpenComms Create.`,
    )
  }

  if (channel.project_id !== input.project_id) {
    return fail(
      `Channel "${input.channel}" belongs to a different project (${channel.project_id}). Sessions from incompatible projects cannot be linked.`,
    )
  }

  if (channel.worktree !== input.worktree) {
    return fail(
      `Channel "${input.channel}" belongs to a different worktree (${channel.worktree}). Sessions from incompatible worktrees cannot be linked.`,
    )
  }

  const existing = memberOf(channel, input.session_id)
  if (existing) {
    if (existing.role === input.role) {
      return fail(
        `This session is already registered on channel "${input.channel}" as ${input.role}. A session cannot join the same channel twice.`,
      )
    }
    return fail(
      `This session is already registered on channel "${input.channel}" as ${existing.role}. One session cannot hold two roles on the same channel.`,
    )
  }

  const roleTaken = channel.members.some((m) => m.role === input.role)
  if (roleTaken) {
    const holder = channel.members.find((m) => m.role === input.role)
    return fail(
      `Role ${input.role} on channel "${input.channel}" is already held by session ${holder?.session_id}. Replacing an existing channel member requires explicit confirmation; disconnect that member first.`,
    )
  }

  if (!input.role_prompt.trim()) return fail("A role prompt is required.")

  channel.members.push({
    session_id: input.session_id,
    role: input.role,
    role_prompt: input.role_prompt,
    joined_at: Date.now(),
    stale: false,
    stale_at: null,
  })

  return ok(
    `Joined channel "${input.channel}" as ${input.role}. This session (${input.session_id}) is now linked.`,
    { channel_id: channel.id, role: input.role, session_id: input.session_id },
  )
}

export function updateRole(state: State, input: UpdateRoleInput): ToolResult {
  const channel = findChannel(state, input.channel)
  if (!channel) return fail(`Channel "${input.channel}" does not exist.`)
  const member = memberOf(channel, input.session_id)
  if (!member) {
    return fail(`This session is not a member of channel "${input.channel}".`)
  }
  if (!input.role_prompt.trim()) return fail("A role prompt is required.")
  member.role_prompt = input.role_prompt
  return ok(`Role prompt updated for ${member.role} on channel "${input.channel}".`)
}

export function pauseChannel(state: State, input: PauseInput): ToolResult {
  const channel = findChannel(state, input.channel)
  if (!channel) return fail(`Channel "${input.channel}" does not exist.`)
  const member = memberOf(channel, input.session_id)
  if (!member) {
    return fail(`This session is not a member of channel "${input.channel}".`)
  }
  if (channel.paused) return ok(`Channel "${input.channel}" is already paused.`)
  channel.paused = true
  channel.paused_at = Date.now()
  return ok(`Channel "${input.channel}" paused. No messages will be delivered until it is resumed.`)
}

export function resumeChannel(state: State, input: ResumeInput): ToolResult {
  const channel = findChannel(state, input.channel)
  if (!channel) return fail(`Channel "${input.channel}" does not exist.`)
  const member = memberOf(channel, input.session_id)
  if (!member) {
    return fail(`This session is not a member of channel "${input.channel}".`)
  }
  if (!channel.paused) return ok(`Channel "${input.channel}" is not paused.`)
  channel.paused = false
  channel.paused_at = null
  return ok(`Channel "${input.channel}" resumed. Pending messages will be delivered.`)
}

export function disconnectChannel(state: State, input: DisconnectInput): ToolResult {
  const channel = findChannel(state, input.channel)
  if (!channel) return fail(`Channel "${input.channel}" does not exist.`)
  const member = memberOf(channel, input.session_id)
  if (!member) {
    return fail(`This session is not a member of channel "${input.channel}".`)
  }

  channel.members = channel.members.filter((m) => m.session_id !== input.session_id)

  // Drop queued messages addressed to the departing session; keep the rest.
  const queue = state.queues[input.session_id] ?? []
  for (const id of queue) {
    const msg = state.messages[id]
    if (msg) msg.delivery_status = "rejected"
  }
  delete state.queues[input.session_id]

  if (channel.members.length === 0) {
    delete state.channels[channel.name]
    return ok(
      `Disconnected from channel "${input.channel}". The channel had no remaining members and was removed. No OpenCode sessions were deleted.`,
    )
  }

  return ok(
    `Disconnected from channel "${input.channel}". The channel remains active for the other member. No OpenCode sessions were deleted.`,
  )
}

export function sendMessage(state: State, input: SendInput, senderSessionId: string): ToolResult {
  const channel = findChannel(state, input.channel)
  if (!channel) return fail(`Channel "${input.channel}" does not exist.`)
  const sender = memberOf(channel, senderSessionId)
  if (!sender) {
    return fail(`This session is not a member of channel "${input.channel}".`)
  }
  const peer = peerOf(channel, senderSessionId)
  if (!peer) {
    return fail(`Channel "${input.channel}" has no peer to send to.`)
  }
  if (peer.stale) {
    return fail(
      `The peer session (${peer.session_id}) is marked stale — it no longer exists. Rejoin or repair the channel first.`,
    )
  }
  if (channel.paused) {
    return fail(`Channel "${input.channel}" is paused. Resume it before sending.`)
  }
  if (!input.content.trim()) return fail("Message content is required.")
  if (input.content.length > 100_000) return fail("Message content is too large (max 100,000 characters).")

  const type: MessageType = input.type ?? "manual"
  const now = Date.now()

  // Rate limit.
  if (now - channel.rate.window_start > 60_000) {
    channel.rate = { window_start: now, count: 0 }
  }
  channel.rate.count += 1
  if (channel.rate.count > channel.rate_limit) {
    return fail(
      `Rate limit exceeded on channel "${input.channel}" (${channel.rate_limit} messages per minute).`,
    )
  }

  // Repeated-content detection. Only mark the content as seen AFTER every
  // other validation passes; otherwise a rejected hop-count or rate-limit
  // attempt would poison the dedup window and block legitimate retries.
  const hash = contentHash(input.content)
  const lastSeen = channel.seen_content[hash]
  if (lastSeen !== undefined && now - lastSeen < channel.stale_event_ms) {
    return fail("Duplicate message content detected; refusing to send the same content twice within the stale window.")
  }

  // Hop counting: a reply to a message inherits its correlation id and
  // increments the hop count. Chains longer than max_hops are rejected.
  let correlationId = newCorrelationId()
  let hopCount = 0
  if (input.reply_to) {
    const parent = state.messages[input.reply_to]
    if (parent) {
      correlationId = parent.correlation_id
      hopCount = parent.hop_count + 1
    }
  }
  if (hopCount > channel.max_hops) {
    return fail(
      `Message chain exceeded the maximum hop count (${channel.max_hops}). The conversation loop is stopped.`,
    )
  }
  // Correlation ids are tracked for observability and loop analysis. Replies
  // legitimately share the parent's correlation id, so only brand-new chains
  // are recorded here; duplicate delivery is prevented by message_id
  // deduplication and repeated-content detection.
  if (!input.reply_to) {
    channel.processed_correlations.push(correlationId)
    if (channel.processed_correlations.length > 500) {
      channel.processed_correlations = channel.processed_correlations.slice(-500)
    }
  }

  // All validation passed — now record the content hash so subsequent
  // duplicate sends within the stale window are rejected.
  channel.seen_content[hash] = now

  const envelope: MessageEnvelope = {
    message_id: newMessageId(),
    channel_id: channel.id,
    sender_session_id: senderSessionId,
    sender_role: sender.role,
    recipient_session_id: peer.session_id,
    recipient_role: peer.role,
    timestamp: now,
    message_type: type,
    content: input.content,
    reply_to: input.reply_to ?? null,
    hop_count: hopCount,
    delivery_status: "pending",
    correlation_id: correlationId,
    delivered_at: null,
    attempts: 0,
  }

  state.messages[envelope.message_id] = envelope
  const queue = state.queues[peer.session_id] ?? []
  queue.push(envelope.message_id)
  state.queues[peer.session_id] = queue

  return ok(
    `Message queued for ${peer.role} (session ${peer.session_id}) on channel "${input.channel}".`,
    { message_id: envelope.message_id, delivery_status: envelope.delivery_status },
  )
}

/**
 * Attempt delivery of queued messages to a recipient session.
 *
 * `deliver` is called by the plugin layer when the recipient becomes idle.
 * It returns the list of envelopes that were actually delivered so the
 * caller can prompt the session once per batch.
 */
export function drainQueue(
  state: State,
  recipientSessionId: string,
  opts: { now?: number; canDeliver?: (msg: MessageEnvelope) => boolean } = {},
): MessageEnvelope[] {
  const now = opts.now ?? Date.now()
  const queue = state.queues[recipientSessionId] ?? []
  const delivered: MessageEnvelope[] = []
  const remaining: string[] = []

  for (const id of queue) {
    const msg = state.messages[id]
    if (!msg) continue
    if (msg.recipient_session_id !== recipientSessionId) continue

    const channel = Object.values(state.channels).find((c) => c.id === msg.channel_id)
    if (!channel) {
      msg.delivery_status = "rejected"
      continue
    }
    if (channel.paused) {
      remaining.push(id)
      continue
    }
    if (msg.delivery_status === "delivered") continue

    // Stale-event rejection.
    if (now - msg.timestamp > channel.stale_event_ms) {
      msg.delivery_status = "stale"
      continue
    }

    // Delivery cooldown per recipient: only the FIRST message in a batch
    // waits for the cooldown; the rest of the batch delivers immediately so
    // queued messages are not starved by a single cooldown.
    const cooldownUntil = channel.cooldown_until[recipientSessionId] ?? 0
    if (now < cooldownUntil && delivered.length === 0) {
      remaining.push(id)
      continue
    }

    if (opts.canDeliver && !opts.canDeliver(msg)) {
      remaining.push(id)
      continue
    }

    msg.delivery_status = "delivered"
    msg.delivered_at = now
    msg.attempts += 1
    channel.cooldown_until[recipientSessionId] = now + channel.delivery_cooldown_ms
    const seen = state.delivered_to[msg.message_id] ?? []
    if (!seen.includes(recipientSessionId)) seen.push(recipientSessionId)
    state.delivered_to[msg.message_id] = seen
    delivered.push(msg)
  }

  state.queues[recipientSessionId] = remaining
  return delivered
}

export function inbox(state: State, input: InboxInput): ToolResult {
  const channel = findChannel(state, input.channel)
  if (!channel) return fail(`Channel "${input.channel}" does not exist.`)
  const member = memberOf(channel, input.session_id)
  if (!member) {
    return fail(`This session is not a member of channel "${input.channel}".`)
  }
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20
  const queue = state.queues[input.session_id] ?? []
  const items = queue
    .slice(0, limit)
    .map((id) => state.messages[id])
    .filter((m): m is MessageEnvelope => Boolean(m))
  return ok(`Inbox for ${member.role} on channel "${input.channel}".`, {
    pending: queue.length,
    messages: items.map((m) => ({
      message_id: m.message_id,
      sender_role: m.sender_role,
      message_type: m.message_type,
      content: m.content,
      timestamp: m.timestamp,
      reply_to: m.reply_to,
      hop_count: m.hop_count,
      delivery_status: m.delivery_status,
    })),
  })
}

export function history(state: State, input: HistoryInput): ToolResult {
  const channel = findChannel(state, input.channel)
  if (!channel) return fail(`Channel "${input.channel}" does not exist.`)
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 100) : 20
  const items = Object.values(state.messages)
    .filter((m) => m.channel_id === channel.id)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
  return ok(`History for channel "${input.channel}".`, {
    messages: items.map((m) => ({
      message_id: m.message_id,
      sender_role: m.sender_role,
      recipient_role: m.recipient_role,
      message_type: m.message_type,
      content: m.content,
      timestamp: m.timestamp,
      reply_to: m.reply_to,
      hop_count: m.hop_count,
      delivery_status: m.delivery_status,
    })),
  })
}

export function status(state: State, input: StatusInput): ToolResult {
  const names = input.channel ? [normalizeChannelName(input.channel)] : Object.keys(state.channels)
  const summaries: ChannelSummary[] = []
  for (const name of names) {
    const channel = state.channels[name]
    if (!channel) continue
    const queueLengths: Record<string, number> = {}
    for (const member of channel.members) {
      queueLengths[member.session_id] = (state.queues[member.session_id] ?? []).length
    }
    const lastMessage = Object.values(state.messages)
      .filter((m) => m.channel_id === channel.id)
      .sort((a, b) => b.timestamp - a.timestamp)[0]
    summaries.push({
      id: channel.id,
      name: channel.name,
      project_id: channel.project_id,
      worktree: channel.worktree,
      created_at: channel.created_at,
      paused: channel.paused,
      members: channel.members.map((m) => ({
        session_id: m.session_id,
        role: m.role,
        stale: m.stale,
        joined_at: m.joined_at,
      })),
      queue_lengths: queueLengths,
      last_message_at: lastMessage?.timestamp ?? null,
    })
  }
  const report: StatusReport = {
    channels: summaries,
    total_messages: Object.keys(state.messages).length,
    pending_messages: Object.values(state.queues).reduce((acc, q) => acc + q.length, 0),
    errors: state.errors,
  }
  return ok("OpenComms status.", report)
}

export function markStale(state: State, sessionId: string): void {
  for (const channel of Object.values(state.channels)) {
    const member = channel.members.find((m) => m.session_id === sessionId)
    if (member && !member.stale) {
      member.stale = true
      member.stale_at = Date.now()
    }
  }
}

export function clearStale(state: State, sessionId: string): void {
  for (const channel of Object.values(state.channels)) {
    const member = channel.members.find((m) => m.session_id === sessionId)
    if (member) {
      member.stale = false
      member.stale_at = null
    }
  }
}

export function isMember(state: State, sessionId: string): boolean {
  return Object.values(state.channels).some((c) => c.members.some((m) => m.session_id === sessionId))
}

export function rolePromptFor(state: State, sessionId: string): string | null {
  for (const channel of Object.values(state.channels)) {
    const member = channel.members.find((m) => m.session_id === sessionId)
    if (member) return member.role_prompt
  }
  return null
}

export function channelForSession(state: State, sessionId: string): Channel | undefined {
  return Object.values(state.channels).find((c) => c.members.some((m) => m.session_id === sessionId))
}

export function deliveryStatusOf(state: State, messageId: string): DeliveryStatus | null {
  return state.messages[messageId]?.delivery_status ?? null
}
