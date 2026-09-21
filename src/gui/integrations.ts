/**
 * GUI integration API layer (M3, Lead-owned after Builder reassignment).
 *
 * Pure functions consumed by the GUI HTTP routes (src/gui/server.ts) and the
 * stdio bridge (guiReads.integrationsList) — NO HTTP here, NO filesystem
 * mutation outside the manager's own operations. The manager (runGuarded)
 * owns locking; this layer adds none.
 *
 * projectBootstrap() is the project-open hook: it MAPS detection to a
 * suggested action and is strictly OFFER-ONLY — calling it never mutates
 * the project (tested). Migration detection mirrors src/core/store.ts's
 * one-time v1->v2 logic: v2 state present => never "migration_required",
 * even when the legacy directory also exists.
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createDefaultManager } from "../integrations/registry.js"
import {
  CURRENT_INTEGRATION_SCHEMA_VERSION,
  getInstalledVersion,
  readIntegrationMarkers,
} from "../integrations/versioning.js"
import type { IntegrationManager } from "../integrations/manager.js"
import type { IntegrationContext, IntegrationDetection, IntegrationReport } from "../integrations/types.js"
import { LEGACY_STATE_DIR, SCHEMA_VERSION, STATE_FILE, STATE_DIR } from "../core/types.js"
import { VERSION } from "../version.js"

export const LIFECYCLE_ACTIONS = ["install", "update", "repair", "verify", "uninstall"] as const
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number]

export interface IntegrationHostView {
  id: string
  name: string
  scope: string
  status: IntegrationDetection["status"]
  installedVersion: string | null
  currentVersion: string
  details: string[]
  issues: string[]
  actions: Record<"install" | "update" | "repair" | "verify" | "uninstall", boolean>
}

export interface IntegrationsOverview {
  project: string
  currentVersion: string
  hosts: IntegrationHostView[]
}

export interface BootstrapDecision {
  integration: "current" | "absent" | "outdated" | "broken" | "migration_required" | "incompatible"
  action: "continue" | "install" | "update" | "repair"
  message: string
}

const INTEGRATION_FILE = "integration.json"

function ctxFor(projectDir: string): IntegrationContext {
  return { projectDir: resolve(projectDir), currentVersion: VERSION }
}

/**
 * Overview of all five hosts against one project. Per-host failures are
 * already mapped to broken detections by the manager — this never throws.
 */
export async function integrationsOverview(projectDir: string): Promise<IntegrationsOverview> {
  const manager = createDefaultManager()
  const ctx = ctxFor(projectDir)
  const hosts: IntegrationHostView[] = []
  for (const adapter of manager.list()) {
    let detection: IntegrationDetection
    try {
      detection = await manager.detect(ctx, adapter.id)
    } catch (error) {
      detection = {
        status: "broken",
        installedVersion: null,
        currentVersion: ctx.currentVersion,
        details: [],
        issues: [error instanceof Error ? error.message : String(error)],
      }
    }
    const hasUninstall = typeof adapter.uninstall === "function"
    hosts.push({
      id: adapter.id,
      name: adapter.name,
      scope: adapter.scope,
      status: detection.status,
      installedVersion: detection.installedVersion ?? null,
      currentVersion: ctx.currentVersion,
      details: detection.details,
      issues: detection.issues,
      actions: {
        install: detection.status === "absent",
        update: detection.status === "outdated",
        repair: detection.status === "broken",
        verify: detection.status === "installed",
        // Uninstall is offered whenever the adapter has the member and the
        // integration exists (absent has nothing to remove).
        uninstall: hasUninstall && detection.status !== "absent",
      },
    })
  }
  return { project: ctx.projectDir, currentVersion: ctx.currentVersion, hosts }
}

/**
 * SYNC bridge variant (guiReads.integrationsList is synchronous in the
 * bridge contract): marker-backed, never throws, no async adapter calls.
 * Full live detection stays on the HTTP overview (GET /api/integrations);
 * the bridge surfaces install state only, with an honest "unknown" status
 * and a pointer to the full view when no marker exists.
 */
export function integrationsListSync(projectDir: string | null): Array<{
  id: string
  name: string
  status: string
  installedVersion: string | null
  currentVersion: string
  issues: string[]
}> {
  if (!projectDir) return []
  const manager = createDefaultManager()
  const ctx = ctxFor(projectDir)
  const out: Array<{
    id: string
    name: string
    status: string
    installedVersion: string | null
    currentVersion: string
    issues: string[]
  }> = []
  for (const adapter of manager.list()) {
    const marker = getInstalledVersion(ctx.projectDir, adapter.id)
    out.push({
      id: adapter.id,
      name: adapter.name,
      status: marker ? "installed" : "unknown",
      installedVersion: marker,
      currentVersion: ctx.currentVersion,
      issues: marker ? [] : ["not detected by the sync bridge — use the Integrations view for full detection"],
    })
  }
  return out
}

/**
 * Run ONE lifecycle verb against ONE host. The five-verb whitelist is
 * enforced HERE (server-side) before anything reaches the manager; unknown
 * ids/actions never touch adapter code.
 */
export async function integrationAction(projectDir: string, id: string, action: string): Promise<IntegrationReport> {
  if (!(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      actions: [],
      warnings: [`Unknown action "${action}" (allowed: ${LIFECYCLE_ACTIONS.join(", ")}).`],
      capabilities: {},
      changedFiles: [],
    }
  }
  const manager: IntegrationManager = createDefaultManager()
  if (!manager.get(id)) {
    return {
      ok: false,
      actions: [],
      warnings: [`Unknown integration "${id}".`],
      capabilities: {},
      changedFiles: [],
    }
  }
  const ctx = ctxFor(projectDir)
  // The whitelist switch is exhaustive over LIFECYCLE_ACTIONS; the trailing
  // throw is unreachable by construction (satisfies the strict return check).
  switch (action) {
    case "install":
      return manager.install(ctx, id)
    case "update":
      return manager.update(ctx, id)
    case "repair":
      return manager.repair(ctx, id)
    case "verify":
      return manager.verify(ctx, id)
    case "uninstall":
      return manager.uninstall(ctx, id)
  }
  throw new Error(`unreachable: action "${action}" passed the whitelist but has no case`)
}

function readStateSchema(projectDir: string): { v2Present: boolean; legacyPresent: boolean; legacySchemaOne: boolean } {
  const target = resolve(projectDir)
  const v2File = join(target, STATE_DIR, STATE_FILE)
  let v2Present = false
  if (existsSync(v2File)) {
    try {
      const parsed = JSON.parse(readFileSync(v2File, "utf8")) as { schema_version?: unknown }
      v2Present = parsed.schema_version === SCHEMA_VERSION
    } catch {
      v2Present = false
    }
  }
  const legacyFile = join(target, LEGACY_STATE_DIR, STATE_FILE)
  const legacyPresent = existsSync(legacyFile)
  let legacySchemaOne = false
  if (legacyPresent) {
    try {
      const parsed = JSON.parse(readFileSync(legacyFile, "utf8")) as { schema_version?: unknown }
      legacySchemaOne = parsed.schema_version === 1
    } catch {
      legacySchemaOne = false
    }
  }
  return { v2Present, legacyPresent, legacySchemaOne }
}

/**
 * Project-open bootstrap decision (OFFER-ONLY: never mutates anything).
 *
 * Mapping (Reviewer-amended spec):
 * - v2 state ABSENT + legacy v1 state PRESENT => migration_required (the
 *   plugin's next load performs the one-time migration; the GUI only tells
 *   the user). v2 PRESENT => never migration_required, legacy dir or not.
 * - integration.json marker with a rejected schema (malformed/foreign
 *   schema_version) => broken/repair — the SAME repair path, no third route.
 * - Otherwise the OpenCode adapter's detection decides (OpenCode is the
 *   reference project integration).
 */
export async function projectBootstrap(projectDir: string): Promise<BootstrapDecision> {
  const target = resolve(projectDir)
  const { v2Present, legacyPresent, legacySchemaOne } = readStateSchema(target)

  if (!v2Present && legacyPresent && legacySchemaOne) {
    return {
      integration: "migration_required",
      action: "continue",
      message: `Legacy v1 state detected at ${LEGACY_STATE_DIR}/. It migrates automatically to ${STATE_DIR}/ on the next OpenCode plugin load; open the project normally.`,
    }
  }

  // Marker schema mismatch => the marker file cannot be trusted => repair.
  const markerFile = join(target, STATE_DIR, INTEGRATION_FILE)
  if (existsSync(markerFile)) {
    const markers = readIntegrationMarkers(target)
    if (!markers) {
      return {
        integration: "incompatible",
        action: "repair",
        message: "Project integration marker is malformed or has an unsupported schema. Repair will rebuild it.",
      }
    }
    if (markers.schema_version !== CURRENT_INTEGRATION_SCHEMA_VERSION) {
      return {
        integration: "incompatible",
        action: "repair",
        message: `Project integration marker schema (${markers.schema_version}) differs from the supported version (${CURRENT_INTEGRATION_SCHEMA_VERSION}). Repair rebuilds it.`,
      }
    }
  }

  const manager = createDefaultManager()
  const ctx = ctxFor(target)
  let detection: IntegrationDetection
  try {
    detection = await manager.detect(ctx, "opencode")
  } catch (error) {
    return {
      integration: "broken",
      action: "repair",
      message: `OpenCode integration detection failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  switch (detection.status) {
    case "installed":
      return {
        integration: "current",
        action: "continue",
        message: `OpenComms project integration is current${detection.installedVersion ? ` (v${detection.installedVersion})` : ""}.`,
      }
    case "absent":
      return {
        integration: "absent",
        action: "install",
        message: "OpenComms is not installed in this project. Install the OpenCode plugin to enable channels here.",
      }
    case "outdated":
      return {
        integration: "outdated",
        action: "update",
        message: `OpenComms project integration is outdated (installed ${detection.installedVersion ?? "unknown"}, current ${VERSION}). Update to the current version.`,
      }
    case "broken":
      return {
        integration: "broken",
        action: "repair",
        message: `OpenComms project integration is broken: ${detection.issues.join("; ") || "partial install"}. Repair restores the missing pieces.`,
      }
  }
}
