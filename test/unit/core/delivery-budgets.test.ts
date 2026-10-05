import { test } from "node:test"
import assert from "node:assert/strict"
import { emptyState } from "../../../src/core/store.js"
import { createChannel, joinChannel, sendMessage, drainQueue, requeueFailedDelivery } from "../../../src/core/engine.js"

function queued(budgets: { max_runtime_ms?: number; max_delivered_messages?: number }) {
  const state = emptyState()
  const now = Date.now()
  assert.ok(
    createChannel(state, {
      channel: "bounded",
      role: "Operator",
      role_prompt: "Coordinate",
      session_id: "operator",
      project_id: "budget",
      worktree: "/budget",
      budgets,
    }).ok,
  )
  assert.ok(
    joinChannel(state, {
      channel: "bounded",
      role: "Worker",
      role_prompt: "Work",
      session_id: "worker",
      project_id: "budget",
      worktree: "/budget",
      stale_policy: { mode: "none", window_ms: null },
    }).ok,
  )
  for (let i = 0; i < 3; i++)
    assert.ok(sendMessage(state, { channel: "bounded", content: `Distinct work ${i}` }, "operator").ok)
  return { state, now }
}

test("delivery lifetime budget gates every queued handover instead of allowing a prequeued batch to overrun", () => {
  const { state, now } = queued({ max_delivered_messages: 1 })
  const batch = drainQueue(state, "worker", { now })
  assert.equal(batch.length, 1)
  assert.equal(state.channels["bounded"]!.delivered_total, 1)
  assert.equal(state.queues["worker"]!.length, 2)
  assert.ok(state.queues["worker"]!.every((id) => state.messages[id]!.delivery_status === "pending"))
  state.channels["bounded"]!.budgets.max_delivered_messages = 3
  assert.equal(drainQueue(state, "worker", { now: now + 60_000 }).length, 2, "explicit extension admits retained work")
})

test("failed delivery retries consume handover budget and stop without losing pending mail", () => {
  const { state, now } = queued({ max_delivered_messages: 1 })
  const initial = drainQueue(state, "worker", { now })
  requeueFailedDelivery(
    state,
    "worker",
    initial.map((m) => m.message_id),
  )
  assert.equal(drainQueue(state, "worker", { now: now + 60_000 }).length, 0)
  assert.equal(state.channels["bounded"]!.delivered_total, 1)
  assert.equal(state.queues["worker"]!.length, 3)
  assert.equal(state.messages[initial[0]!.message_id]!.attempts, 1)
})

test("runtime budget expiring after enqueue prevents host handover while retaining mail for an operator decision", () => {
  const { state, now } = queued({ max_runtime_ms: 60_000 })
  assert.equal(drainQueue(state, "worker", { now: now + 120_000 }).length, 0)
  assert.equal(state.channels["bounded"]!.delivered_total, 0)
  assert.equal(state.queues["worker"]!.length, 3)
})
