/**
 * Claude Desktop adapter (M2): wraps src/adapters/claude-desktop/package.ts.
 *
 * Project artifacts:
 *   - <project>/opencomms-claude-desktop/manifest.json (MCPB spec v0.3)
 *   - <project>/opencomms-claude-desktop/server/main.mjs (self-contained bundle)
 *
 * Both present + manifest valid -> installed (or outdated via marker);
 * neither -> absent; partial/invalid -> broken.
 * Capabilities stay honest: PULL ONLY, no push/identity/lifecycle (never FULL).
 * The Claude Desktop app itself is not programmatically detectable from a CLI
 * process; bundle presence is the project signal (doctor reports the same).
 */

import { existsSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  buildDesktopBundle,
  validateDesktopManifest,
  DESKTOP_CAPABILITIES,
} from "../../adapters/claude-desktop/package.js"
import { compareVersions, getInstalledVersion, removeIntegrationMarker, setInstalledVersion } from "../versioning.js"
import type { HostIntegration, IntegrationContext, IntegrationDetection, IntegrationReport } from "../types.js"

export const DESKTOP_BUNDLE_DIR = "opencomms-claude-desktop"

async function detectDesktop(ctx: IntegrationContext): Promise<IntegrationDetection> {
  const target = resolve(ctx.projectDir)
  const details: string[] = []
  const issues: string[] = []

  const bundleDir = join(target, DESKTOP_BUNDLE_DIR)
  const manifestPath = join(bundleDir, "manifest.json")
  const serverPath = join(bundleDir, "server", "main.mjs")
  const manifestPresent = existsSync(manifestPath)
  const serverPresent = existsSync(serverPath)
  details.push(`bundle manifest ${manifestPresent ? "present" : "missing"} (${DESKTOP_BUNDLE_DIR}/manifest.json)`)
  details.push(`bundle server ${serverPresent ? "present" : "missing"} (${DESKTOP_BUNDLE_DIR}/server/main.mjs)`)
  details.push("Claude Desktop app presence is not programmatically detectable; bundle presence is the project signal")

  let manifestValid = false
  if (manifestPresent) {
    const check = validateDesktopManifest(manifestPath)
    manifestValid = check.ok
    if (!check.ok) issues.push(`bundle manifest invalid: ${check.reason}`)
    else details.push("bundle manifest valid (MCPB spec v0.3 essentials)")
  }

  const marker = getInstalledVersion(target, "claude-desktop")
  if (marker) details.push(`marker version ${marker}`)

  if (!manifestPresent && !serverPresent) {
    return { status: "absent", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  if (!manifestPresent || !serverPresent || !manifestValid) {
    if (!manifestPresent) issues.push("bundle manifest missing (opencomms-claude-desktop/manifest.json)")
    if (!serverPresent) issues.push("bundle server missing (opencomms-claude-desktop/server/main.mjs)")
    return { status: "broken", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  if (marker && compareVersions(marker, ctx.currentVersion) < 0) {
    issues.push(`outdated marker ${marker} < ${ctx.currentVersion} (update required)`)
    return { status: "outdated", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  return { status: "installed", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
}

function toReport(
  ctx: IntegrationContext,
  native: { ok: boolean; bundleDir: string | null; warnings: string[] },
  action: string,
): IntegrationReport {
  if (!native.ok) {
    return {
      ok: false,
      actions: [],
      warnings: native.warnings.length > 0 ? native.warnings : [`${action} failed (see warnings; bundle not laid out)`],
      capabilities: DESKTOP_CAPABILITIES,
      changedFiles: [],
    }
  }
  setInstalledVersion(resolve(ctx.projectDir), "claude-desktop", ctx.currentVersion, { via: action })
  return {
    ok: true,
    actions: [`${action}: bundle laid out at ${native.bundleDir ?? DESKTOP_BUNDLE_DIR}`],
    warnings: native.warnings,
    capabilities: DESKTOP_CAPABILITIES,
    changedFiles: [`${DESKTOP_BUNDLE_DIR}/manifest.json`, `${DESKTOP_BUNDLE_DIR}/server/main.mjs`],
  }
}

export const claudeDesktopAdapter: HostIntegration = {
  id: "claude-desktop",
  name: "Claude Desktop",
  scope: "project",
  detect: detectDesktop,
  async install(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, buildDesktopBundle({ projectDir: resolve(ctx.projectDir) }), "install")
  },
  async update(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, buildDesktopBundle({ projectDir: resolve(ctx.projectDir) }), "update")
  },
  async repair(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, buildDesktopBundle({ projectDir: resolve(ctx.projectDir) }), "repair")
  },
  async verify(ctx: IntegrationContext): Promise<IntegrationReport> {
    const detection = await detectDesktop(ctx)
    if (detection.status === "installed") {
      return {
        ok: true,
        actions: [`verify: bundle present (${detection.details.join("; ")})`],
        warnings: [],
        capabilities: DESKTOP_CAPABILITIES,
        changedFiles: [],
      }
    }
    return {
      ok: false,
      actions: [],
      warnings: [`verify failed (${detection.status}): ${[...detection.issues, ...detection.details].join("; ")}`],
      capabilities: DESKTOP_CAPABILITIES,
      changedFiles: [],
    }
  },
  async uninstall(ctx: IntegrationContext): Promise<IntegrationReport> {
    // Binding order (Reviewer R2): files first, marker last. Absent => ok:true
    // no-op before touching the marker. Removes the laid-out bundle directory
    // only; the extension itself is removed by the user in Claude Desktop >
    // Settings > Extensions (same wording as the CLI).
    const target = resolve(ctx.projectDir)
    const detection = await detectDesktop(ctx)
    if (detection.status === "absent") {
      return {
        ok: true,
        actions: ["uninstall: nothing to remove (not installed)"],
        warnings: ["Note: state.json is shared project state and is NOT removed."],
        capabilities: DESKTOP_CAPABILITIES,
        changedFiles: [],
      }
    }
    const bundleDir = join(target, DESKTOP_BUNDLE_DIR)
    if (existsSync(bundleDir)) {
      try {
        rmSync(bundleDir, { recursive: true, force: true })
      } catch (error) {
        return {
          ok: false,
          actions: [],
          warnings: [`could not remove ${DESKTOP_BUNDLE_DIR}/: ${(error as Error).message}`],
          capabilities: DESKTOP_CAPABILITIES,
          changedFiles: [],
        }
      }
    }
    removeIntegrationMarker(target, "claude-desktop")
    return {
      ok: true,
      actions: [`removed ${DESKTOP_BUNDLE_DIR}/ bundle directory`],
      warnings: [
        "Delete the extension via Claude Desktop > Settings > Extensions (OpenComms) to complete removal. Note: state.json is shared project state and is NOT removed.",
      ],
      capabilities: DESKTOP_CAPABILITIES,
      changedFiles: [`${DESKTOP_BUNDLE_DIR}/`],
    }
  },
}
