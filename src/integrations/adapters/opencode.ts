/**
 * OpenCode adapter (M1): wraps the EXISTING installer, never rewrites it.
 *
 * Detection artifacts (project scope):
 *   - <project>/.opencode/plugins/plugin.js present?
 *   - opencode.json(.jsonc) "plugin" array contains ".opencode/plugins/plugin.js"?
 *   - .opencomms/integration.json marker version vs ctx.currentVersion?
 *
 * Mapping:
 *   both present            -> installed (or outdated when marker < current)
 *   registered but missing  -> broken (partial install)
 *   file present, unregistered -> broken (registration missing)
 *   neither                 -> absent
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { opencodeInstallReport, stripJsoncComments } from "../../cli/install-opencode.js"
import type { OpencodeInstallOutcome } from "../../cli/install-opencode.js"
import { compareVersions, getInstalledVersion, removeIntegrationMarker, setInstalledVersion } from "../versioning.js"
import type { HostIntegration, IntegrationContext, IntegrationDetection, IntegrationReport } from "../types.js"

export const OPENCODE_PLUGIN_REL = ".opencode/plugins/plugin.js"

const OPENCODE_CAPABILITIES: Record<string, string> = {
  delivery: "PUSH (system-prompt injection)",
  roleInjection: "system-prompt",
  installation: "project plugin (.opencode/plugins/plugin.js + opencode.json registration)",
}

const ADAPTER_DIR = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
})()

function readConfig(projectDir: string): {
  path: string
  parsed: Record<string, unknown> | null
  rawError: string | null
} {
  const target = resolve(projectDir)
  const candidates = [join(target, "opencode.json"), join(target, "opencode.jsonc")]
  const existing = candidates.find((p) => existsSync(p)) ?? candidates[0]!
  if (!existsSync(existing)) return { path: existing, parsed: null, rawError: null }
  let raw: string
  try {
    raw = readFileSync(existing, "utf8")
  } catch (error) {
    return { path: existing, parsed: null, rawError: `cannot read ${basename(existing)}: ${(error as Error).message}` }
  }
  // String-aware comment stripping shared with the installer (Reviewer
  // P2-6): the adapter must parse identically to install-opencode.ts, so the
  // scanner lives in exactly one place. Only .jsonc is stripped — naive //
  // stripping corrupts "$schema": "https://..." URLs in .json.
  let text = raw
  if (existing.endsWith(".jsonc")) {
    text = stripJsoncComments(text)
  }
  try {
    return { path: existing, parsed: JSON.parse(text) as Record<string, unknown>, rawError: null }
  } catch (error) {
    return {
      path: existing,
      parsed: null,
      rawError: `could not parse ${basename(existing)}: ${(error as Error).message}`,
    }
  }
}

function isRegistered(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false
  const field = parsed["plugin"]
  if (typeof field === "string") return field === OPENCODE_PLUGIN_REL
  if (Array.isArray(field)) {
    return field.some(
      (entry) => entry === OPENCODE_PLUGIN_REL || (Array.isArray(entry) && entry[0] === OPENCODE_PLUGIN_REL),
    )
  }
  return false
}

function configRelPath(projectDir: string): string {
  const { path } = readConfig(projectDir)
  return path.slice(resolve(projectDir).length + 1).replace(/\\/g, "/")
}

async function detectOpencode(ctx: IntegrationContext): Promise<IntegrationDetection> {
  const target = resolve(ctx.projectDir)
  const details: string[] = []
  const issues: string[] = []
  const pluginFile = join(target, ".opencode", "plugins", "plugin.js")
  const filePresent = existsSync(pluginFile)
  // Foreign-plugin clobber guard: an existing plugin.js that is not the
  // OpenComms bundle must never be silently overwritten. Heuristic: the
  // OpenComms bundle always mentions opencomms (case-insensitive).
  let foreignPlugin = false
  if (filePresent) {
    try {
      const content = readFileSync(pluginFile, "utf8")
      if (!/opencomms/i.test(content)) {
        foreignPlugin = true
      }
    } catch {
      // Unreadable file is itself a breakage signal; fall through to partial.
    }
  }
  const cfg = readConfig(target)
  if (cfg.rawError) {
    return {
      status: "broken",
      installedVersion: getInstalledVersion(target, "opencode"),
      currentVersion: ctx.currentVersion,
      details: [`plugin file ${filePresent ? "present" : "missing"}`],
      issues: [cfg.rawError],
    }
  }
  const registered = cfg.parsed ? isRegistered(cfg.parsed) : false
  details.push(`plugin file ${filePresent ? "present" : "missing"} (.opencode/plugins/plugin.js)`)
  details.push(`opencode.json registration ${registered ? "present" : "missing"}`)
  if (foreignPlugin) details.push("plugin.js exists but is NOT the OpenComms bundle (foreign file)")
  if (cfg.parsed === null) details.push("no opencode.json(.jsonc) yet")

  const marker = getInstalledVersion(target, "opencode")
  if (marker) details.push(`marker version ${marker}`)

  if (foreignPlugin) {
    issues.push(
      ".opencode/plugins/plugin.js exists but is NOT the registered OpenComms entry (foreign plugin.js clobber guard) — back it up before reinstalling",
    )
    return { status: "broken", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }

  if (!filePresent && !registered) {
    return { status: "absent", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  if (!filePresent || !registered) {
    if (!filePresent) issues.push("plugin registered but .opencode/plugins/plugin.js is missing (partial install)")
    if (!registered) issues.push("plugin file present but not registered in opencode.json (registration missing)")
    return { status: "broken", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  // Both artifacts present — marker decides installed vs outdated.
  if (marker && compareVersions(marker, ctx.currentVersion) < 0) {
    issues.push(`outdated marker ${marker} < ${ctx.currentVersion} (update required)`)
    return { status: "outdated", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  return { status: "installed", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
}

function toReport(ctx: IntegrationContext, outcome: OpencodeInstallOutcome, action: string): IntegrationReport {
  if (!outcome.ok) {
    const warnings = [...outcome.lines]
    if (outcome.preExistingForeignPlugin) {
      warnings.push("pre-existing foreign plugin.js detected before install (left in place, not overwritten blindly)")
    }
    return {
      ok: false,
      actions: [],
      warnings,
      capabilities: OPENCODE_CAPABILITIES,
      changedFiles: [],
    }
  }
  setInstalledVersion(resolve(ctx.projectDir), "opencode", ctx.currentVersion, { via: action })
  const pluginRel = outcome.pluginRelPath ?? OPENCODE_PLUGIN_REL
  const configRel = outcome.configPath
    ? outcome.configPath.slice(resolve(ctx.projectDir).length + 1).replace(/\\/g, "/")
    : configRelPath(ctx.projectDir)
  return {
    ok: true,
    actions: [
      `${action}: plugin ${outcome.wrotePlugin ? "written" : "already present"}; ` +
        `config ${outcome.pluginRegistered ? "registered" : "registration unchanged"} ` +
        `(${pluginRel} in ${configRel})`,
    ],
    warnings: outcome.preExistingForeignPlugin
      ? ["pre-existing foreign plugin.js was present before this run (see install log)"]
      : [],
    capabilities: OPENCODE_CAPABILITIES,
    changedFiles: [pluginRel, configRel],
  }
}

function runInstaller(ctx: IntegrationContext) {
  return opencodeInstallReport({
    targetProject: resolve(ctx.projectDir),
    sea: false,
    execPath: process.execPath,
    anchorDir: ADAPTER_DIR,
  })
}

export const opencodeAdapter: HostIntegration = {
  id: "opencode",
  name: "OpenCode",
  scope: "project",
  detect: detectOpencode,
  async install(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, runInstaller(ctx), "install")
  },
  async update(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, runInstaller(ctx), "update")
  },
  async repair(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, runInstaller(ctx), "repair")
  },
  async verify(ctx: IntegrationContext): Promise<IntegrationReport> {
    const detection = await detectOpencode(ctx)
    if (detection.status === "installed") {
      return {
        ok: true,
        actions: [`verify: artifacts present (${detection.details.join("; ")})`],
        warnings: [],
        capabilities: OPENCODE_CAPABILITIES,
        changedFiles: [],
      }
    }
    return {
      ok: false,
      actions: [],
      warnings: [`verify failed (${detection.status}): ${[...detection.issues, ...detection.details].join("; ")}`],
      capabilities: OPENCODE_CAPABILITIES,
      changedFiles: [],
    }
  },
  async uninstall(ctx: IntegrationContext): Promise<IntegrationReport> {
    // Binding order (Reviewer R2): files first, marker last. Validate BEFORE
    // any mutation (parse-before-remove, same rule as parse-before-copy); the
    // marker is removed ONLY after the full removal succeeded, so
    // runGuarded's rollback can never resurrect a marker whose artifacts are
    // already gone. Absent => ok:true no-op before touching the marker.
    const target = resolve(ctx.projectDir)
    const detection = await detectOpencode(ctx)
    if (detection.status === "absent") {
      return {
        ok: true,
        actions: ["uninstall: nothing to remove (not installed)"],
        warnings: [
          "Other config untouched. NOTE: .opencomms/state.json and pins are shared project state and were NOT removed.",
        ],
        capabilities: OPENCODE_CAPABILITIES,
        changedFiles: [],
      }
    }

    // Validate the config BEFORE mutating anything.
    const cfg = readConfig(target)
    if (cfg.rawError) {
      return {
        ok: false,
        actions: [],
        warnings: [cfg.rawError],
        capabilities: OPENCODE_CAPABILITIES,
        changedFiles: [],
      }
    }

    const changedFiles: string[] = []
    const warnings: string[] = []
    const actions: string[] = []

    // plugin.js: delete ONLY when it is the OpenComms bundle (inverse of the
    // P3-3 detect guard — uninstall must not become a new destructive path).
    const pluginFile = join(target, ".opencode", "plugins", "plugin.js")
    if (existsSync(pluginFile)) {
      let isOurs = false
      try {
        isOurs = /opencomms/i.test(readFileSync(pluginFile, "utf8"))
      } catch {
        isOurs = false
      }
      if (isOurs) {
        try {
          unlinkSync(pluginFile)
          changedFiles.push(OPENCODE_PLUGIN_REL)
          actions.push("removed .opencode/plugins/plugin.js")
        } catch (error) {
          return {
            ok: false,
            actions: [],
            warnings: [`could not remove .opencode/plugins/plugin.js: ${(error as Error).message}`],
            capabilities: OPENCODE_CAPABILITIES,
            changedFiles: [],
          }
        }
      } else {
        warnings.push(
          ".opencode/plugins/plugin.js left in place: content does not match the OpenComms bundle (foreign file — back it up before reinstalling)",
        )
      }
    }

    // opencode.json(.jsonc) plugin entry, via the SAME parse path as install.
    if (cfg.parsed) {
      const field = cfg.parsed["plugin"]
      if (typeof field === "string" && field === OPENCODE_PLUGIN_REL) {
        delete cfg.parsed["plugin"]
        writeFileSync(cfg.path, `${JSON.stringify(cfg.parsed, null, 2)}\n`, "utf8")
        changedFiles.push(configRelPath(ctx.projectDir))
        actions.push(`removed plugin entry from ${configRelPath(ctx.projectDir)}`)
      } else if (Array.isArray(field)) {
        const filtered = field.filter(
          (entry) => !(entry === OPENCODE_PLUGIN_REL || (Array.isArray(entry) && entry[0] === OPENCODE_PLUGIN_REL)),
        )
        if (filtered.length !== field.length) {
          if (filtered.length === 0) delete cfg.parsed["plugin"]
          else cfg.parsed["plugin"] = filtered
          writeFileSync(cfg.path, `${JSON.stringify(cfg.parsed, null, 2)}\n`, "utf8")
          changedFiles.push(configRelPath(ctx.projectDir))
          actions.push(`removed plugin entry from ${configRelPath(ctx.projectDir)}`)
        }
      } else if (field !== undefined) {
        warnings.push('opencode.json "plugin" field is not a string or array; left untouched')
      }
    }

    removeIntegrationMarker(target, "opencode")
    if (changedFiles.length === 0 && actions.length === 0) {
      actions.push("uninstall: nothing to remove (not installed)")
    }
    warnings.push(
      "Other config untouched. NOTE: .opencomms/state.json and pins are shared project state and were NOT removed.",
    )
    return { ok: true, actions, warnings, capabilities: OPENCODE_CAPABILITIES, changedFiles }
  },
}
