/**
 * Multi-provider + budget + retry-cap tests (work orders 2026-09-08).
 *
 * Scenario coverage: (1) Claude+Codex one session, (4) TWO Claude agents,
 * (5) TWO Codex agents, (6) multiple providers -> one target, (7)
 * broadcast across providers, (8) direct member-to-member, (9)
 * PUSH+PULL+spawn coexisting, (16) rate limiting, (17) concurrent
 * different members, plus the budget guards (max_runtime /
 * max_delivered_messages) and the dead-letter retry cap.
 *
 * All at the engine boundary with realistic member rows â€” the transports
 * themselves are exercised in spawn-delivery.test.ts and the cross-host
 * suites; the broker never needs provider identities.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createChannel,
  joinChannel,
  sendMessage,
  drainQueue,
  commitDelivery,
  requeueFailedDelivery,
  MAX_DELIVERY_ATTEMPTS,
} from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"
import type { Member } from "../../../src/core/types.js"

const PROJECT = "proj_mp"
const WORKTREE = "C:\\repo"

function member(
  sessionId: string,
  role: string,
  host: string,
  deliveryMode: Member["delivery_mode"],
  hostSessionId: string | null,
): Member {
  return {
    session_id: sessionId,
    role,
    role_prompt: `${role} prompt`,
    joined_at: Date.now(),
    stale: false,
    stale_at: null,
    host,
    surface: "mcp",
    delivery_mode: deliveryMode,
    host_session_id: hostSessionId,
    stale_policy:
      deliveryMode === "pull" ? { mode: "none", window_ms: null } : { mode: "window", window_ms: 5 * 60_000 },
  }
}

/** Six-provider session: 2 Claude + 2 Codex + 1 OpenCode + 1 PULL (desktop). */
function seedSixProviders(state: Parameters<typeof createChannel>[0]) {
  const created = createChannel(state, {
    channel: "mp",
    role: "Architect",
    role_prompt: "architect",
    session_id: "m_arch",
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(created.ok, true)
  const channel = state.channels["mp"]!
  // The creator is an opencode push member.
  channel.members[0]!.host = "opencode"
  channel.members[0]!.delivery_mode = "push"
  const joins: Array<[string, string, string, Member["delivery_mode"], string | null]> = [
    ["m_sec", "SecurityReview", "claude-code", "spawn_push", "claude-uuid-sec"],
    ["m_rev2", "SecurityReviewer2", "claude-code", "spawn_push", "claude-uuid-rev2"],
    ["m_backend", "Backend", "codex", "spawn_push", "codex-sess-backend"],
    ["m_refactor", "Refactor", "codex", "spawn_push", "codex-sess-refactor"],
    ["m_frontend", "Frontend", "opencode", "push", "m_frontend"],
    ["m_desktop", "DesktopWatch", "claude-desktop", "pull", null],
  ]
  let i = 0
  for (const [sid, role, host, mode, hs] of joins) {
    channel.members.push(member(sid, role, host, mode, hs))
    i++
  }
  return channel
}

test("(1)(4)(5) two Claude + two Codex members coexist in one session", () => {
  const state = emptyState()
  const channel = seedSixProviders(state)
  const claude = channel.members.filter((m) => m.host === "claude-code")
  const codex = channel.members.filter((m) => m.host === "codex")
  assert.equal(claude.length, 2)
  assert.equal(codex.length, 2)
  // Member ids are unique; provider names are NOT keys.
  const ids = new Set(channel.members.map((m) => m.session_id))
  assert.equal(ids.size, channel.members.length)
})

test("(6)(8) multiple providers -> one target; direct member-to-member", () => {
  const state = emptyState()
  seedSixProviders(state)
  // Three different-provider senders target SecurityReview directly.
  for (const sender of ["m_arch", "m_backend", "m_frontend"]) {
    const sent = sendMessage(
      state,
      { channel: "mp", content: `for security from ${sender}`, to: "SecurityReview" },
      sender,
    )
    assert.equal(sent.ok, true, sent.message)
    assert.deepEqual((sent.data as { recipients: string[] }).recipients, ["m_sec"])
  }
  // Direct member-to-member by session id (codex -> claude).
  const direct = sendMessage(state, { channel: "mp", content: "backend asks reviewer", to: "m_rev2" }, "m_backend")
  assert.equal(direct.ok, true)
  assert.deepEqual((direct.data as { recipients: string[] }).recipients, ["m_rev2"])
  // Queues: exactly one envelope per targeted member.
  assert.equal(state.queues["m_sec"]!.length, 3)
  assert.equal(state.queues["m_rev2"]!.length, 1)
})

test("(7) broadcast across all providers; PULL member queued too", () => {
  const state = emptyState()
  seedSixProviders(state)
  const fan = sendMessage(state, { channel: "mp", content: "all hands", broadcast: true }, "m_arch")
  assert.equal(fan.ok, true)
  assert.equal(
    (fan.data as { recipients: string[] }).recipients.length,
    6,
    "all other members (2 claude, 2 codex, opencode, desktop)",
  )
  for (const m of state.channels["mp"]!.members) {
    if (m.session_id === "m_arch") continue
    assert.equal(state.queues[m.session_id]!.length, 1, `${m.session_id} got its copy`)
  }
})

test("(9) PUSH + PULL + spawn_push coexist; drains respect the mode (PULL survives until read)", () => {
  const state = emptyState()
  seedSixProviders(state)
  sendMessage(state, { channel: "mp", content: "to backend", to: "Backend" }, "m_arch")
  sendMessage(state, { channel: "mp", content: "to desktop", to: "DesktopWatch" }, "m_arch")
  sendMessage(state, { channel: "mp", content: "broadcast for everyone", broadcast: true }, "m_arch")

  // PUSH member drain works normally (broadcast copy).
  const frontendDrain = drainQueue(state, "m_frontend")
  assert.equal(frontendDrain.length, 1)
  commitDelivery(
    state,
    "m_frontend",
    frontendDrain.map((p) => p.message_id),
    "push",
  )
  assert.equal(frontendDrain[0]!.delivery_method, "push")

  // PULL member's mail survives (never stale) and commits as pull.
  const pulled = drainQueue(state, "m_desktop")
  assert.equal(pulled.length, 2, "direct + broadcast copy both readable")
  assert.equal(pulled[0]!.delivery_status, "in_flight")
  commitDelivery(
    state,
    "m_desktop",
    pulled.map((p) => p.message_id),
    "pull",
  )
  assert.equal(pulled[0]!.delivery_method, "pull")
})

test("(16)(17) rate limit counts logical sends; concurrent different members progress independently", () => {
  const state = emptyState()
  const created = createChannel(state, {
    channel: "rl",
    role: "Coordinator",
    role_prompt: "c",
    session_id: "c0",
    project_id: PROJECT,
    worktree: WORKTREE,
    rate_limit: 4,
  })
  assert.equal(created.ok, true)
  const ch = state.channels["rl"]!
  ch.members.push(member("p1", "P1", "claude-code", "spawn_push", "u1"))
  ch.members.push(member("p2", "P2", "codex", "spawn_push", "u2"))
  // Two senders alternate; the rate window counts 4 logical sends then blocks.
  let okCount = 0
  for (let i = 0; i < 6; i++) {
    const r = sendMessage(
      state,
      { channel: "rl", content: `m${i}`, to: i % 2 === 0 ? "P2" : "Coordinator" },
      i % 2 === 0 ? "c0" : "p1",
    )
    if (r.ok) okCount++
  }
  assert.equal(okCount, 4, "rate limit enforced across senders (shared channel window)")
})

test("budgets: max_delivered_messages caps lifetime handovers (retries included)", () => {
  const state = emptyState()
  createChannel(state, {
    channel: "bud",
    role: "Builder",
    role_prompt: "p",
    session_id: "b0",
    project_id: PROJECT,
    worktree: WORKTREE,
    budgets: { max_delivered_messages: 3 },
  })
  const ch = state.channels["bud"]!
  ch.members.push(member("b1", "Peer", "opencode", "push", "b1"))
  for (let i = 0; i < 3; i++) {
    const r = sendMessage(state, { channel: "bud", content: `m${i}` }, "b0")
    assert.equal(r.ok, true)
  }
  // Drain 3 (budget consumed at handover).
  const drained = drainQueue(state, "b1")
  assert.equal(drained.length, 3)
  assert.equal(ch.delivered_total, 3)
  const blocked = sendMessage(state, { channel: "bud", content: "over budget" }, "b0")
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /message budget/)
})

test("budgets: max_runtime_ms stops a conversation past its runtime cap", () => {
  const state = emptyState()
  createChannel(state, {
    channel: "runtime",
    role: "Builder",
    role_prompt: "p",
    session_id: "r0",
    project_id: PROJECT,
    worktree: WORKTREE,
    budgets: { max_runtime_ms: 60_000 },
  })
  const ch = state.channels["runtime"]!
  ch.members.push(member("r1", "Peer", "opencode", "push", "r1"))
  assert.equal(sendMessage(state, { channel: "runtime", content: "in time" }, "r0").ok, true)
  // Age the conversation past the cap.
  ch.created_at = Date.now() - 120_000
  const blocked = sendMessage(state, { channel: "runtime", content: "too late" }, "r0")
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /runtime budget/)
})

test("retry cap: failed deliveries dead-letter after MAX_DELIVERY_ATTEMPTS (no amplification)", () => {
  const state = emptyState()
  createChannel(state, {
    channel: "dead",
    role: "Builder",
    role_prompt: "p",
    session_id: "d0",
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  const ch = state.channels["dead"]!
  ch.members.push(member("d1", "Peer", "opencode", "push", "d1"))
  sendMessage(state, { channel: "dead", content: "will fail repeatedly" }, "d0")

  // Fail the delivery MAX_DELIVERY_ATTEMPTS times (clock advances past the
  // 1s delivery cooldown between attempts, as real retries would).
  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
    const now = Date.now() + attempt * 2_000
    const drained = drainQueue(state, "d1", { now })
    assert.equal(drained.length, 1, `attempt ${attempt} drains`)
    requeueFailedDelivery(
      state,
      "d1",
      drained.map((d) => d.message_id),
    )
    const msg = Object.values(state.messages)[0]!
    if (attempt < MAX_DELIVERY_ATTEMPTS) {
      assert.equal(msg.delivery_status, "pending", `attempt ${attempt}: still retrying`)
      assert.equal((state.queues["d1"] ?? []).length, 1)
    } else {
      assert.equal(msg.delivery_status, "failed", "dead-lettered after the cap")
      assert.equal((state.queues["d1"] ?? []).length, 0, "removed from the queue")
    }
  }
  // No further drain possible.
  assert.equal(drainQueue(state, "d1", { now: Date.now() + 10_000 }).length, 0)
})

test("concurrent members: interleaved sends to DIFFERENT targets never cross", () => {
  const state = emptyState()
  createChannel(state, {
    channel: "conc",
    role: "Coordinator",
    role_prompt: "c",
    session_id: "k0",
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  const ch = state.channels["conc"]!
  ch.members.push(member("k1", "A", "claude-code", "spawn_push", "ua"))
  ch.members.push(member("k2", "B", "codex", "spawn_push", "ub"))
  // Round-robin interleaving (engine calls are serialized by the state lock
  // in real processes; here we verify per-target isolation).
  for (let round = 0; round < 4; round++) {
    assert.equal(sendMessage(state, { channel: "conc", content: `a${round}`, to: "A" }, "k0").ok, true)
    assert.equal(sendMessage(state, { channel: "conc", content: `b${round}`, to: "B" }, "k0").ok, true)
  }
  assert.deepEqual(
    (state.queues["k1"] ?? []).map((id) => state.messages[id]!.content),
    ["a0", "a1", "a2", "a3"],
  )
  assert.deepEqual(
    (state.queues["k2"] ?? []).map((id) => state.messages[id]!.content),
    ["b0", "b1", "b2", "b3"],
  )
})

test("max_members: 8 is the DEFAULT, not the ceiling (configurable up to 32)", () => {
  const state = emptyState()
  const created = createChannel(state, {
    channel: "big",
    role: "Coordinator",
    role_prompt: "p",
    session_id: "big0",
    project_id: PROJECT,
    worktree: WORKTREE,
    max_members: 16,
  })
  assert.equal(created.ok, true)
  assert.equal(state.channels["big"]!.max_members, 16, "above-default caps are honored up to the ceiling")
  // Over-ceiling clamps to MAX_MEMBERS_CEILING (32), not the 8 default.
  const clamped = createChannel(state, {
    channel: "biggest",
    role: "Coordinator",
    role_prompt: "c",
    session_id: "big1",
    project_id: PROJECT,
    worktree: WORKTREE,
    max_members: 100,
  })
  assert.equal(clamped.ok, true)
  assert.equal(state.channels["biggest"]!.max_members, 32)
})
