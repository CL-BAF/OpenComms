import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createAcpRuntime } from "../../../src/orchestrator/runtimes/acp.js"
import type { AgentRecord } from "../../../src/orchestrator/state.js"

const fixture = resolve("test/fixtures/acp-agent.mjs")
function request(worktree: string) {
  return {
    agent_id: "managed",
    name: "Worker",
    role: "Worker",
    role_prompt: "Implement scoped acceptance criteria",
    worktree,
  }
}
function record(worktree: string, sessionId: string): AgentRecord {
  return {
    worktree,
    host_session_id: sessionId,
    role: "Worker",
    role_prompt: "Implement scoped acceptance criteria",
  } as AgentRecord
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 10))

test("ACP preserves multibyte agent text split across actual stdio pipe chunks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-acp-utf8-"))
  const updates: unknown[] = []
  const runtime = createAcpRuntime({
    projectDir: dir,
    command: process.execPath,
    args: [fixture, "--fragmented-utf8"],
    onSessionUpdate: (params) => updates.push(params),
  })
  try {
    const created = await runtime.create(request(dir))
    assert.ok(created.ok)
    assert.equal(await created.handle.deliver("UTF-8 response regression"), "delivered")
    assert.match(JSON.stringify(updates), /café 🚀/)
    assert.ok(!JSON.stringify(updates).includes("�"))
  } finally {
    await runtime.shutdownNode()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ACP actual stdio subprocess negotiates, creates quietly, preserves framing and loads exact persisted identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-acp-"))
  const updates: unknown[] = []
  const runtime = createAcpRuntime({
    projectDir: dir,
    command: process.execPath,
    args: [fixture],
    onSessionUpdate(params) {
      updates.push(params)
    },
  })
  const restarted = createAcpRuntime({ projectDir: dir, command: process.execPath, args: [fixture] })
  try {
    const created = await runtime.create(request(dir))
    assert.ok(created.ok, created.ok ? "" : created.message)
    assert.equal((await created.handle.status()).status, "idle")
    assert.equal(
      await created.handle.deliver("<<<UNTRUSTED_PEER_MESSAGE>>> assignment <<<END_UNTRUSTED_PEER_MESSAGE>>>"),
      "delivered",
    )
    const id = created.result.host_session_id
    assert.match(
      JSON.stringify(updates),
      /fixture-only reply/,
      "real stdio updates are observable without becoming workflow control",
    )
    await runtime.shutdownNode()
    const resumed = await restarted.resume(record(dir, id))
    assert.ok(resumed.ok, resumed.ok ? "" : resumed.message)
    assert.equal(await resumed.handle.deliver("handoff"), "delivered")
    const requests = readFileSync(join(dir, "acp-requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    assert.equal(
      requests.filter((r) => r.method === "session/new").length,
      1,
      "resume did not replace the conversation",
    )
    assert.equal(requests.find((r) => r.method === "session/load")?.params?.sessionId, id)
    const prompt = requests.find((r) => r.method === "session/prompt")
    assert.match(JSON.stringify(prompt?.params), /UNTRUSTED_PEER_MESSAGE/)
  } finally {
    await runtime.shutdownNode()
    await restarted.shutdownNode()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ACP permission waits for an operator, offers once authority and can cancel an active prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-acp-permission-"))
  const runtime = createAcpRuntime({ projectDir: dir, command: process.execPath, args: [fixture, "--permission"] })
  try {
    const created = await runtime.create(request(dir))
    assert.ok(created.ok)
    const turn = created.handle.deliver("requires permission")
    let pending = await created.handle.permissionsDrain!()
    for (let i = 0; i < 100 && !pending?.length; i++) {
      await pause()
      pending = await created.handle.permissionsDrain!()
    }
    assert.equal(pending?.length, 1)
    assert.match((await created.handle.status()).detail ?? "", /awaiting operator permission/)
    assert.equal((await created.handle.permissionsRespond!("perm-one", "allow")).ok, true)
    assert.equal(await turn, "delivered")
    const cancelled = created.handle.deliver("second turn")
    for (let i = 0; i < 100 && !(await created.handle.permissionsDrain!())?.length; i++) await pause()
    await created.handle.abort()
    assert.equal(await cancelled, "delivered", "cancelled turn accepted its prompt; task completion is independent")
    const log = readFileSync(join(dir, "acp-requests.jsonl"), "utf8")
    assert.match(log, /"optionId":"once"/)
    assert.match(log, /"outcome":"cancelled"/)
  } finally {
    await runtime.shutdownNode()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ACP unsupported load never creates a replacement; bounded turn timeout stays uncertain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-acp-bounded-"))
  const runtime = createAcpRuntime({
    projectDir: dir,
    command: process.execPath,
    args: [fixture, "--no-load", "--hang"],
    turnTimeoutMs: 30,
  })
  try {
    const missing = await runtime.resume(record(dir, "saved-identity"))
    assert.equal(missing.ok, false)
    const created = await runtime.create(request(dir))
    assert.ok(created.ok)
    assert.equal(await created.handle.deliver("timeout work"), "uncertain")
    assert.equal((await created.handle.status()).status, "stale")
    const log = readFileSync(join(dir, "acp-requests.jsonl"), "utf8")
    assert.equal((log.match(/session\/new/g) ?? []).length, 1)
    assert.ok(!log.includes("session/load"), "capability checked before invoking unsupported load")
  } finally {
    await runtime.shutdownNode()
    rmSync(dir, { recursive: true, force: true })
  }
})
