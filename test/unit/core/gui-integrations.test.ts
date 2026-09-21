/**
 * GUI integration API layer tests (M3, Lead slice).
 *
 * Covers: integrationsOverview shapes + per-status action availability,
 * integrationAction five-verb whitelist + unknown id/action rejection,
 * projectBootstrap mapping (fresh → install offer; stamped → continue;
 * outdated → update; broken → repair; legacy v1 + no v2 → migration_required;
 * v2 present + legacy dir → NEVER migration_required; malformed marker →
 * incompatible/repair), and the OFFER-ONLY no-write guarantee (calling
 * projectBootstrap on a fresh project mutates NOTHING).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  integrationsOverview,
  integrationAction,
  projectBootstrap,
  LIFECYCLE_ACTIONS,
  type IntegrationsOverview,
} from "../../../src/gui/integrations.js"
import { createDefaultManager } from "../../../src/integrations/registry.js"
import { getInstalledVersion, updateIntegrationMarker } from "../../../src/integrations/versioning.js"
import { VERSION } from "../../../src/version.js"

const HOST_IDS = ["opencode", "claude-code", "codex", "claude-desktop", "chatgpt"]

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function distReady(): boolean {
  return existsSync(join(process.cwd(), "dist", "plugin.bundled.js"))
}

function statusOf(overview: IntegrationsOverview, id: string): IntegrationHostViewLike {
  const found = overview.hosts.find((h) => h.id === id)
  assert.ok(found, `expected host ${id} in overview`)
  return found
}

interface IntegrationHostViewLike {
  id: string
  status: string
  installedVersion: string | null
  actions: Record<string, boolean>
}

test("overview: fresh project — all five hosts absent, install offered, uninstall withheld", async () => {
  const dir = mkTmp("oc-gi-fresh-")
  try {
    const overview = await integrationsOverview(dir)
    assert.equal(overview.currentVersion, VERSION)
    assert.deepEqual(
      overview.hosts.map((h) => h.id).sort(),
      [...HOST_IDS].sort(),
      "overview covers exactly the five registered hosts",
    )
    for (const id of HOST_IDS) {
      const host = statusOf(overview, id)
      assert.equal(host.status, "absent", id)
      assert.equal(host.actions.install, true, `${id}: absent => install offered`)
      assert.equal(host.actions.uninstall, false, `${id}: absent => uninstall withheld`)
      assert.equal(host.actions.update, false)
      assert.equal(host.actions.repair, false)
    }
  } finally {
    cleanup(dir)
  }
})

test("overview: installed opencode — verify offered, uninstall offered, update/repair withheld", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-gi-installed-")
  try {
    const report = await integrationAction(dir, "opencode", "install")
    assert.equal(report.ok, true, report.warnings.join("; "))
    const overview = await integrationsOverview(dir)
    const opencode = statusOf(overview, "opencode")
    assert.equal(opencode.status, "installed")
    assert.equal(opencode.installedVersion, VERSION)
    assert.equal(opencode.actions.verify, true)
    assert.equal(opencode.actions.uninstall, true)
    assert.equal(opencode.actions.install, false)
    assert.equal(opencode.actions.update, false)
  } finally {
    cleanup(dir)
  }
})

test("integrationAction: unknown verb and unknown id rejected BEFORE the manager", async () => {
  const dir = mkTmp("oc-gi-action-")
  try {
    const badVerb = await integrationAction(dir, "opencode", "explode")
    assert.equal(badVerb.ok, false)
    assert.match(badVerb.warnings.join(" "), /Unknown action "explode"/)
    assert.deepEqual(badVerb.changedFiles, [])
    // The five verbs are the whitelist.
    assert.deepEqual([...LIFECYCLE_ACTIONS].sort(), ["install", "repair", "uninstall", "update", "verify"])

    const badId = await integrationAction(dir, "not-a-host", "install")
    assert.equal(badId.ok, false)
    assert.match(badId.warnings.join(" "), /Unknown integration "not-a-host"/)
    assert.ok(!existsSync(join(dir, ".opencode")), "rejected action wrote nothing")
  } finally {
    cleanup(dir)
  }
})

test("bootstrap: fresh project offers install and writes NOTHING (offer-only guarantee)", async () => {
  const dir = mkTmp("oc-gi-boot-fresh-")
  try {
    const before = readdirSync(dir)
    const decision = await projectBootstrap(dir)
    assert.equal(decision.integration, "absent")
    assert.equal(decision.action, "install")
    assert.match(decision.message, /not installed/i)
    assert.deepEqual(readdirSync(dir), before, "projectBootstrap must not mutate the project")
  } finally {
    cleanup(dir)
  }
})

test("bootstrap: current integration continues; outdated offers update", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-gi-boot-cur-")
  try {
    assert.equal((await integrationAction(dir, "opencode", "install")).ok, true)
    const current = await projectBootstrap(dir)
    assert.equal(current.integration, "current")
    assert.equal(current.action, "continue")

    // Simulate an older stamp: marker version < VERSION.
    updateIntegrationMarker(dir, "opencode", { version: "0.0.1" })
    const outdated = await projectBootstrap(dir)
    assert.equal(outdated.integration, "outdated")
    assert.equal(outdated.action, "update")
  } finally {
    cleanup(dir)
  }
})

test("bootstrap: broken integration offers repair (partial install)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-gi-boot-broken-")
  try {
    assert.equal((await integrationAction(dir, "opencode", "install")).ok, true)
    rmSync(join(dir, ".opencode", "plugins", "plugin.js"))
    const decision = await projectBootstrap(dir)
    assert.equal(decision.integration, "broken")
    assert.equal(decision.action, "repair")
  } finally {
    cleanup(dir)
  }
})

test("bootstrap: legacy v1 state without v2 => migration_required (continue, never auto-migrate)", async () => {
  const dir = mkTmp("oc-gi-boot-legacy-")
  try {
    mkdirSync(join(dir, ".opencode-comms"), { recursive: true })
    writeFileSync(
      join(dir, ".opencode-comms", "state.json"),
      JSON.stringify({ schema_version: 1, channels: {} }),
      "utf8",
    )
    const decision = await projectBootstrap(dir)
    assert.equal(decision.integration, "migration_required")
    assert.equal(decision.action, "continue", "migration is automatic at plugin load — the GUI never runs it")
    assert.ok(!existsSync(join(dir, ".opencomms")), "bootstrap must not create v2 state itself")
  } finally {
    cleanup(dir)
  }
})

test("bootstrap: v2 state present + legacy dir present => NEVER migration_required (store.ts parity)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-gi-boot-v2-legacy-")
  try {
    assert.equal((await integrationAction(dir, "opencode", "install")).ok, true)
    mkdirSync(join(dir, ".opencomms"), { recursive: true })
    writeFileSync(
      join(dir, ".opencomms", "state.json"),
      JSON.stringify({ schema_version: 2, channels: {}, messages: {}, queues: {}, delivered_to: {}, errors: [] }),
      "utf8",
    )
    mkdirSync(join(dir, ".opencode-comms"), { recursive: true })
    writeFileSync(join(dir, ".opencode-comms", "state.json"), JSON.stringify({ schema_version: 1 }), "utf8")
    const decision = await projectBootstrap(dir)
    assert.equal(decision.integration, "current")
    assert.equal(decision.action, "continue")
  } finally {
    cleanup(dir)
  }
})

test("bootstrap: malformed / foreign-schema marker => incompatible mapped to the SAME repair path", async () => {
  const dir = mkTmp("oc-gi-boot-marker-")
  try {
    mkdirSync(join(dir, ".opencomms"), { recursive: true })
    writeFileSync(join(dir, ".opencomms", "integration.json"), "{ corrupt", "utf8")
    const malformed = await projectBootstrap(dir)
    assert.equal(malformed.integration, "incompatible")
    assert.equal(malformed.action, "repair")

    writeFileSync(
      join(dir, ".opencomms", "integration.json"),
      JSON.stringify({ schema_version: 99, integrations: {} }),
      "utf8",
    )
    const foreign = await projectBootstrap(dir)
    assert.equal(foreign.integration, "incompatible")
    assert.equal(foreign.action, "repair", "no third path — repair() rebuilds the marker")
  } finally {
    cleanup(dir)
  }
})

test("bootstrap: uninstall via integrationAction closes the lifecycle (absent again)", async (t) => {
  if (!distReady()) {
    t.skip("dist missing — run npm run build")
    return
  }
  const dir = mkTmp("oc-gi-boot-cycle-")
  try {
    assert.equal((await integrationAction(dir, "opencode", "install")).ok, true)
    assert.equal(getInstalledVersion(dir, "opencode"), VERSION)
    const removed = await integrationAction(dir, "opencode", "uninstall")
    assert.equal(removed.ok, true, removed.warnings.join("; "))
    assert.equal(getInstalledVersion(dir, "opencode"), null, "marker removed by uninstall")
    const decision = await projectBootstrap(dir)
    assert.equal(decision.integration, "absent")
    assert.equal(decision.action, "install")
  } finally {
    cleanup(dir)
  }
})
