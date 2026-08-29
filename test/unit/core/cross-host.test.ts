/**
 * Cross-host communication tests (Stage 10).
 *
 * Proves compatible host combinations communicate through the shared core
 * with explicit delivery modes — and that the mixed PUSH<->PULL drain
 * semantics hold in realistic interleavings.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createChannel,
  joinChannel,
  sendMessage,
  drainQueue,
  inbox,
  kickChannel,
  status,
} from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"

type CoreState = ReturnType<typeof emptyState>

const PROJECT = "proj-x"
const WORKTREE = "C:\\repo"

interface HostSpec {
  id: string
  host: string
  surface: "cli" | "desktop" | "mcp"
  deliveryMode: "push" | "pull"
  stalePolicy: { mode: "window"; window_ms: number } | { mode: "none"; window_ms: null }
}

const OPENCODE: HostSpec = {
  id: "sess_oc",
  host: "opencode",
  surface: "cli",
  deliveryMode: "push",
  stalePolicy: { mode: "window", window_ms: 5 * 60_000 },
}
const CLAUDE_CODE: HostSpec = {
  id: "sess_cc",
  host: "claude-code",
  surface: "mcp",
  deliveryMode: "pull",
  stalePolicy: { mode: "none", window_ms: null },
}
const CLAUDE_DESKTOP: HostSpec = {
  id: "sess_cd",
  host: "claude-desktop",
  surface: "desktop",
  deliveryMode: "pull",
  stalePolicy: { mode: "none", window_ms: null },
}
const CODEX: HostSpec = {
  id: "sess_cx",
  host: "codex",
  surface: "mcp",
  deliveryMode: "pull",
  stalePolicy: { mode: "none", window_ms: null },
}

function addHost(state: CoreState, spec: HostSpec, role: string, channel = "x-ch"): void {
  const isCreate = !state.channels[channel]
  const input = {
    channel,
    role,
    role_prompt: `role for ${spec.host}`,
    session_id: spec.id,
    project_id: PROJECT,
    worktree: WORKTREE,
    host: spec.host,
    surface: spec.surface,
    delivery_mode: spec.deliveryMode,
    host_session_id: `host-${spec.id}`,
    stale_policy: spec.stalePolicy,
  }
  const result = isCreate ? createChannel(state, input) : joinChannel(state, input)
  assert.equal(result.ok, true, `${spec.host} join failed: ${result.message}`)
}

function send(state: CoreState, from: string, content: string, to?: string): void {
  const result = sendMessage(state, { channel: "x-ch", content, to: to ?? null }, from)
  assert.equal(result.ok, true, `send from ${from} failed: ${result.message}`)
}

test("OpenCode PUSH <-> Claude Code PULL: mixed channel delivers both ways", () => {
  const state = emptyState()
  addHost(state, OPENCODE, "Builder")
  addHost(state, CLAUDE_CODE, "Reviewer")

  // OpenCode sends; the PULL member's copy waits for their hook/pull.
  send(state, "sess_oc", "from opencode push")
  const ccPull = drainQueue(state, "sess_cc")
  assert.equal(ccPull.length, 1)
  assert.equal(ccPull[0]!.content, "from opencode push")

  // Claude Code replies via its pinned member; PUSH member drains on idle.
  send(state, "sess_cc", "from claude code pull")
  const ocDrain = drainQueue(state, "sess_oc", { now: Date.now() })
  assert.equal(ocDrain.length, 1)
  assert.equal(
    ocDrain[0]!.content,
    "from opencode push".replace("opencode push", "") === "" ? ocDrain[0]!.content : "from claude code pull",
  )
})

test("PUSH<->PULL staleness boundary: age kills PUSH copies, PULL copies survive", () => {
  const state = emptyState()
  addHost(state, OPENCODE, "Builder")
  addHost(state, CLAUDE_DESKTOP, "Architect")

  send(state, "sess_oc", "to desktop")
  send(state, "sess_cd", "to opencode")
  // Age 6 minutes.
  const past = Date.now() - 6 * 60_000
  for (const m of Object.values(state.messages)) m.timestamp = past

  drainQueue(state, "sess_oc") // PUSH side: ages out
  const staleMsg = Object.values(state.messages).find((m) => m.recipient_session_id === "sess_oc")
  assert.equal(staleMsg!.delivery_status, "stale")

  const pulled = drainQueue(state, "sess_cd") // PULL side: still delivers
  assert.equal(pulled.length, 1)
  assert.equal(pulled[0]!.delivery_status, "delivered")
})

test("three-host channel: duplicate role rejected cross-host; targeted sends exact", () => {
  const state = emptyState()
  addHost(state, OPENCODE, "Builder")
  addHost(state, CLAUDE_DESKTOP, "Architect")
  // Codex tries to join under the held role "Builder" — rejected cross-host.
  const join = joinChannel(state, {
    channel: "x-ch",
    role: "Builder",
    role_prompt: "p",
    session_id: "sess_cx",
    project_id: PROJECT,
    worktree: WORKTREE,
    host: "codex",
    surface: "mcp",
    delivery_mode: "pull",
    host_session_id: "host-sess_cx",
    stale_policy: { mode: "none", window_ms: null },
  })
  assert.equal(join.ok, false, "duplicate role must be rejected across hosts")
  assert.match(join.message, /already held/)
  // A unique role joins fine.
  addHost(state, CODEX, "Coder")

  send(state, "sess_oc", "for architect", "Architect")
  const drainDesktop = drainQueue(state, "sess_cd")
  assert.equal(drainDesktop.length, 1)

  // Codex never received anything.
  assert.equal(state.queues["sess_cx"], undefined)
})

test("status exposes each participant's host/surface/delivery (channel status row)", () => {
  const state = emptyState()
  addHost(state, OPENCODE, "Builder")
  addHost(state, CLAUDE_DESKTOP, "Reviewer")
  const data = status(state, { channel: "x-ch" }).data as {
    channels: Array<{ members: Array<{ role: string; host: string; surface: string; delivery_mode: string }> }>
  }
  const members = data.channels[0]!.members
  assert.deepEqual(
    members.map((m) => `${m.role}:${m.host}:${m.surface}:${m.delivery_mode}`),
    ["Builder:opencode:cli:push", "Reviewer:claude-desktop:desktop:pull"],
  )
})

test("kick works cross-host: kicked MCP member's pin dies, PUSH side unaffected", () => {
  const state = emptyState()
  addHost(state, OPENCODE, "Builder")
  addHost(state, CLAUDE_DESKTOP, "Reviewer")
  const kick = kickChannel(state, { channel: "x-ch", session_id: "sess_oc", target_role: "Reviewer" })
  assert.equal(kick.ok, true)
  // Reviewer no longer in roster; Builder keeps the channel.
  const data = status(state, { channel: "x-ch" }).data as {
    channels: Array<{ members: Array<{ session_id: string }> }>
  }
  assert.equal(data.channels[0]!.members.length, 1)
  assert.equal(data.channels[0]!.members[0]!.session_id, "sess_oc")
  // And the kicked member's inbox access is gone.
  const inboxAttempt = inbox(state, { channel: "x-ch", session_id: "sess_cd" })
  assert.equal(inboxAttempt.ok, false)
})
