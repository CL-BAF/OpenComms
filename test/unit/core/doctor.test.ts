/**
 * Doctor backend tests (M2).
 *
 * Covers doctorReport/doctorReportWithManager against tmp projects:
 * fresh-absent, all-installed, broken→fix→idempotent, outdated→fix,
 * corrupt marker + broken artifacts (fail → repair path), placeholder
 * unfixable (never auto-runs install-member), and adapter-throw safety.
 * Real installs need dist (guarded with skip); placeholder pin replacement
 * uses local helpers (mirrors the adapters suite, not imported from it).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { doctorReport, doctorReportWithManager } from "../../../src/cli/doctor.js"
import { createDefaultManager } from "../../../src/integrations/registry.js"
import { IntegrationManager } from "../../../src/integrations/manager.js"
import {
  getInstalledVersion,
  readIntegrationMarkers,
  setInstalledVersion,
} from "../../../src/integrations/versioning.js"
import { listMemberPins } from "../../../src/mcp/identity.js"
import { VERSION } from "../../../src/version.js"
import type { HostIntegration } from "../../../src/integrations/types.js"

const HOST_IDS = ["opencode", "claude-code", "codex", "claude-desktop", "chatgpt"]

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

function hostCheck(report: { checks: Array<{ id: string; status: string }> }, id: string): string {
  const found = report.checks.find((c) => c.id === `host:${id}`)
  assert.ok(found, `expected a host:${id} check`)
  return found.status
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
  writeFileSync(path, toml.replace("<set by: opencomms install-member>", memberId), "utf8")
}

test("doctor: fresh project is all-absent, ok=true, nothing to fix", async () => {
  const dir = mkTmp("oc-doc-fresh-")
  try {
    const report = await doctorReport(dir, { fix: false })
    assert.equal(report.ok, true)
    for (const id of HOST_IDS) assert.equal(hostCheck(report, id), "warn")
    assert.deepEqual(report.fixed, [])
    assert.deepEqual(report.unfixable, [])
    const state = report.checks.find((c) => c.id === "state")
    assert.equal(state?.status, "ok")
  } finally {
    cleanup(dir)
  }
})

test("doctor: registry covers all five hosts", () => {
  const ids = createDefaultManager()
    .list()
    .map((a) => a.id)
    .sort()
  assert.deepEqual(ids, [...HOST_IDS].sort())
})

test("doctor: all five installed => all host checks ok", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-doc-all-")
  try {
    const manager = createDefaultManager()
    const ctx = { projectDir: dir, currentVersion: VERSION }
    for (const id of HOST_IDS) {
      const installed = await manager.install(ctx, id)
      assert.equal(installed.ok, true, `${id}: ${installed.warnings.join("; ")}`)
    }
    replaceClaudePlaceholder(dir)
    replaceCodexPlaceholder(dir)
    const report = await doctorReport(dir, { fix: false })
    for (const id of HOST_IDS) assert.equal(hostCheck(report, id), "ok", id)
    assert.equal(report.ok, true)
    assert.deepEqual(report.fixed, [])
    assert.deepEqual(report.unfixable, [])
  } finally {
    cleanup(dir)
  }
})

test("doctor: broken plugin registration fails, --fix repairs, second run is idempotent", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-doc-broken-")
  try {
    const manager = createDefaultManager()
    const ctx = { projectDir: dir, currentVersion: VERSION }
    const installed = await manager.install(ctx, "opencode")
    assert.equal(installed.ok, true)
    unlinkSync(join(dir, ".opencode", "plugins", "plugin.js"))

    const before = await doctorReport(dir, { fix: false })
    assert.equal(before.ok, false)
    assert.equal(hostCheck(before, "opencode"), "fail")
    assert.deepEqual(before.fixed, [])

    const fixed = await doctorReport(dir, { fix: true })
    assert.equal(fixed.ok, false, "checks reflect pre-fix detection")
    assert.ok(
      fixed.fixed.some((f) => f.startsWith("repaired opencode:")),
      `expected opencode repair in fixed[]: ${fixed.fixed.join(" | ")}`,
    )
    assert.deepEqual(fixed.unfixable, [])
    assert.ok(existsSync(join(dir, ".opencode", "plugins", "plugin.js")))

    const again = await doctorReport(dir, { fix: true })
    assert.equal(hostCheck(again, "opencode"), "ok")
    assert.deepEqual(again.fixed, [], "nothing left to fix on the second run")
    assert.deepEqual(again.unfixable, [])
  } finally {
    cleanup(dir)
  }
})

test("doctor: outdated marker warns, --fix updates the marker", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-doc-out-")
  try {
    const manager = createDefaultManager()
    const ctx = { projectDir: dir, currentVersion: VERSION }
    assert.equal((await manager.install(ctx, "opencode")).ok, true)
    setInstalledVersion(dir, "opencode", "0.0.1")

    const before = await doctorReport(dir, { fix: false })
    assert.equal(hostCheck(before, "opencode"), "warn")
    assert.deepEqual(before.fixed, [])

    const fixed = await doctorReport(dir, { fix: true })
    assert.ok(
      fixed.fixed.some((f) => f.startsWith("updated opencode:")),
      `expected opencode update in fixed[]: ${fixed.fixed.join(" | ")}`,
    )
    assert.equal(getInstalledVersion(dir, "opencode"), VERSION)
  } finally {
    cleanup(dir)
  }
})

test("doctor: corrupt marker + broken artifacts fails, --fix takes the repair path", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-doc-corrupt-")
  try {
    const manager = createDefaultManager()
    const ctx = { projectDir: dir, currentVersion: VERSION }
    assert.equal((await manager.install(ctx, "opencode")).ok, true)
    unlinkSync(join(dir, ".opencode", "plugins", "plugin.js"))
    mkdirSync(join(dir, ".opencomms"), { recursive: true })
    writeFileSync(join(dir, ".opencomms", "integration.json"), "{ corrupt", "utf8")
    assert.equal(readIntegrationMarkers(dir), null)

    const before = await doctorReport(dir, { fix: false })
    assert.equal(hostCheck(before, "opencode"), "fail")

    const fixed = await doctorReport(dir, { fix: true })
    assert.ok(
      fixed.fixed.some((f) => f.startsWith("repaired opencode:")),
      `expected repair in fixed[]: ${fixed.fixed.join(" | ")}`,
    )
    const markers = readIntegrationMarkers(dir)
    assert.ok(markers, "marker file valid again after repair")
    assert.equal(markers?.integrations["opencode"]?.version, VERSION)
  } finally {
    cleanup(dir)
  }
})

test("doctor: placeholder member env is unfixable with install-member guidance (never auto-runs)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-doc-pin-")
  try {
    const manager = createDefaultManager()
    const ctx = { projectDir: dir, currentVersion: VERSION }
    assert.equal((await manager.install(ctx, "claude-code")).ok, true)

    const report = await doctorReport(dir, { fix: true })
    assert.equal(hostCheck(report, "claude-code"), "fail")
    assert.ok(
      report.unfixable.some((u) => u.includes("claude-code") && u.includes("install-member")),
      `expected placeholder guidance in unfixable[]: ${report.unfixable.join(" | ")}`,
    )
    assert.ok(
      report.fixed.every((f) => !f.includes("claude-code")),
      "repair is not attempted for the placeholder case",
    )
    assert.deepEqual(listMemberPins(dir), [], "install-member was never auto-run")
  } finally {
    cleanup(dir)
  }
})

test("doctor: absent integrations are never installed implicitly by --fix", async () => {
  const dir = mkTmp("oc-doc-absent-")
  try {
    const report = await doctorReport(dir, { fix: true })
    assert.equal(report.ok, true)
    assert.deepEqual(report.fixed, [])
    assert.deepEqual(report.unfixable, [])
    assert.ok(!existsSync(join(dir, ".opencode", "plugins", "plugin.js")))
    assert.ok(!existsSync(join(dir, "opencomms-chatgpt")))
  } finally {
    cleanup(dir)
  }
})

test("doctor: throwing adapter becomes a fail check, never a crash", async () => {
  const dir = mkTmp("oc-doc-throw-")
  try {
    const throwing: HostIntegration = {
      id: "boom",
      name: "Boom",
      scope: "project",
      detect: async () => {
        throw new Error("detect boom")
      },
      install: async () => {
        throw new Error("install boom")
      },
      update: async () => {
        throw new Error("update boom")
      },
      repair: async () => {
        throw new Error("repair boom")
      },
      verify: async () => {
        throw new Error("verify boom")
      },
    }
    const manager = new IntegrationManager()
    manager.register(throwing)
    const report = await doctorReportWithManager(dir, { fix: true }, manager)
    const check = report.checks.find((c) => c.id === "host:boom")
    assert.ok(check, "throwing host still yields a check")
    assert.equal(check.status, "fail")
    assert.equal(report.ok, false)
    // Broken is fixable, so --fix attempts repair; the throw maps to an
    // honest ok:false Report which lands in unfixable[] — never a crash.
    assert.deepEqual(report.fixed, [])
    assert.ok(
      report.unfixable.some((u) => u.includes("boom") && u.includes("repair boom")),
      `expected honest repair failure in unfixable[]: ${report.unfixable.join(" | ")}`,
    )
  } finally {
    cleanup(dir)
  }
})
