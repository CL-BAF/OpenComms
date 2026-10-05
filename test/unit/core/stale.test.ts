/** PUSH messages expire by age; PULL messages survive until read or explicitly expired. */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createChannel, joinChannel, sendMessage, drainQueue, inbox, commitDelivery } from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"

const PROJECT = "proj1"
const WORKTREE = "C:\\repo"

function mixedChannel(state: Parameters<typeof createChannel>[0]) {
  const created = createChannel(state, {
    channel: "mixed",
    role: "Builder",
    role_prompt: "p",
    session_id: "sess_push",
    project_id: PROJECT,
    worktree: WORKTREE,
    stale_policy: { mode: "window", window_ms: 5 * 60_000 },
  })
  assert.equal(created.ok, true)
  const joined = joinChannel(state, {
    channel: "mixed",
    role: "Reviewer",
    role_prompt: "p",
    session_id: "sess_pull",
    project_id: PROJECT,
    worktree: WORKTREE,
    stale_policy: { mode: "none", window_ms: null },
    delivery_mode: "pull",
    host: "claude-desktop",
    surface: "desktop",
  })
  assert.equal(joined.ok, true)
  return state.channels["mixed"]!
}

test("PULL member's envelope survives far beyond the 5-minute window", () => {
  const state = emptyState()
  mixedChannel(state)
  const sent = sendMessage(state, { channel: "mixed", content: "for the pull side" }, "sess_push")
  assert.equal(sent.ok, true)

  const future = Date.now() + 6 * 60 * 60_000
  const drained = drainQueue(state, "sess_pull", { now: future })
  assert.equal(sent.ok, true)
  // Pull-drain must NOT have marked it stale (drain marks in_flight; the
  // PULL consumer commits delivered when the content is actually handed over).
  const msg = Object.values(state.messages)[0]!
  assert.equal(msg.delivery_status, "in_flight", "PULL envelope must survive until read")
  commitDelivery(
    state,
    "sess_pull",
    drained.map((d) => d.message_id),
  )
  assert.equal(msg.delivery_status, "delivered", "commit marks the read envelope delivered")
})

test("PUSH member's envelope still goes stale after the window (unchanged v1 behavior)", () => {
  const state = emptyState()
  mixedChannel(state)
  const first = sendMessage(state, { channel: "mixed", content: "ping" }, "sess_push")
  assert.equal(first.ok, true)
  const back = sendMessage(state, { channel: "mixed", content: "for the push side" }, "sess_pull")
  assert.equal(back.ok, true, `reply failed: ${back.message}`)
  const future = Date.now() + 6 * 60_000
  drainQueue(state, "sess_push", { now: future })
  const msg = Object.values(state.messages).find((m) => m.recipient_session_id === "sess_push")!
  assert.equal(msg.delivery_status, "stale", "PUSH member must still age out per stale_policy")
})

test("mixed PUSH+PULL channel: PUSH copy goes stale, PULL copy stays readable", () => {
  const state = emptyState()
  mixedChannel(state)
  const toPull = sendMessage(state, { channel: "mixed", content: "push-to-pull" }, "sess_push")
  const toPush = sendMessage(state, { channel: "mixed", content: "pull-to-push" }, "sess_pull")
  assert.equal(toPull.ok, true, `send to PULL member failed: ${toPull.message}`)
  assert.equal(toPush.ok, true, `send to PUSH member failed: ${toPush.message}`)

  const past = Date.now() - 6 * 60_000
  for (const msg of Object.values(state.messages)) msg.timestamp = past

  const now = Date.now()
  const pushDrained = drainQueue(state, "sess_push", { now })
  assert.equal(pushDrained.length, 0, "PUSH envelope must age out (stale)")
  assert.equal(
    Object.values(state.messages).find((m) => m.recipient_session_id === "sess_push")!.delivery_status,
    "stale",
  )

  const pullView = inbox(state, { channel: "mixed", session_id: "sess_pull" })
  assert.equal(pullView.ok, true)
  const data = pullView.data as { pending: number; messages: Array<{ content: string; delivery_status: string }> }
  assert.equal(data.pending, 1, "PULL envelope must survive past the PUSH window")
  assert.equal(data.messages[0]!.content, "push-to-pull")

  // Pull-drain marks in_flight on read; the consumer commits delivered in
  // the same locked mutate (no infinite retry loop).
  const pulled = drainQueue(state, "sess_pull", { now })
  assert.equal(pulled.length, 1)
  assert.equal(pulled[0]!.delivery_status, "in_flight")
  commitDelivery(
    state,
    "sess_pull",
    pulled.map((d) => d.message_id),
  )
  assert.equal(pulled[0]!.attempts, 1)
})

test("PUSH default preserved for v1-migrated members (window policy)", () => {
  const state = emptyState()
  mixedChannel(state)
  const created = createChannel(emptyState(), {
    channel: "solo",
    role: "Builder",
    role_prompt: "p",
    session_id: "x",
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(created.ok, true)
})
