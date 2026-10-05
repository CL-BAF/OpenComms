#!/usr/bin/env node
/** Build the real Windows installer with Inno Setup 6. */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(join(fileURLToPath(new URL("..", import.meta.url))))
const exe = resolve(join(repoRoot, "dist-release", "opencomms.exe"))
const packageVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version
if (process.platform !== "win32") {
  throw new Error("The Inno Setup installer is Windows-only. Run npm run build:installer on Windows or in Windows CI.")
}
if (!existsSync(exe))
  throw new Error("Missing dist-release/opencomms.exe. Run npm run build:exe -- --out dist-release first.")
const versionEnv = { ...process.env }
delete versionEnv.OPENCOMMS_VERSION
const executableVersion = execFileSync(exe, ["version"], {
  encoding: "utf8",
  timeout: 30_000,
  env: versionEnv,
}).match(/^opencomms ([^\s]+)/)?.[1]
if (executableVersion !== packageVersion) {
  throw new Error(
    `Release executable version ${executableVersion ?? "unknown"} differs from package ${packageVersion}; rebuild it before packaging.`,
  )
}

const candidates = [
  process.env["ISCC_EXE"],
  process.env["INNO_SETUP_HOME"] ? join(process.env["INNO_SETUP_HOME"], "ISCC.exe") : undefined,
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
  "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
].filter((value) => value && existsSync(value))
const iscc = candidates[0]
if (!iscc) {
  throw new Error("ISCC.exe not found. Install Inno Setup 6.4.x or set ISCC_EXE to its full path.")
}

execFileSync(iscc, [`/DAppVersion=${packageVersion}`, join(repoRoot, "installer", "OpenComms.iss")], {
  cwd: repoRoot,
  stdio: "inherit",
})
const artifacts = readdirSync(join(repoRoot, "dist-release")).filter((name) => name.endsWith(".exe"))
if (!existsSync(join(repoRoot, "dist-release", `OpenComms-Setup-${packageVersion}.exe`)))
  throw new Error("Current-version installer output was not produced")
console.log(`[opencomms-installer] produced: ${artifacts.join(", ")}`)
