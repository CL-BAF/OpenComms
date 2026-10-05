import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { installClaudeCode, registerProjectMember } from "../../../src/adapters/claude-code/install.js"
import { installCodex } from "../../../src/adapters/codex/install.js"
import { StateStore } from "../../../src/core/store.js"
import { createChannel, joinChannel, sendMessage } from "../../../src/core/engine.js"
import { claudeCodeAdapter } from "../../../src/integrations/adapters/claude-code.js"
import { codexAdapter } from "../../../src/integrations/adapters/codex.js"

test("installed Claude hook runs without subcommand, binds identity and delivers framed queued mail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-installed-hook-"))
  try {
    const installed = installClaudeCode(dir)
    assert.equal(installed.ok, true, installed.warnings.join("; "))
    const store = new StateStore(dir)
    const state = store.load()
    assert.equal(
      createChannel(state, {
        channel: "installed",
        role: "Lead",
        role_prompt: "p",
        session_id: "lead",
        project_id: "project",
        worktree: dir,
      }).ok,
      true,
    )
    assert.equal(
      joinChannel(state, {
        channel: "installed",
        role: "Worker",
        role_prompt: "p",
        session_id: "worker",
        project_id: "project",
        worktree: dir,
        host: "claude-code",
        surface: "mcp",
        delivery_mode: "pull",
      }).ok,
      true,
    )
    assert.equal(sendMessage(state, { channel: "installed", content: "installed-hook-round-trip" }, "lead").ok, true)
    store.save(state)
    assert.equal(registerProjectMember(dir, { host: "claude-code", memberId: "worker" }).ok, true)
    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    assert.ok(settings.hooks.SessionStart?.[0]?.hooks[0]?.command.includes("claude-code-hooks.mjs"))
    const result = spawnSync(process.execPath, [join(dir, ".opencomms/claude-code-hooks.mjs")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
      input: JSON.stringify({ session_id: "real-host-identity", hook_event_name: "SessionStart", cwd: dir }),
      env: { ...process.env, OPENCOMMS_MEMBER_ID: "worker" },
    })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } }
    assert.match(output.hookSpecificOutput?.additionalContext ?? "", /UNTRUSTED_PEER_MESSAGE/)
    assert.match(output.hookSpecificOutput?.additionalContext ?? "", /installed-hook-round-trip/)
    const persisted = store.load()
    assert.equal(persisted.channels.installed?.members[1]?.host_session_id, "real-host-identity")
    assert.equal(Object.values(persisted.messages)[0]?.delivery_status, "delivered")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("installed Codex MCP artifact answers JSON-RPC outside the package directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-installed-mcp-"))
  try {
    const installed = installCodex(dir)
    assert.equal(installed.ok, true, installed.warnings.join("; "))
    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "installed-test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]
    const result = spawnSync(process.execPath, [join(dir, ".opencomms/opencomms-mcp.mjs"), dir, "--host", "codex"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 20_000,
      input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
      env: { ...process.env, OPENCOMMS_NO_SPAWN: "1" },
    })
    assert.equal(result.status, 0, result.stderr)
    const responses = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: number; result?: { tools?: Array<{ name: string }> } })
    assert.ok(responses.find((r) => r.id === 1)?.result, "initialize answered")
    assert.ok(
      responses.find((r) => r.id === 2)?.result?.tools?.some((t) => t.name === "opencomms_pull"),
      "pull tool is usable",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("uninstalling either CLI retains the shared MCP bundle required by the other host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-shared-adapters-"))
  const context = { projectDir: dir, currentVersion: "1.4.0" }
  try {
    assert.equal(installClaudeCode(dir).ok, true)
    assert.equal(installCodex(dir).ok, true)
    assert.equal((await codexAdapter.uninstall!(context)).ok, true)
    assert.ok(existsSync(join(dir, ".opencomms/opencomms-mcp.mjs")))
    assert.equal(
      (await codexAdapter.detect(context)).status,
      "absent",
      "retained shared resource is not a Codex installation",
    )
    assert.equal(installCodex(dir).ok, true)
    assert.equal((await claudeCodeAdapter.uninstall!(context)).ok, true)
    assert.ok(existsSync(join(dir, ".opencomms/opencomms-mcp.mjs")))
    assert.equal(
      (await claudeCodeAdapter.detect(context)).status,
      "absent",
      "retained shared resource is not a Claude installation",
    )
    assert.ok(readFileSync(join(dir, ".codex/config.toml"), "utf8").includes("[mcp_servers.opencomms]"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
