#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "win32") throw new Error("The native release smoke test requires Windows and WebView2.")

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)))
const option = (name) => {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}
const installer = option("--installer")
assert.ok(installer && existsSync(installer), "Pass the built NSIS package with --installer <path>.")
const driver = option("--driver") || join(homedir(), ".cargo", "bin", "tauri-driver.exe")
assert.ok(existsSync(driver), "Install tauri-driver with cargo install tauri-driver --locked.")
const nativeDriver = option("--native-driver")
if (nativeDriver) assert.ok(existsSync(nativeDriver), "The supplied Microsoft Edge driver does not exist.")
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version
const evidence = join(repo, ".verification")
const root = join(evidence, `native-release-${process.pid}-${Date.now()}`)
const installDir = join(root, "Install with spaces")
const project = join(root, "Project")
const profile = join(root, "Profile")
const config = join(root, "Config")
for (const path of [evidence, installDir, project, profile, config, join(profile, "AppData", "Local")]) {
  mkdirSync(path, { recursive: true })
}

// Provider credentials and host launch configuration are deliberately absent.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|PROGRAMDATA|TEMP|TMP|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(
      name,
    ),
  ),
)
Object.assign(env, {
  USERPROFILE: profile,
  LOCALAPPDATA: join(profile, "AppData", "Local"),
  APPDATA: join(profile, "AppData", "Roaming"),
  OPENCOMMS_CONFIG_DIR: config,
})
mkdirSync(env.APPDATA, { recursive: true })
const checks = []
let session = null
let driverProcess = null
let installed = false
let failure = null
let driverLog = ""
let appPath = ""
const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
const check = (name) => {
  checks.push(name)
  console.log(`[native-release] PASS ${name}`)
}
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
const powershell = (code, extra = {}) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...env, ...extra },
    timeout: 15_000,
  }).trim()

async function waitFor(fn, description, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await pause(250)
  }
  throw new Error(`Timed out: ${description}`)
}

async function run(path, args, timeout = 120_000, windowsVerbatimArguments = false) {
  const child = spawn(path, args, { env, windowsHide: true, windowsVerbatimArguments, stdio: "inherit" })
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${basename(path)} exceeded ${timeout}ms.`))
    }, timeout)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`${basename(path)} exited with ${code}.`))
    })
  })
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolvePromise)
  })
  const port = server.address().port
  await new Promise((resolvePromise) => server.close(resolvePromise))
  return port
}

let address
async function webdriver(method, path, body) {
  const response = await fetch(address + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const result = await response.json()
  assert.ok(
    response.ok && !result.value?.error,
    `WebDriver ${method} ${path}: ${result.value?.message || response.status}`,
  )
  return result.value
}
const execute = (script, args = []) => webdriver("POST", `/session/${session}/execute/sync`, { script, args })
const visible = (selector) =>
  execute(
    "const e=document.querySelector(arguments[0]); return !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);",
    [selector],
  )
async function element(selector) {
  await waitFor(() => visible(selector), `visible ${selector}`)
  const result = await webdriver("POST", `/session/${session}/element`, { using: "css selector", value: selector })
  return result["element-6066-11e4-a52e-4f735466cecf"]
}
async function click(selector) {
  await webdriver("POST", `/session/${session}/element/${await element(selector)}/click`, {})
}
async function fill(selector, text) {
  const id = await element(selector)
  await webdriver("POST", `/session/${session}/element/${id}/clear`, {})
  await webdriver("POST", `/session/${session}/element/${id}/value`, { text })
}
async function invoke(cmd, args = {}) {
  return webdriver("POST", `/session/${session}/execute/async`, {
    script:
      "const done=arguments[arguments.length-1]; window.__TAURI__.core.invoke('orchestrator_invoke',{cmd:arguments[0],args:arguments[1]}).then(result=>done({resolved:true,result}),error=>done({resolved:false,error}));",
    args: [cmd, args],
  })
}
function installedProcesses() {
  const json = powershell(
    "$dir=$env:OPENCOMMS_NATIVE_SMOKE_INSTALL+[IO.Path]::DirectorySeparatorChar; $rows=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir,[StringComparison]::OrdinalIgnoreCase)} | ForEach-Object {[pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;name=$_.Name}}); ConvertTo-Json -InputObject $rows -Compress",
    { OPENCOMMS_NATIVE_SMOKE_INSTALL: installDir },
  )
  return JSON.parse(json || "[]")
}
function closeApp(pid) {
  const closed = powershell(
    "$process=Get-Process -Id ([int]$env:OPENCOMMS_NATIVE_SMOKE_PID) -ErrorAction Stop; $process.CloseMainWindow()",
    { OPENCOMMS_NATIVE_SMOKE_PID: String(pid) },
  )
  assert.equal(closed, "True", "The installed GUI must expose a window that can close normally.")
}
function findUninstaller() {
  return readdirSync(installDir).find((name) => /^uninstall.*\.exe$/i.test(name))
}

try {
  // NSIS requires /D last and without quotes, even when the directory contains spaces.
  await run(resolve(installer), ["/S", `/D=${installDir}`], 120_000, true)
  installed = true
  appPath = join(installDir, "opencomms-desktop.exe")
  const coordinator = join(installDir, "opencomms-coordinator.exe")
  assert.ok(existsSync(appPath), "NSIS package omitted the native executable.")
  assert.ok(existsSync(coordinator), "NSIS package omitted the coordinator beside the executable.")
  assert.equal(
    hash(appPath),
    hash(join(repo, "desktop", "src-tauri", "target", "x86_64-pc-windows-msvc", "release", "opencomms-desktop.exe")),
    "Installed GUI differs from the release Rust executable.",
  )
  assert.equal(
    hash(coordinator),
    hash(join(repo, "dist-release", "opencomms.exe")),
    "Installed coordinator differs from the release SEA.",
  )
  assert.match(
    execFileSync(coordinator, ["version"], { env, encoding: "utf8", windowsHide: true, timeout: 15_000 }),
    new RegExp(`opencomms ${version.replaceAll(".", "\\.")}\\b`),
  )
  check("NSIS isolated installation and current coordinator identity")

  const port = await availablePort()
  const nativePort = await availablePort()
  address = `http://127.0.0.1:${port}`
  const driverArgs = ["--port", String(port), "--native-port", String(nativePort)]
  if (nativeDriver) driverArgs.push("--native-driver", resolve(nativeDriver))
  driverProcess = spawn(driver, driverArgs, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  driverProcess.on("error", (error) => {
    failure = error
  })
  const capture = (data) => {
    driverLog = (driverLog + data.toString()).slice(-100_000)
  }
  driverProcess.stdout.on("data", capture)
  driverProcess.stderr.on("data", capture)
  await waitFor(async () => {
    if (failure) throw failure
    if (driverProcess.exitCode !== null) throw new Error(`tauri-driver exited early: ${driverProcess.exitCode}`)
    try {
      return (await fetch(`${address}/status`, { signal: AbortSignal.timeout(1000) })).ok
    } catch {
      return false
    }
  }, "tauri-driver ready")
  const opened = await webdriver("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: appPath } } },
  })
  session = opened.sessionId
  assert.ok(session, "WebDriver did not create a native WebView session.")
  await webdriver("POST", `/session/${session}/timeouts`, { script: 125_000, implicit: 0, pageLoad: 60_000 })
  await waitFor(
    () =>
      execute(
        "return !!window.__TAURI__?.core?.invoke && typeof renderRoute==='function' && !!document.querySelector('#projectBtn');",
      ),
    "offline console boot",
  )
  const pageUrl = await webdriver("GET", `/session/${session}/url`)
  assert.ok(!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(pageUrl), "Native GUI loaded a loopback HTTP page.")
  check("installed WebView loads bundled GUI and real Tauri IPC")
  const asset = await webdriver("POST", `/session/${session}/execute/async`, {
    script:
      "const done=arguments[arguments.length-1]; fetch(new URL('./app.js',location.href)).then(r=>{if(!r.ok)throw new Error('Packaged app.js is unavailable'); return r.text();}).then(text=>done({ok:true,text}),error=>done({ok:false,message:String(error)}));",
    args: [],
  })
  assert.equal(asset.ok, true, asset.message)
  assert.equal(
    createHash("sha256").update(asset.text, "utf8").digest("hex"),
    hash(join(repo, "desktop", "dist-shell", "app.js")),
    "Packaged WebView assets differ from the final GUI build.",
  )
  check("installed GUI script matches the current offline asset build")

  await click("#projectBtn")
  await fill("#projectPathInput", project)
  await click('#modalForm button[type="submit"]')
  await waitFor(
    () =>
      execute(
        "return !document.querySelector('#modalForm') && document.querySelector('#projectPath').textContent===arguments[0];",
        [project],
      ),
    "project selected through GUI",
  )
  check("GUI project selection rebinds the packaged coordinator")

  await click('[data-nav="sessions"]')
  await click("#newBtnInline")
  await fill("#sessionName", "native-release-smoke")
  await click('#modalForm button[type="submit"]')
  await waitFor(() => visible('[data-open="native-release-smoke"]'), "created session card")
  const statePath = join(project, ".opencomms", "state.json")
  assert.ok(
    JSON.parse(readFileSync(statePath, "utf8")).channels["native-release-smoke"],
    "GUI channel creation was not persisted.",
  )
  assert.equal(
    existsSync(join(installDir, ".opencomms")),
    false,
    "Native bootstrap wrote channel state into its install directory.",
  )
  check("GUI channel creation persists in the selected project")

  const diagnostics = await invoke("diagnostics")
  assert.equal(diagnostics.resolved, true)
  assert.equal(diagnostics.result.ok, true)
  assert.equal(diagnostics.result.data.version, version)
  assert.ok(diagnostics.result.id && diagnostics.result.request_id, "Coordinator response lacks correlation metadata.")
  await click('[data-nav="settings"]')
  await click('[data-tab="diagnostics"]')
  await waitFor(
    () =>
      execute(
        "return Array.from(document.querySelectorAll('.diagnostic-row')).some(e=>e.textContent.includes('OpenComms version')&&e.textContent.includes(arguments[0]));",
        [version],
      ),
    "current GUI Diagnostics version",
  )
  check("packaged GUI and coordinator report the release version")

  const capability = await invoke("capabilities")
  assert.equal(capability.resolved, true)
  assert.equal(capability.result.ok, true)
  assert.equal(capability.result.data.actions.session_create.state, "supported")
  const joinCommand = await invoke("session_join_command", { name: "native-release-smoke", host: "codex" })
  assert.equal(joinCommand.resolved, true)
  assert.equal(joinCommand.result.ok, true)
  assert.match(JSON.stringify(joinCommand.result.data), /native-release-smoke/)
  check("packaged native capabilities and host join command succeed")

  const refused = await invoke("arbitrary_proxy", { url: "https://example.invalid" })
  assert.equal(refused.resolved, false)
  assert.equal(refused.error.code, "unsupported")
  assert.equal(refused.error.outcome, "not_executed")
  assert.ok(refused.error.request_id && refused.error.error.recovery)
  const healthy = await invoke("sessions_list")
  assert.equal(healthy.resolved, true)
  assert.equal(healthy.result.ok, true)
  check("unknown native operations are bounded, correlated and leave the connection healthy")

  const tracked = installedProcesses()
  const gui = tracked.find((row) => row.name.toLowerCase() === "opencomms-desktop.exe")
  const child = tracked.find((row) => row.name.toLowerCase() === "opencomms-coordinator.exe")
  assert.ok(gui && child, "Native GUI must have an actual installed coordinator child.")
  assert.equal(child.parent, gui.pid, "Coordinator was not launched by the installed GUI.")
  closeApp(gui.pid)
  await waitFor(() => installedProcesses().length === 0, "GUI and coordinator disappear after normal close", 30_000)
  check("normal window close terminates and reaps its coordinator")
  await webdriver("DELETE", `/session/${session}`).catch(() => {})
  session = null

  const uninstaller = findUninstaller()
  assert.ok(uninstaller, "NSIS package did not install an uninstaller.")
  await run(join(installDir, uninstaller), ["/S"])
  await waitFor(() => !existsSync(appPath) && !existsSync(coordinator), "native uninstall completes")
  installed = false
  assert.ok(
    JSON.parse(readFileSync(statePath, "utf8")).channels["native-release-smoke"],
    "Uninstall removed project state.",
  )
  check("NSIS uninstall removes executables and preserves project state")
} catch (error) {
  failure = error
} finally {
  if (session) await webdriver("DELETE", `/session/${session}`).catch(() => {})
  if (driverProcess?.pid) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(driverProcess.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      })
    } catch {}
  }
  // Cleanup is scoped to executable paths in this test's install directory.
  try {
    for (const row of installedProcesses()) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(row.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
      } catch {}
    }
    if (installed) {
      const uninstaller = findUninstaller()
      if (uninstaller) await run(join(installDir, uninstaller), ["/S"]).catch(() => {})
    }
  } catch {}
  writeFileSync(join(evidence, "native-release-driver.log"), driverLog)
  writeFileSync(
    join(evidence, "native-release-summary.json"),
    JSON.stringify(
      {
        version,
        installer: basename(installer),
        platform: process.platform,
        node: process.version,
        checks,
        passed: checks.length,
        failed: failure ? 1 : 0,
        provider_execution: "not attempted; credentials and host launch configuration excluded",
        error: failure?.message || null,
      },
      null,
      2,
    ) + "\n",
  )
}
if (failure) throw failure
console.log(
  `[native-release] ${checks.length} checks passed in the installed Windows WebView; no provider execution attempted.`,
)
