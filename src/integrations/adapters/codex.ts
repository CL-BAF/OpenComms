/**
 * Codex adapter (M1): wraps src/adapters/codex/install.ts.
 *
 * Detection artifacts (project scope):
 *   - .opencomms/opencomms-mcp.mjs present?
 *   - .codex/config.toml contains [mcp_servers.opencomms]?
 *   - marker version vs ctx.currentVersion?
 *
 * Both present -> installed (or outdated); neither -> absent; partial -> broken.
 * Capabilities stay honest: PULL only, no TUI push (never FULL).
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { installCodex, CODEX_CAPABILITIES } from "../../adapters/codex/install.js"
import { compareVersions, getInstalledVersion, removeIntegrationMarker, setInstalledVersion } from "../versioning.js"
import { PLACEHOLDER_ISSUE } from "../types.js"
import type { HostIntegration, IntegrationContext, IntegrationDetection, IntegrationReport } from "../types.js"

async function detectCodex(ctx: IntegrationContext): Promise<IntegrationDetection> {
  const target = resolve(ctx.projectDir)
  const details: string[] = []
  const issues: string[] = []

  const bundle = join(target, ".opencomms", "opencomms-mcp.mjs")
  const bundlePresent = existsSync(bundle)
  details.push(`mcp bundle ${bundlePresent ? "present" : "missing"} (.opencomms/opencomms-mcp.mjs)`)

  const configPath = join(target, ".codex", "config.toml")
  let sectionPresent = false
  let memberPlaceholder = false
  let orphanEnv = false
  if (existsSync(configPath)) {
    let toml = ""
    try {
      toml = readFileSync(configPath, "utf8")
    } catch (error) {
      return {
        status: "broken",
        installedVersion: getInstalledVersion(target, "codex"),
        currentVersion: ctx.currentVersion,
        details,
        issues: [`cannot read .codex/config.toml: ${(error as Error).message}`],
      }
    }
    sectionPresent = toml.includes("[mcp_servers.opencomms]")
    memberPlaceholder = toml.includes("<set by: opencomms install-member>")
    orphanEnv = toml.includes("[mcp_servers.opencomms.env]") && !sectionPresent
  }
  details.push(`mcp section ${sectionPresent ? "registered" : "missing"} (.codex/config.toml)`)
  if (memberPlaceholder) details.push("member env placeholder present (.codex/config.toml)")

  const marker = getInstalledVersion(target, "codex")
  if (marker) details.push(`marker version ${marker}`)

  // Orphan env block (env present without its parent section) is a partial
  // install: repair rewrites the full block.
  if (orphanEnv) {
    issues.push("[mcp_servers.opencomms.env] present but [mcp_servers.opencomms] parent absent (partial install)")
    return { status: "broken", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }

  // Placeholder env is never installed evidence: fresh installs always carry
  // it until `opencomms install-member` replaces it with a real member id.
  // PLACEHOLDER_ISSUE is emitted VERBATIM (structural contract with doctor).
  if (sectionPresent && memberPlaceholder) {
    issues.push(PLACEHOLDER_ISSUE)
    return { status: "broken", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }

  if (!bundlePresent && !sectionPresent) {
    return { status: "absent", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  if (!bundlePresent || !sectionPresent) {
    if (!bundlePresent) issues.push("mcp bundle missing (.opencomms/opencomms-mcp.mjs)")
    if (!sectionPresent) issues.push("[mcp_servers.opencomms] missing in .codex/config.toml")
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
  native: { ok: boolean; patches: string[]; warnings: string[] },
  action: string,
): IntegrationReport {
  if (!native.ok) {
    return {
      ok: false,
      actions: [],
      warnings: native.warnings.length > 0 ? native.warnings : [`${action} failed`],
      capabilities: CODEX_CAPABILITIES,
      changedFiles: [],
    }
  }
  setInstalledVersion(resolve(ctx.projectDir), "codex", ctx.currentVersion, { via: action })
  return {
    ok: true,
    actions: [`${action}: ${native.patches.join("; ")}`],
    warnings: native.warnings,
    capabilities: CODEX_CAPABILITIES,
    changedFiles: [".opencomms/opencomms-mcp.mjs", ".codex/config.toml"],
  }
}

export const codexAdapter: HostIntegration = {
  id: "codex",
  name: "Codex",
  scope: "project",
  detect: detectCodex,
  async install(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, installCodex(resolve(ctx.projectDir)), "install")
  },
  async update(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, installCodex(resolve(ctx.projectDir)), "update")
  },
  async repair(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, installCodex(resolve(ctx.projectDir)), "repair")
  },
  async verify(ctx: IntegrationContext): Promise<IntegrationReport> {
    const detection = await detectCodex(ctx)
    if (detection.status === "installed") {
      return {
        ok: true,
        actions: [`verify: artifacts present (${detection.details.join("; ")})`],
        warnings: [],
        capabilities: CODEX_CAPABILITIES,
        changedFiles: [],
      }
    }
    return {
      ok: false,
      actions: [],
      warnings: [`verify failed (${detection.status}): ${[...detection.issues, ...detection.details].join("; ")}`],
      capabilities: CODEX_CAPABILITIES,
      changedFiles: [],
    }
  },
  async uninstall(ctx: IntegrationContext): Promise<IntegrationReport> {
    // Binding order (Reviewer R2): files first, marker last. Absent => ok:true
    // no-op before touching the marker. Removes ALL [mcp_servers.opencomms*]
    // sections (same cut rule as the CLI, so no orphan env block survives).
    const target = resolve(ctx.projectDir)
    const detection = await detectCodex(ctx)
    if (detection.status === "absent") {
      return {
        ok: true,
        actions: ["uninstall: nothing to remove (not installed)"],
        warnings: [
          "Other config untouched. NOTE: .opencomms/state.json and pins are shared project state and were NOT removed.",
        ],
        capabilities: CODEX_CAPABILITIES,
        changedFiles: [],
      }
    }

    const changedFiles: string[] = []
    const actions: string[] = []
    const configPath = join(target, ".codex", "config.toml")
    if (existsSync(configPath)) {
      let toml: string
      try {
        toml = readFileSync(configPath, "utf8")
      } catch (error) {
        return {
          ok: false,
          actions: [],
          warnings: [`cannot read .codex/config.toml (nothing was written): ${(error as Error).message}`],
          capabilities: CODEX_CAPABILITIES,
          changedFiles: [],
        }
      }
      const sectionRe = /^\[mcp_servers\.opencomms(?:\.[^\]]*)?\]$/gm
      if (sectionRe.test(toml)) {
        sectionRe.lastIndex = 0
        const cuts: Array<[number, number]> = []
        for (let m = sectionRe.exec(toml); m !== null; m = sectionRe.exec(toml)) {
          const start = m.index
          const afterHeader = toml.indexOf("\n[", start + 1)
          let end = toml.length
          let cursor = afterHeader
          while (cursor !== -1) {
            const lineEnd = toml.indexOf("\n", cursor + 1)
            const line = toml.slice(cursor + 1, lineEnd === -1 ? toml.length : lineEnd).trim()
            if (/^\[mcp_servers\.opencomms(?:\.[^\]]*)?\]$/.test(line)) {
              cursor = toml.indexOf("\n[", cursor + 1)
              continue
            }
            end = cursor === -1 ? toml.length : cursor + 1
            break
          }
          cuts.push([start, end])
        }
        let cleaned = toml
        for (let i = cuts.length - 1; i >= 0; i--) {
          const [start, end] = cuts[i]!
          cleaned = cleaned.slice(0, start) + cleaned.slice(end)
        }
        cleaned = cleaned.replace(/\n{3,}/g, "\n\n")
        if (cleaned !== toml) {
          writeFileSync(configPath, cleaned, "utf8")
          changedFiles.push(".codex/config.toml")
          actions.push("removed [mcp_servers.opencomms*] sections from .codex/config.toml")
        }
      }
    }

    const bundle = join(target, ".opencomms", "opencomms-mcp.mjs")
    if (existsSync(bundle)) {
      try {
        unlinkSync(bundle)
        changedFiles.push(".opencomms/opencomms-mcp.mjs")
        actions.push("removed .opencomms/opencomms-mcp.mjs")
      } catch {
        /* best effort; report continues */
      }
    }

    removeIntegrationMarker(target, "codex")
    if (changedFiles.length === 0) actions.push("uninstall: nothing to remove (not installed)")
    return {
      ok: true,
      actions,
      warnings: [
        "Other config untouched. NOTE: .opencomms/state.json and pins are shared project state and were NOT removed.",
      ],
      capabilities: CODEX_CAPABILITIES,
      changedFiles,
    }
  },
}
