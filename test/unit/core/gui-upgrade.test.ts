/** Real backend + persistence exercised through both audited transports.
 * These checks do not claim live host interoperability or desktop packaging.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { startGuiServer, type GuiServerHandle } from "../../../src/gui/server.js"
import { dispatchBridgeCommand, runBridge, type BridgeDeps } from "../../../src/orchestrator/bridge.js"
import { StateStore } from "../../../src/core/store.js"
import { joinChannel } from "../../../src/core/engine.js"
import { OrchestratorStore, newAgentId, type AgentRecord } from "../../../src/orchestrator/state.js"
import type { ApiResult } from "../../../src/orchestrator/api.js"

async function withBackend(
  fn: (handle: GuiServerHandle, dir: string, native: BridgeDeps) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "oc-gui-upgrade-"))
  const dir = join(root, "project with spaces")
  mkdirSync(dir)
  const previous = process.env["OPENCOMMS_CONFIG_DIR"]
  process.env["OPENCOMMS_CONFIG_DIR"] = join(root, "app-config")
  const handle = await startGuiServer({ projectDir: dir, port: 0, hostname: "127.0.0.1" })
  try {
    const core = handle.bridgeDeps()
    assert.ok(core, "native bridge backend must exist for selected project")
    await fn(handle, dir, { ...core, getCoreDeps: handle.bridgeDeps, write: () => {}, error: () => {} })
  } finally {
    await handle.close()
    if (previous === undefined) delete process.env["OPENCOMMS_CONFIG_DIR"]
    else process.env["OPENCOMMS_CONFIG_DIR"] = previous
    rmSync(root, { recursive: true, force: true })
  }
}

let sequence = 0
const invoke = (deps: BridgeDeps, cmd: string, args: Record<string, unknown> = {}): Promise<ApiResult> =>
  dispatchBridgeCommand(deps, { id: `native-test-${++sequence}`, cmd, args })

const http = async (handle: GuiServerHandle, path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {
    status: response.status,
    payload: (await response.json()) as ApiResult & { request_id?: string; error?: { state: string } },
  }
}

async function joinMembers(
  dir: string,
  channel: string,
  ids = ["existing-lead", "existing-worker", "existing-reviewer"],
): Promise<void> {
  const store = new StateStore(dir)
  await store.withLock(() => {
    const state = store.load()
    for (const [index, session_id] of ids.entries()) {
      const result = joinChannel(state, {
        channel,
        role: ["Lead", "Worker", "Reviewer"][index]!,
        role_prompt: "Keep existing identity.",
        session_id,
        project_id: "gui-local-project",
        worktree: dir,
        host: "opencode",
        surface: "cli",
        delivery_mode: "pull",
        stale_policy: { mode: "none", window_ms: null },
      })
      assert.equal(result.ok, true, result.message)
    }
    store.save(state)
  })
}

function addAgent(dir: string, session_id: string, designated: "lead" | null = null): AgentRecord {
  const channelStore = new StateStore(dir)
  const store = new OrchestratorStore(dir, channelStore)
  const state = store.load()
  const agent: AgentRecord = {
    id: newAgentId(),
    name: designated ? "lead" : "worker",
    host: "opencode",
    role: designated ? "Lead" : "Worker",
    role_prompt: "Acceptance evidence is required.",
    runtime: "opencode",
    node_id: state.local_node_id,
    worktree: dir,
    status: "idle",
    host_session_id: session_id,
    spawn_cmd_redacted: "opencode serve",
    designated,
    channel_ids: ["work"],
    last_heartbeat: Date.now(),
    created_at: Date.now(),
    restart_count: 0,
    model: null,
  }
  state.agents.push(agent)
  store.save(state)
  return agent
}

test("GUI/native: creation budgets, existing identities, removal, pause, archive and resume persist through shared backend", async () => {
  await withBackend(async (handle, dir, native) => {
    const created = await invoke(native, "session_create", {
      name: "work",
      max_members: 4,
      rate_limit: 11,
      max_hops: 6,
      budgets: { max_runtime_ms: 180_000, max_delivered_messages: 7 },
    })
    assert.equal(created.ok, true, created.message)
    const store = new StateStore(dir)
    const channel = store.load().channels["work"]!
    assert.equal(channel.max_members, 4)
    assert.equal(channel.rate_limit, 11)
    assert.equal(channel.max_hops, 6)
    assert.deepEqual(channel.budgets, { max_runtime_ms: 180_000, max_delivered_messages: 7 })
    assert.equal(channel.members.length, 0)
    await joinMembers(dir, "work")
    const members = await invoke(native, "session_members", { name: "work" })
    const browserMembers = await http(handle, "/api/sessions/work/members")
    assert.deepEqual(JSON.parse(JSON.stringify(members.data)), browserMembers.payload.data)
    const nativeJoin = await invoke(native, "session_join_command", { name: "work", host: "codex" })
    const browserJoin = await http(handle, "/api/sessions/work/join-command?host=codex")
    assert.equal(nativeJoin.ok, true, nativeJoin.message)
    assert.deepEqual(nativeJoin.data, browserJoin.payload.data)
    const removed = await invoke(native, "member_remove", { name: "work", target_session_id: "existing-reviewer" })
    assert.equal(removed.ok, true, removed.message)
    assert.deepEqual(
      store.load().channels["work"]!.members.map((member) => member.session_id),
      ["existing-lead", "existing-worker"],
    )
    assert.equal((await invoke(native, "session_pause", { name: "work" })).ok, true)
    assert.equal(store.load().channels["work"]!.paused, true)
    assert.equal((await http(handle, "/api/sessions/work/unpause", "POST")).payload.ok, true)
    assert.equal(store.load().channels["work"]!.paused, false)
    const saved = await invoke(native, "session_save", { name: "work", summary: "Acceptance evidence preserved." })
    assert.equal(saved.ok, true, saved.message)
    assert.equal(store.load().channels["work"], undefined)
    const resumed = await invoke(native, "session_resume", { name: "work", new_name: "next" })
    assert.equal(resumed.ok, true, resumed.message)
    assert.notEqual(store.load().channels["next"]!.id, channel.id)
    assert.equal(store.load().channels["next"]!.members.length, 0)
    const sessions = await http(handle, "/api/sessions")
    assert.equal(
      (sessions.payload.data as { archived: Array<{ summary: string }> }).archived[0]?.summary,
      "Acceptance evidence preserved.",
    )
  })
})

test("GUI/native: one established bridge follows project selection without leaking context or writes to previous project", async () => {
  await withBackend(async (handle, first, native) => {
    assert.equal((await invoke(native, "session_create", { name: "first-only" })).ok, true)
    const decision = await invoke(native, "context_add", {
      kind: "decision",
      status: "accepted",
      title: "First project",
      body: "Keep first boundary.",
      references: [],
    })
    assert.equal(decision.ok, true, decision.message)
    const second = join(first, "..", "second project")
    mkdirSync(second)
    assert.equal((await invoke(native, "workspace_select", { path: second })).ok, true)
    assert.equal((await invoke(native, "session_create", { name: "second-only" })).ok, true)
    const secondContext = await invoke(native, "context_list")
    assert.equal(secondContext.ok, true, secondContext.message)
    assert.ok(!JSON.stringify(secondContext.data).includes("Keep first boundary."))
    assert.equal(
      (
        await invoke(native, "context_add", {
          kind: "constraint",
          status: "accepted",
          title: "Second project",
          body: "Keep second boundary.",
          references: [],
        })
      ).ok,
      true,
    )
    assert.deepEqual(Object.keys(new StateStore(first).load().channels), ["first-only"])
    assert.deepEqual(Object.keys(new StateStore(second).load().channels), ["second-only"])
    assert.equal((await invoke(native, "workspace_select", { path: first })).ok, true)
    const firstContext = await invoke(native, "context_list")
    assert.ok(JSON.stringify(firstContext.data).includes("Keep first boundary."))
    assert.ok(!JSON.stringify(firstContext.data).includes("Keep second boundary."))
    assert.equal((await http(handle, "/api/workspace")).payload.ok, true)
  })
})

test("GUI/native: operator assignment in a three-member channel targets the worker, and stable retry sends once", async () => {
  await withBackend(async (handle, dir, native) => {
    assert.equal((await invoke(native, "session_create", { name: "work" })).ok, true)
    await joinMembers(dir, "work")
    const agent = addAgent(dir, "existing-worker")
    const assignment = {
      agent_id: agent.id,
      request_id: "stable-assignment",
      task: {
        title: "Fix attack behavior",
        body: "Reproduce and fix the attack range.",
        channel: "work",
        acceptance_criteria: ["Attack starts inside range and stops outside range."],
        ownership: ["src/entity"],
      },
    }
    const assigned = await invoke(native, "task_assign", assignment)
    assert.equal(assigned.ok, true, assigned.message)
    const replay = await http(handle, "/api/orchestrator/tasks/assign", "POST", assignment)
    assert.equal(replay.payload.ok, true, replay.payload.message)
    assert.equal((replay.payload.data as { replayed: boolean }).replayed, true)
    const channelState = new StateStore(dir).load()
    const assignments = Object.values(channelState.messages).filter(
      (message) => message.message_type === "review_request",
    )
    assert.equal(assignments.length, 1)
    assert.equal(assignments[0]!.recipient_session_id, "existing-worker")
    assert.equal((channelState.queues["existing-lead"] ?? []).length, 0)
    assert.equal((channelState.queues["existing-reviewer"] ?? []).length, 0)
    const taskId = (assigned.data as { task_id: string }).task_id
    const task = await invoke(native, "task_get", { task_id: taskId })
    assert.equal((task.data as { task: { execution_state: string } }).task.execution_state, "assigned")
    const premature = await invoke(native, "task_transition", {
      task_id: taskId,
      state: "verified_complete",
      expected_revision: 1,
      actor_id: "reviewer",
    })
    assert.equal(premature.ok, false, "assignment or delivery does not establish verified execution")
  })
})

test("GUI/native: coordination stop remains available when the designated Lead is present", async () => {
  await withBackend(async (_handle, dir, native) => {
    assert.equal((await invoke(native, "session_create", { name: "work" })).ok, true)
    await joinMembers(dir, "work")
    const lead = addAgent(dir, "existing-lead", "lead")
    const stopped = await invoke(native, "emergency_stop", { interrupt_managed: false })
    assert.equal(stopped.ok, true, stopped.message)
    assert.equal(new StateStore(dir).load().channels["work"]!.paused, true)
    assert.equal(
      new OrchestratorStore(dir, new StateStore(dir)).load().agents.find((agent) => agent.id === lead.id)?.status,
      "idle",
      "delivery-only stop preserves linked and managed host state",
    )
    const resumed = await invoke(native, "emergency_stop", { resume: true })
    assert.equal(resumed.ok, true, resumed.message)
    assert.equal(new StateStore(dir).load().channels["work"]!.paused, false)
  })
})

test("GUI/native: emergency coordination stop gates assignment even if a channel is individually unpaused", async () => {
  await withBackend(async (_handle, dir, native) => {
    assert.equal((await invoke(native, "session_create", { name: "work" })).ok, true)
    await joinMembers(dir, "work")
    const agent = addAgent(dir, "existing-worker")
    assert.equal((await invoke(native, "emergency_stop", { interrupt_managed: false })).ok, true)
    assert.equal((await invoke(native, "session_unpause", { name: "work" })).ok, true)
    const rejected = await invoke(native, "task_assign", {
      agent_id: agent.id,
      task: { title: "Do not start", body: "Coordination must resume explicitly.", channel: "work" },
    })
    assert.equal(rejected.ok, false, "native assignment must share the server coordination stop guard")
    assert.match(rejected.message, /stopped|resume|paused/i)
    assert.equal(
      Object.values(new StateStore(dir).load().messages).filter((message) => message.message_type === "review_request")
        .length,
      0,
    )
  })
})

test("GUI/native: emergency state follows the project and cannot unpause a same-named session in another project", async () => {
  await withBackend(async (_handle, first, native) => {
    const second = join(first, "..", "second emergency project")
    mkdirSync(second)
    assert.equal((await invoke(native, "session_create", { name: "work" })).ok, true)
    assert.equal((await invoke(native, "session_create", { name: "already-paused" })).ok, true)
    assert.equal((await invoke(native, "session_pause", { name: "already-paused" })).ok, true)
    assert.equal((await invoke(native, "emergency_stop", { interrupt_managed: false })).ok, true)
    assert.equal((await invoke(native, "workspace_select", { path: second })).ok, true)
    assert.equal(
      ((await invoke(native, "capabilities")).data as { coordination_stopped: boolean }).coordination_stopped,
      false,
    )
    assert.equal((await invoke(native, "session_create", { name: "work" })).ok, true)
    assert.equal(new StateStore(second).load().channels["work"]!.paused, false)
    assert.equal((await invoke(native, "emergency_stop", { interrupt_managed: false })).ok, true)
    assert.equal((await invoke(native, "workspace_select", { path: first })).ok, true)
    assert.equal(
      ((await invoke(native, "capabilities")).data as { coordination_stopped: boolean }).coordination_stopped,
      true,
    )
    assert.equal((await invoke(native, "emergency_stop", { resume: true })).ok, true)
    assert.equal(new StateStore(first).load().channels["work"]!.paused, false)
    assert.equal(new StateStore(first).load().channels["already-paused"]!.paused, true)
    assert.equal(new StateStore(second).load().channels["work"]!.paused, true)
    assert.equal((await invoke(native, "workspace_select", { path: second })).ok, true)
    assert.equal(
      ((await invoke(native, "capabilities")).data as { coordination_stopped: boolean }).coordination_stopped,
      true,
    )
    assert.equal((await invoke(native, "emergency_stop", { resume: true })).ok, true)
    assert.equal(new StateStore(second).load().channels["work"]!.paused, false)
  })
})

test("GUI/native: a pending native mutation blocks concurrent HTTP project switching", async () => {
  await withBackend(async (handle, dir, _native) => {
    const current = handle.bridgeDeps()!
    assert.ok(current.withMutation, "both transports must share the native mutation lifetime hook")
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const controlled: BridgeDeps = {
      ...current,
      guiWrites: {
        ...current.guiWrites,
        agentCreate: async () => {
          started()
          await waiting
          return { ok: true, message: "Host operation completed in its original project." }
        },
      },
      write: () => {},
      error: () => {},
    }
    const pending = invoke(controlled, "agent_create", { name: "controlled" })
    await began
    try {
      const second = join(dir, "..", "racing project")
      mkdirSync(second)
      const switched = await http(handle, "/api/workspace", "POST", { path: second })
      assert.equal(switched.payload.ok, false)
      assert.match(switched.payload.message, /pending|wait|operation/i)
      const workspace = await http(handle, "/api/workspace")
      assert.equal((workspace.payload.data as { current_project: string }).current_project, dir)
    } finally {
      release()
      await pending
    }
  })
})

test("GUI/native: emergency coordination state and prior pauses survive a coordinator restart", async () => {
  await withBackend(async (handle, dir, native) => {
    assert.equal((await invoke(native, "session_create", { name: "work" })).ok, true)
    assert.equal((await invoke(native, "session_create", { name: "already-paused" })).ok, true)
    assert.equal((await invoke(native, "session_pause", { name: "already-paused" })).ok, true)
    await joinMembers(dir, "work")
    const agent = addAgent(dir, "existing-worker")
    assert.equal((await invoke(native, "emergency_stop", { interrupt_managed: false })).ok, true)
    await handle.close()
    const restarted = await startGuiServer({ projectDir: dir, port: 0, hostname: "127.0.0.1" })
    try {
      const current = restarted.bridgeDeps()!
      const restored: BridgeDeps = { ...current, getCoreDeps: restarted.bridgeDeps, write: () => {}, error: () => {} }
      assert.equal(
        ((await invoke(restored, "capabilities")).data as { coordination_stopped: boolean }).coordination_stopped,
        true,
      )
      const denied = await invoke(restored, "task_assign", {
        agent_id: agent.id,
        task: { title: "Wait for resume", body: "Emergency state is durable.", channel: "work" },
      })
      assert.equal(denied.ok, false)
      assert.match(denied.message, /resume|stopped/i)
      assert.equal((await invoke(restored, "emergency_stop", { resume: true })).ok, true)
      assert.equal(new StateStore(dir).load().channels["work"]!.paused, false)
      assert.equal(new StateStore(dir).load().channels["already-paused"]!.paused, true)
    } finally {
      await restarted.close()
    }
  })
})

test("GUI/native: remote and inactive permission capability matches the enforced host boundary", async () => {
  await withBackend(async (handle, dir, native) => {
    assert.equal((await invoke(native, "session_create", { name: "work" })).ok, true)
    await joinMembers(dir, "work")
    const remote = addAgent(dir, "existing-worker")
    const inactive = addAgent(dir, "existing-reviewer")
    const store = new OrchestratorStore(dir, new StateStore(dir))
    await store.withLock(() => {
      const state = store.load()
      state.agents.find((agent) => agent.id === remote.id)!.node_id = "node_remote_fixture"
      state.agents.find((agent) => agent.id === inactive.id)!.status = "stopped"
      store.save(state)
    })
    const nativeCaps = await invoke(native, "capabilities")
    const browserCaps = await http(handle, "/api/capabilities")
    assert.deepEqual(nativeCaps.data, browserCaps.payload.data)
    const caps = nativeCaps.data as {
      agents: Record<string, { permissions: string; permissions_detail: string }>
      actions: Record<string, { state: string }>
    }
    assert.equal(caps.agents[remote.id]!.permissions, "unsupported")
    assert.match(caps.agents[remote.id]!.permissions_detail, /actual host|remote runtime/i)
    assert.equal(caps.agents[inactive.id]!.permissions, "temporarily_unavailable")
    assert.equal(caps.actions["task_assign"]!.state, "not_configured", "remote records are not local workers")
    const listed = await invoke(native, "permissions_list", { agent_id: remote.id })
    assert.equal((listed.data as { supported: boolean }).supported, false)
    const response = await http(handle, `/api/orchestrator/agents/${remote.id}/permissions/pending`, "POST", {
      response: "allow",
    })
    assert.equal(response.payload.ok, false)
    assert.equal(response.payload.error?.state, "unsupported", "HTTP preserves explicit capability refusal")
    assert.match(response.payload.message, /remote.*unsupported|actual host/i)
  })
})

test("GUI/native: capability negotiation names supported actions and failures retain actionable correlation", async () => {
  await withBackend(async (handle, _dir, native) => {
    const capabilities = await invoke(native, "capabilities")
    assert.equal(capabilities.ok, true)
    const browserCapabilities = await http(handle, "/api/capabilities")
    assert.deepEqual(capabilities.data, browserCapabilities.payload.data)
    const written: string[] = []
    await runBridge(
      { ...native, write: (line) => written.push(line) },
      Readable.from([
        '{"hello_ok":true}\n',
        '{"id":"invalid-create","cmd":"session_create","args":{"name":"invalid space"}}\n',
      ]),
    )
    const result = JSON.parse(written[1]!) as {
      ok: boolean
      request_id: string
      operation: string
      error: { state: string; recovery: string }
    }
    assert.equal(result.ok, false)
    assert.equal(result.request_id, "invalid-create")
    assert.equal(result.operation, "session_create")
    assert.equal(result.error.state, "execution_failed")
    assert.ok(result.error.recovery)
    const browserError = await http(handle, "/api/sessions", "POST", { name: "invalid space" })
    assert.equal(browserError.payload.error?.state, "execution_failed")
    assert.ok(browserError.payload.request_id)
  })
})
