/** Record the exact source inventory and local artifacts; no Git revision is invented. */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { resolve, relative, join } from "node:path"

const root = resolve(".")
const excluded = new Set(["node_modules", "target", "dist-shell", "binaries", ".git"])
const files = []
function walk(path) {
  if (!existsSync(path)) return
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue
    const candidate = join(path, entry.name)
    if (entry.isDirectory()) walk(candidate)
    else if (entry.isFile()) files.push(candidate)
  }
}
for (const folder of ["src", "test", "scripts", "desktop", "installer", "adapters", "assets"]) walk(join(root, folder))
if (existsSync("install.mjs")) files.push(join(root, "install.mjs"))
for (const name of readdirSync(root))
  if (/^(package(?:-lock)?\.json|tsconfig.*\.json|\.gitignore)$/.test(name)) files.push(join(root, name))
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
const inventory = files.map((path) => ({ path: relative(root, path).replaceAll("\\", "/"), sha256: hash(path) })).sort((a, b) => a.path.localeCompare(b.path, "en"))
const snapshot = createHash("sha256").update(inventory.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("")).digest("hex")
const artifacts = [
  "dist-release/opencomms.exe",
  "dist-release/opencomms-1.4.0.tgz",
  "desktop/src-tauri/binaries/opencomms-coordinator-x86_64-pc-windows-msvc.exe",
  "desktop/dist-shell/index.html",
  "desktop/dist-shell/app.js",
  "desktop/dist-shell/manifest.json",
].filter(existsSync).map((path) => ({ path, bytes: statSync(path).size, sha256: hash(path) }))
const summaries = {}
for (const [name, path] of Object.entries({ unit: "validation-unit-final.log", contract: "validation-contract-final.log", linked_live: "validation-live-final.log", managed_vendor: "validation-vendor-final.log" })) {
  if (!existsSync(path)) continue
  const log = readFileSync(path, "utf8")
  const values = Object.fromEntries([...log.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)].map((match) => [match[1], Number(match[2])]))
  summaries[name] = { log: path, ...values }
}
const manifest = {
  recorded_at: new Date().toISOString(),
  package_version: JSON.parse(readFileSync("package.json", "utf8")).version,
  tested_source_snapshot_sha256: snapshot,
  snapshot_algorithm: "sha256 of sorted UTF-8 lines: <file sha256> two spaces <relative path> LF",
  scope: "src, test, scripts, installer, adapters/assets, desktop source/config, install.mjs, root package/tsconfig/.gitignore; excludes generated outputs, dependencies, caches and root/docs documentation",
  git_revision: null,
  node: process.version,
  files: inventory,
  artifacts,
  test_summaries: summaries,
}
writeFileSync(".verification/source-manifest.json", JSON.stringify(manifest, null, 2) + "\n")
writeFileSync("dist-release/SHA256SUMS", artifacts.filter((entry) => entry.path.startsWith("dist-release/")).map((entry) => `${entry.sha256}  ${entry.path.slice("dist-release/".length)}\n`).join(""))
console.log(JSON.stringify({ snapshot, files: inventory.length, artifacts, test_summaries: summaries }, null, 2))
