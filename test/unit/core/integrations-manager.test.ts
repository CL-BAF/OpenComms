/**
 * M1 core-abstraction tests (+ R1 hardening).
 *
 * Covers: manager register/list, unknown-id handling, adapter-throw
 * resilience, versioning fresh write / malformed -> null / per-id update
 * preserves other ids / atomic rename, compareVersions (incl. leading-v),
 * and the manager update dispatcher (absent -> install, broken -> repair,
 * marker drift -> update, installed-but-marker-absent -> adoption update,
 * installed-and-current -> strict no-op). R1 additions: parallel installs
 * under the StateStore lock (no lost markers), failure rollback (ok:false
 * never leaves a success stamp), and one real-adapter scenario (corrupt
 * .claude/settings.json via the real claude-code adapter — skipped when
 * dist is not built). Otherwise mocks only; never touches gui/ files.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { IntegrationManager } from "../../../src/integrations/manager.js"
import {
  compareVersions,
  getInstalledVersion,
  getIntegrationMarker,
  integrationFilePath,
  readIntegrationFile,
  readIntegrationMarkers,
  removeIntegrationMarker,
  setInstalledVersion,
  updateIntegrationMarker,
  writeIntegrationMarkers,
  emptyIntegrationFile,
  CURRENT_INTEGRATION_SCHEMA_VERSION,
} from "../../../src/integrations/versioning.js"
import { claudeCodeAdapter } from "../../../src/integrations/adapters/claude-code.js"
import { PLACEHOLDER_ISSUE } from "../../../src/integrations/types.js"
import type {
  HostIntegration,
  IntegrationContext,
  IntegrationDetection,
  IntegrationReport,
} from "../../../src/integrations/types.js"

function ctxFor(dir: string, currentVersion = "1.3.1"): IntegrationContext {
  return { projectDir: dir, currentVersion }
}

function okReport(action: string): IntegrationReport {
  return { ok: true, actions: [action], warnings: [], capabilities: {}, changedFiles: [] }
}

function mockAdapter(
  id: string,
  overrides: Partial<HostIntegration> = {},
): HostIntegration & { calls: Record<string, number> } {
  const calls: Record<string, number> = { detect: 0, install: 0, update: 0, repair: 0, verify: 0, uninstall: 0 }
  const installed: IntegrationDetection = {
    status: "installed",
    installedVersion: "1.3.1",
    currentVersion: "1.3.1",
    details: ["mock installed"],
    issues: [],
  }
  const base: HostIntegration = {
    id,
    name: id,
    scope: "project",
    detect: async () => {
      calls["detect"] = (calls["detect"] ?? 0) + 1
      return installed
    },
    install: async () => {
      calls["install"] = (calls["install"] ?? 0) + 1
      return okReport(`installed ${id}`)
    },
    update: async () => {
      calls["update"] = (calls["update"] ?? 0) + 1
      return okReport(`updated ${id}`)
    },
    repair: async () => {
      calls["repair"] = (calls["repair"] ?? 0) + 1
      return okReport(`repaired ${id}`)
    },
    verify: async () => {
      calls["verify"] = (calls["verify"] ?? 0) + 1
      return okReport(`verified ${id}`)
    },
    uninstall: async () => {
      calls["uninstall"] = (calls["uninstall"] ?? 0) + 1
      return okReport(`uninstalled ${id}`)
    },
  }
  return { ...base, ...overrides, calls }
}

function withTmpDir(fn: (dir: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-int-"))
    try {
      await fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test(
  "manager: register + list exposes adapters by id",
  withTmpDir(async () => {
    const manager = new IntegrationManager()
    assert.deepEqual(
      manager.list().map((a) => a.id),
      [],
    )
    manager.register(mockAdapter("opencode"))
    manager.register(mockAdapter("codex"))
    assert.deepEqual(
      manager
        .list()
        .map((a) => a.id)
        .sort(),
      ["codex", "opencode"],
    )
  }),
)

test(
  "manager: unknown id returns ok:false Reports; detect throws",
  withTmpDir(async (dir) => {
    const manager = new IntegrationManager()
    manager.register(mockAdapter("opencode"))
    const ctx = ctxFor(dir)
    for (const op of ["install", "update", "repair", "verify"] as const) {
      const report = await manager[op](ctx, "nope")
      assert.equal(report.ok, false)
      assert.match(report.warnings.join(" "), /Unknown integration/)
    }
    await assert.rejects(() => manager.detect(ctx, "nope"), /Unknown integration/)
  }),
)

test(
  "manager: adapter throw maps to ok:false Report and broken detection",
  withTmpDir(async (dir) => {
    const manager = new IntegrationManager()
    const failing = mockAdapter("boom", {
      detect: async () => {
        throw new Error("detect exploded")
      },
      install: async () => {
        throw new Error("install exploded")
      },
      update: async () => {
        throw new Error("update exploded")
      },
      repair: async () => {
        throw new Error("repair exploded")
      },
      verify: async () => {
        throw new Error("verify exploded")
      },
    })
    manager.register(failing)
    const ctx = ctxFor(dir)
    const detection = await manager.detect(ctx, "boom")
    assert.equal(detection.status, "broken")
    assert.match(detection.issues.join(" "), /detect exploded/)
    const all = await manager.detectAll(ctx)
    assert.equal(all["boom"]?.status, "broken")
    for (const op of ["install", "repair", "verify"] as const) {
      const report = await manager[op](ctx, "boom")
      assert.equal(report.ok, false)
      assert.match(report.warnings.join(" "), /exploded/)
    }
    // update() with a throwing detect maps to ok:false without calling install.
    const updated = await manager.update(ctx, "boom")
    assert.equal(updated.ok, false)
    assert.match(updated.warnings.join(" "), /Detection.*failed|exploded/)
  }),
)

test(
  "manager update: absent -> install, broken -> repair",
  withTmpDir(async (dir) => {
    const manager = new IntegrationManager()
    const absent = mockAdapter("absent-host", {
      detect: async () => ({ status: "absent", details: ["nothing installed"], issues: ["missing"] }),
    })
    const broken = mockAdapter("broken-host", {
      detect: async () => ({ status: "broken", details: [], issues: ["half installed"] }),
    })
    manager.register(absent)
    manager.register(broken)
    const ctx = ctxFor(dir)
    const viaInstall = await manager.update(ctx, "absent-host")
    assert.equal(viaInstall.ok, true)
    assert.equal(absent.calls["install"], 1)
    assert.equal(absent.calls["update"] ?? 0, 0)
    const viaRepair = await manager.update(ctx, "broken-host")
    assert.equal(viaRepair.ok, true)
    assert.equal(broken.calls["repair"], 1)
    assert.equal(broken.calls["update"] ?? 0, 0)
  }),
)

test(
  "manager update: marker version drift triggers adapter.update; current marker is a no-op",
  withTmpDir(async (dir) => {
    const manager = new IntegrationManager()
    const adapter = mockAdapter("opencode")
    manager.register(adapter)
    // Stale marker -> update path even though detect says installed.
    updateIntegrationMarker(dir, "opencode", { version: "1.2.0" })
    const ctx = ctxFor(dir, "1.3.1")
    const updated = await manager.update(ctx, "opencode")
    assert.equal(updated.ok, true)
    assert.equal(adapter.calls["update"], 1)
    // Fresh marker at current version -> no-op, adapter.update not called again.
    updateIntegrationMarker(dir, "opencode", { version: "1.3.1" })
    const noop = await manager.update(ctx, "opencode")
    assert.equal(noop.ok, true)
    assert.equal(adapter.calls["update"], 1)
    assert.match(noop.actions.join(" "), /already current/)
  }),
)

test(
  "manager update: adapter outdated status triggers adapter.update",
  withTmpDir(async (dir) => {
    const manager = new IntegrationManager()
    const adapter = mockAdapter("codex", {
      detect: async () => ({
        status: "outdated",
        installedVersion: "1.2.0",
        currentVersion: "1.3.1",
        details: ["old bundle"],
        issues: ["version drift"],
      }),
    })
    manager.register(adapter)
    const report = await manager.update(ctxFor(dir, "1.3.1"), "codex")
    assert.equal(report.ok, true)
    assert.equal(adapter.calls["update"], 1)
  }),
)

test(
  "versioning: fresh write then read round-trips",
  withTmpDir(async (dir) => {
    assert.equal(readIntegrationMarkers(dir), null)
    assert.equal(getIntegrationMarker(dir, "opencode"), null)
    updateIntegrationMarker(dir, "opencode", { version: "1.3.1" })
    const file = readIntegrationMarkers(dir)
    assert.equal(file?.schema_version, CURRENT_INTEGRATION_SCHEMA_VERSION)
    assert.equal(file?.integrations["opencode"]?.version, "1.3.1")
  }),
)

test(
  "versioning: malformed JSON returns null and never throws",
  withTmpDir(async (dir) => {
    const file = integrationFilePath(dir)
    writeIntegrationMarkers(dir, emptyIntegrationFile())
    assert.notEqual(readIntegrationMarkers(dir), null)
    writeFileSync(file, "{ not json", "utf8")
    assert.equal(readIntegrationMarkers(dir), null)
    assert.equal(getIntegrationMarker(dir, "opencode"), null)
    writeFileSync(file, JSON.stringify({ schema_version: 999, integrations: {} }), "utf8")
    assert.equal(readIntegrationMarkers(dir), null)
    writeFileSync(file, JSON.stringify({ schema_version: 1, integrations: { opencode: { version: 42 } } }), "utf8")
    assert.equal(readIntegrationMarkers(dir), null)
  }),
)

test(
  "versioning: per-id update preserves other ids and is idempotent",
  withTmpDir(async (dir) => {
    updateIntegrationMarker(dir, "opencode", { version: "1.3.1" })
    updateIntegrationMarker(dir, "codex", { version: "1.2.0" })
    const before = readIntegrationMarkers(dir)
    assert.equal(before?.integrations["opencode"]?.version, "1.3.1")
    assert.equal(before?.integrations["codex"]?.version, "1.2.0")
    const installedAt = before?.integrations["opencode"]?.installed_at
    updateIntegrationMarker(dir, "codex", { version: "1.3.1" })
    const after = readIntegrationMarkers(dir)
    assert.equal(after?.integrations["opencode"]?.version, "1.3.1")
    assert.equal(after?.integrations["opencode"]?.installed_at, installedAt)
    assert.equal(after?.integrations["codex"]?.version, "1.3.1")
  }),
)

test(
  "versioning: atomic write leaves no temp files behind",
  withTmpDir(async (dir) => {
    updateIntegrationMarker(dir, "opencode", { version: "1.3.1" })
    const opencommsDir = join(dir, ".opencomms")
    const entries = readdirSync(opencommsDir)
    assert.ok(entries.includes("integration.json"))
    assert.equal(entries.filter((e) => e.endsWith(".tmp")).length, 0)
    assert.ok(existsSync(integrationFilePath(dir)))
  }),
)

test("versioning: compareVersions handles major/minor/patch and suffixes", () => {
  assert.equal(compareVersions("1.3.1", "1.3.1"), 0)
  assert.equal(compareVersions("1.2.0", "1.3.1"), -1)
  assert.equal(compareVersions("1.3.1", "1.2.9"), 1)
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1)
  assert.equal(compareVersions("1.3", "1.3.0"), 0)
  assert.equal(compareVersions("1.3.1-alpha", "1.3.1"), 0)
})

test("versioning: compareVersions strips a leading v (update.ts parity)", () => {
  assert.equal(compareVersions("v1.3.1", "1.3.1"), 0)
  assert.equal(compareVersions("v2.0.0", "1.9.9"), 1)
  assert.equal(compareVersions("v1.2.0", "1.3.1"), -1)
})

test(
  "versioning: readIntegrationFile mirrors readIntegrationMarkers; removeIntegrationMarker drops one id",
  withTmpDir(async (dir) => {
    assert.equal(readIntegrationFile(dir), null)
    updateIntegrationMarker(dir, "opencode", { version: "1.3.1" })
    updateIntegrationMarker(dir, "codex", { version: "1.3.1" })
    assert.deepEqual(Object.keys(readIntegrationFile(dir)?.integrations ?? {}).sort(), ["codex", "opencode"])
    removeIntegrationMarker(dir, "opencode")
    assert.equal(getInstalledVersion(dir, "opencode"), null)
    assert.equal(getInstalledVersion(dir, "codex"), "1.3.1")
    removeIntegrationMarker(dir, "missing-id")
    assert.equal(getInstalledVersion(dir, "codex"), "1.3.1")
  }),
)

test(
  "manager update: installed + marker absent triggers adoption update, not a no-op",
  withTmpDir(async (dir) => {
    const manager = new IntegrationManager()
    const adapter = mockAdapter("adopted-host")
    manager.register(adapter)
    assert.equal(readIntegrationMarkers(dir), null)
    const report = await manager.update(ctxFor(dir, "1.3.1"), "adopted-host")
    assert.equal(report.ok, true)
    assert.equal(adapter.calls["update"], 1)
  }),
)

test(
  "manager update: installed + marker current is a strict no-op (single action, no writes)",
  withTmpDir(async (dir) => {
    const manager = new IntegrationManager()
    const adapter = mockAdapter("current-host")
    manager.register(adapter)
    updateIntegrationMarker(dir, "current-host", { version: "1.3.1" })
    const before = readIntegrationMarkers(dir)
    const report = await manager.update(ctxFor(dir, "1.3.1"), "current-host")
    assert.equal(report.ok, true)
    assert.equal(report.actions.length, 1)
    assert.match(report.actions[0] ?? "", /already current/)
    assert.deepEqual(report.changedFiles, [])
    assert.equal(adapter.calls["update"] ?? 0, 0)
    assert.equal(adapter.calls["install"] ?? 0, 0)
    assert.equal(adapter.calls["repair"] ?? 0, 0)
    assert.deepEqual(readIntegrationMarkers(dir), before)
  }),
)

test(
  "manager: ok:false never leaves a success stamp (rollback restores pre-op marker)",
  withTmpDir(async (dir) => {
    const manager = new IntegrationManager()
    // Misbehaving adapter: stamps a marker, then reports failure.
    const stampingFailure = mockAdapter("stamp-fail", {
      install: async (ctx) => {
        setInstalledVersion(ctx.projectDir, "stamp-fail", ctx.currentVersion)
        return {
          ok: false,
          actions: [],
          warnings: ["simulated failure after stamp"],
          capabilities: {},
          changedFiles: [],
        }
      },
    })
    manager.register(stampingFailure)
    const failed = await manager.install(ctxFor(dir, "1.3.1"), "stamp-fail")
    assert.equal(failed.ok, false)
    assert.equal(getInstalledVersion(dir, "stamp-fail"), null)
    // Pre-existing marker survives a later failure untouched.
    setInstalledVersion(dir, "stamp-fail", "1.2.0")
    const failedAgain = await manager.install(ctxFor(dir, "1.3.1"), "stamp-fail")
    assert.equal(failedAgain.ok, false)
    assert.equal(getInstalledVersion(dir, "stamp-fail"), "1.2.0")
  }),
)

test(
  "manager: two parallel installs serialize — no lost markers, file stays valid",
  withTmpDir(async (dir) => {
    const manager = new IntegrationManager()
    // Gap adapters simulate a naive read-modify-write with an async yield
    // between read and write: without the manager lock the second write
    // would clobber the first id's marker.
    const gapAdapter = (id: string): HostIntegration => ({
      id,
      name: id,
      scope: "project",
      detect: async () => ({ status: "absent", details: [], issues: ["missing"] }),
      install: async (ctx) => {
        const file = readIntegrationMarkers(ctx.projectDir) ?? emptyIntegrationFile()
        await new Promise((resolve) => setTimeout(resolve, 25))
        const now = Date.now()
        writeIntegrationMarkers(ctx.projectDir, {
          schema_version: CURRENT_INTEGRATION_SCHEMA_VERSION,
          integrations: {
            ...file.integrations,
            [id]: { version: ctx.currentVersion, installed_at: now, updated_at: now },
          },
        })
        return okReport(`installed ${id}`)
      },
      update: async () => okReport(`updated ${id}`),
      repair: async () => okReport(`repaired ${id}`),
      verify: async () => okReport(`verified ${id}`),
    })
    manager.register(gapAdapter("parallel-a"))
    manager.register(gapAdapter("parallel-b"))
    const ctx = ctxFor(dir, "1.3.1")
    const [first, second] = await Promise.all([manager.install(ctx, "parallel-a"), manager.install(ctx, "parallel-b")])
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    const file = readIntegrationMarkers(dir)
    assert.ok(file, "integration.json valid after parallel installs")
    assert.equal(file?.integrations["parallel-a"]?.version, "1.3.1")
    assert.equal(file?.integrations["parallel-b"]?.version, "1.3.1")
  }),
)

function distReady(): boolean {
  return (
    existsSync(join(process.cwd(), "dist", "plugin.bundled.js")) &&
    existsSync(join(process.cwd(), "dist", "mcp", "main.js")) &&
    existsSync(join(process.cwd(), "dist", "adapters", "claude-code", "hook-cli.js"))
  )
}

test("manager + real claude-code adapter: corrupt settings => ok:false, marker untouched, never throws", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-int-real-"))
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true })
    writeFileSync(join(dir, ".claude", "settings.json"), "{ broken", "utf8")
    const manager = new IntegrationManager()
    manager.register(claudeCodeAdapter)
    const report = await manager.install({ projectDir: dir, currentVersion: "1.3.1" }, "claude-code")
    assert.equal(report.ok, false)
    assert.ok(report.warnings.length > 0)
    assert.equal(getInstalledVersion(dir, "claude-code"), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("manager.uninstall: delegates to adapters with the member; ok:false 'uninstall unsupported' without it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-int-uninst-"))
  try {
    const manager = new IntegrationManager()

    // Adapter WITHOUT the optional member (delete via override cast).
    const bare = mockAdapter("bare")
    const bareNoUninstall = { ...bare } as HostIntegration & { calls: Record<string, number> }
    delete (bareNoUninstall as Partial<HostIntegration>).uninstall
    manager.register(bareNoUninstall)
    const refused = await manager.uninstall(ctxFor(dir), "bare")
    assert.equal(refused.ok, false)
    assert.match(refused.warnings.join(" "), /Uninstall unsupported by "bare"/)
    assert.equal(bare.calls["uninstall"] ?? 0, 0)

    // Adapter WITH the member delegates under runGuarded.
    const full = mockAdapter("full")
    manager.register(full)
    const done = await manager.uninstall(ctxFor(dir), "full")
    assert.equal(done.ok, true)
    assert.equal(full.calls["uninstall"], 1)

    // Unknown id.
    const unknown = await manager.uninstall(ctxFor(dir), "nope")
    assert.equal(unknown.ok, false)
    assert.match(unknown.warnings.join(" "), /Unknown integration "nope"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("PLACEHOLDER_ISSUE is the exact string both claude-code and codex adapters emit", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-int-ph-"))
  try {
    const manager = new IntegrationManager()
    manager.register(claudeCodeAdapter)
    const ctx = ctxFor(dir)
    assert.equal((await manager.install(ctx, "claude-code")).ok, true)
    const detection = await manager.detect(ctx, "claude-code")
    assert.equal(detection.status, "broken")
    assert.ok(detection.issues.includes(PLACEHOLDER_ISSUE), "claude-code emits the shared constant verbatim")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
