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
  commitDelivery,
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

  send(state, "sess_oc", "from opencode push")
  const ccPull = drainQueue(state, "sess_cc")
  assert.equal(ccPull.length, 1)
  assert.equal(ccPull[0]!.content, "from opencode push")

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
  const past = Date.now() - 6 * 60_000
  for (const m of Object.values(state.messages)) m.timestamp = past

  drainQueue(state, "sess_oc")
  const staleMsg = Object.values(state.messages).find((m) => m.recipient_session_id === "sess_oc")
  assert.equal(staleMsg!.delivery_status, "stale")

  const pulled = drainQueue(state, "sess_cd")
  assert.equal(pulled.length, 1)
  assert.equal(pulled[0]!.delivery_status, "in_flight")
  commitDelivery(
    state,
    "sess_cd",
    pulled.map((d) => d.message_id),
  )
  assert.equal(pulled[0]!.delivery_status, "delivered")
})

test("three-host channel: duplicate role rejected cross-host; targeted sends exact", () => {
  const state = emptyState()
  addHost(state, OPENCODE, "Builder")
  addHost(state, CLAUDE_DESKTOP, "Architect")
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
  addHost(state, CODEX, "Coder")

  send(state, "sess_oc", "for architect", "Architect")
  const drainDesktop = drainQueue(state, "sess_cd")
  assert.equal(drainDesktop.length, 1)

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
  const data = status(state, { channel: "x-ch" }).data as {
    channels: Array<{ members: Array<{ session_id: string }> }>
  }
  assert.equal(data.channels[0]!.members.length, 1)
  assert.equal(data.channels[0]!.members[0]!.session_id, "sess_oc")
  const inboxAttempt = inbox(state, { channel: "x-ch", session_id: "sess_cd" })
  assert.equal(inboxAttempt.ok, false)
})
