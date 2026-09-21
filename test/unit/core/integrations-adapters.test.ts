/**
 * Integrations adapters tests (M1+M2, IntegrationBuilder slice).
 *
 * Uses real tmp project dirs + the REAL wrapped installers (dist must exist;
 * CI builds first). Asserts:
 * - fresh install / already-installed / outdated / repeated / repair
 * - malformed integration.json -> repair path works (never bricks)
 * - preservation of unrelated user config (opencode.json, .claude/settings.json,
 *   .mcp.json, .codex/config.toml)
 * - failure rollback (installer refusal leaves config + marker untouched)
 * - placeholder member env is broken until `install-member` replaces it
 * - foreign plugin.js clobber guard, orphan codex env block
 * - parse-before-copy: malformed claude settings -> no partial writes
 * - capability honesty (no FULL claims on PULL-only hosts)
 * - versioning: fresh write, malformed -> null, per-id preservation, atomic
 * - manager: register/list, unknown id, adapter throw -> ok:false/broken
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { opencodeAdapter } from "../../../src/integrations/adapters/opencode.js"
import { claudeCodeAdapter } from "../../../src/integrations/adapters/claude-code.js"
import { codexAdapter } from "../../../src/integrations/adapters/codex.js"
import { claudeDesktopAdapter } from "../../../src/integrations/adapters/claude-desktop.js"
import { chatgptAdapter } from "../../../src/integrations/adapters/chatgpt.js"
import { IntegrationManager } from "../../../src/integrations/manager.js"
import {
  compareVersions,
  getInstalledVersion,
  readIntegrationMarkers,
  setInstalledVersion,
} from "../../../src/integrations/versioning.js"
import type { IntegrationContext } from "../../../src/integrations/types.js"

const CURRENT = "1.3.1"
const OLD = "0.0.1"
const PLACEHOLDER = "<set by: opencomms install-member>"

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

/** Replace the claude .mcp.json member placeholder with a real member id. */
function replaceClaudePlaceholder(dir: string, memberId = "sess_test_member"): void {
  const path = join(dir, ".mcp.json")
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    mcpServers: Record<string, { env?: Record<string, string> }>
  }
  parsed.mcpServers["opencomms"]!.env!["OPENCOMMS_MEMBER_ID"] = memberId
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
}

/** Replace the codex config.toml member placeholder with a real member id. */
function replaceCodexPlaceholder(dir: string, memberId = "sess_test_member"): void {
  const path = join(dir, ".codex", "config.toml")
  const toml = readFileSync(path, "utf8")
  writeFileSync(path, toml.replace(PLACEHOLDER, memberId), "utf8")
}

// ---------- versioning ----------

test("versioning: fresh write stamps one id; per-id update preserves others", () => {
  const dir = mkTmp("oc-int-ver-")
  try {
    assert.equal(readIntegrationMarkers(dir), null)
    setInstalledVersion(dir, "opencode", CURRENT)
    assert.equal(getInstalledVersion(dir, "opencode"), CURRENT)
    setInstalledVersion(dir, "codex", OLD)
    assert.equal(getInstalledVersion(dir, "codex"), OLD)
    assert.equal(getInstalledVersion(dir, "opencode"), CURRENT)
    const file = readIntegrationMarkers(dir)
    assert.ok(file)
    assert.equal(file?.schema_version, 1)
  } finally {
    cleanup(dir)
  }
})

test("versioning: malformed integration.json returns null and never throws", () => {
  const dir = mkTmp("oc-int-mal-")
  try {
    mkdirSync(join(dir, ".opencomms"), { recursive: true })
    writeFileSync(join(dir, ".opencomms", "integration.json"), "{ not json", "utf8")
    assert.equal(readIntegrationMarkers(dir), null)
    assert.equal(getInstalledVersion(dir, "opencode"), null)
    setInstalledVersion(dir, "opencode", CURRENT)
    assert.equal(getInstalledVersion(dir, "opencode"), CURRENT)
  } finally {
    cleanup(dir)
  }
})

test("versioning: atomic write leaves no temp files behind", () => {
  const dir = mkTmp("oc-int-atom-")
  try {
    setInstalledVersion(dir, "opencode", CURRENT)
    const entries = readdirSync(join(dir, ".opencomms"))
    assert.ok(entries.includes("integration.json"))
    assert.equal(entries.filter((e) => e.includes(".tmp")).length, 0, "no temp files remain")
  } finally {
    cleanup(dir)
  }
})

test("versioning: compareVersions is semver-ish with leading-v parity", () => {
  assert.equal(compareVersions(CURRENT, CURRENT), 0)
  assert.ok(compareVersions(OLD, CURRENT) < 0)
  assert.ok(compareVersions(CURRENT, OLD) > 0)
  assert.ok(compareVersions("1.3.0", "1.3.1") < 0)
  assert.equal(compareVersions("v1.3.1", "1.3.1"), 0)
})

// ---------- manager hardening ----------

test("manager: register/list; unknown install -> ok:false; unknown detect throws; adapter throw -> ok:false/broken", async () => {
  const dir = mkTmp("oc-int-mgr-")
  try {
    const manager = new IntegrationManager()
    manager.register(opencodeAdapter)
    assert.equal(manager.list().length, 1)
    const unknown = await manager.install(mkCtx(dir), "nope")
    assert.equal(unknown.ok, false)
    assert.match(unknown.warnings.join(" "), /Unknown integration/)
    await assert.rejects(() => manager.detect(mkCtx(dir), "nope"), /Unknown integration/)

    manager.register({
      id: "boom",
      name: "Boom",
      scope: "project",
      async detect() {
        throw new Error("detect boom")
      },
      async install() {
        throw new Error("install boom")
      },
      async update() {
        throw new Error("update boom")
      },
      async repair() {
        throw new Error("repair boom")
      },
      async verify() {
        throw new Error("verify boom")
      },
    })
    const failed = await manager.install(mkCtx(dir), "boom")
    assert.equal(failed.ok, false)
    assert.match(failed.warnings.join(" "), /install boom/)
    const detected = await manager.detect(mkCtx(dir), "boom")
    assert.equal(detected.status, "broken")
  } finally {
    cleanup(dir)
  }
})

// ---------- opencode adapter ----------

test("opencode: fresh project detects absent; fresh install stamps marker", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-int-oc-")
  try {
    assert.equal((await opencodeAdapter.detect(mkCtx(dir))).status, "absent")
    const installed = await opencodeAdapter.install(mkCtx(dir))
    assert.equal(installed.ok, true, installed.warnings.join("; "))
    assert.ok(existsSync(join(dir, ".opencode", "plugins", "plugin.js")))
    assert.equal(getInstalledVersion(dir, "opencode"), CURRENT)
    assert.equal((await opencodeAdapter.detect(mkCtx(dir))).status, "installed")
    assert.equal((await opencodeAdapter.verify(mkCtx(dir))).ok, true)
  } finally {
    cleanup(dir)
  }
})

test("opencode: repeated install is idempotent (single plugin entry)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ocrep-")
  try {
    await opencodeAdapter.install(mkCtx(dir))
    assert.equal((await opencodeAdapter.install(mkCtx(dir))).ok, true)
    const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as { plugin: unknown[] }
    assert.equal(cfg.plugin.filter((e) => e === ".opencode/plugins/plugin.js").length, 1)
  } finally {
    cleanup(dir)
  }
})

test("opencode: outdated marker -> detect outdated -> update bumps marker", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ocout-")
  try {
    await opencodeAdapter.install(mkCtx(dir, OLD))
    assert.equal((await opencodeAdapter.detect(mkCtx(dir, CURRENT))).status, "outdated")
    assert.equal((await opencodeAdapter.update(mkCtx(dir, CURRENT))).ok, true)
    assert.equal(getInstalledVersion(dir, "opencode"), CURRENT)
  } finally {
    cleanup(dir)
  }
})

test("opencode: broken (registered but file missing) -> repair restores file", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ocrep2-")
  try {
    await opencodeAdapter.install(mkCtx(dir))
    unlinkSync(join(dir, ".opencode", "plugins", "plugin.js"))
    assert.equal((await opencodeAdapter.detect(mkCtx(dir))).status, "broken")
    assert.equal((await opencodeAdapter.repair(mkCtx(dir))).ok, true)
    assert.ok(existsSync(join(dir, ".opencode", "plugins", "plugin.js")))
  } finally {
    cleanup(dir)
  }
})

test("opencode: foreign plugin.js is broken via clobber guard (never silently overwritten)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ocfor-")
  try {
    mkdirSync(join(dir, ".opencode", "plugins"), { recursive: true })
    writeFileSync(join(dir, ".opencode", "plugins", "plugin.js"), "// user custom plugin\n", "utf8")
    const detected = await opencodeAdapter.detect(mkCtx(dir))
    assert.equal(detected.status, "broken")
    assert.match(detected.issues.join(" "), /foreign plugin\.js clobber guard/)
  } finally {
    cleanup(dir)
  }
})

test("opencode: preserves unrelated config keys across install+update", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ocpres-")
  try {
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({ custom: "keep-me", theme: "dark", plugin: [] }, null, 2),
      "utf8",
    )
    await opencodeAdapter.install(mkCtx(dir))
    await opencodeAdapter.update(mkCtx(dir))
    const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as Record<string, unknown>
    assert.equal(cfg["custom"], "keep-me")
    assert.equal(cfg["theme"], "dark")
  } finally {
    cleanup(dir)
  }
})

test("opencode: .jsonc with $schema URL + comments parses identically to installer (P2-6)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ocjsonc-")
  try {
    writeFileSync(
      join(dir, "opencode.jsonc"),
      [
        "{",
        "  // project comment (must not corrupt the $schema URL below)",
        '  "$schema": "https://opencode.ai/config.json",',
        '  "custom": "keep-me",',
        '  "plugin": []',
        "}",
        "",
      ].join("\n"),
      "utf8",
    )
    // Detection must see through comments exactly like the installer does.
    const before = await opencodeAdapter.detect(mkCtx(dir))
    assert.equal(before.status, "absent")
    const installed = await opencodeAdapter.install(mkCtx(dir))
    assert.equal(installed.ok, true, installed.warnings.join("; "))
    const raw = readFileSync(join(dir, "opencode.jsonc"), "utf8")
    assert.ok(raw.includes("https://opencode.ai/config.json"), "URL value must survive intact (no // truncation)")
    const cfg = JSON.parse(raw) as { plugin: unknown[]; custom: unknown }
    assert.ok(cfg.plugin.includes(".opencode/plugins/plugin.js"), "plugin entry registered")
    assert.equal(cfg.custom, "keep-me")
    assert.equal((await opencodeAdapter.detect(mkCtx(dir))).status, "installed")
  } finally {
    cleanup(dir)
  }
})

test("opencode: malformed opencode.json -> detect broken (never throws); verify fails honestly", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ocmal-")
  try {
    writeFileSync(join(dir, "opencode.json"), "{ broken", "utf8")
    assert.equal((await opencodeAdapter.detect(mkCtx(dir))).status, "broken")
    assert.equal((await opencodeAdapter.verify(mkCtx(dir))).ok, false)
  } finally {
    cleanup(dir)
  }
})

test("opencode: installer refusal (bad plugin field) -> ok:false, marker untouched (rollback)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ocfail-")
  try {
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: 42 }), "utf8")
    assert.equal((await opencodeAdapter.install(mkCtx(dir))).ok, false)
    assert.equal(getInstalledVersion(dir, "opencode"), null)
    assert.equal((JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")) as { plugin: unknown }).plugin, 42)
  } finally {
    cleanup(dir)
  }
})

// ---------- claude-code adapter ----------

test("claude-code: fresh install carries placeholder -> broken; pin replacement -> installed; verify only after pin", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-cc-")
  try {
    assert.equal((await claudeCodeAdapter.detect(mkCtx(dir))).status, "absent")
    assert.equal((await claudeCodeAdapter.install(mkCtx(dir))).ok, true)
    const afterInstall = await claudeCodeAdapter.detect(mkCtx(dir))
    assert.equal(afterInstall.status, "broken")
    assert.match(afterInstall.issues.join(" "), /placeholder not replaced/)
    assert.equal((await claudeCodeAdapter.verify(mkCtx(dir))).ok, false)

    replaceClaudePlaceholder(dir)
    assert.equal((await claudeCodeAdapter.detect(mkCtx(dir))).status, "installed")
    assert.equal((await claudeCodeAdapter.verify(mkCtx(dir))).ok, true)

    const second = await claudeCodeAdapter.install(mkCtx(dir))
    assert.equal(second.ok, true)
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as {
      hooks?: Record<string, unknown[]>
    }
    assert.equal((settings.hooks?.["SessionStart"] ?? []).length, 1)
  } finally {
    cleanup(dir)
  }
})

test("claude-code: outdated (pinned) -> update bumps marker", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ccout-")
  try {
    await claudeCodeAdapter.install(mkCtx(dir, OLD))
    replaceClaudePlaceholder(dir)
    // Re-stamp OLD after the installer stamped CURRENT so the outdated path is exercised.
    setInstalledVersion(dir, "claude-code", OLD)
    assert.equal((await claudeCodeAdapter.detect(mkCtx(dir, CURRENT))).status, "outdated")
    assert.equal((await claudeCodeAdapter.update(mkCtx(dir, CURRENT))).ok, true)
    assert.equal(getInstalledVersion(dir, "claude-code"), CURRENT)
  } finally {
    cleanup(dir)
  }
})

test("claude-code: preserves unrelated settings hooks + mcp servers", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ccpres-")
  try {
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
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "docs-server" } } }, null, 2),
      "utf8",
    )
    await claudeCodeAdapter.install(mkCtx(dir))
    await claudeCodeAdapter.update(mkCtx(dir))
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as Record<string, unknown>
    assert.equal(settings["model"], "keep-me")
    assert.ok(Array.isArray((settings["hooks"] as Record<string, unknown[]>)["PreToolUse"]))
    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }
    assert.ok("docs" in mcp.mcpServers)
    assert.ok("opencomms" in mcp.mcpServers)
  } finally {
    cleanup(dir)
  }
})

test("claude-code: malformed settings -> install ok:false with zero partial writes (parse-before-copy)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ccparse-")
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(join(dir, ".claude", "settings.json"), "{ broken", "utf8")
    const result = await claudeCodeAdapter.install(mkCtx(dir))
    assert.equal(result.ok, false)
    assert.ok(!existsSync(join(dir, ".opencomms", "claude-code-hooks.mjs")), "no bundle copied on parse failure")
    assert.ok(!existsSync(join(dir, ".opencomms", "opencomms-mcp.mjs")), "no bundle copied on parse failure")
    assert.equal(getInstalledVersion(dir, "claude-code"), null)
  } finally {
    cleanup(dir)
  }
})

test("claude-code: malformed integration.json -> detect still works; repair restamps", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-ccmal-")
  try {
    await claudeCodeAdapter.install(mkCtx(dir))
    replaceClaudePlaceholder(dir)
    writeFileSync(join(dir, ".opencomms", "integration.json"), "###bad###", "utf8")
    assert.equal((await claudeCodeAdapter.detect(mkCtx(dir))).status, "installed")
    assert.equal((await claudeCodeAdapter.repair(mkCtx(dir))).ok, true)
    assert.equal(getInstalledVersion(dir, "claude-code"), CURRENT)
  } finally {
    cleanup(dir)
  }
})

// ---------- codex adapter ----------

test("codex: fresh install carries placeholder -> broken; pin replacement -> installed", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-cx-")
  try {
    assert.equal((await codexAdapter.detect(mkCtx(dir))).status, "absent")
    assert.equal((await codexAdapter.install(mkCtx(dir))).ok, true)
    const afterInstall = await codexAdapter.detect(mkCtx(dir))
    assert.equal(afterInstall.status, "broken")
    assert.match(afterInstall.issues.join(" "), /placeholder not replaced/)

    replaceCodexPlaceholder(dir)
    assert.equal((await codexAdapter.detect(mkCtx(dir))).status, "installed")
    assert.equal((await codexAdapter.verify(mkCtx(dir))).ok, true)

    await codexAdapter.install(mkCtx(dir))
    assert.equal(
      readFileSync(join(dir, ".codex", "config.toml"), "utf8").split("[mcp_servers.opencomms]").length - 1,
      1,
    )
  } finally {
    cleanup(dir)
  }
})

test("codex: orphan env block without parent section is broken; repair rewrites full block", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-cxorph-")
  try {
    await codexAdapter.install(mkCtx(dir))
    mkdirSync(join(dir, ".opencomms"), { recursive: true })
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      '[mcp_servers.opencomms.env]\nOPENCOMMS_MEMBER_ID = "sess_x"\n',
      "utf8",
    )
    const detected = await codexAdapter.detect(mkCtx(dir))
    assert.equal(detected.status, "broken")
    assert.match(detected.issues.join(" "), /parent absent/)
    assert.equal((await codexAdapter.repair(mkCtx(dir))).ok, true)
    assert.ok(readFileSync(join(dir, ".codex", "config.toml"), "utf8").includes("[mcp_servers.opencomms]"))
  } finally {
    cleanup(dir)
  }
})

test("codex: outdated (pinned) -> update; broken bundle -> repair", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-cxflow-")
  try {
    await codexAdapter.install(mkCtx(dir))
    replaceCodexPlaceholder(dir)
    setInstalledVersion(dir, "codex", OLD)
    assert.equal((await codexAdapter.detect(mkCtx(dir))).status, "outdated")
    assert.equal((await codexAdapter.update(mkCtx(dir))).ok, true)

    unlinkSync(join(dir, ".opencomms", "opencomms-mcp.mjs"))
    assert.equal((await codexAdapter.detect(mkCtx(dir))).status, "broken")
    assert.equal((await codexAdapter.repair(mkCtx(dir))).ok, true)
  } finally {
    cleanup(dir)
  }
})

test("codex: preserves unrelated config.toml sections", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-cxpres-")
  try {
    mkdirSync(join(dir, ".codex"), { recursive: true })
    writeFileSync(
      join(dir, ".codex", "config.toml"),
      'model = "gpt-5.2"\n\n[mcp_servers.docs]\ncommand = "docs-server"\n',
      "utf8",
    )
    await codexAdapter.install(mkCtx(dir))
    await codexAdapter.update(mkCtx(dir))
    const toml = readFileSync(join(dir, ".codex", "config.toml"), "utf8")
    assert.ok(toml.includes('model = "gpt-5.2"'))
    assert.ok(toml.includes("[mcp_servers.docs]"))
    assert.ok(toml.includes("[mcp_servers.opencomms]"))
  } finally {
    cleanup(dir)
  }
})

// ---------- capability honesty ----------

test("capabilities stay honest: claude/codex never claim FULL push", async () => {
  const dir = mkTmp("oc-int-cap-")
  try {
    const cc = await claudeCodeAdapter.install(mkCtx(dir))
    const cx = await codexAdapter.install(mkCtx(dir))
    for (const report of [cc, cx]) {
      assert.ok(!/:\s*"FULL"/i.test(JSON.stringify(report.capabilities)), "no FULL claims")
    }
    assert.match(JSON.stringify(cc.capabilities), /UNSUPPORTED/)
    assert.match(JSON.stringify(cx.capabilities), /PULL/)
  } finally {
    cleanup(dir)
  }
})

// ---------- M2: claude-desktop adapter ----------

test("claude-desktop: fresh project detects absent; verify fails honestly", async () => {
  const dir = mkTmp("oc-int-dt-")
  try {
    assert.equal((await claudeDesktopAdapter.detect(mkCtx(dir))).status, "absent")
    assert.equal((await claudeDesktopAdapter.verify(mkCtx(dir))).ok, false)
  } finally {
    cleanup(dir)
  }
})

test("claude-desktop: install lays out bundle + stamps marker; verify passes", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-dtinst-")
  try {
    const result = await claudeDesktopAdapter.install(mkCtx(dir))
    assert.equal(result.ok, true, result.warnings.join("; "))
    assert.ok(existsSync(join(dir, "opencomms-claude-desktop", "manifest.json")))
    assert.ok(existsSync(join(dir, "opencomms-claude-desktop", "server", "main.mjs")))
    assert.equal(getInstalledVersion(dir, "claude-desktop"), CURRENT)
    assert.equal((await claudeDesktopAdapter.detect(mkCtx(dir))).status, "installed")
    assert.equal((await claudeDesktopAdapter.verify(mkCtx(dir))).ok, true)
    assert.ok(!/:\s*"FULL"/i.test(JSON.stringify(result.capabilities)), "no FULL claims")
    assert.match(JSON.stringify(result.capabilities), /PULL ONLY/)
  } finally {
    cleanup(dir)
  }
})

test("claude-desktop: repeated install idempotent; outdated marker -> update bumps", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-dtrep-")
  try {
    await claudeDesktopAdapter.install(mkCtx(dir))
    assert.equal((await claudeDesktopAdapter.install(mkCtx(dir))).ok, true)
    assert.ok(existsSync(join(dir, "opencomms-claude-desktop", "server", "main.mjs")))
    setInstalledVersion(dir, "claude-desktop", OLD)
    assert.equal((await claudeDesktopAdapter.detect(mkCtx(dir))).status, "outdated")
    assert.equal((await claudeDesktopAdapter.update(mkCtx(dir))).ok, true)
    assert.equal(getInstalledVersion(dir, "claude-desktop"), CURRENT)
  } finally {
    cleanup(dir)
  }
})

test("claude-desktop: broken (server deleted) -> repair restores; unrelated files preserved", async (t) => {
  if (!distReady()) {
    t.skip("dist missing")
    return
  }
  const dir = mkTmp("oc-int-dtrep2-")
  try {
    await claudeDesktopAdapter.install(mkCtx(dir))
    writeFileSync(join(dir, "keep-me.txt"), "user content", "utf8")
    unlinkSync(join(dir, "opencomms-claude-desktop", "server", "main.mjs"))
    assert.equal((await claudeDesktopAdapter.detect(mkCtx(dir))).status, "broken")
    assert.equal((await claudeDesktopAdapter.repair(mkCtx(dir))).ok, true)
    assert.ok(existsSync(join(dir, "opencomms-claude-desktop", "server", "main.mjs")))
    assert.equal(readFileSync(join(dir, "keep-me.txt"), "utf8"), "user content")
  } finally {
    cleanup(dir)
  }
})

test("claude-desktop: partial bundle (manifest without server) is broken; capabilities stay honest", async () => {
  const dir = mkTmp("oc-int-dtpart-")
  try {
    mkdirSync(join(dir, "opencomms-claude-desktop"), { recursive: true })
    writeFileSync(
      join(dir, "opencomms-claude-desktop", "manifest.json"),
      JSON.stringify({
        manifest_version: "0.3",
        name: "opencomms",
        version: "1.3.1",
        description: "test",
        author: "test",
        server: { mcp_config: { command: "node" } },
      }),
      "utf8",
    )
    const detected = await claudeDesktopAdapter.detect(mkCtx(dir))
    assert.equal(detected.status, "broken")
    assert.match(detected.issues.join(" "), /bundle server missing/)
    assert.equal((await claudeDesktopAdapter.verify(mkCtx(dir))).ok, false)
  } finally {
    cleanup(dir)
  }
})

test("claude-desktop: invalid manifest is broken (never installed)", async () => {
  const dir = mkTmp("oc-int-dtinv-")
  try {
    mkdirSync(join(dir, "opencomms-claude-desktop", "server"), { recursive: true })
    writeFileSync(join(dir, "opencomms-claude-desktop", "manifest.json"), JSON.stringify({ name: "x" }), "utf8")
    writeFileSync(join(dir, "opencomms-claude-desktop", "server", "main.mjs"), "// stub\n", "utf8")
    assert.equal((await claudeDesktopAdapter.detect(mkCtx(dir))).status, "broken")
  } finally {
    cleanup(dir)
  }
})

// ---------- M2: chatgpt adapter ----------

test("chatgpt: fresh absent; install scaffolds + stamps marker; verify passes", async () => {
  const dir = mkTmp("oc-int-gpt-")
  try {
    assert.equal((await chatgptAdapter.detect(mkCtx(dir))).status, "absent")
    const installed = await chatgptAdapter.install(mkCtx(dir))
    assert.equal(installed.ok, true, installed.warnings.join("; "))
    assert.ok(existsSync(join(dir, "opencomms-chatgpt", "mcp-streamable-server.mjs")))
    assert.ok(existsSync(join(dir, "opencomms-chatgpt", "README.md")))
    assert.equal(getInstalledVersion(dir, "chatgpt"), CURRENT)
    assert.equal((await chatgptAdapter.detect(mkCtx(dir))).status, "installed")
    assert.equal((await chatgptAdapter.verify(mkCtx(dir))).ok, true)
  } finally {
    cleanup(dir)
  }
})

test("chatgpt: repeated install idempotent; outdated marker -> update bumps", async () => {
  const dir = mkTmp("oc-int-gptrep-")
  try {
    await chatgptAdapter.install(mkCtx(dir))
    assert.equal((await chatgptAdapter.install(mkCtx(dir))).ok, true)
    assert.ok(existsSync(join(dir, "opencomms-chatgpt", "mcp-streamable-server.mjs")))

    setInstalledVersion(dir, "chatgpt", OLD)
    assert.equal((await chatgptAdapter.detect(mkCtx(dir))).status, "outdated")
    assert.equal((await chatgptAdapter.update(mkCtx(dir))).ok, true)
    assert.equal(getInstalledVersion(dir, "chatgpt"), CURRENT)
  } finally {
    cleanup(dir)
  }
})

test("chatgpt: broken (one file deleted) -> repair restores; unrelated project files preserved", async () => {
  const dir = mkTmp("oc-int-gptrep2-")
  try {
    await chatgptAdapter.install(mkCtx(dir))
    writeFileSync(join(dir, "keep-me.txt"), "user content", "utf8")
    unlinkSync(join(dir, "opencomms-chatgpt", "README.md"))
    assert.equal((await chatgptAdapter.detect(mkCtx(dir))).status, "broken")
    assert.equal((await chatgptAdapter.repair(mkCtx(dir))).ok, true)
    assert.ok(existsSync(join(dir, "opencomms-chatgpt", "README.md")))
    assert.equal(readFileSync(join(dir, "keep-me.txt"), "utf8"), "user content")
  } finally {
    cleanup(dir)
  }
})

test("chatgpt: malformed integration.json -> detect still works; repair restamps", async () => {
  const dir = mkTmp("oc-int-gptmal-")
  try {
    await chatgptAdapter.install(mkCtx(dir))
    writeFileSync(join(dir, ".opencomms", "integration.json"), "###bad###", "utf8")
    assert.equal((await chatgptAdapter.detect(mkCtx(dir))).status, "installed")
    assert.equal((await chatgptAdapter.repair(mkCtx(dir))).ok, true)
    assert.equal(getInstalledVersion(dir, "chatgpt"), CURRENT)
  } finally {
    cleanup(dir)
  }
})

test("chatgpt: capabilities honest — PULL ONLY scaffold, never FULL", async () => {
  const dir = mkTmp("oc-int-gptcap-")
  try {
    const report = await chatgptAdapter.install(mkCtx(dir))
    const blob = JSON.stringify(report.capabilities)
    assert.ok(!/:\s*"FULL"/i.test(blob), `no FULL claims: ${blob}`)
    assert.match(blob, /PULL ONLY/)
    assert.match(report.warnings.join(" "), /scaffold/i)
    const detected = await chatgptAdapter.detect(mkCtx(dir))
    assert.match(detected.details.join(" "), /Platform setup required/)
  } finally {
    cleanup(dir)
  }
})

test("manager: registers all five adapters; detectAll covers desktop + chatgpt without throwing", async () => {
  const dir = mkTmp("oc-int-all-")
  try {
    const manager = new IntegrationManager()
    manager.register(opencodeAdapter)
    manager.register(claudeCodeAdapter)
    manager.register(codexAdapter)
    manager.register(claudeDesktopAdapter)
    manager.register(chatgptAdapter)
    assert.equal(manager.list().length, 5)
    const all = await manager.detectAll(mkCtx(dir))
    assert.ok("claude-desktop" in all)
    assert.ok("chatgpt" in all)
    assert.equal(all["chatgpt"]?.status, "absent")
    assert.equal(all["claude-desktop"]?.status, "absent")
  } finally {
    cleanup(dir)
  }
})
