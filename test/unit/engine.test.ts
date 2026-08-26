import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createChannel,
  joinChannel,
  sendMessage,
  drainQueue,
  pauseChannel,
  resumeChannel,
  disconnectChannel,
  updateRole,
  inbox,
  history,
  status,
  normalizeChannelName,
  normalizeRole,
  contentHash,
  assertRootSession,
} from "../../src/engine.js"
import { emptyState } from "../../src/store.js"
import type { State } from "../../src/types.js"

const SESSION_A = "sess_a"
const SESSION_B = "sess_b"
const PROJECT = "proj_1"
const WORKTREE = "C:\\repo"

function freshState(): State {
  return emptyState()
}

function createPair(state: State) {
  const created = createChannel(state, {
    channel: "my-feature",
    role: "Builder",
    role_prompt: "Implement the user's requests, verify your work, and send completed work to Reviewer.",
    session_id: SESSION_A,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(created.ok, true)
  const joined = joinChannel(state, {
    channel: "my-feature",
    role: "Reviewer",
    role_prompt: "Independently inspect Builder's work. Return PASS only when no material defects remain.",
    session_id: SESSION_B,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(joined.ok, true)
}

test("createChannel registers the exact calling session", () => {
  const state = freshState()
  const result = createChannel(state, {
    channel: "My-Feature",
    role: "Builder",
    role_prompt: "Build things.",
    session_id: SESSION_A,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(result.ok, true)
  const channel = state.channels[normalizeChannelName("My-Feature")]
  assert.ok(channel)
  assert.equal(channel.members.length, 1)
  assert.equal(channel.members[0]!.session_id, SESSION_A)
  assert.equal(channel.members[0]!.role, "Builder")
  assert.equal(channel.members[0]!.role_prompt, "Build things.")
})

test("createChannel rejects duplicate channel names", () => {
  const state = freshState()
  createChannel(state, {
    channel: "dup",
    role: "Builder",
    role_prompt: "p",
    session_id: SESSION_A,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  const result = createChannel(state, {
    channel: "DUP",
    role: "Reviewer",
    role_prompt: "p",
    session_id: SESSION_B,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /already exists/)
})

test("joinChannel registers the second exact session as Reviewer", () => {
  const state = freshState()
  createPair(state)
  const channel = state.channels["my-feature"]!
  assert.equal(channel.members.length, 2)
  assert.equal(channel.members[1]!.session_id, SESSION_B)
  assert.equal(channel.members[1]!.role, "Reviewer")
})

test("joinChannel rejects joining the same session twice", () => {
  const state = freshState()
  createPair(state)
  const result = joinChannel(state, {
    channel: "my-feature",
    role: "Builder",
    role_prompt: "p",
    session_id: SESSION_A,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /already registered/)
})

test("joinChannel rejects one session holding both roles", () => {
  const state = freshState()
  createChannel(state, {
    channel: "c",
    role: "Builder",
    role_prompt: "p",
    session_id: SESSION_A,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  const result = joinChannel(state, {
    channel: "c",
    role: "Reviewer",
    role_prompt: "p",
    session_id: SESSION_A,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /cannot hold two roles/)
})

test("joinChannel rejects replacing an existing member without confirmation", () => {
  const state = freshState()
  createPair(state)
  const result = joinChannel(state, {
    channel: "my-feature",
    role: "Reviewer",
    role_prompt: "p",
    session_id: "sess_c",
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /already held by session/)
})

test("joinChannel rejects incompatible projects and worktrees", () => {
  const state = freshState()
  createPair(state)
  const badProject = joinChannel(state, {
    channel: "my-feature",
    role: "Builder",
    role_prompt: "p",
    session_id: "sess_c",
    project_id: "other_project",
    worktree: WORKTREE,
  })
  assert.equal(badProject.ok, false)
  assert.match(badProject.message, /different project/)

  const badWorktree = joinChannel(state, {
    channel: "my-feature",
    role: "Builder",
    role_prompt: "p",
    session_id: "sess_c",
    project_id: PROJECT,
    worktree: "C:\\other",
  })
  assert.equal(badWorktree.ok, false)
  assert.match(badWorktree.message, /different worktree/)
})

test("joinChannel rejects nonexistent channels", () => {
  const state = freshState()
  const result = joinChannel(state, {
    channel: "nope",
    role: "Builder",
    role_prompt: "p",
    session_id: SESSION_A,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /does not exist/)
})

test("sendMessage queues a full envelope for the peer", () => {
  const state = freshState()
  createPair(state)
  const result = sendMessage(
    state,
    { channel: "my-feature", type: "review_request", content: "Implementation is ready." },
    SESSION_A,
  )
  assert.equal(result.ok, true)
  const msg = Object.values(state.messages)[0]!
  assert.equal(msg.sender_session_id, SESSION_A)
  assert.equal(msg.sender_role, "Builder")
  assert.equal(msg.recipient_session_id, SESSION_B)
  assert.equal(msg.recipient_role, "Reviewer")
  assert.equal(msg.message_type, "review_request")
  assert.equal(msg.delivery_status, "pending")
  assert.equal(msg.hop_count, 0)
  assert.ok(msg.message_id)
  assert.ok(msg.correlation_id)
  assert.equal(state.queues[SESSION_B]!.length, 1)
})

test("sendMessage rejects when not a member", () => {
  const state = freshState()
  createPair(state)
  const result = sendMessage(
    state,
    { channel: "my-feature", content: "hi" },
    "sess_outsider",
  )
  assert.equal(result.ok, false)
  assert.match(result.message, /not a member/)
})

test("sendMessage rejects when channel is paused", () => {
  const state = freshState()
  createPair(state)
  pauseChannel(state, { channel: "my-feature", session_id: SESSION_A })
  const result = sendMessage(state, { channel: "my-feature", content: "hi" }, SESSION_A)
  assert.equal(result.ok, false)
  assert.match(result.message, /paused/)
})

test("sendMessage rejects duplicate content within the stale window", () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "same text" }, SESSION_A)
  const result = sendMessage(state, { channel: "my-feature", content: "same text" }, SESSION_A)
  assert.equal(result.ok, false)
  assert.match(result.message, /Duplicate message content/)
})

test("reply chains increment hop count and are capped", () => {
  const state = freshState()
  createPair(state)
  const first = sendMessage(state, { channel: "my-feature", content: "one" }, SESSION_A)
  const id1 = (first.data as { message_id: string }).message_id
  const second = sendMessage(
    state,
    { channel: "my-feature", content: "two", reply_to: id1 },
    SESSION_B,
  )
  const id2 = (second.data as { message_id: string }).message_id
  assert.equal(state.messages[id2]!.hop_count, 1)
  assert.equal(state.messages[id2]!.correlation_id, state.messages[id1]!.correlation_id)

  // Exceed max hops (default 4).
  let last = id2
  let result
  for (let i = 0; i < 5; i++) {
    result = sendMessage(
      state,
      { channel: "my-feature", content: `hop ${i}`, reply_to: last },
      i % 2 === 0 ? SESSION_A : SESSION_B,
    )
    if (!result.ok) break
    last = (result.data as { message_id: string }).message_id
  }
  assert.equal(result!.ok, false)
  assert.match(result!.message, /maximum hop count/)
})

test("drainQueue delivers once and preserves ordering", () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "first" }, SESSION_A)
  sendMessage(state, { channel: "my-feature", content: "second" }, SESSION_A)
  const delivered = drainQueue(state, SESSION_B)
  assert.equal(delivered.length, 2)
  assert.equal(delivered[0]!.content, "first")
  assert.equal(delivered[1]!.content, "second")
  assert.equal(delivered[0]!.delivery_status, "delivered")
  assert.equal(state.queues[SESSION_B]!.length, 0)

  // Second drain delivers nothing (dedup).
  const again = drainQueue(state, SESSION_B)
  assert.equal(again.length, 0)
})

test("drainQueue respects pause", () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "hi" }, SESSION_A)
  pauseChannel(state, { channel: "my-feature", session_id: SESSION_A })
  const delivered = drainQueue(state, SESSION_B)
  assert.equal(delivered.length, 0)
  assert.equal(state.queues[SESSION_B]!.length, 1)
})

test("resume allows delivery to continue", () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "hi" }, SESSION_A)
  pauseChannel(state, { channel: "my-feature", session_id: SESSION_A })
  resumeChannel(state, { channel: "my-feature", session_id: SESSION_A })
  const delivered = drainQueue(state, SESSION_B)
  assert.equal(delivered.length, 1)
})

test("drainQueue rejects stale events", () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "old" }, SESSION_A)
  const msg = Object.values(state.messages)[0]!
  const channel = state.channels["my-feature"]!
  const delivered = drainQueue(state, SESSION_B, {
    now: msg.timestamp + channel.stale_event_ms + 1,
  })
  assert.equal(delivered.length, 0)
  assert.equal(state.messages[msg.message_id]!.delivery_status, "stale")
})

test("drainQueue respects delivery cooldown", () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "a" }, SESSION_A)
  const now = Date.now()
  const first = drainQueue(state, SESSION_B, { now })
  assert.equal(first.length, 1)
  sendMessage(state, { channel: "my-feature", content: "b" }, SESSION_A)
  const second = drainQueue(state, SESSION_B, { now: now + 10 })
  assert.equal(second.length, 0)
  const third = drainQueue(state, SESSION_B, { now: now + 2_000 })
  assert.equal(third.length, 1)
})

test("disconnect stops communication and does not delete sessions", () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "hi" }, SESSION_A)
  const result = disconnectChannel(state, { channel: "my-feature", session_id: SESSION_B })
  assert.equal(result.ok, true)
  assert.match(result.message, /No OpenCode sessions were deleted/)
  const channel = state.channels["my-feature"]!
  assert.equal(channel.members.length, 1)
  assert.equal(channel.members[0]!.session_id, SESSION_A)
  // Queued message for the departed session is rejected.
  const msg = Object.values(state.messages)[0]!
  assert.equal(msg.delivery_status, "rejected")
  // Sending from the remaining member now fails (no peer).
  const send = sendMessage(state, { channel: "my-feature", content: "again" }, SESSION_A)
  assert.equal(send.ok, false)
  assert.match(send.message, /no peer/)
})

test("disconnect removes empty channels", () => {
  const state = freshState()
  createPair(state)
  disconnectChannel(state, { channel: "my-feature", session_id: SESSION_A })
  disconnectChannel(state, { channel: "my-feature", session_id: SESSION_B })
  assert.equal(state.channels["my-feature"], undefined)
})

test("updateRole replaces the persistent role prompt", () => {
  const state = freshState()
  createPair(state)
  const result = updateRole(state, {
    channel: "my-feature",
    session_id: SESSION_A,
    role_prompt: "New builder instructions.",
  })
  assert.equal(result.ok, true)
  const channel = state.channels["my-feature"]!
  assert.equal(channel.members[0]!.role_prompt, "New builder instructions.")
})

test("inbox lists pending messages without delivering", () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "one" }, SESSION_A)
  sendMessage(state, { channel: "my-feature", content: "two" }, SESSION_A)
  const result = inbox(state, { channel: "my-feature", session_id: SESSION_B })
  assert.equal(result.ok, true)
  const data = result.data as { pending: number; messages: unknown[] }
  assert.equal(data.pending, 2)
  assert.equal(data.messages.length, 2)
  assert.equal(state.queues[SESSION_B]!.length, 2)
})

test("history returns newest first with delivery status", async () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "old" }, SESSION_A)
  await new Promise((r) => setTimeout(r, 5))
  sendMessage(state, { channel: "my-feature", content: "new" }, SESSION_A)
  const result = history(state, { channel: "my-feature" })
  const data = result.data as { messages: Array<{ content: string; delivery_status: string }> }
  assert.equal(data.messages[0]!.content, "new")
  assert.equal(data.messages[1]!.content, "old")
  assert.equal(data.messages[0]!.delivery_status, "pending")
})

test("status reports channels, members, queues, and errors", () => {
  const state = freshState()
  createPair(state)
  sendMessage(state, { channel: "my-feature", content: "hi" }, SESSION_A)
  state.errors.push({ at: Date.now(), message: "boom" })
  const result = status(state, {})
  const data = result.data as {
    channels: Array<{ name: string; members: unknown[]; queue_lengths: Record<string, number> }>
    pending_messages: number
    errors: unknown[]
  }
  assert.equal(data.channels.length, 1)
  assert.equal(data.channels[0]!.name, "my-feature")
  assert.equal(data.channels[0]!.members.length, 2)
  assert.equal(data.channels[0]!.queue_lengths[SESSION_B], 1)
  assert.equal(data.pending_messages, 1)
  assert.equal(data.errors.length, 1)
})

test("normalizeRole accepts case-insensitive roles and rejects others", () => {
  assert.equal(normalizeRole("builder"), "Builder")
  assert.equal(normalizeRole("REVIEWER"), "Reviewer")
  assert.equal(normalizeRole("coder"), null)
})

test("contentHash is deterministic", () => {
  assert.equal(contentHash("abc"), contentHash("abc"))
  assert.notEqual(contentHash("abc"), contentHash("abd"))
})

test("assertRootSession rejects child sessions and accepts root sessions", () => {
  assert.equal(assertRootSession(undefined, "sess_a"), null)
  assert.equal(assertRootSession(null, "sess_a"), null)
  assert.equal(assertRootSession("", "sess_a"), null)
  const reject = assertRootSession("parent_1", "sess_child")
  assert.ok(reject)
  assert.match(reject!, /child session/)
  assert.match(reject!, /parent_1/)
})
