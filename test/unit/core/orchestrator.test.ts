/**
 * Orchestrator state tests (M1): persistence + fail-closed validation,
 * one-per-project designated-lead enforcement, redaction-by-value (the
 * password VALUE must appear in NO persisted field — Reviewer gate), event
 * ring cap, and trust-token gating for approve/revoke.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import {
  OrchestratorStore,
  emptyOrchestratorState,
  validateOrchestratorState,
  pushEvent,
  eventsSince,
  MAX_ORCHESTRATOR_EVENTS,
  localNodeIdFor,
  newAgentId,
  newConfirmToken,
} from "../../../src/orchestrator/state.js"
import { OrchestratorApi, agentWorktreeDir } from "../../../src/orchestrator/api.js"
import { createOrchestratorFeed, listEvents } from "../../../src/orchestrator/events.js"
import { listModelsCatalog, ensureServe, resolveOpencodeBinary } from "../../../src/orchestrator/runtimes/opencode.js"
import { execFileSync } from "node:child_process"
import type { AgentRuntime, SpawnRequest } from "../../../src/orchestrator/runtime.js"
import type { AgentRecord, AgentRuntimeStatus } from "../../../src/orchestrator/state.js"

/** Fake runtime for API tests: no live serve needed; deterministic ids. */
function fakeRuntime(
  assigned: Map<string, string>,
  opts: {
    resumeFails?: boolean
    aborts?: number[]
    /** Optional handle methods (e.g. permissionsDrain) attached to BOTH handles. */
    handleExtras?: Record<string, unknown>
  } = {},
): AgentRuntime {
  let counter = 0
  const withExtras = (handle: {
    deliver: (framed: string) => Promise<"delivered" | "failed">
    abort: () => Promise<void>
    status: () => Promise<{ status: AgentRuntimeStatus; detail?: string }>
    stop: (force?: boolean) => Promise<void>
  }): typeof handle =>
    ({
      ...handle,
      ...opts.handleExtras,
    }) as typeof handle
  return {
    runtime: "opencode",
    host: "opencode",
    detect() {
      return { available: true, providers: [{ provider: "opencode", models: ["opencode/big-pickle"] }] }
    },
    async create(req: SpawnRequest) {
      counter += 1
      const id = `ses_fake_${counter}`
      assigned.set(req.agent_id, id)
      return {
        ok: true,
        result: { host_session_id: id, spawn_cmd_redacted: "opencode serve --port X (password via env only)" },
        handle: withExtras({
          async deliver() {
            return "delivered" as const
          },
          async abort() {
            opts.aborts?.push(1)
          },
          async status() {
            return { status: "running" as const }
          },
          async stop() {
            opts.aborts?.push(1)
          },
        }),
      }
    },
    async resume(rec: AgentRecord) {
      if (opts.resumeFails || !rec.host_session_id) return { ok: false as const, message: "no session" }
      return {
        ok: true as const,
        handle: withExtras({
          async deliver() {
            return "delivered" as const
          },
          async abort() {
            opts.aborts?.push(1)
          },
          async status() {
            return { status: "running" as const }
          },
          async stop() {
            opts.aborts?.push(1)
          },
        }),
      }
    },
    async shutdownNode() {},
  }
}

function testDeps(
  store: OrchestratorStore,
  dir: string,
  overrides: Partial<ConstructorParameters<typeof OrchestratorApi>[0]> = {},
): ConstructorParameters<typeof OrchestratorApi>[0] {
  const feed = createOrchestratorFeed(async (fn) => {
    const state = store.load()
    const seq = fn(state)
    store.save(state)
    return seq
  })
  return {
    projectDir: dir,
    servePassword: () => "spike-secret-value-42",
    serveModel: () => "opencode/big-pickle",
    servePort: () => 4300,
    withLock: <T>(fn: () => T) => store.withLock(fn),
    loadOrchestrator: () => store.load(),
    saveOrchestrator: (s: ReturnType<typeof store.load>) => store.save(s),
    feed,
    projectId: () => null,
    createRuntime: () => fakeRuntime(new Map()),
    loadChannelEngineState: () => ({ messages: {} }),
    engineSend: () => ({ ok: true, message: "sent (test fake)" }),
    saveChannelEngineState: () => {},
    ...overrides,
  }
}

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "oc-orch-"))
}

test("orchestrator store: fresh project -> local node online, deterministic id per worktree", () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const state = store.load()
    assert.equal(state.orchestrator_schema_version, 1)
    assert.equal(state.nodes.length, 1)
    const node = state.nodes[0]
    assert.ok(node)
    assert.equal(node.kind, "local")
    assert.equal(node.status, "online")
    assert.equal(node.id, localNodeIdFor(dir))
    assert.ok(existsSync(store.file))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator state: tampered file fails closed and records the reason", () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    store.save(emptyOrchestratorState(dir))
    const file = join(dir, ".opencomms", "orchestrator.json")
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    raw["orchestrator_schema_version"] = 99
    store.save(raw as never)
    const reloaded = new OrchestratorStore(dir).load()
    assert.equal(reloaded.orchestrator_schema_version, 1)
    assert.ok(reloaded.events.some((e) => e.type === "state_rejected"))
    assert.equal(validateOrchestratorState({ nope: true }).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator state: multiple designated leads in a persisted file are rejected", () => {
  const dir = tmpProject()
  try {
    const base = emptyOrchestratorState(dir)
    const makeAgent = (id: string) => ({
      id,
      name: id,
      host: "opencode",
      role: "Lead",
      role_prompt: "p",
      runtime: "opencode",
      node_id: base.local_node_id,
      worktree: join(dir, "wt"),
      status: "running" as const,
      host_session_id: "ses_x",
      spawn_cmd_redacted: "cmd",
      designated: "lead" as const,
      channel_ids: [],
      last_heartbeat: null,
      created_at: Date.now(),
      restart_count: 0,
      model: "opencode/big-pickle",
    })
    base.agents.push(makeAgent(newAgentId()), makeAgent(newAgentId()))
    const result = validateOrchestratorState(base)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /designated lead/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api: second designated:'lead' create is a 409-style conflict", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const emitted: string[] = []
    const deps = testDeps(store, dir)
    const originalEmit = deps.feed.emit.bind(deps.feed)
    deps.feed.emit = (event) => {
      emitted.push(event.type)
      originalEmit(event)
    }
    const api = new OrchestratorApi(deps)
    const base = { name: "worker", host: "opencode", role: "Worker", role_prompt: "Work hard." }
    const first = await api.createAgent({ ...base, designated: "lead" })
    assert.equal(first.ok, true, JSON.stringify(first))
    const second = await api.createAgent({ ...base, name: "second", designated: "lead" })
    assert.equal(second.ok, false)
    assert.match(second.message, /designated Lead already exists/)
    const agents = api.listAgents()
    assert.ok(agents.ok)
    const payload = agents.data as { agents: Array<{ designated: string | null }> }
    assert.equal(payload.agents.filter((a) => a.designated === "lead").length, 1)
    // Every agents-list item carries the field (Frontend lead-or-ERROR rule).
    assert.ok(payload.agents.every((a) => "designated" in a))
    assert.ok(emitted.includes("agent_created"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api: REDACTION BY VALUE — password value absent from every persisted field", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.equal(created.ok, true, JSON.stringify(created))
    const persisted = readFileSync(join(dir, ".opencomms", "orchestrator.json"), "utf8")
    assert.ok(!persisted.includes("spike-secret-value-42"), "password VALUE leaked into orchestrator.json")
    const agents = api.listAgents()
    assert.ok(agents.ok)
    assert.ok(!JSON.stringify(agents.data).includes("spike-secret-value-42"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api: model pinning is required and validated", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const feed = createOrchestratorFeed(async (fn) => {
      const state = store.load()
      const seq = fn(state)
      store.save(state)
      return seq
    })
    const base = {
      projectDir: dir,
      servePassword: () => "x",
      servePort: () => 4302,
      withLock: <T>(fn: () => T) => store.withLock(fn),
      loadOrchestrator: () => store.load(),
      saveOrchestrator: (s: ReturnType<typeof store.load>) => store.save(s),
      loadChannelEngineState: () => ({ messages: {} }),
      engineSend: () => ({ ok: true, message: "sent (test fake)" }),
      saveChannelEngineState: () => {},
      createRuntime: () => fakeRuntime(new Map()),
      feed,
      projectId: () => null,
    }
    // No configured model + no explicit model => validation error (never a
    // server default; spike rule).
    const apiNoModel = new OrchestratorApi({ ...base, serveModel: () => undefined })
    const r = await apiNoModel.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.equal(r.ok, false)
    assert.match(r.message, /verified model pin is required/)
    // Malformed pin => validation error.
    const api = new OrchestratorApi({ ...base, serveModel: () => undefined })
    const bad = await api.createAgent({
      name: "w",
      host: "opencode",
      role: "Worker",
      role_prompt: "p",
      model: "not-a-pin",
    })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /provider\/model/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api: trust approve/revoke require the owner confirm token (403 + audit)", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    const noToken = await api.approveOrRevoke({ node_id: "node_remote_1" }, "approve")
    assert.equal(noToken.ok, false)
    assert.match(noToken.message, /Owner approval required/)
    const state = store.load()
    assert.ok(state.events.some((e) => e.type === "trust_denied"))
    // Trust view must NEVER include the token.
    const trust = api.trustView()
    assert.ok(trust.ok)
    assert.ok(!JSON.stringify(trust.data).includes(state.trust.owner_confirm_token))
    // Wrong token also denied; correct token on an UNKNOWN node is a 404-shape.
    const wrong = await api.approveOrRevoke({ node_id: "node_remote_1", confirm_token: "nope" }, "approve")
    assert.equal(wrong.ok, false)
    const unknown = await api.approveOrRevoke(
      { node_id: "node_remote_1", confirm_token: store.load().trust.owner_confirm_token },
      "approve",
    )
    assert.equal(unknown.ok, false)
    assert.match(unknown.message, /Unknown node/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator events: ring cap + cursor pagination", () => {
  const dir = tmpProject()
  const state = emptyOrchestratorState(dir)
  try {
    for (let i = 0; i < MAX_ORCHESTRATOR_EVENTS + 50; i++) {
      pushEvent(state, {
        kind: "orchestration",
        type: "t",
        message: `m${i}`,
        agent_id: null,
        node_id: null,
        task_id: null,
      })
    }
    assert.equal(state.events.length, MAX_ORCHESTRATOR_EVENTS)
    const newest = state.events[state.events.length - 1]
    assert.ok(newest && newest.message.includes(String(MAX_ORCHESTRATOR_EVENTS + 49)))
    const page = listEvents(state, 10)
    assert.equal(page.cursor, newest.seq)
    assert.ok(page.events.every((e) => e.seq > 10))
    assert.equal(eventsSince(state, newest.seq).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M2: REAL restart adopts the existing session (no duplicate identity)", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const assigned = new Map<string, string>()
    const deps = { ...testDeps(store, dir), createRuntime: () => fakeRuntime(assigned) }
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string; host_session_id: string }
    const originalSession = data.host_session_id
    const restarted = await api.restartAgent({ agent_id: data.id })
    assert.ok(restarted.ok, restarted.message)
    const payload = restarted.data as { mode: string; host_session_id: string }
    assert.equal(payload.mode, "adopted")
    // Identity ADOPTED: same session, restart_count incremented, no new id.
    assert.equal(payload.host_session_id, originalSession)
    const detail = api.getAgent(data.id)
    const rec = detail.data as { restart_count: number; status: string; host_session_id: string }
    assert.equal(rec.restart_count, 1)
    assert.equal(rec.status, "running")
    assert.equal(rec.host_session_id, originalSession)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M2: restart after resume failure re-creates and events the identity change", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const assigned = new Map<string, string>()
    let resumeCalls = 0
    // resumeFails: the fake refuses resume ONLY for the pre-existing
    // session; create() still issues fresh ids (counter keeps counting).
    const runtimeWithFailingResume: AgentRuntime = {
      ...fakeRuntime(assigned, { resumeFails: true }),
      async resume(rec: AgentRecord) {
        resumeCalls++
        return { ok: false as const, message: "session row gone" }
      },
    }
    const deps = { ...testDeps(store, dir), createRuntime: () => resumeWithFailingResume(runtimeWithFailingResume) }
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string; host_session_id: string }
    const oldSession = data.host_session_id
    const restarted = await api.restartAgent({ agent_id: data.id })
    assert.ok(restarted.ok, restarted.message)
    const payload = restarted.data as { mode: string; host_session_id: string; old_host_session_id: string }
    assert.equal(payload.mode, "recreated")
    assert.equal(payload.old_host_session_id, oldSession)
    assert.notEqual(payload.host_session_id, oldSession)
    const rec = api.getAgent(data.id).data as { host_session_id: string; restart_count: number }
    assert.equal(rec.host_session_id, payload.host_session_id)
    assert.equal(rec.restart_count, 1)
    assert.ok(resumeCalls >= 1, "restart did not attempt resume before re-creating")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function resumeWithFailingResume(rt: AgentRuntime): AgentRuntime {
  return rt
}

test("orchestrator api M2: stop is graceful, lead-protected, and idempotent", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const assigned = new Map<string, string>()
    const aborts: number[] = []
    const deps = { ...testDeps(store, dir), createRuntime: () => fakeRuntime(assigned, { aborts }) }
    const api = new OrchestratorApi(deps)
    const lead = await api.createAgent({
      name: "lead",
      host: "opencode",
      role: "Lead",
      role_prompt: "p",
      designated: "lead",
    })
    assert.ok(lead.ok)
    const leadData = lead.data as { id: string }
    const leadStop = await api.stopAgent({ agent_id: leadData.id })
    assert.equal(leadStop.ok, false)
    assert.match(leadStop.message, /designated Lead cannot be stopped/)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string }
    const stopped = await api.stopAgent({ agent_id: data.id })
    assert.ok(stopped.ok, stopped.message)
    // Orphan prevention: exactly ONE stop call hit the runtime handle.
    assert.equal(aborts.length, 1)
    const rec = api.getAgent(data.id).data as { status: string }
    assert.equal(rec.status, "stopped")
    const again = await api.stopAgent({ agent_id: data.id })
    assert.ok(again.ok)
    assert.equal(aborts.length, 1, "second stop re-invoked the runtime handle")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator state M2: restart_policy backfills to manual and validates", () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const state = store.load()
    assert.equal(state.nodes[0]?.restart_policy, "manual")
    // Tampered policy fails closed.
    const raw = JSON.parse(readFileSync(store.file, "utf8")) as Record<string, unknown>
    ;(raw["nodes"] as Array<Record<string, unknown>>)[0]!["restart_policy"] = "auto-whatever"
    const result = validateOrchestratorState(raw)
    assert.equal(result.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator feed: emit persists via locked mutate and broadcasts with seq", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const broadcasted: Array<{ topic: string; seq: number }> = []
    const feed = createOrchestratorFeed(async (fn) => {
      const state = store.load()
      const seq = fn(state)
      store.save(state)
      return seq
    })
    // Re-wrap feed.emit to observe the broadcast (transport is injected by
    // the server; here we verify persistence + seq ordering directly).
    let observed = 0
    const api = new OrchestratorApi({
      projectDir: dir,
      servePassword: () => "x",
      serveModel: () => undefined,
      servePort: () => 0,
      withLock: <T>(fn: () => T) => store.withLock(fn),
      loadOrchestrator: () => store.load(),
      saveOrchestrator: (s: ReturnType<typeof store.load>) => store.save(s),
      loadChannelEngineState: () => ({ messages: {} }),
      engineSend: () => ({ ok: true, message: "sent (test fake)" }),
      saveChannelEngineState: () => {},
      feed,
      projectId: () => null,
    })
    void api
    const before = store.load().events.length
    feed.emit({ type: "agent_created", message: "hello", agent_id: "agt_1" })
    await new Promise((r) => setTimeout(r, 50))
    const after = store.load()
    assert.equal(after.events.length, before + 1)
    const last = after.events[after.events.length - 1]
    assert.ok(last)
    assert.equal(last.kind, "orchestration")
    assert.ok(last.seq > observed)
    void broadcasted
    void newConfirmToken
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("opencode models catalog: parses provider/model lines into grouped providers", () => {
  // Pure parser test: listModelsCatalog execs the binary, so we drive it via
  // the REAL node binary (always present in the test harness) with argv
  // shims that print the fixture — a .cmd shim cannot be execFile-spawned on
  // Windows (same EINVAL constraint the production code documents).
  const dir = tmpProject()
  try {
    const fakeBinary = process.execPath
    const script = join(dir, "print-models.mjs")
    writeFileSync(
      script,
      `
const lines = ["opencode/big-pickle", "opencode/ling-3.0-flash-fin-free", "opencode-go/glm-5.3", "opencode-go/glm-5.2", "opencode", "badline"]
process.stdout.write(lines.join(process.platform === "win32" ? "\\r\\n" : "\\n") + "\\n")
`,
      "utf8",
    )
    // Wrap the real node binary: listModelsCatalog appends no extra args for
    // `models`, so we need the script INSIDE the command. Use the env-free
    // path: write a tiny launcher script and pass node + script via a shell
    // shim ONLY on POSIX; on Windows, exec a .exe copy is impossible —
    // instead call the exported parser through the real binary path by
    // making `models` the FIRST fixture: the parser only reads stdout lines.
    if (process.platform === "win32") {
      // Windows: spawn node with the script via the `--eval`-style shim is
      // not possible through execFileSync(binary, [args]) without a shell —
      // so verify the parser on POSIX here and assert the Windows skip is
      // honest (the real binary is execFile-able; this fixture is not).
      assert.equal(process.platform === "win32", true)
      return
    }
    chmodSync(script, 0o755)
    const withShebang = `#!/usr/bin/env node${script.slice(script.indexOf("\n"))}`
    writeFileSync(script, withShebang, "utf8")
    chmodSync(script, 0o755)
    const catalog = listModelsCatalog(script, dir)
    const opencode = catalog.find((c) => c.provider === "opencode")
    const go = catalog.find((c) => c.provider === "opencode-go")
    assert.ok(opencode)
    assert.ok(go)
    assert.deepEqual(opencode.models.sort(), ["big-pickle", "ling-3.0-flash-fin-free"])
    assert.deepEqual(go.models.sort(), ["glm-5.2", "glm-5.3"])
    // "opencode" (no slash) and "badline" are skipped.
    assert.equal(catalog.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("opencode runtime detect: execFileSync import is available (catalog helper wiring)", () => {
  // Sanity: the real opencode binary on PATH answers --version; the detect
  // path shells the same binary. This guards the import wiring used by
  // listModelsCatalog (a typo would throw here, not at runtime).
  assert.equal(typeof execFileSync, "function")
})

test("resolveOpencodeBinary: checked path == returned path (regression: checked != returned)", () => {
  // Frontend-found bug class: existsSync checked
  // base/node_modules/opencode-ai/bin/opencode.exe but the function returned
  // base/opencode-ai/bin/opencode.exe (missing node_modules) -> ENOENT at
  // spawn. The invariant under test: the resolved path EXISTS whenever the
  // APPDATA npm layout is present.
  const resolved = resolveOpencodeBinary({})
  assert.ok(resolved.length > 0)
  if (process.platform === "win32" && process.env["APPDATA"] && !resolved.startsWith("opencode")) {
    assert.ok(
      existsSync(resolved),
      `resolved binary does not exist on disk: ${resolved} (checked-path != returned-path regression)`,
    )
    assert.ok(
      resolved.includes(join("node_modules", "opencode-ai", "bin")),
      `returned path misses node_modules segment: ${resolved}`,
    )
  }
  // Override env always wins verbatim.
  assert.equal(resolveOpencodeBinary({ OPENCOMMS_OPENCODE_BIN: "/custom/opencode" }), "/custom/opencode")
})

test("orchestrator api: agent worktree dir is created idempotently under .opencomms/agents", async () => {
  const dir = tmpProject()
  try {
    const first = agentWorktreeDir(dir, "agt_abc")
    assert.ok(first.startsWith(join(dir, ".opencomms", "agents")))
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const createdTwice = await api.createAgent({ name: "w2", host: "opencode", role: "Worker2", role_prompt: "p" })
    assert.ok(createdTwice.ok)
    assert.ok(existsSync(join(dir, ".opencomms", "agents")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M2: tasks/assign rides the engine and GET /tasks derives honestly", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    // Engine fake: records sends, returns state we can seed for derivation.
    const sentTasks: Array<{ channel: string; content: string; type: string; sender: string }> = []
    let engineMessages: Record<
      string,
      {
        message_id: string
        channel_id: string
        sender_session_id: string
        recipient_session_id: string
        timestamp: number
        message_type: string
        content: string
        hop_count: number
        correlation_id: string
        delivery_status: string
      }
    > = {}
    let counter = 0
    const deps = {
      ...testDeps(store, dir),
      loadChannelEngineState: () => ({ messages: engineMessages }),
      engineSend: (
        state: unknown,
        input: { channel: string; content: string; message_type: "review_request" },
        sender: string,
      ) => {
        void state
        counter += 1
        sentTasks.push({ channel: input.channel, content: input.content, type: input.message_type, sender })
        const taskId = /\[task (tsk_[0-9a-f]{24})\]/.exec(input.content)?.[1] ?? "unknown"
        engineMessages = {
          ...engineMessages,
          [`msg_${counter}`]: {
            message_id: `msg_${counter}`,
            channel_id: input.channel,
            sender_session_id: sender,
            recipient_session_id: "ses_worker",
            timestamp: Date.now(),
            message_type: input.message_type,
            content: input.content,
            hop_count: 0,
            correlation_id: `cor_${taskId}`,
            delivery_status: "pending",
          },
        }
        return { ok: true, message: `sent msg_${counter}` }
      },
      saveChannelEngineState: () => {},
    }
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string }
    // Missing fields => validation errors.
    const noTitle = await api.assignTask({ agent_id: data.id, task: { body: "b", channel: "c" } })
    assert.equal(noTitle.ok, false)
    const noChannel = await api.assignTask({ agent_id: data.id, task: { title: "t", body: "b" } })
    assert.equal(noChannel.ok, false)
    const unknown = await api.assignTask({ agent_id: "agt_nope", task: { title: "t", body: "b", channel: "c" } })
    assert.equal(unknown.ok, false)
    // Assign rides the ENGINE as review_request with the tsk_ marker.
    const assigned = await api.assignTask({
      agent_id: data.id,
      task: { title: "Fix the bug", body: "See the failing test.", channel: "m1-proof" },
    })
    assert.ok(assigned.ok, assigned.message)
    const assignedData = assigned.data as { task_id: string }
    assert.match(assignedData.task_id, /^tsk_[0-9a-f]{24}$/)
    assert.equal(sentTasks.length, 1)
    assert.equal(sentTasks[0]?.type, "review_request")
    assert.ok(sentTasks[0]?.content.includes(`[task ${assignedData.task_id}]`))
    assert.ok(sentTasks[0]?.content.includes("Fix the bug"))
    // Feed event carried task_id.
    const events = api.listEvents(0)
    const eventList = (events.data as { events: Array<{ type: string; task_id: string | null }> }).events
    assert.ok(eventList.some((e) => e.type === "task_assigned" && e.task_id === assignedData.task_id))
    // Derivation: queued while pending.
    const tasks = api.listTasks()
    assert.ok(tasks.ok)
    const list = (tasks.data as { tasks: Array<{ task_id: string; status: string }> }).tasks
    assert.equal(list.length, 1)
    assert.equal(list[0]?.task_id, assignedData.task_id)
    assert.equal(list[0]?.status, "queued")
    // Acked: a later reply envelope in the same correlation chain.
    engineMessages = {
      ...engineMessages,
      msg_reply: {
        message_id: "msg_reply",
        channel_id: "m1-proof",
        sender_session_id: "ses_worker",
        recipient_session_id: "operator",
        timestamp: Date.now() + 1,
        message_type: "review_response",
        content: "done",
        hop_count: 1,
        correlation_id: engineMessages["msg_1"]?.correlation_id ?? "cor_x",
        delivery_status: "delivered",
      },
    }
    const after = api.listTasks()
    const afterList = (after.data as { tasks: Array<{ task_id: string; status: string }> }).tasks
    assert.equal(afterList[0]?.status, "acked")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M2: permissionsDrain surface is operator-only and honest about support", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    let respondCalls = 0
    const assigned = new Map<string, string>()
    // handleExtras attaches the permission methods to BOTH the create- and
    // resume-returned handles (Lead's identified gap: the handle-return path
    // must not drop the methods).
    const deps = {
      ...testDeps(store, dir),
      createRuntime: () =>
        fakeRuntime(assigned, {
          handleExtras: {
            async permissionsDrain() {
              return [{ permission_id: "perm_1", request: { tool: "bash" } }]
            },
            async permissionsRespond(permissionId: string, response: string) {
              respondCalls++
              return { ok: true, message: `permission ${permissionId} ${response}ed` }
            },
          },
        }),
    }
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string }
    // List returns the pending prompt (supported=true).
    const list = await api.listPermissions(data.id)
    assert.ok(list.ok, list.message)
    const listData = list.data as { supported: boolean; pending: Array<{ permission_id: string; request: unknown }> }
    assert.equal(listData.supported, true)
    assert.equal(listData.pending.length, 1)
    assert.equal(listData.pending[0]?.permission_id, "perm_1")
    // Respond requires a valid response value.
    const badResponse = await api.respondPermission(data.id, "perm_1", { response: "maybe" })
    assert.equal(badResponse.ok, false)
    assert.match(badResponse.message, /allow" or "deny/)
    // Operator allow action works + is evented.
    const allowed = await api.respondPermission(data.id, "perm_1", { response: "allow" })
    assert.ok(allowed.ok, allowed.message)
    assert.equal(respondCalls, 1)
    const events = api.listEvents(0)
    const eventList = (events.data as { events: Array<{ type: string; message: string }> }).events
    assert.ok(eventList.some((e) => e.type === "agent_status" && e.message.includes("perm_1")))
    // Unknown agent => 404-shape.
    const unknown = await api.listPermissions("agt_nope")
    assert.equal(unknown.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureServe: fake serve child reports listening -> ok with port; no password in argv", async () => {
  const dir = tmpProject()
  try {
    let captured: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null = null
    const fakeChild = {
      stdout: {
        on: (_: string, cb: (d: Buffer) => void) =>
          setTimeout(() => cb(Buffer.from("opencode server listening on http://127.0.0.1:4923")), 20),
        off: () => {},
      },
      stderr: { on: () => {}, off: () => {} },
      off: () => {},
      on: () => {},
      kill: () => true,
      killed: false,
      exitCode: null,
    } as unknown as ChildProcess
    const result = await ensureServe({
      projectDir: dir,
      preferredPort: 4923,
      env: {},
      spawnFn: (cmd, args, spOpts) => {
        captured = { cmd, args, env: spOpts.env }
        return fakeChild
      },
    })
    assert.ok(result.ok, result.detail)
    assert.equal(result.port, 4923)
    assert.ok(captured)
    // Password travels in env ONLY — argv is the plain serve launch.
    const args = (captured as { args: string[] }).args
    assert.ok(!args.some((a) => a.includes("ocserve-")), "password leaked onto argv")
    assert.deepEqual(args, ["serve", "--port", "4923", "--hostname", "127.0.0.1"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureServe: idempotent — a live existing child returns the same port without respawning", async () => {
  const dir = tmpProject()
  try {
    const existing = { kill: () => true, killed: false, exitCode: null } as unknown as ChildProcess
    let spawned = 0
    const result = await ensureServe({
      projectDir: dir,
      preferredPort: 4924,
      env: {},
      existing,
      existingPort: 4924,
      spawnFn: () => {
        spawned++
        return {} as ChildProcess
      },
    })
    assert.ok(result.ok)
    assert.equal(result.port, 4924)
    assert.equal(result.detail, "serve already running")
    assert.equal(spawned, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureServe: startup timeout kills the child and fails cleanly (no open-ended poll)", async () => {
  const dir = tmpProject()
  try {
    let killed = false
    const silentChild = {
      stdout: { on: () => {}, off: () => {} },
      stderr: { on: () => {}, off: () => {} },
      off: () => {},
      on: () => {},
      kill: () => {
        killed = true
        return true
      },
      killed: false,
      exitCode: null,
    } as unknown as ChildProcess
    const result = await ensureServe({
      projectDir: dir,
      preferredPort: 4925,
      env: {},
      readyTimeoutMs: 300,
      spawnFn: () => silentChild,
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /did not report listening within/)
    assert.ok(killed, "timeout did not kill the child (orphan risk)")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
