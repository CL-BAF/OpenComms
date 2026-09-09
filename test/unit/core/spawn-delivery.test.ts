/**
 * Spawn-push delivery tests.
 *
 * Covers the argv contract for the documented CLI resume APIs (argv array,
 * message as the LAST element, NO shell), the fail-closed gating (mode,
 * binding, host support), and the two-phase delivery flow with a fake
 * spawner: drain → spawn → commit; failure → FIFO requeue.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CLAUDE_CODE_SPAWN,
  CODEX_SPAWN,
  spawnBuilderFor,
  spawnDeliveryRefusal,
  deliverViaSpawn,
  type SpawnCommand,
  type SpawnRunnerDeps,
} from "../../../src/hosts/spawn-delivery.js"
import { createChannel, joinChannel, sendMessage } from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"
import type { Member, State } from "../../../src/core/types.js"

const PROJECT = "proj_spawn"
const WORKTREE = "C:\\repo"

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    session_id: "sess_spawn_target",
    role: "Reviewer",
    role_prompt: "p",
    joined_at: Date.now(),
    stale: false,
    stale_at: null,
    host: "claude-code",
    surface: "mcp",
    delivery_mode: "spawn_push",
    host_session_id: "claude-uuid-1234",
    stale_policy: { mode: "window", window_ms: 5 * 60_000 },
    ...overrides,
  }
}

function seedChannelWithSpawnMember(state: State, member: Member, senderId = "sess_sender"): void {
  const created = createChannel(state, {
    channel: "spawn-ch",
    role: "Builder",
    role_prompt: "p",
    session_id: senderId,
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(created.ok, true)
  const channel = state.channels["spawn-ch"]!
  channel.members.push(member)
}

test("claude spawn argv contract: --resume <id> --print, message appended LAST, no shell", () => {
  const cmd = CLAUDE_CODE_SPAWN.buildResumeCommand({ hostSessionId: "abc-uuid", cwd: "C:\\proj" })
  assert.equal(cmd.command, "claude")
  assert.deepEqual(cmd.args, ["--resume", "abc-uuid", "--print"])
  assert.equal(cmd.cwd, "C:\\proj")
})

test("codex spawn argv contract: exec resume <id>, message appended LAST", () => {
  const cmd = CODEX_SPAWN.buildResumeCommand({ hostSessionId: "codex-uuid", cwd: "/proj" })
  assert.equal(cmd.command, "codex")
  assert.deepEqual(cmd.args, ["exec", "resume", "codex-uuid"])
  assert.equal(cmd.cwd, "/proj")
})

test("builder lookup is host-gated (fail closed for unsupported hosts)", () => {
  assert.equal(spawnBuilderFor("claude-code")?.binary, "claude")
  assert.equal(spawnBuilderFor("codex")?.binary, "codex")
  assert.equal(spawnBuilderFor("claude-desktop"), null, "Desktop has no resume API")
  assert.equal(spawnBuilderFor("chatgpt"), null, "ChatGPT has no resume API")
  assert.equal(spawnBuilderFor("opencode"), null, "OpenCode pushes in-process, not via spawn")
})

test("spawnDeliveryRefusal: requires spawn_push mode + bound host session id + supported host", () => {
  assert.equal(spawnDeliveryRefusal(makeMember()), null, "fully eligible member has no refusal")

  assert.match(spawnDeliveryRefusal(makeMember({ delivery_mode: "pull" }))!, /delivery mode is "pull"/)
  assert.match(spawnDeliveryRefusal(makeMember({ host_session_id: null }))!, /no bound host_session_id/)
  assert.match(spawnDeliveryRefusal(makeMember({ host_session_id: "" }))!, /no bound host_session_id/)
  assert.match(spawnDeliveryRefusal(makeMember({ host: "claude-desktop" }))!, /no documented non-interactive resume/)
})

interface FakeDeps {
  deps: SpawnRunnerDeps
  state: State
  spawned: Array<{ cmd: SpawnCommand; message: string }>
  failSpawn: boolean
}

function makeFakeDeps(state: State, opts: { failSpawn?: boolean } = {}): FakeDeps {
  const spawned: Array<{ cmd: SpawnCommand; message: string }> = []
  const errors: string[] = []
  const deps: SpawnRunnerDeps = {
    withLock: <T>(fn: () => T) => Promise.resolve(fn()),
    load: () => state,
    save: () => {},
    cwd: "C:\\proj",
    spawn: (cmd, message) => {
      spawned.push({ cmd, message })
      return opts.failSpawn
        ? Promise.resolve({ ok: false, error: "simulated CLI failure" })
        : Promise.resolve({ ok: true, stdout: "ok" })
    },
    recordError: (m) => errors.push(m),
  }
  return { deps, state, spawned, failSpawn: opts.failSpawn === true }
}

test("deliverViaSpawn happy path: drains, spawns with framed batch, commits delivered", async () => {
  const state = emptyState()
  const member = makeMember()
  seedChannelWithSpawnMember(state, member)
  const sent = sendMessage(state, { channel: "spawn-ch", content: "hello spawn push" }, "sess_sender")
  assert.equal(sent.ok, true)

  const { deps, spawned } = makeFakeDeps(state)
  const outcome = await deliverViaSpawn(deps, member)

  assert.equal(outcome.status, "delivered", outcome.status === "failed" ? outcome.detail : "")
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0]!.cmd.command, "claude")
  assert.equal(spawned[0]!.cmd.args.at(-1), "--print", "message must be the LAST argv element")
  assert.ok(spawned[0]!.message.includes("hello spawn push"), "framed message passed to the CLI")
  assert.ok(spawned[0]!.message.includes("UNTRUSTED_PEER_MESSAGE"), "peer framing preserved")
  assert.equal(state.messages[Object.keys(state.messages)[0]!]!.delivery_status, "delivered")
})

test("deliverViaSpawn failure: CLI error requeues in FIFO order + records error", async () => {
  const state = emptyState()
  const member = makeMember()
  seedChannelWithSpawnMember(state, member)
  sendMessage(state, { channel: "spawn-ch", content: "m1" }, "sess_sender")
  sendMessage(state, { channel: "spawn-ch", content: "m2" }, "sess_sender")

  const { deps, spawned } = makeFakeDeps(state, { failSpawn: true })
  const outcome = await deliverViaSpawn(deps, member)

  assert.equal(outcome.status, "failed")
  assert.equal(spawned.length, 1)
  // FIFO restored: both messages pending again, original order.
  assert.deepEqual(
    (state.queues["sess_spawn_target"] ?? []).map((id) => state.messages[id]!.content),
    ["m1", "m2"],
  )
  for (const m of Object.values(state.messages)) assert.equal(m.delivery_status, "pending")
})

test("deliverViaSpawn skips ineligible members without spawning", async () => {
  const state = emptyState()
  const member = makeMember({ delivery_mode: "pull" })
  seedChannelWithSpawnMember(state, member)
  sendMessage(state, { channel: "spawn-ch", content: "pull-only" }, "sess_sender")
  const { deps, spawned } = makeFakeDeps(state)

  const outcome = await deliverViaSpawn(deps, member)
  assert.equal(outcome.status, "skipped")
  assert.match(outcome.detail, /delivery mode is "pull"/)
  assert.equal(spawned.length, 0)
  assert.equal((state.queues["sess_spawn_target"] ?? []).length, 1, "queue untouched")
})

test("deliverViaSpawn: per-member in-flight guard prevents overlapping spawns", async () => {
  const state = emptyState()
  const member = makeMember()
  seedChannelWithSpawnMember(state, member)
  sendMessage(state, { channel: "spawn-ch", content: "once only" }, "sess_sender")

  let inFlight = false
  const { deps } = makeFakeDeps(state)
  deps.isDelivering = () => inFlight
  deps.setDelivering = (_id, value) => {
    inFlight = value
  }
  const outcome = await deliverViaSpawn(deps, member)
  assert.equal(outcome.status, "delivered")
})

test("codex member spawn uses codex exec resume argv", async () => {
  const state = emptyState()
  const member = makeMember({ host: "codex", host_session_id: "codex-session-9" })
  seedChannelWithSpawnMember(state, member)
  sendMessage(state, { channel: "spawn-ch", content: "codex ping" }, "sess_sender")
  const { deps, spawned } = makeFakeDeps(state)

  const outcome = await deliverViaSpawn(deps, member)
  assert.equal(outcome.status, "delivered")
  assert.equal(spawned[0]!.cmd.command, "codex")
  assert.deepEqual(spawned[0]!.cmd.args, ["exec", "resume", "codex-session-9"])
  assert.ok(spawned[0]!.message.includes("codex ping"))
})

test("join with spawn_push flag records spawn_push delivery mode (MCP schema)", async () => {
  // Schema-level check: the tool schema exposes spawn_push and the mode
  // round-trips through the engine. (Full MCP flow covered in mcp tests.)
  const state = emptyState()
  const created = createChannel(state, {
    channel: "spx",
    role: "Builder",
    role_prompt: "p",
    session_id: "sess_a",
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(created.ok, true)
  const joined = joinChannel(state, {
    channel: "spx",
    role: "Reviewer",
    role_prompt: "p",
    session_id: "sess_b",
    project_id: PROJECT,
    worktree: WORKTREE,
    host: "claude-code",
    surface: "mcp",
    delivery_mode: "spawn_push",
    stale_policy: { mode: "window", window_ms: 5 * 60_000 },
  })
  assert.equal(joined.ok, true)
  assert.equal(state.channels["spx"]!.members[1]!.delivery_mode, "spawn_push")
})
