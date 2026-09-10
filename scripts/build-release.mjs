#!/usr/bin/env node
/** Build all distributable Windows release artifacts in one reproducible step. */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(join(fileURLToPath(new URL("..", import.meta.url))))
const outDir = resolve(join(repoRoot, "dist-release"))
mkdirSync(outDir, { recursive: true })
const node = process.execPath
const buildExe = join(repoRoot, "scripts", "build-exe.mjs")
execFileSync(node, [buildExe, "--out", "dist-release"], { cwd: repoRoot, stdio: "inherit" })

const exe = join(outDir, process.platform === "win32" ? "opencomms.exe" : "opencomms")
if (!existsSync(exe)) throw new Error(`Release executable missing: ${exe}`)
const checksum = createHash("sha256").update(readFileSync(exe)).digest("hex")
writeFileSync(join(outDir, `${exe.split(/[\\/]/).pop()}.sha256`), `${checksum}  ${exe.split(/[\\/]/).pop()}\n`, "utf8")

if (process.platform === "win32") {
  execFileSync(node, [join(repoRoot, "scripts", "build-installer.mjs")], { cwd: repoRoot, stdio: "inherit" })
}

console.log(`[opencomms-release] executable: ${exe}`)
