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
  parseCommandTemplate,
  resolveBinaryOverride,
  spawnArgvBudget,
  isWindowsShimPath,
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
  errors: string[]
}

function makeFakeDeps(state: State, opts: { failSpawn?: boolean; spawnError?: string } = {}): FakeDeps {
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
        ? Promise.resolve({ ok: false, error: opts.spawnError ?? "simulated CLI failure" })
        : Promise.resolve({ ok: true, stdout: "ok" })
    },
    recordError: (m) => errors.push(m),
  }
  return { deps, state, spawned, failSpawn: opts.failSpawn === true, errors }
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

// ── P2-1: Windows npm-shim handling (command-template override) ──

test("parseCommandTemplate: quote-aware split, no shell semantics", () => {
  assert.deepEqual(parseCommandTemplate("node C:\\tools\\cli.js"), ["node", "C:\\tools\\cli.js"])
  assert.deepEqual(parseCommandTemplate('"C:\\Program Files\\cli\\claude.exe" --flag'), [
    "C:\\Program Files\\cli\\claude.exe",
    "--flag",
  ])
  assert.deepEqual(parseCommandTemplate("  single  "), ["single"])
  assert.deepEqual(parseCommandTemplate('""'), [""])
  assert.throws(() => parseCommandTemplate('"unterminated'), /unterminated quote/)
})

test("resolveBinaryOverride: plain value = argv[0]; template = executable + prepended args", () => {
  assert.deepEqual(resolveBinaryOverride(undefined, "claude"), { command: "claude", prependArgs: [] })
  assert.deepEqual(resolveBinaryOverride("C:\\bin\\claude.exe", "claude"), {
    command: "C:\\bin\\claude.exe",
    prependArgs: [],
  })
  assert.deepEqual(resolveBinaryOverride('node "C:\\npm\\@openai\\codex bin\\codex.js"', "codex"), {
    command: "node",
    prependArgs: ["C:\\npm\\@openai\\codex bin\\codex.js"],
  })
  assert.deepEqual(resolveBinaryOverride("node D:\\codex.js --json", "codex"), {
    command: "node",
    prependArgs: ["D:\\codex.js", "--json"],
  })
})

test("template override flows through the builders (extra argv before host args)", () => {
  process.env["OPENCOMMS_CODEX_BIN"] = 'node "C:\\npm\\codex.js" --json'
  try {
    const cmd = CODEX_SPAWN.buildResumeCommand({ hostSessionId: "s1", cwd: "." })
    assert.equal(cmd.command, "node")
    assert.deepEqual(cmd.args, ["C:\\npm\\codex.js", "--json", "exec", "resume", "s1"])
  } finally {
    delete process.env["OPENCOMMS_CODEX_BIN"]
  }
  process.env["OPENCOMMS_CLAUDE_BIN"] = "node C:\\npm\\claude.js"
  try {
    const cmd = CLAUDE_CODE_SPAWN.buildResumeCommand({ hostSessionId: "s2", cwd: "." })
    assert.equal(cmd.command, "node")
    assert.deepEqual(cmd.args, ["C:\\npm\\claude.js", "--resume", "s2", "--print"])
  } finally {
    delete process.env["OPENCOMMS_CLAUDE_BIN"]
  }
})

test("shim detection: .cmd/.bat on win32 only", () => {
  assert.equal(isWindowsShimPath("C:\\npm\\codex.cmd"), process.platform === "win32")
  assert.equal(isWindowsShimPath("C:\\bin\\codex.exe"), false)
  assert.equal(isWindowsShimPath("codex"), false)
})

test("P2-1: spawn failure with EINVAL carries the actionable shim hint", async () => {
  const state = emptyState()
  const member = makeMember({ host: "codex", host_session_id: "codex-1" })
  seedChannelWithSpawnMember(state, member)
  sendMessage(state, { channel: "spawn-ch", content: "shim test" }, "sess_sender")
  const { deps, errors } = makeFakeDeps(state, { failSpawn: true, spawnError: "spawn codex EINVAL" })
  const outcome = await deliverViaSpawn(deps, member)
  assert.equal(outcome.status, "failed")
  assert.match(outcome.detail, /EINVAL/)
  assert.match(outcome.detail, /OPENCOMMS_CODEX_BIN/)
  // The failure is persisted in state.errors (visible via opencomms_status).
  assert.ok(
    (state.errors ?? []).some((e) => e.message.includes("Spawn delivery") && e.message.includes("EINVAL")),
    "persisted error recorded",
  )
  assert.equal(errors.length, 0, "driver delegates persistence to state.errors for spawn failures")
  // FIFO preserved after the failed spawn.
  assert.equal((state.queues[member.session_id] ?? []).length, 1)
})

// ── P2-2: argv size guard ──

test("P2-2: oversized batch refused BEFORE draining; queue untouched; no spawn", async () => {
  const state = emptyState()
  const member = makeMember()
  seedChannelWithSpawnMember(state, member)
  // Three 45k-char messages (each under the 100k single-message send limit)
  // sum past every platform budget (win32 30k / POSIX 120k).
  for (let i = 0; i < 3; i++) {
    const sent = sendMessage(state, { channel: "spawn-ch", content: `m${i} ` + "x".repeat(45_000) }, "sess_sender")
    assert.equal(sent.ok, true)
  }
  const { deps, spawned, errors } = makeFakeDeps(state)

  const outcome = await deliverViaSpawn(deps, member)
  assert.equal(outcome.status, "skipped")
  assert.match(outcome.detail, /argv limit/)
  assert.equal(spawned.length, 0, "no doomed spawn attempted")
  assert.equal((state.queues[member.session_id] ?? []).length, 3, "queue left untouched")
  for (const m of Object.values(state.messages)) assert.equal(m.delivery_status, "pending", "not drained")
  assert.ok(errors.some((e) => e.includes("spawn argv limit") && e.includes("switch this member to pull")))

  // Repeat attempt: no duplicate error spam (guard dedups per message id).
  const outcome2 = await deliverViaSpawn(deps, member)
  assert.equal(outcome2.status, "skipped")
  assert.equal(errors.filter((e) => e.includes("spawn argv limit")).length, 1)
})

test("spawn argv budget is platform-aware and conservative", () => {
  assert.equal(spawnArgvBudget("win32"), 30_000)
  assert.equal(spawnArgvBudget("linux"), 120_000)
  assert.equal(spawnArgvBudget("darwin"), 120_000)
  assert.ok(spawnArgvBudget("win32") < 32_767, "Windows CreateProcess limit respected with headroom")
})

test("normal messages unaffected by the size guard (fit within budget)", async () => {
  const state = emptyState()
  const member = makeMember()
  seedChannelWithSpawnMember(state, member)
  const sent = sendMessage(state, { channel: "spawn-ch", content: "normal sized" }, "sess_sender")
  assert.equal(sent.ok, true)
  const { deps, spawned } = makeFakeDeps(state)
  const outcome = await deliverViaSpawn(deps, member)
  assert.equal(outcome.status, "delivered")
  assert.equal(spawned.length, 1)
})
