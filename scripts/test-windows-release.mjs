#!/usr/bin/env node
/** Smoke-test the built Windows installer in an isolated per-user install. */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

if (process.platform !== "win32") {
  throw new Error("The Windows release smoke test must run on Windows.")
}

const repoRoot = resolve(join(fileURLToPath(new URL("..", import.meta.url))))
const releaseDir = join(repoRoot, "dist-release")
const packageVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version
const installer = join(releaseDir, `OpenComms-Setup-${packageVersion}.exe`)
const sourceExe = join(releaseDir, "opencomms.exe")
if (!existsSync(installer) || !existsSync(sourceExe))
  throw new Error(`Current release ${packageVersion} installer or executable is missing; run npm run build:release.`)
const smokeEnv = { ...process.env }
delete smokeEnv.OPENCOMMS_VERSION

const root = join(tmpdir(), `opencomms-release-smoke-${process.pid}`)
const installDir = join(root, "Install")
const configDir = join(root, "Config")
const projectDir = join(root, "Project")
const projectState = join(projectDir, ".opencomms", "state.json")
const preservedState = '{"schema_version":2,"channels":{},"messages":{},"queues":{},"delivered_to":{},"errors":[]}\n'
const port = String(49300 + (process.pid % 500))
let smokeExecutable = null

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function shortcutInfo(shortcut) {
  const script =
    "$p=$env:OPENCOMMS_SMOKE_SHORTCUT; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); [pscustomobject]@{TargetPath=$s.TargetPath; Arguments=$s.Arguments; WorkingDirectory=$s.WorkingDirectory} | ConvertTo-Json -Compress"
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env: { ...process.env, OPENCOMMS_SMOKE_SHORTCUT: shortcut },
    }),
  )
}

function findFile(rootDir, wantedName) {
  if (!existsSync(rootDir)) return null
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const candidate = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      const nested = findFile(candidate, wantedName)
      if (nested) return nested
    } else if (entry.name.toLowerCase() === wantedName.toLowerCase()) {
      return candidate
    }
  }
  return null
}

async function waitForGui(url, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs
  let lastError = "unknown error"
  while (Date.now() < end) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error.message
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`Installed GUI did not answer at ${url}: ${lastError}`)
}

function stopSmokeGui() {
  if (!smokeExecutable) return
  const script =
    "$path=$env:OPENCOMMS_SMOKE_EXE; Get-Process -Name opencomms -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $path } | Stop-Process -Force -ErrorAction SilentlyContinue"
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "ignore",
      env: { ...process.env, OPENCOMMS_SMOKE_EXE: smokeExecutable },
    })
  } catch {
    // The smoke process may already have exited.
  }
}

try {
  mkdirSync(join(projectDir, ".opencomms"), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(projectState, preservedState, "utf8")

  execFileSync(
    installer,
    ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${installDir}`, "/TASKS=desktopicon"],
    {
      stdio: "inherit",
    },
  )

  const installedExe = join(installDir, "opencomms.exe")
  smokeExecutable = installedExe
  const launcher = join(installDir, "OpenComms.vbs")
  const icon = join(installDir, "icon.ico")
  check(existsSync(installedExe), "Installed opencomms.exe is missing.")
  check(existsSync(launcher), "Installed OpenComms.vbs launcher is missing.")
  check(existsSync(icon), "Installed icon.ico is missing.")

  const version = execFileSync(installedExe, ["version"], { encoding: "utf8", env: smokeEnv })
  check(
    version.match(/^opencomms ([^\s]+)/)?.[1] === packageVersion,
    "Installed executable does not report the current package version.",
  )
  check(
    sha256(installedExe) === sha256(sourceExe),
    "Installer packaged a different executable from the current release build.",
  )

  const desktopShortcut = join(homedir(), "Desktop", "OpenComms.lnk")
  const programsRoot = join(
    process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  )
  const startShortcut = findFile(programsRoot, "OpenComms.lnk")
  check(startShortcut !== null, "Start Menu OpenComms shortcut is missing.")
  check(existsSync(desktopShortcut), "Desktop OpenComms shortcut is missing.")

  for (const shortcut of [startShortcut, desktopShortcut]) {
    const info = shortcutInfo(shortcut)
    check(
      info.TargetPath.toLowerCase().endsWith("\\wscript.exe"),
      `Shortcut target is not wscript.exe: ${info.TargetPath}`,
    )
    check(
      info.Arguments.includes("OpenComms.vbs") && /\bgui\b/i.test(info.Arguments),
      "Shortcut arguments do not launch the GUI.",
    )
    check(
      info.WorkingDirectory.toLowerCase() === installDir.toLowerCase(),
      "Shortcut working directory is not the install directory.",
    )
  }

  const gui = spawn(
    join(process.env.WINDIR ?? "C:\\Windows", "System32", "wscript.exe"),
    [launcher, "gui", "--server", "--port", port],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...smokeEnv, OPENCOMMS_CONFIG_DIR: configDir },
    },
  )
  gui.unref()
  const workspace = await (await waitForGui(`http://127.0.0.1:${port}/api/workspace`)).json()
  check(workspace.ok === true, "Installed GUI workspace endpoint failed.")
  const capabilities = await (await fetch(`http://127.0.0.1:${port}/api/capabilities`)).json()
  check(
    capabilities.ok === true && capabilities.data?.version === packageVersion,
    "Installed GUI backend does not report the current release version.",
  )
  check(!existsSync(join(installDir, ".opencomms")), "GUI created project state inside the install directory.")
  stopSmokeGui()

  const uninstaller = findFile(installDir, "unins000.exe")
  check(uninstaller !== null, "Inno Setup uninstaller is missing.")
  execFileSync(uninstaller, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"], { stdio: "inherit" })
  check(!existsSync(installedExe), "Uninstall left opencomms.exe behind.")
  check(!existsSync(launcher), "Uninstall left the launcher behind.")
  check(!existsSync(desktopShortcut), "Uninstall left the desktop shortcut behind.")
  check(!existsSync(startShortcut), "Uninstall left the Start Menu shortcut behind.")
  check(readFileSync(projectState, "utf8") === preservedState, "Uninstall modified project .opencomms state.")
  console.log("[opencomms-windows-release] install, shortcuts, GUI launch, and uninstall passed")
} finally {
  stopSmokeGui()
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Best effort cleanup for a failed installer smoke test.
  }
}
