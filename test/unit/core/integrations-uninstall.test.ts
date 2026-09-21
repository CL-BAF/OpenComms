/**
 * Integrations uninstall tests (M3, IntegrationBuilder slice).
 *
 * Per-host lifecycle closure for the optional HostIntegration.uninstall
 * member (Reviewer R2 binding: files first, marker last; absent => ok:true
 * no-op before touching the marker; malformed config => ok:false with zero
 * writes and an untouched marker):
 * - fresh -> install -> uninstall -> detect absent -> re-uninstall no-op
 * - changedFiles fidelity (exactly what was removed)
 * - marker removed for the id only; other ids' markers preserved
 * - state.json + pins/ survive every uninstall
 * - unrelated user config preserved
 * - opencode foreign plugin.js left in place with a warning (never deleted)
 * - malformed config => ok:false, marker untouched, zero writes
 * - manager uninstall delegation, unsupported-member refusal, unknown id
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { opencodeAdapter } from "../../../src/integrations/adapters/opencode.js"
import { claudeCodeAdapter } from "../../../src/integrations/adapters/claude-code.js"
import { codexAdapter } from "../../../src/integrations/adapters/codex.js"
import { claudeDesktopAdapter } from "../../../src/integrations/adapters/claude-desktop.js"
import { chatgptAdapter } from "../../../src/integrations/adapters/chatgpt.js"
import { IntegrationManager } from "../../../src/integrations/manager.js"
import { getInstalledVersion, setInstalledVersion } from "../../../src/integrations/versioning.js"
import type { HostIntegration, IntegrationContext, IntegrationReport } from "../../../src/integrations/types.js"

async function uninstall(adapter: HostIntegration, ctx: IntegrationContext): Promise<IntegrationReport> {
  assert.ok(adapter.uninstall, `${adapter.id} must implement uninstall for these tests`)
  return adapter.uninstall(ctx)
}

const CURRENT = "1.3.1"

function mkCtx(dir: string, currentVersion = CURRENT): IntegrationContext {
  return { projectDir: dir, currentVersion }
}

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function distReady(): boolean {
  return (
    existsSync(join(process.cwd(), "dist", "plugin.bundled.js")) &&
    existsSync(join(process.cwd(), "dist", "mcp", "main.js")) &&
    existsSync(join(process.cwd(), "dist", "adapters", "claude-code", "hook-cli.js"))
  )
}

/** Seed shared project state that uninstall must never touch. */
function seedSharedState(dir: string): void {
  mkdirSync(join(dir, ".opencomms", "pins"), { recursive: true })
  writeFileSync(
    join(dir, ".opencomms", "state.json"),
    JSON.stringify({ schema_version: 2, channels: {}, messages: {}, queues: {}, delivered_to: {}, errors: [] }),
    "utf8",
  )
  writeFileSync(
    join(dir, ".opencomms", "pins", "sess_keep.json"),
    JSON.stringify({ member_id: "sess_keep", host: "claude-code" }),
    "utf8",
  )
}

function assertSharedStateSurvives(dir: string): void {
  assert.ok(existsSync(join(dir, ".opencomms", "state.json")), "state.json must survive uninstall")
  assert.ok(existsSync(join(dir, ".opencomms", "pins", "sess_keep.json")), "pins must survive uninstall")
}

// ---------- opencode ----------

test("opencode uninstall: fresh->install->uninstall->absent->re-uninstall no-op", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-oc-")
  try {
    seedSharedState(dir)
    await opencodeAdapter.install(mkCtx(dir))
    const removed = await uninstall(opencodeAdapter, mkCtx(dir))
    assert.equal(removed.ok, true)
    assert.deepEqual(
      [...removed.changedFiles].sort(),
      [".opencode/plugins/plugin.js", "opencode.json"].sort(),
      "changedFiles = exactly what was removed",
    )
    assert.match(removed.warnings.join(" "), /were NOT removed/)
    assert.equal(getInstalledVersion(dir, "opencode"), null, "own marker removed")
    assert.equal((await opencodeAdapter.detect(mkCtx(dir))).status, "absent")
    assertSharedStateSurvives(dir)

    const noop = await uninstall(opencodeAdapter, mkCtx(dir))
    assert.equal(noop.ok, true)
    assert.deepEqual(noop.changedFiles, [])
    assert.match(noop.actions.join(" "), /nothing to remove/)
  } finally {
    cleanup(dir)
  }
})

test("opencode uninstall: preserves unrelated keys + other markers; foreign plugin.js never deleted", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-ocpres-")
  try {
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ custom: "keep-me", plugin: [".opencode/plugins/plugin.js", "other-plugin"] }, null, 2),
      "utf8",
    )
    await opencodeAdapter.install(mkCtx(dir))
    setInstalledVersion(dir, "codex", CURRENT)
    const removed = await uninstall(opencodeAdapter, mkCtx(dir))
    assert.equal(removed.ok, true)
    const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as Record<string, unknown>
    assert.equal(cfg["custom"], "keep-me")
    assert.deepEqual(cfg["plugin"], ["other-plugin"])
    assert.equal(getInstalledVersion(dir, "codex"), CURRENT, "other ids preserved")

    // Foreign bundle: left in place with a warning, never deleted.
    writeFileSync(join(dir, ".opencode", "plugins", "plugin.js"), "// user custom plugin\n", "utf8")
    const foreign = await uninstall(opencodeAdapter, mkCtx(dir))
    assert.equal(foreign.ok, true)
    assert.equal(readFileSync(join(dir, ".opencode", "plugins", "plugin.js"), "utf8"), "// user custom plugin\n")
    assert.match(foreign.warnings.join(" "), /foreign file/)
  } finally {
    cleanup(dir)
  }
})

test("opencode uninstall: malformed config => ok:false, marker untouched, zero writes", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-ocmal-")
  try {
    await opencodeAdapter.install(mkCtx(dir))
    assert.equal(getInstalledVersion(dir, "opencode"), CURRENT)
    writeFileSync(join(dir, "opencode.json"), "{ broken", "utf8")
    const result = await uninstall(opencodeAdapter, mkCtx(dir))
    assert.equal(result.ok, false)
    assert.equal(getInstalledVersion(dir, "opencode"), CURRENT, "marker untouched on failure")
    assert.ok(existsSync(join(dir, ".opencode", "plugins", "plugin.js")), "no files removed on failure")
  } finally {
    cleanup(dir)
  }
})

// ---------- claude-code ----------

test("claude-code uninstall: removes hooks + mcp entry + bundles; state/pins survive", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-cc-")
  try {
    seedSharedState(dir)
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(
        { model: "keep-me", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] } },
        null,
        2,
      ),
      "utf8",
    )
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "x" } } }, null, 2), "utf8")
    await claudeCodeAdapter.install(mkCtx(dir))
    const removed = await uninstall(claudeCodeAdapter, mkCtx(dir))
    assert.equal(removed.ok, true)
    for (const f of [".claude/settings.json", ".mcp.json", ".opencomms/claude-code-hooks.mjs"]) {
      assert.ok(removed.changedFiles.includes(f), `changedFiles includes ${f}`)
    }
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as Record<string, unknown>
    assert.equal(settings["model"], "keep-me")
    assert.ok(
      Array.isArray((settings["hooks"] as Record<string, unknown[]>)["PreToolUse"]),
      "unrelated hooks preserved",
    )
    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }
    assert.ok("docs" in mcp.mcpServers)
    assert.ok(!("opencomms" in mcp.mcpServers))
    assert.equal(getInstalledVersion(dir, "claude-code"), null)
    assert.equal((await claudeCodeAdapter.detect(mkCtx(dir))).status, "absent")
    assertSharedStateSurvives(dir)

    assert.deepEqual((await uninstall(claudeCodeAdapter, mkCtx(dir))).changedFiles, [])
  } finally {
    cleanup(dir)
  }
})

test("claude-code uninstall: malformed settings => ok:false, marker untouched, zero writes", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-ccmal-")
  try {
    await claudeCodeAdapter.install(mkCtx(dir))
    writeFileSync(join(dir, ".claude", "settings.json"), "{ broken", "utf8")
    const result = await uninstall(claudeCodeAdapter, mkCtx(dir))
    assert.equal(result.ok, false)
    assert.equal(getInstalledVersion(dir, "claude-code"), CURRENT, "marker untouched on failure")
    assert.ok(existsSync(join(dir, ".opencomms", "claude-code-hooks.mjs")), "no bundles removed on failure")
  } finally {
    cleanup(dir)
  }
})

// ---------- codex ----------

test("codex uninstall: removes ALL opencomms sections + bundle; others survive", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-cx-")
  try {
    seedSharedState(dir)
    mkdirSync(join(dir, ".codex"), { recursive: true })
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      'model = "keep"\n\n[mcp_servers.docs]\ncommand = "docs"\n',
      "utf8",
    )
    await codexAdapter.install(mkCtx(dir))
    const removed = await uninstall(codexAdapter, mkCtx(dir))
    assert.equal(removed.ok, true)
    assert.deepEqual([...removed.changedFiles].sort(), [".codex/config.toml", ".opencomms/opencomms-mcp.mjs"].sort())
    const toml = readFileSync(join(dir, ".codex", "config.toml"), "utf8")
    assert.ok(!toml.includes("mcp_servers.opencomms"), "no opencomms section (incl. env) survives")
    assert.ok(toml.includes("[mcp_servers.docs]"), "other servers preserved")
    assert.equal(getInstalledVersion(dir, "codex"), null)
    assert.equal((await codexAdapter.detect(mkCtx(dir))).status, "absent")
    assertSharedStateSurvives(dir)
  } finally {
    cleanup(dir)
  }
})

test("codex uninstall: orphan env block is fully removed (no reinstall ghost)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-cxorph-")
  try {
    mkdirSync(join(dir, ".codex"), { recursive: true })
    writeFileSync(join(dir, ".codex", "config.toml"), '[mcp_servers.opencomms.env]\nX = "1"\n', "utf8")
    const removed = await uninstall(codexAdapter, mkCtx(dir))
    assert.equal(removed.ok, true)
    assert.ok(!readFileSync(join(dir, ".codex", "config.toml"), "utf8").includes("opencomms"))
  } finally {
    cleanup(dir)
  }
})

// ---------- desktop + chatgpt ----------

test("claude-desktop uninstall: bundle dir removed; re-uninstall no-op", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-dt-")
  try {
    seedSharedState(dir)
    writeFileSync(join(dir, "keep.txt"), "user", "utf8")
    const installed = await claudeDesktopAdapter.install(mkCtx(dir))
    assert.equal(installed.ok, true, installed.warnings.join("; "))
    const removed = await uninstall(claudeDesktopAdapter, mkCtx(dir))
    assert.equal(removed.ok, true)
    assert.deepEqual(removed.changedFiles, ["opencomms-claude-desktop/"])
    assert.ok(!existsSync(join(dir, "opencomms-claude-desktop")))
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "user")
    assert.equal(getInstalledVersion(dir, "claude-desktop"), null)
    assert.equal((await claudeDesktopAdapter.detect(mkCtx(dir))).status, "absent")
    assertSharedStateSurvives(dir)
    assert.deepEqual((await uninstall(claudeDesktopAdapter, mkCtx(dir))).changedFiles, [])
  } finally {
    cleanup(dir)
  }
})

test("chatgpt uninstall: scaffold dir removed; re-uninstall no-op", async () => {
  const dir = mkTmp("oc-un-gpt-")
  try {
    seedSharedState(dir)
    assert.equal((await chatgptAdapter.install(mkCtx(dir))).ok, true)
    const removed = await uninstall(chatgptAdapter, mkCtx(dir))
    assert.equal(removed.ok, true)
    assert.deepEqual(removed.changedFiles, ["opencomms-chatgpt/"])
    assert.ok(!existsSync(join(dir, "opencomms-chatgpt")))
    assert.equal(getInstalledVersion(dir, "chatgpt"), null)
    assert.equal((await chatgptAdapter.detect(mkCtx(dir))).status, "absent")
    assertSharedStateSurvives(dir)
    assert.deepEqual((await uninstall(chatgptAdapter, mkCtx(dir))).changedFiles, [])
  } finally {
    cleanup(dir)
  }
})

// ---------- manager layer ----------

test("manager uninstall: delegates, refuses member-less adapters, rejects unknown ids", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-mgr-")
  try {
    const manager = new IntegrationManager()
    manager.register(opencodeAdapter)
    manager.register(chatgptAdapter)
    await manager.install(mkCtx(dir), "chatgpt")
    const removed = await manager.uninstall(mkCtx(dir), "chatgpt")
    assert.equal(removed.ok, true)
    assert.deepEqual(removed.changedFiles, ["opencomms-chatgpt/"])

    manager.register({
      id: "legacy",
      name: "Legacy",
      scope: "project",
      async detect() {
        return { status: "absent" as const, details: [], issues: [] }
      },
      async install() {
        return { ok: true, actions: [], warnings: [], capabilities: {}, changedFiles: [] }
      },
      async update() {
        return { ok: true, actions: [], warnings: [], capabilities: {}, changedFiles: [] }
      },
      async repair() {
        return { ok: true, actions: [], warnings: [], capabilities: {}, changedFiles: [] }
      },
      async verify() {
        return { ok: true, actions: [], warnings: [], capabilities: {}, changedFiles: [] }
      },
    })
    const refused = await manager.uninstall(mkCtx(dir), "legacy")
    assert.equal(refused.ok, false)
    assert.match(refused.warnings.join(" "), /Uninstall unsupported by "legacy"/)

    const unknown = await manager.uninstall(mkCtx(dir), "nope")
    assert.equal(unknown.ok, false)
    assert.match(unknown.warnings.join(" "), /Unknown integration/)
  } finally {
    cleanup(dir)
  }
})

test("uninstall removes only its own marker (other ids preserved)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-un-mark-")
  try {
    await opencodeAdapter.install(mkCtx(dir))
    await chatgptAdapter.install(mkCtx(dir))
    await uninstall(opencodeAdapter, mkCtx(dir))
    assert.equal(getInstalledVersion(dir, "opencode"), null)
    assert.equal(getInstalledVersion(dir, "chatgpt"), CURRENT)
    // Cleanup the second marker so tmp state is consistent.
    unlinkSync(join(dir, ".opencomms", "integration.json"))
  } finally {
    cleanup(dir)
  }
})
