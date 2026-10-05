import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { geminiCliAdapter } from "../../../src/integrations/adapters/gemini-cli.js"
import { registerProjectMember } from "../../../src/adapters/claude-code/install.js"
import { StateStore } from "../../../src/core/store.js"
import { createChannel, joinChannel, sendMessage } from "../../../src/core/engine.js"

test("Gemini onboarding preserves settings, actual installed hook binds existing identity and receives framed mail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-gemini-"))
  const ctx = { projectDir: dir, currentVersion: "1.4.0" }
  try {
    mkdirSync(join(dir, ".gemini"))
    writeFileSync(
      join(dir, ".gemini/settings.json"),
      JSON.stringify({
        theme: "custom",
        mcpServers: { unrelated: { command: "existing" } },
        hooks: { BeforeAgent: [{ hooks: [{ name: "unrelated", type: "command", command: "existing-hook" }] }] },
      }),
    )
    const installed = await geminiCliAdapter.install(ctx)
    assert.equal(installed.ok, true, installed.warnings.join("; "))
    assert.equal((await geminiCliAdapter.detect(ctx)).status, "broken", "unconfigured member identity is explicit")
    assert.equal((await geminiCliAdapter.install(ctx)).ok, true, "repeat install is safe")
    const path = join(dir, ".gemini/settings.json")
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      theme: string
      mcpServers: Record<string, { env?: Record<string, string> }>
      hooks: Record<string, unknown[]>
    }
    assert.equal(config.theme, "custom")
    assert.ok(config.mcpServers.unrelated)
    assert.equal(config.hooks.BeforeAgent?.length, 2, "one owned hook; unrelated retained")
    config.mcpServers.opencomms!.env!.OPENCOMMS_MEMBER_ID = "gem-worker"
    writeFileSync(path, JSON.stringify(config))
    assert.equal((await geminiCliAdapter.detect(ctx)).status, "installed")
    const store = new StateStore(dir)
    const state = store.load()
    assert.equal(
      createChannel(state, {
        channel: "gemini",
        role: "Lead",
        role_prompt: "p",
        session_id: "lead",
        project_id: "p",
        worktree: dir,
      }).ok,
      true,
    )
    assert.equal(
      joinChannel(state, {
        channel: "gemini",
        role: "Worker",
        role_prompt: "p",
        session_id: "gem-worker",
        project_id: "p",
        worktree: dir,
        host: "gemini-cli",
        surface: "mcp",
        delivery_mode: "pull",
      }).ok,
      true,
    )
    assert.equal(sendMessage(state, { channel: "gemini", content: "gemini-adapter-mail" }, "lead").ok, true)
    store.save(state)
    assert.equal(registerProjectMember(dir, { host: "gemini-cli", memberId: "gem-worker" }).ok, true)
    const result = spawnSync(process.execPath, [join(dir, ".opencomms/gemini-cli-hooks.mjs")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
      input: JSON.stringify({ session_id: "gemini-user-existing-id", hook_event_name: "SessionStart", cwd: dir }),
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /UNTRUSTED_PEER_MESSAGE/)
    assert.match(result.stdout, /gemini-adapter-mail/)
    assert.equal(store.load().channels.gemini?.members[1]?.host_session_id, "gemini-user-existing-id")
    const removed = await geminiCliAdapter.uninstall!(ctx)
    assert.equal(removed.ok, true)
    assert.equal((await geminiCliAdapter.detect(ctx)).status, "absent")
    assert.ok(existsSync(join(dir, ".opencomms/state.json")), "project state survives uninstall")
    assert.ok(existsSync(join(dir, ".opencomms/opencomms-mcp.mjs")), "shared MCP artifact survives uninstall")
    const after = JSON.parse(readFileSync(path, "utf8")) as typeof config
    assert.ok(after.mcpServers.unrelated)
    assert.equal(after.hooks.BeforeAgent?.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Gemini malformed configuration refuses install with no partial files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-gemini-broken-"))
  try {
    mkdirSync(join(dir, ".gemini"))
    writeFileSync(join(dir, ".gemini/settings.json"), "{broken")
    const result = await geminiCliAdapter.install({ projectDir: dir, currentVersion: "1.4.0" })
    assert.equal(result.ok, false)
    assert.equal(existsSync(join(dir, ".opencomms")), false)
    assert.equal(readFileSync(join(dir, ".gemini/settings.json"), "utf8"), "{broken")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
