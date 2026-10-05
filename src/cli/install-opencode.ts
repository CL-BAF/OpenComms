/**
 * Install the embedded SEA plugin or development bundle into a target project.
 * Resource lookup uses module/binary anchors, never the target project's CWD.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pluginBundlePath } from "./paths.js"

export interface OpencodeInstallOutcome {
  ok: boolean
  lines: string[]
  /** Adapters use structured fields; human-readable lines are not an API. */
  pluginRelPath?: string
  configPath?: string
  /** plugin.js was written this run (false = already identical/registered). */
  wrotePlugin?: boolean
  /** opencode.json(.jsonc) "plugin" array now contains our entry. */
  pluginRegistered?: boolean
  /** true when plugin.js existed but was NOT the registered OpenComms entry
   *  before this run (possible foreign plugin — surfaced as a warning). */
  preExistingForeignPlugin?: boolean
}

/** build-exe.mjs embeds the plugin bundle under this SEA asset key. */
export const PLUGIN_BUNDLE_PLACEHOLDER = "opencode-plugin-bundle"

export function readPluginBundle(opts: { sea: boolean; execPath: string; anchorDir: string | null }): string | null {
  if (!opts.sea) {
    const found = pluginBundlePath(opts)
    if (found.path) return readFileSync(found.path, "utf8")
    return null
  }
  // SEA: read the embedded asset (node:sea). Import lazily so plain-node
  // tests never touch the SEA API.
  try {
    const sea = require("node:sea") as { getRawAsset?: (key: string) => string | ArrayBuffer | null }
    if (typeof sea.getRawAsset === "function") {
      const asset = sea.getRawAsset(PLUGIN_BUNDLE_PLACEHOLDER)
      if (asset) {
        if (typeof asset === "string") return asset
        return Buffer.from(asset as unknown as ArrayBuffer).toString("utf8")
      }
    }
  } catch {
    /* not a SEA build with assets; fall through */
  }
  return null
}

function readConfigText(path: string): string | null {
  if (!existsSync(path)) return null
  return readFileSync(path, "utf8")
}

/** Strip JSONC comments outside strings, preserving escaped quotes and URLs. */
export function stripJsoncComments(raw: string): string {
  let out = ""
  let i = 0
  let inString = false
  while (i < raw.length) {
    const ch = raw[i]!
    if (inString) {
      out += ch
      if (ch === "\\") {
        const next = raw[i + 1]
        if (next !== undefined) {
          out += next
          i += 2
          continue
        }
      } else if (ch === '"') {
        inString = false
      }
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2)
      i = end === -1 ? raw.length : end + 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function parseConfig(path: string, raw: string): { config?: Record<string, unknown>; error?: string } {
  let text = raw
  if (path.endsWith(".jsonc")) {
    text = stripJsoncComments(text)
  }
  try {
    return { config: JSON.parse(text) as Record<string, unknown> }
  } catch (error) {
    return { error: `could not parse existing ${path}: ${(error as Error).message}. Back it up, then re-run.` }
  }
}

export function opencodeInstallReport(opts: {
  targetProject: string
  sea: boolean
  execPath: string
  anchorDir: string | null
}): OpencodeInstallOutcome {
  const lines: string[] = []
  const target = resolve(opts.targetProject)
  const pluginsDir = join(target, ".opencode", "plugins")

  const contents = readPluginBundle(opts)
  if (!contents) {
    return {
      ok: false,
      lines: [
        "Plugin bundle not available.",
        opts.sea
          ? "The packaged exe should carry the embedded plugin; rebuild with npm run build:exe."
          : "dist/plugin.bundled.js missing — run `npm run build` first.",
      ],
      pluginRelPath: ".opencode/plugins/plugin.js",
      wrotePlugin: false,
      pluginRegistered: false,
      preExistingForeignPlugin: false,
    }
  }

  mkdirSync(pluginsDir, { recursive: true })
  // Remove stale multi-file plugin layouts from older installs.
  for (const name of ["engine.js", "store.js", "types.js"]) {
    const stale = join(pluginsDir, name)
    if (existsSync(stale)) {
      try {
        unlinkSync(stale)
      } catch {
        /* best effort */
      }
    }
  }
  const pluginFile = join(pluginsDir, "plugin.js")
  // Report an existing foreign plugin before overwriting the OpenComms-owned path.
  const preExistingForeignPlugin = existsSync(pluginFile) && !readFileSync(pluginFile, "utf8").includes("opencomms")
  writeFileSync(pluginFile, contents, "utf8")
  lines.push(`wrote .opencode/plugins/plugin.js (self-contained)`)
  if (preExistingForeignPlugin) {
    lines.push(
      "WARNING: .opencode/plugins/plugin.js existed but was not an OpenComms plugin; it was replaced. Restore it from version control if it was yours.",
    )
  }

  const jsonCandidates = [join(target, "opencode.json"), join(target, "opencode.jsonc")]
  const existing = jsonCandidates.find((p) => existsSync(p))
  const configPath = existing ?? jsonCandidates[0] ?? join(target, "opencode.json")
  const pluginRelPath = ".opencode/plugins/plugin.js"
  if (!configPath) {
    lines.push("could not determine opencode.json path")
    return { ok: false, lines, pluginRelPath, wrotePlugin: true, pluginRegistered: false, preExistingForeignPlugin }
  }
  const raw = readConfigText(configPath)
  if (raw !== null) {
    const parsed = parseConfig(configPath, raw)
    if (parsed.error) {
      return {
        ok: false,
        lines: [parsed.error],
        pluginRelPath,
        wrotePlugin: true,
        pluginRegistered: false,
        preExistingForeignPlugin,
      }
    }
    const config = parsed.config as Record<string, unknown>
    const pluginField = config["plugin"]
    let arr: unknown[]
    if (pluginField === undefined) arr = []
    else if (typeof pluginField === "string") arr = [pluginField]
    else if (Array.isArray(pluginField)) arr = [...pluginField]
    else {
      lines.push('opencode.json "plugin" field is not a string or array; refusing to overwrite.')
      return { ok: false, lines, pluginRelPath, wrotePlugin: true, pluginRegistered: false, preExistingForeignPlugin }
    }
    const already = arr.some((entry) => entry === pluginRelPath || (Array.isArray(entry) && entry[0] === pluginRelPath))
    if (!already) arr.push(pluginRelPath)
    config["plugin"] = arr
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    lines.push(`registered plugin in ${configPath.replace(/\\/g, "/")}: "${pluginRelPath}"`)
  } else {
    writeFileSync(configPath, `${JSON.stringify({ plugin: [pluginRelPath] }, null, 2)}\n`, "utf8")
    lines.push(`created ${configPath.replace(/\\/g, "/")} registering "${pluginRelPath}"`)
  }

  lines.push("Done. Open OpenCode in the target project and run /OpenComms Create ... in a session.")
  return {
    ok: true,
    lines,
    pluginRelPath,
    configPath: configPath.replace(/\\/g, "/"),
    wrotePlugin: true,
    pluginRegistered: true,
    preExistingForeignPlugin,
  }
}
