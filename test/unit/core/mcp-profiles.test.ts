import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { once } from "node:events"
import { createMcpProfile, MCP_PROFILE_HOSTS } from "../../../src/integrations/mcp-profiles.js"
import { readAdapterResource } from "../../../src/cli/adapter-resources.js"
import { runCli } from "../../../src/cli/main.js"
import { createChannel, sendMessage } from "../../../src/core/engine.js"
import { StateStore } from "../../../src/core/store.js"

type Launch = { command: string; args: string[]; env: Record<string, string> }
function exportedLaunch(content: string, format: string): Launch {
  if (format === "json") return JSON.parse(content).mcpServers.opencomms as Launch
  // Goose's exported fragment uses documented YAML with JSON flow values.
  const field = (name: string) => JSON.parse(content.match(new RegExp(`^    ${name}: (.+)$`, "m"))![1]!) as unknown
  return {
    command: field("cmd") as string,
    args: field("args") as string[],
    env: field("envs") as Record<string, string>,
  }
}

for (const host of MCP_PROFILE_HOSTS) {
  test(`${host} exported profile launches actual standalone MCP, preserves host label and pulls framed mail`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-mcp-profile-"))
    const project = join(dir, "project with spaces")
    mkdirSync(project)
    const bundle = join(dir, "standalone server.mjs")
    writeFileSync(bundle, readAdapterResource("opencomms-mcp"))
    const profile = createMcpProfile({
      host,
      projectDir: project,
      memberId: "editor-member",
      serverPath: bundle,
      nodeCommand: process.execPath,
    })
    const launch = exportedLaunch(profile.content, profile.format)
    const store = new StateStore(project)
    const state = store.load()
    assert.equal(
      createChannel(state, {
        channel: "profiles",
        role: "Lead",
        role_prompt: "p",
        session_id: "lead",
        project_id: "local-project",
        worktree: project,
      }).ok,
      true,
    )
    store.save(state)
    const child = spawn(launch.command, launch.args, {
      cwd: dir,
      env: { ...process.env, ...launch.env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    const closed = once(child, "close")
    child.stderr.on("data", () => {})
    let next = 0
    const pending = new Map<
      number,
      {
        resolve(value: Record<string, unknown>): void
        reject(error: Error): void
        timer: ReturnType<typeof setTimeout>
      }
    >()
    const lines = createInterface({ input: child.stdout })
    lines.on("line", (line) => {
      const response = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown }
      const item = response.id === undefined ? undefined : pending.get(response.id)
      if (!item) return
      pending.delete(response.id!)
      clearTimeout(item.timer)
      if (response.error) item.reject(new Error(JSON.stringify(response.error)))
      else item.resolve(response.result ?? {})
    })
    const rpc = (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++next
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("Standalone profile MCP response timed out"))
        }, 10_000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
      })
    try {
      assert.ok(
        (
          await rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "profile-regression", version: "1" },
          })
        ).serverInfo,
      )
      const tools = (await rpc("tools/list", {})).tools as Array<{ name: string }>
      assert.ok(tools.some((tool) => tool.name === "opencomms_pull"))
      assert.ok(!tools.some((tool) => tool.name === "opencomms_kick"), "profile did not enable admin mode")
      const joined = await rpc("tools/call", {
        name: "opencomms_join",
        arguments: { channel: "profiles", role: "Worker", role_prompt: "p" },
      })
      assert.equal(joined.isError, false)
      const member = store.load().channels.profiles?.members.find((m) => m.session_id === "editor-member")
      assert.equal(member?.host, host, "host was not aliased to a different vendor")
      assert.equal(member?.host_session_id, null, "native conversation identity stays unknown")
      assert.equal(member?.delivery_mode, "pull")
      await store.withLock(() => {
        const queued = store.load()
        assert.equal(sendMessage(queued, { channel: "profiles", content: "manual-profile-peer-data" }, "lead").ok, true)
        store.save(queued)
      })
      const pulled = await rpc("tools/call", { name: "opencomms_pull", arguments: { channel: "profiles" } })
      assert.equal(pulled.isError, false)
      assert.match(JSON.stringify(pulled), /UNTRUSTED_PEER_MESSAGE/)
      assert.match(JSON.stringify(pulled), /manual-profile-peer-data/)
      assert.equal(Object.values(store.load().messages)[0]?.delivery_status, "delivered")
    } finally {
      for (const item of pending.values()) clearTimeout(item.timer)
      lines.close()
      child.stdin.end()
      child.kill()
      await closed
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("MCP profile CLI prints reviewable config without altering project files and rejects unsafe/missing inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-profile-cli-"))
  try {
    const bundle = join(dir, "server.mjs")
    writeFileSync(bundle, "// explicit server artifact")
    const result = runCli(["mcp-profile", "cursor", "--project", dir, "--server", bundle, "--id", "editor"])
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.output).mcpServers.opencomms.env.OPENCOMMS_MEMBER_ID, "editor")
    assert.deepEqual(readdirSync(dir), ["server.mjs"])
    assert.equal(runCli(["mcp-profile", "cursor", "--project", dir, "--id", "editor"]).code, 1)
    assert.equal(runCli(["mcp-profile", "cursor", "--project", dir, "--server", bundle, "--id", "../../other"]).code, 1)
    assert.equal(runCli(["mcp-profile", "unknown", "--project", dir, "--server", bundle, "--id", "editor"]).code, 1)
    assert.deepEqual(readdirSync(dir), ["server.mjs"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
