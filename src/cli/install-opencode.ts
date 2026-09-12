/**
 * De-repo'd OpenCode plugin installer (SEA fix, 2026-09-11).
 *
 * The old CLI dispatched `opencomms install opencode` by locating the
 * repo's install.mjs — impossible for the standalone exe (no repo) and the
 * source of the "Unknown command <cwd>\install.mjs" misparse (Platform
 * repro). The install logic now lives HERE, bundled with the CLI:
 *
 *   1. Plugin source: under the packaged exe the plugin bundle is EMBEDDED
 *      (SEA asset placeholder replaced at build time — see
 *      scripts/build-exe.mjs); in development it is <repo>/dist/plugin.bundled.js.
 *   2. Copy to <target>/.opencode/plugins/plugin.js.
 *   3. Patch <target>/opencode.json(.jsonc) "plugin" array (idempotent).
 *
 * Never runs a build, never touches the repo, never resolves anything from
 * CWD (only the TARGET PROJECT dir, which is the documented default).
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pluginBundlePath } from "./paths.js"

export interface OpencodeInstallOutcome {
  ok: boolean
  lines: string[]
}

/**
 * SEA asset placeholder: build-exe.mjs injects the real plugin bundle as a
 * SEA asset named by this key. When running under the exe the asset is read
 * via node:sea getAsset; in development we read the repo dist file. The
 * placeholder constant is also what lets the unit tests assert the
 * build-time wiring exists.
 */
export const PLUGIN_BUNDLE_PLACEHOLDER = "opencode-plugin-bundle"

/**
 * Read the plugin bundle contents. Throws with an actionable message when
 * neither source is present (dev: run npm run build).
 */
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

/** Strip comments ONLY for .jsonc (naive // stripping corrupts URLs in .json). */
function parseConfig(path: string, raw: string): { config?: Record<string, unknown>; error?: string } {
  let text = raw
  if (path.endsWith(".jsonc")) {
    text = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
  }
  try {
    return { config: JSON.parse(text) as Record<string, unknown> }
  } catch (error) {
    return { error: `could not parse existing ${path}: ${(error as Error).message}. Back it up, then re-run.` }
  }
}

/**
 * Install the OpenComms plugin into a target project. Works identically
 * from the standalone exe (embedded asset) and from a dev checkout (dist
 * bundle). No repo access, no build, no CWD dependence beyond the default
 * target resolution the caller documents.
 */
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
  writeFileSync(pluginFile, contents, "utf8")
  lines.push(`wrote .opencode/plugins/plugin.js (self-contained)`)

  // Patch opencode.json (or .jsonc) — same behavior as the legacy install.mjs.
  const jsonCandidates = [join(target, "opencode.json"), join(target, "opencode.jsonc")]
  const existing = jsonCandidates.find((p) => existsSync(p))
  const configPath = existing ?? jsonCandidates[0] ?? join(target, "opencode.json")
  const pluginRelPath = ".opencode/plugins/plugin.js"
  if (!configPath) {
    lines.push("could not determine opencode.json path")
    return { ok: false, lines }
  }
  const raw = readConfigText(configPath)
  if (raw !== null) {
    const parsed = parseConfig(configPath, raw)
    if (parsed.error) {
      return { ok: false, lines: [parsed.error] }
    }
    const config = parsed.config as Record<string, unknown>
    const pluginField = config["plugin"]
    let arr: unknown[]
    if (pluginField === undefined) arr = []
    else if (typeof pluginField === "string") arr = [pluginField]
    else if (Array.isArray(pluginField)) arr = [...pluginField]
    else {
      lines.push('opencode.json "plugin" field is not a string or array; refusing to overwrite.')
      return { ok: false, lines }
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
  return { ok: true, lines }
}
