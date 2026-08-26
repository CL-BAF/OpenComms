#!/usr/bin/env node
/**
 * OpenComms installer.
 *
 * Usage:
 *   node install.mjs [target-project-dir]
 *
 * Defaults to the current working directory if no target is given.
 *
 * What it does:
 *   1. Builds the plugin (npm run build) if dist/ is missing.
 *   2. Copies dist/* into <target>/.opencode/plugins/.
 *   3. Patches <target>/opencode.json (or .jsonc) to register the plugin
 *      under the "plugin" key, preserving all existing config and avoiding
 *      duplicate entries.
 *
 * Run it from the OpenComms repo root:
 *   node install.mjs C:\Users\Cameron\Desktop\Shhhh
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { join, resolve, dirname, basename } from "node:path"
import { execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = __dirname

const target = resolve(process.argv[2] ?? process.cwd())
const pluginsDir = join(target, ".opencode", "plugins")

function log(msg) {
  console.log(`[OpenComms] ${msg}`)
}

function fail(msg) {
  console.error(`[OpenComms] ERROR: ${msg}`)
  process.exit(1)
}

// 1. Ensure the bundled plugin exists (build if missing).
const distDir = join(repoRoot, "dist")
const bundledPath = join(distDir, "plugin.bundled.js")
if (!existsSync(bundledPath)) {
  log("dist/plugin.bundled.js not found — running npm run build ...")
  execSync("npm run build", { cwd: repoRoot, stdio: "inherit" })
  if (!existsSync(bundledPath)) fail("build did not produce dist/plugin.bundled.js.")
}

// 2. Copy the self-contained bundled plugin into <target>/.opencode/plugins/.
//    We ship a single bundled file (plugin.bundled.js, produced by esbuild
//    with @opencode-ai/plugin and @opencode-ai/sdk marked external since
//    OpenCode provides those at runtime) plus the dist sources as fallback.
log(`Target project: ${target}`)
mkdirSync(pluginsDir, { recursive: true })

// Remove stale plugin files we previously copied so the directory stays clean.
for (const name of ["plugin.js", "engine.js", "store.js", "types.js"]) {
  const stale = join(pluginsDir, name)
  if (existsSync(stale)) {
    try { unlinkSync(stale) } catch {}
  }
}

const bundledSrc = join(distDir, "plugin.bundled.js")
if (!existsSync(bundledSrc)) {
  fail("dist/plugin.bundled.js missing. Run `npm run build` in the OpenComms repo first.")
}
copyFileSync(bundledSrc, join(pluginsDir, "plugin.js"))
log("copied plugin.bundled.js -> .opencode/plugins/plugin.js (self-contained)")

// 3. Patch opencode.json (or .jsonc) in the target.
const jsonCandidates = [
  join(target, "opencode.json"),
  join(target, "opencode.jsonc"),
]
let configPath = jsonCandidates.find((p) => existsSync(p)) ?? jsonCandidates[0]
const pluginRelPath = ".opencode/plugins/plugin.js"

function readConfig(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, "utf8")
  // For .jsonc only, strip line/block comments. Naive // stripping would
  // corrupt URLs inside .json (e.g. "$schema": "https://..."), so only apply
  // it to .jsonc files.
  let text = raw
  if (path.endsWith(".jsonc")) {
    text = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
  }
  try {
    return JSON.parse(text)
  } catch {
    fail(`could not parse existing ${basename(path)}. Back it up, then re-run.`)
  }
}

const config = readConfig(configPath)
const pluginField = config.plugin

// Normalize to an array and avoid duplicates.
let arr
if (pluginField === undefined) {
  arr = []
} else if (typeof pluginField === "string") {
  arr = [pluginField]
} else if (Array.isArray(pluginField)) {
  arr = [...pluginField]
} else {
  fail(`opencode.json "plugin" field is not a string or array; refusing to overwrite.`)
}

const alreadyRegistered = arr.some((entry) => {
  if (typeof entry !== "string") {
    // Could be [path, options] tuple form.
    return Array.isArray(entry) && entry[0] === pluginRelPath
  }
  return entry === pluginRelPath
})

if (!alreadyRegistered) {
  arr.push(pluginRelPath)
}
config.plugin = arr

writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8")
log(`registered plugin in ${basename(configPath)}: "${pluginRelPath}"`)

log("Done. Open OpenCode Desktop in the target project and run /OpenComms Create ... in a tab.")