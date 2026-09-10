#!/usr/bin/env node
/**
 * Build a standalone Windows/Linux/macOS executable for the `opencomms`
 * CLI using Node.js Single Executable Application (SEA, Node 20+).
 *
 *   node scripts/build-exe.mjs [--out dist-opencomms]
 *
 * Output: <out>/opencomms(.exe) — no Node.js installation required on the
 * target machine. The GUI (`opencomms gui`) works inside the exe: assets
 * are embedded in the JS bundle.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(join(here, ".."))
const outDir = resolve(join(repoRoot, process.argv[2]?.startsWith("--out") ? (process.argv[3] ?? "dist-opencomms") : "dist-opencomms"))

function run(cmd, args) {
  console.log(`+ ${cmd} ${args.join(" ")}`)
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" })
}

/** Windows npm is a .cmd shim Node refuses to spawn — run npm's JS directly. */
function npmRun(script) {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(repoRoot, "node_modules", "npm", "bin", "npm-cli.js"),
  ]
  const npmCli = candidates.find((p) => existsSync(p))
  const args = npmCli ? [process.execPath, npmCli, "run", script] : ["npm", "run", script]
  console.log(`+ ${args.join(" ")}`)
  execFileSync(args[0], args.slice(1), { cwd: repoRoot, stdio: "inherit" })
}

console.log(`[opencomms-exe] output dir: ${outDir}`)

// 1. Build the CLI (tsc) — dist/cli/main.js must exist.
npmRun("build")

// 2. Bundle the CLI to CommonJS (SEA runs CJS; dist is ESM).
const bundle = join(repoRoot, "dist", "cli", "cli-bundle.cjs")
run(process.execPath, [
  join(repoRoot, "node_modules", "esbuild", "bin", "esbuild"),
  "dist/cli/main.js",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  `--outfile=${bundle}`,
  "--log-level=warning",
])
if (!existsSync(bundle)) throw new Error("CLI bundle was not produced")

// 3. SEA preparation blob.
const seaConfig = join(repoRoot, "sea-config.json")
writeFileSync(seaConfig, JSON.stringify({ main: "dist/cli/cli-bundle.cjs", output: "sea-prep.blob", disableExperimentalSEAWarning: true }, null, 2))
run(process.execPath, ["--experimental-sea-config", "sea-config.json"])
const blob = join(repoRoot, "sea-prep.blob")
if (!existsSync(blob)) throw new Error("SEA blob was not produced")

// 3. Copy the node binary + inject the blob with postject.
const platform = process.platform
const exeName = platform === "win32" ? "opencomms.exe" : "opencomms"
const target = join(outDir, exeName)
mkdirSync(outDir, { recursive: true })
const nodeBinary = process.execPath
copyFileSync(nodeBinary, target)

// postject (devDependency): injects the blob as a POSTJECT_RESOURCE section.
const postjectCli = join(repoRoot, "node_modules", "postject", "dist", "cli.js")
if (!existsSync(postjectCli)) throw new Error("postject not installed — run npm install (it is a devDependency)")
run(process.execPath, [
  postjectCli,
  target,
  "NODE_SEA_BLOB",
  blob,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
])

// 4. Sanity check: version command runs from the exe.
const smoke = execFileSync(target, ["version"], { encoding: "utf8", timeout: 30_000 })
console.log(`[opencomms-exe] smoke: ${smoke.trim()}`)

// Cleanup intermediates.
try {
  rmSync(blob)
} catch {}
writeFileSync(join(outDir, "README.txt"), `opencomms standalone executable (built from source at repo root).\nUsage: ${exeName} help | gui [--port N] | session list ...\n`)
console.log(`[opencomms-exe] done: ${target}`)
