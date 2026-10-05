import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createHttpTransport, createOpencodeRuntime } from "../../../src/orchestrator/runtimes/opencode.js"
import type { AgentRecord } from "../../../src/orchestrator/state.js"

test("managed OpenCode verifies recorded identity, reads busy/idle and commits acceptance independently of work completion", async () => {
  let busy = true
  let accepts = 0
  let aborts = 0
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json")
    if (req.url === "/session/owned") return void res.end(JSON.stringify({ id: "owned" }))
    if (req.url === "/session/status") return void res.end(JSON.stringify(busy ? { owned: { type: "busy" } } : {}))
    if (req.url === "/session/owned/prompt_async" && req.method === "POST") {
      accepts++
      res.statusCode = 204
      return void res.end()
    }
    if (req.url === "/session/owned/abort") {
      aborts++
      res.statusCode = 503
      return void res.end(JSON.stringify({ message: "sensitive-host-output" }))
    }
    res.statusCode = 404
    res.end(JSON.stringify({ message: "sensitive-host-output" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const port = (server.address() as AddressInfo).port
    const runtime = createOpencodeRuntime({
      projectDir: process.cwd(),
      port,
      env: { OPENCOMMS_ORCH_SERVE_PASSWORD: "test-only-password" },
      transport: createHttpTransport(`http://127.0.0.1:${port}`, "test-only-password"),
    })
    const record = { host_session_id: "owned" } as AgentRecord
    const resumed = await runtime.resume(record)
    assert.equal(resumed.ok, true)
    assert.equal((await resumed.handle.status()).status, "running")
    busy = false
    assert.equal((await resumed.handle.status()).status, "idle", "host removes idle entries")
    assert.equal(await resumed.handle.deliver("framed assignment"), "delivered")
    assert.equal(accepts, 1)
    await assert.rejects(() => resumed.handle.stop(), /503/)
    assert.equal(aborts, 1)
    const missing = await runtime.resume({ host_session_id: "deleted" } as AgentRecord)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.ok(!missing.message.includes("sensitive-host-output"), "host response bodies are redacted")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("managed OpenCode retains an uncertain delivery after transport loss and distinguishes rejection", async () => {
  const runtime = createOpencodeRuntime({
    projectDir: process.cwd(),
    port: 1,
    env: { OPENCOMMS_ORCH_SERVE_PASSWORD: "test" },
    transport: {
      async createSession() {
        return { id: "owned" }
      },
      async messages() {
        return []
      },
      async prompt() {
        throw new Error("connection reset after submit")
      },
      async abort() {},
      async permissionsList() {
        return null
      },
      async permissionsRespond() {},
    },
  })
  const resumed = await runtime.resume({ host_session_id: "owned" } as AgentRecord)
  assert.ok(resumed.ok)
  assert.equal(await resumed.handle.deliver("assignment"), "uncertain")
  assert.equal((await resumed.handle.status()).status, "stale", "absence of a status API does not invent running")
})

test("managed OpenCode permissions use the official list/reply routes and restrict replies to the recorded session", async () => {
  let failList = false
  const replies: Array<{ path: string; body: unknown }> = []
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json")
    if (req.url === "/session/owned") return void res.end(JSON.stringify({ id: "owned" }))
    if (req.url === "/permission") {
      if (failList) {
        res.statusCode = 401
        return void res.end('{"secret":"never display host bodies"}')
      }
      return void res.end(
        JSON.stringify([
          { id: "p_ours", sessionID: "owned", permission: "bash" },
          { id: "p_other", sessionID: "another" },
        ]),
      )
    }
    if (req.url?.startsWith("/permission/") && req.method === "POST") {
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => {
        replies.push({ path: req.url!, body: JSON.parse(body) as unknown })
        res.end("true")
      })
      return
    }
    res.statusCode = 404
    res.end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const port = (server.address() as AddressInfo).port
    const transport = createHttpTransport(`http://127.0.0.1:${port}`, "test-only")
    assert.deepEqual(
      (await transport.permissionsList("owned"))?.map((row) => row.permission_id),
      ["p_ours"],
    )
    await assert.rejects(() => transport.permissionsRespond("owned", "p_other", "allow"), /not pending for this agent/)
    assert.equal(replies.length, 0, "other session's permission is never answered")
    await transport.permissionsRespond("owned", "p_ours", "allow")
    assert.deepEqual(replies, [{ path: "/permission/p_ours/reply", body: { reply: "once" } }])
    const runtime = createOpencodeRuntime({
      projectDir: process.cwd(),
      port,
      env: { OPENCOMMS_ORCH_SERVE_PASSWORD: "test-only" },
      transport,
    })
    const resumed = await runtime.resume({ host_session_id: "owned" } as AgentRecord)
    assert.ok(resumed.ok)
    failList = true
    await assert.rejects(
      () => resumed.handle.permissionsDrain!(),
      /failed \(401\)/,
      "authentication failure does not masquerade as unsupported permissions",
    )
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("managed OpenCode session creation and delivery carry the exact selected worktree directory", async () => {
  const directories: Array<string | null> = []
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture.invalid")
    directories.push(url.searchParams.get("directory"))
    res.setHeader("Content-Type", "application/json")
    if (url.pathname === "/session" && req.method === "POST") return void res.end('{"id":"isolated"}')
    if (url.pathname === "/session/isolated/prompt_async") {
      res.statusCode = 204
      return void res.end()
    }
    if (url.pathname === "/session/isolated") return void res.end('{"id":"isolated"}')
    res.statusCode = 404
    res.end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const worktree = "selected project with spaces/isolated"
    const runtime = createOpencodeRuntime({
      projectDir: "source-root",
      port: (server.address() as AddressInfo).port,
      env: { OPENCOMMS_ORCH_SERVE_PASSWORD: "test-only", OPENCOMMS_ORCH_SERVE_MODEL: "fixture/model" },
    })
    const created = await runtime.create({
      agent_id: "agent",
      name: "worker",
      role: "Builder",
      role_prompt: "Build scope",
      worktree,
    })
    assert.ok(created.ok)
    assert.equal(await created.handle.deliver("framed isolated assignment"), "delivered")
    const resumed = await runtime.resume({ host_session_id: "isolated", worktree } as AgentRecord)
    assert.ok(resumed.ok)
    assert.equal(await resumed.handle.deliver("resume isolated assignment"), "delivered")
    assert.deepEqual(directories, [worktree, worktree, worktree, worktree, worktree])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
