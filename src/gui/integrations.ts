/** Shared HTTP/stdio integration layer. The manager owns mutation locking. */

import { existsSync, readFileSync } from "node:fs"
import { delimiter, join, resolve } from "node:path"
import { OrchestratorStore } from "../orchestrator/state.js"
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
  onboarding: {
    application: "detected" | "not_detected" | "unknown"
    configuration: "configured" | "needs_attention"
    connection: "runtime_contact_observed" | "unknown"
    round_trip: "unverified"
    detail: string
  }
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

export async function integrationsOverview(projectDir: string): Promise<IntegrationsOverview> {
  const manager = createDefaultManager()
  const ctx = ctxFor(projectDir)
  const hosts: IntegrationHostView[] = []
  const agents = new OrchestratorStore(ctx.projectDir).load().agents
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
      onboarding: {
        application: applicationPresence(adapter.id),
        configuration: detection.status === "installed" ? "configured" : "needs_attention",
        connection: agents.some(
          (agent) =>
            agent.host === adapter.id &&
            ["running", "idle"].includes(agent.status) &&
            agent.last_heartbeat !== null &&
            Date.now() - agent.last_heartbeat < 30_000,
        )
          ? "runtime_contact_observed"
          : "unknown",
        round_trip: "unverified",
        detail:
          "Configuration checks inspect files. Runtime contact is a recent recorded managed-host observation; it does not establish model execution. Verify a message round trip in the actual host before assigning consequential work.",
      },
      actions: {
        install: detection.status === "absent",
        update: detection.status === "outdated",
        repair: detection.status === "broken",
        verify: detection.status === "installed",
        uninstall: hasUninstall && detection.status !== "absent",
      },
    })
  }
  return { project: ctx.projectDir, currentVersion: ctx.currentVersion, hosts }
}

/** Executable presence is separate from configuration, login and protocol support. */
function applicationPresence(id: string): "detected" | "not_detected" | "unknown" {
  const names: Record<string, string> = {
    opencode: "opencode",
    "claude-code": "claude",
    codex: "codex",
    "gemini-cli": "gemini",
  }
  const command = names[id]
  if (!command) return "unknown"
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  const found = (process.env["PATH"] ?? "")
    .split(delimiter)
    .some((directory) => suffixes.some((suffix) => existsSync(join(directory.replace(/^"|"$/g, ""), command + suffix))))
  return found ? "detected" : "not_detected"
}

/** Marker-only synchronous view; use integrationsOverview for full detection. */
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

/** Validate host and lifecycle action before invoking adapter code. */
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

/** Offer guidance without mutations; valid v2 state takes precedence over legacy state. */
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
