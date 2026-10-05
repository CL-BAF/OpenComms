import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { OrchestratorApi } from "../../../src/orchestrator/api.js"
import { OrchestratorStore } from "../../../src/orchestrator/state.js"
import type { AgentHandle, AgentRuntime, SpawnRequest } from "../../../src/orchestrator/runtime.js"
import { createManagedWorktree } from "../../../src/orchestrator/worktrees.js"

function apiFor(dir: string) {
  const store = new OrchestratorStore(dir)
  const spawns: SpawnRequest[] = []
  let release: (() => void) | undefined
  let gate: Promise<void> | undefined
  const handle: AgentHandle = {
    async deliver() {
      return "delivered"
    },
    async abort() {},
    async stop() {},
    async status() {
      return { status: "idle" }
    },
  }
  const runtime: AgentRuntime = {
    runtime: "opencode",
    host: "opencode",
    detect() {
      return { available: true }
    },
    async create(req) {
      spawns.push(req)
      await gate
      return { ok: true, result: { host_session_id: `host-${spawns.length}`, spawn_cmd_redacted: "fixture" }, handle }
    },
    async resume() {
      return { ok: true, handle }
    },
    async shutdownNode() {},
  }
  const api = new OrchestratorApi({
    projectDir: dir,
    servePassword: () => "test-only",
    serveModel: () => "test/model",
    servePort: () => 1,
    withLock: (fn) => store.withLock(fn),
    loadOrchestrator: () => store.load(),
    saveOrchestrator: (state) => store.save(state),
    feed: { emit() {} },
    projectId: () => "test",
    createRuntime: () => runtime,
    loadChannelEngineState: () => ({ messages: {} }),
    saveChannelEngineState: () => {},
    engineSend: () => ({ ok: true, message: "test" }),
  })
  return {
    api,
    store,
    spawns,
    block() {
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    },
    unblock() {
      release?.()
    },
  }
}
const input = {
  name: "worker",
  host: "opencode",
  role: "Builder",
  role_prompt: "Build the requested scope",
  request_id: "durable-create",
}
function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim()
}

test("managed creation durably reserves an operation, rejects a concurrent retry and reuses its exact successful identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-create-idempotency-"))
  try {
    const fixture = apiFor(dir)
    fixture.block()
    const first = fixture.api.createAgent(input)
    while (fixture.spawns.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    const duplicate = await fixture.api.createAgent(input)
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.message, /No duplicate host session/)
    fixture.unblock()
    const created = await first
    assert.equal(created.ok, true)
    const retry = await fixture.api.createAgent(input)
    assert.equal(retry.ok, true)
    assert.equal(
      (retry.data as { host_session_id: string }).host_session_id,
      (created.data as { host_session_id: string }).host_session_id,
    )
    assert.equal(fixture.spawns.length, 1)
    assert.equal((await fixture.api.createAgent({ ...input, role_prompt: "Different work" })).ok, false)
    assert.equal((await fixture.api.createAgent({ ...input, request_id: "new-id", name: "WORKER" })).ok, false)
    assert.equal(fixture.store.load().agents.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("explicit managed isolation creates a real detached Git checkout of source HEAD and persists that runtime working directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-isolated-source-"))
  try {
    git(dir, ["init"])
    writeFileSync(join(dir, "source.txt"), "committed source")
    git(dir, ["add", "source.txt"])
    git(dir, [
      "-c",
      "user.name=OpenComms Test",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture source",
    ])
    const head = git(dir, ["rev-parse", "HEAD"])
    writeFileSync(join(dir, "source.txt"), "uncommitted source edit")
    const fixture = apiFor(dir)
    const created = await fixture.api.createAgent({
      ...input,
      isolated_worktree: true,
      required_capabilities: ["isolated_worktree", "identity"],
    })
    assert.equal(created.ok, true, created.message)
    const record = fixture.store.load().agents[0]!
    assert.ok(existsSync(join(record.worktree, ".git")))
    assert.equal(readFileSync(join(record.worktree, "source.txt"), "utf8"), "committed source")
    assert.equal(git(record.worktree, ["rev-parse", "HEAD"]), head)
    assert.equal(fixture.spawns[0]?.worktree, record.worktree)
    assert.equal(readFileSync(join(dir, "source.txt"), "utf8"), "uncommitted source edit")
    assert.throws(() => createManagedWorktree(dir, record.worktree), /already exists/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("nonGit isolation and unsupported required capabilities fail before runtime creation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-isolated-archive-"))
  try {
    const fixture = apiFor(dir)
    assert.equal((await fixture.api.createAgent({ ...input, isolated_worktree: true })).ok, false)
    assert.equal(fixture.spawns.length, 0)
    assert.equal(fixture.store.load().agents[0]?.status, "failed")
    assert.equal(
      (
        await fixture.api.createAgent({
          ...input,
          name: "unsupported",
          request_id: "capability",
          required_capabilities: ["cost"],
        })
      ).ok,
      false,
    )
    assert.equal(
      (
        await fixture.api.createAgent({
          ...input,
          name: "acp",
          host: "acp",
          request_id: "acp",
          required_capabilities: ["resume"],
        })
      ).ok,
      false,
    )
    assert.equal(fixture.spawns.length, 0)
    assert.equal(fixture.store.load().agents.length, 1, "capability gate writes no new agent records")
    assert.equal(
      (await fixture.api.createAgent({ ...input, name: "different-runtime", request_id: "runtime", runtime: "acp" }))
        .ok,
      false,
    )
    assert.equal(fixture.spawns.length, 0, "explicit runtime mismatch cannot silently choose a host")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
