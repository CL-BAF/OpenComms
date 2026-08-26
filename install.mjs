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

import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, readFileSync, writeFileSync } from "node:fs"
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

// 1. Ensure dist/ exists (build if missing).
const distDir = join(repoRoot, "dist")
if (!existsSync(distDir)) {
  log("dist/ not found — running npm run build ...")
  execSync("npm run build", { cwd: repoRoot, stdio: "inherit" })
  if (!existsSync(distDir)) fail("build did not produce dist/.")
}

// 2. Copy dist/* into <target>/.opencode/plugins/
log(`Target project: ${target}`)
mkdirSync(pluginsDir, { recursive: true })
const entries = readdirSync(distDir)
for (const name of entries) {
  const src = join(distDir, name)
  if (!statSync(src).isFile()) continue
  const dst = join(pluginsDir, name)
  copyFileSync(src, dst)
  log(`copied ${name} -> .opencode/plugins/${name}`)
}

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
  // Strip JSONC comments/lines so we can parse and rewrite cleanly.
  const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
  try {
    return JSON.parse(stripped)
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