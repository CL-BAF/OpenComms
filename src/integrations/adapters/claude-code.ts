/**
 * Claude Code adapter (M1): wraps src/adapters/claude-code/install.ts.
 *
 * Detection artifacts (project scope):
 *   - .opencomms/claude-code-hooks.mjs + .opencomms/opencomms-mcp.mjs present?
 *   - .claude/settings.json hooks contain claude-code-hooks.mjs?
 *   - .mcp.json mcpServers.opencomms present?
 *   - marker version vs ctx.currentVersion?
 *
 * All present -> installed (or outdated); none -> absent; partial -> broken.
 * Capabilities stay honest: hook-boundary delivery, no mid-turn push (never FULL).
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { installClaudeCode } from "../../adapters/claude-code/install.js"
import { compareVersions, getInstalledVersion, removeIntegrationMarker, setInstalledVersion } from "../versioning.js"
import { PLACEHOLDER_ISSUE } from "../types.js"
import type { HostIntegration, IntegrationContext, IntegrationDetection, IntegrationReport } from "../types.js"

const CLAUDE_CAPABILITIES: Record<string, string> = {
  delivery: "hook-boundary (SessionStart / UserPromptSubmit / Stop)",
  pullInbox: "SUPPORTED (MCP tools)",
  pushIntoRunningSession: "UNSUPPORTED (documented)",
  existingSessionLinking: "PARTIAL",
}

function readJsonSafe(path: string): { parsed: Record<string, unknown> | null; error: string | null } {
  if (!existsSync(path)) return { parsed: null, error: null }
  try {
    return { parsed: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>, error: null }
  } catch (error) {
    return { parsed: null, error: `could not parse ${path}: ${(error as Error).message}` }
  }
}

async function detectClaudeCode(ctx: IntegrationContext): Promise<IntegrationDetection> {
  const target = resolve(ctx.projectDir)
  const details: string[] = []
  const issues: string[] = []

  const hooksFile = join(target, ".opencomms", "claude-code-hooks.mjs")
  const mcpBundle = join(target, ".opencomms", "opencomms-mcp.mjs")
  const hooksPresent = existsSync(hooksFile)
  const bundlePresent = existsSync(mcpBundle)
  details.push(`hooks bundle ${hooksPresent ? "present" : "missing"} (.opencomms/claude-code-hooks.mjs)`)
  details.push(`mcp bundle ${bundlePresent ? "present" : "missing"} (.opencomms/opencomms-mcp.mjs)`)

  const settingsPath = join(target, ".claude", "settings.json")
  const settings = readJsonSafe(settingsPath)
  if (settings.error) {
    return {
      status: "broken",
      installedVersion: getInstalledVersion(target, "claude-code"),
      currentVersion: ctx.currentVersion,
      details,
      issues: [settings.error],
    }
  }
  let hooksRegistered = false
  if (settings.parsed) {
    const hooks = settings.parsed["hooks"]
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
      hooksRegistered = Object.values(hooks as Record<string, unknown>).some((entries) =>
        JSON.stringify(entries ?? []).includes("claude-code-hooks.mjs"),
      )
    }
  }
  details.push(`settings hooks ${hooksRegistered ? "registered" : "missing"} (.claude/settings.json)`)

  const mcpPath = join(target, ".mcp.json")
  const mcp = readJsonSafe(mcpPath)
  if (mcp.error) {
    return {
      status: "broken",
      installedVersion: getInstalledVersion(target, "claude-code"),
      currentVersion: ctx.currentVersion,
      details,
      issues: [mcp.error],
    }
  }
  let serverRegistered = false
  let memberPlaceholder = false
  if (mcp.parsed) {
    const servers = mcp.parsed["mcpServers"]
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      const opencomms = (servers as Record<string, unknown>)["opencomms"]
      serverRegistered = "opencomms" in (servers as Record<string, unknown>)
      if (opencomms && typeof opencomms === "object" && !Array.isArray(opencomms)) {
        const env = (opencomms as Record<string, unknown>)["env"]
        if (env && typeof env === "object" && !Array.isArray(env)) {
          const memberId = (env as Record<string, unknown>)["OPENCOMMS_MEMBER_ID"]
          memberPlaceholder = typeof memberId === "string" && memberId.includes("<set by: opencomms install-member>")
        }
      }
    }
  }
  details.push(`mcp server ${serverRegistered ? "registered" : "missing"} (.mcp.json)`)
  if (memberPlaceholder) details.push("member env placeholder present (.mcp.json)")

  const marker = getInstalledVersion(target, "claude-code")
  if (marker) details.push(`marker version ${marker}`)

  // Placeholder env is never installed evidence: fresh installs always carry
  // it until `opencomms install-member` replaces it with a real member id.
  // PLACEHOLDER_ISSUE is emitted VERBATIM (structural contract with doctor).
  if (serverRegistered && memberPlaceholder) {
    issues.push(PLACEHOLDER_ISSUE)
    return { status: "broken", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }

  const present = [hooksPresent, bundlePresent, hooksRegistered, serverRegistered]
  if (present.every((p) => !p)) {
    return { status: "absent", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  if (present.some((p) => !p)) {
    if (!hooksPresent) issues.push("hooks bundle missing (.opencomms/claude-code-hooks.mjs)")
    if (!bundlePresent) issues.push("mcp bundle missing (.opencomms/opencomms-mcp.mjs)")
    if (!hooksRegistered) issues.push("hooks not registered in .claude/settings.json")
    if (!serverRegistered) issues.push("opencomms server not registered in .mcp.json")
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
  native: { ok: boolean; filesInstalled: string[]; configPatches: string[]; warnings: string[] },
  action: string,
): IntegrationReport {
  if (!native.ok) {
    return {
      ok: false,
      actions: [],
      warnings: native.warnings.length > 0 ? native.warnings : [`${action} failed`],
      capabilities: CLAUDE_CAPABILITIES,
      changedFiles: [],
    }
  }
  setInstalledVersion(resolve(ctx.projectDir), "claude-code", ctx.currentVersion, { via: action })
  return {
    ok: true,
    actions: [`${action}: ${[...native.configPatches].join("; ")}`],
    warnings: native.warnings,
    capabilities: CLAUDE_CAPABILITIES,
    changedFiles: [...native.filesInstalled],
  }
}

export const claudeCodeAdapter: HostIntegration = {
  id: "claude-code",
  name: "Claude Code",
  scope: "project",
  detect: detectClaudeCode,
  async install(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, installClaudeCode(resolve(ctx.projectDir)), "install")
  },
  async update(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, installClaudeCode(resolve(ctx.projectDir)), "update")
  },
  async repair(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, installClaudeCode(resolve(ctx.projectDir)), "repair")
  },
  async verify(ctx: IntegrationContext): Promise<IntegrationReport> {
    const detection = await detectClaudeCode(ctx)
    if (detection.status === "installed") {
      return {
        ok: true,
        actions: [`verify: artifacts present (${detection.details.join("; ")})`],
        warnings: [],
        capabilities: CLAUDE_CAPABILITIES,
        changedFiles: [],
      }
    }
    return {
      ok: false,
      actions: [],
      warnings: [`verify failed (${detection.status}): ${[...detection.issues, ...detection.details].join("; ")}`],
      capabilities: CLAUDE_CAPABILITIES,
      changedFiles: [],
    }
  },
  async uninstall(ctx: IntegrationContext): Promise<IntegrationReport> {
    // Binding order (Reviewer R2): files first, marker last. Absent => ok:true
    // no-op before touching the marker; both configs are parsed BEFORE any
    // mutation (parse-before-remove), so a malformed file yields ok:false with
    // zero writes and an untouched marker.
    // Mirrors the CLI runUninstall claude-code path: remove ONLY OpenComms
    // entries; never touch unrelated config.
    const target = resolve(ctx.projectDir)
    const detection = await detectClaudeCode(ctx)
    if (detection.status === "absent") {
      return {
        ok: true,
        actions: ["uninstall: nothing to remove (not installed)"],
        warnings: [
          "Other config untouched. NOTE: .opencomms/state.json and pins are shared project state and were NOT removed.",
        ],
        capabilities: CLAUDE_CAPABILITIES,
        changedFiles: [],
      }
    }

    const settingsPath = join(target, ".claude", "settings.json")
    let settings: { hooks?: Record<string, unknown> } | null = null
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, unknown> }
      } catch (error) {
        return {
          ok: false,
          actions: [],
          warnings: [`could not parse .claude/settings.json (nothing was written): ${(error as Error).message}`],
          capabilities: CLAUDE_CAPABILITIES,
          changedFiles: [],
        }
      }
    }
    const mcpJsonPath = join(target, ".mcp.json")
    let mcpConfig: { mcpServers?: Record<string, unknown> } | null = null
    if (existsSync(mcpJsonPath)) {
      try {
        mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf8")) as { mcpServers?: Record<string, unknown> }
      } catch (error) {
        return {
          ok: false,
          actions: [],
          warnings: [`could not parse .mcp.json (nothing was written): ${(error as Error).message}`],
          capabilities: CLAUDE_CAPABILITIES,
          changedFiles: [],
        }
      }
    }

    const changedFiles: string[] = []
    const actions: string[] = []
    if (settings?.hooks) {
      let changedAny = false
      for (const event of Object.keys(settings.hooks)) {
        const entries = settings.hooks[event]
        if (Array.isArray(entries)) {
          const filtered = entries.filter((e) => !JSON.stringify(e).includes("claude-code-hooks.mjs"))
          if (filtered.length !== entries.length) {
            settings.hooks[event] = filtered
            changedAny = true
          }
        }
      }
      for (const event of Object.keys(settings.hooks)) {
        if (Array.isArray(settings.hooks[event]) && (settings.hooks[event] as unknown[]).length === 0) {
          delete settings.hooks[event]
          changedAny = true
        }
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks
      if (changedAny) {
        writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
        changedFiles.push(".claude/settings.json")
        actions.push("removed OpenComms hooks from .claude/settings.json")
      }
    }

    if (mcpConfig?.mcpServers && "opencomms" in mcpConfig.mcpServers) {
      delete mcpConfig.mcpServers["opencomms"]
      if (Object.keys(mcpConfig.mcpServers).length === 0) delete mcpConfig.mcpServers
      writeFileSync(mcpJsonPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8")
      changedFiles.push(".mcp.json")
      actions.push("removed opencomms server from .mcp.json")
    }

    for (const bundle of [".opencomms/claude-code-hooks.mjs", ".opencomms/opencomms-mcp.mjs"]) {
      const bundlePath = join(target, bundle)
      if (existsSync(bundlePath)) {
        try {
          unlinkSync(bundlePath)
          changedFiles.push(bundle.replace(/\\/g, "/"))
          actions.push(`removed ${bundle.replace(/\\/g, "/")}`)
        } catch {
          /* best effort; report continues */
        }
      }
    }

    removeIntegrationMarker(target, "claude-code")
    if (changedFiles.length === 0) actions.push("uninstall: nothing to remove (not installed)")
    return {
      ok: true,
      actions,
      warnings: [
        "Other config untouched. NOTE: .opencomms/state.json and pins are shared project state and were NOT removed.",
      ],
      capabilities: CLAUDE_CAPABILITIES,
      changedFiles,
    }
  },
}
