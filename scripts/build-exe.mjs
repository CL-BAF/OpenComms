#!/usr/bin/env node
/** Build the standalone CLI with Node SEA: node scripts/build-exe.mjs [--out dir]. */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(join(here, ".."))
const outDir = resolve(
  join(repoRoot, process.argv[2]?.startsWith("--out") ? (process.argv[3] ?? "dist-opencomms") : "dist-opencomms"),
)

/** Enforce the pinned SEA build Node version to avoid incompatible executable blobs. */
function enforceBuildNodePinned() {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
  const required = packageJson.engines?.buildNode
  if (!required)
    throw new Error("package.json engines.buildNode is missing — SEA builds must be pinned to an exact Node version.")
  if (process.version !== `v${required}`) {
    console.error(`[opencomms-exe] ERROR: SEA builds require Node ${required} exactly.`)
    console.error(`  found:    ${process.version}`)
    console.error(`  required: v${required} (set by package.json engines.buildNode)`)
    console.error(`  fix:      nvm install ${required} && nvm use ${required}, or invoke the pinned binary directly.`)
    process.exit(1)
  }
  console.log(`[opencomms-exe] Node pin OK: ${process.version} (engines.buildNode ${required})`)
}

enforceBuildNodePinned()

function run(cmd, args) {
  console.log(`+ ${cmd} ${args.join(" ")}`)
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" })
}

/** Windows npm is a .cmd shim Node refuses to spawn — run npm's JS directly. */
function npmRun(script) {
  const candidates = [
    process.env["OPENCOMMS_NPM_CLI"],
    process.env["npm_execpath"],
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(repoRoot, "node_modules", "npm", "bin", "npm-cli.js"),
  ]
  const npmCli = candidates.find((p) => p && existsSync(p))
  const args = npmCli ? [process.execPath, npmCli, "run", script] : ["npm", "run", script]
  console.log(`+ ${args.join(" ")}`)
  execFileSync(args[0], args.slice(1), { cwd: repoRoot, stdio: "inherit" })
}

console.log(`[opencomms-exe] output dir: ${outDir}`)

npmRun("build")

const bundle = join(repoRoot, "dist", "cli", "cli-bundle.cjs")
run(process.execPath, [
  join(repoRoot, "scripts", "bundle.mjs"),
  "--entry",
  join(repoRoot, "dist", "cli", "main.js"),
  "--format",
  "cjs",
  "--outfile",
  bundle,
])
if (!existsSync(bundle)) throw new Error("CLI bundle was not produced")

const pluginBundle = join(repoRoot, "dist", "plugin.bundled.js")
if (!existsSync(pluginBundle)) throw new Error("dist/plugin.bundled.js missing — run npm run build first")
const embeddedAssets = {
  "opencode-plugin-bundle": "dist/plugin.bundled.js",
  "opencomms-mcp": "dist/mcp/main.js",
  "claude-hook": "dist/adapters/claude-code/hook-cli.js",
  "gemini-hook": "dist/adapters/gemini-cli/hook-cli.js",
  "claude-desktop-manifest": "dist/adapters/claude-desktop/manifest.json",
}
for (const asset of Object.values(embeddedAssets)) {
  if (!existsSync(join(repoRoot, asset))) throw new Error(`Missing standalone adapter asset: ${asset}`)
}

const seaConfig = join(repoRoot, "sea-config.json")
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: "dist/cli/cli-bundle.cjs",
      output: "sea-prep.blob",
      disableExperimentalSEAWarning: true,
      assets: embeddedAssets,
    },
    null,
    2,
  ),
)
run(process.execPath, ["--experimental-sea-config", "sea-config.json"])
const blob = join(repoRoot, "sea-prep.blob")
if (!existsSync(blob)) throw new Error("SEA blob was not produced")

const platform = process.platform
const exeName = platform === "win32" ? "opencomms.exe" : "opencomms"
const target = join(outDir, exeName)
mkdirSync(outDir, { recursive: true })
const nodeBinary = process.execPath
copyFileSync(nodeBinary, target)

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

const smokeEnv = { ...process.env }
delete smokeEnv.OPENCOMMS_VERSION
const smoke = execFileSync(target, ["version"], { encoding: "utf8", timeout: 30_000, env: smokeEnv })
const expectedVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version
if (smoke.match(/^opencomms ([^\s]+)/)?.[1] !== expectedVersion) {
  throw new Error(`Executable version mismatch: expected opencomms ${expectedVersion}, received ${smoke.trim()}`)
}
console.log(`[opencomms-exe] smoke: ${smoke.trim()}`)

try {
  rmSync(blob)
} catch {}
writeFileSync(
  join(outDir, "README.txt"),
  `opencomms standalone executable (built from source at repo root).\nUsage: ${exeName} help | gui [--port N] | session list ...\n`,
)
console.log(`[opencomms-exe] done: ${target}`)
