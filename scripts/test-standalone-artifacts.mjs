/** Exercise the copied SEA binary and its installed adapters away from the repository. */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createServer } from "node:net"
import { join, resolve } from "node:path"

const source = resolve(process.argv[2] ?? "dist-release/opencomms.exe")
const npmMode = process.argv.includes("--npm")
assert.ok(existsSync(source), "Build the standalone executable first.")
const root = mkdtempSync(join(tmpdir(), "opencomms-standalone-"))
const install = join(root, "Install")
mkdirSync(install)
const binary = join(install, "opencomms.exe"),
  project = join(root, "Project")
mkdirSync(project)
if (!npmMode) copyFileSync(source, binary)
const env = { ...process.env, OPENCOMMS_CONFIG_DIR: join(root, "Config") }
const actions = []
let gui
let prefix = []
const executable = npmMode ? process.execPath : binary
function execute(args) {
  const result = spawnSync(executable, [...prefix, ...args], { cwd: project, env, encoding: "utf8", timeout: 30000 })
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`)
  actions.push({ action: args.slice(0, 2).join(" "), exit_code: result.status })
  return result.stdout
}
function nodeAdapter(file, input) {
  const result = spawnSync(process.execPath, [file], { cwd: project, env, input, encoding: "utf8", timeout: 20000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
try {
  if (npmMode) {
    const npmCli = process.env.OPENCOMMS_NPM_CLI
    assert.ok(npmCli && existsSync(npmCli), "Set OPENCOMMS_NPM_CLI to npm/bin/npm-cli.js for the offline package smoke.")
    const installed = spawnSync(process.execPath, [npmCli, "install", source, "--prefix", install, "--ignore-scripts", ...(process.argv.includes("--online") ? ["--prefer-offline", "--fetch-retries=0", "--fetch-timeout=15000"] : ["--offline"]), "--no-audit", "--fund=false", "--cache", resolve(".npm-cache")], { encoding: "utf8", timeout: 60000 })
    assert.equal(installed.status, 0, installed.stdout + installed.stderr)
    prefix = [join(install, "node_modules", "opencomms", "dist", "cli", "main.js")]
  }
  assert.match(execute(["version"]), /1\.4\.0/)
  for (const host of ["opencode", "claude-code", "codex", "gemini-cli", "claude-desktop"])
    execute(["install", host, "--project", project])
  const mcp = join(project, ".opencomms", "opencomms-mcp.mjs")
  assert.ok(existsSync(mcp), "Installed standalone MCP artifact must exist.")
  const initialized = nodeAdapter(
    mcp,
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "standalone-smoke", version: "1" },
      },
    }) + "\n",
  )
  assert.match(initialized, /"id":1/)
  assert.match(initialized, /serverInfo/)
  for (const [file, event] of [
    ["claude-code-hooks.mjs", "SessionStart"],
    ["gemini-cli-hooks.mjs", "SessionStart"],
  ]) {
    const hook = join(project, ".opencomms", file)
    assert.ok(existsSync(hook), `Missing ${file}`)
    const output = nodeAdapter(
      hook,
      JSON.stringify({ hook_event_name: event, session_id: "smoke-existing", cwd: project }),
    )
    assert.doesNotThrow(() => JSON.parse(output))
  }
  assert.ok(existsSync(join(project, "opencomms-claude-desktop", "manifest.json")))
  const desktopMcp = join(project, "opencomms-claude-desktop", "server", "main.mjs")
  assert.ok(existsSync(desktopMcp), "Desktop bundle must contain the MCP entry point.")
  const probe = createServer()
  await new Promise((done) => probe.listen(0, "127.0.0.1", done))
  const port = probe.address().port
  await new Promise((done) => probe.close(done))
  gui = spawn(executable, [...prefix, "gui", "--server", "--port", String(port), "--project", project], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = "",
    errors = ""
  gui.stdout.on("data", (chunk) => {
    output += chunk
  })
  gui.stderr.on("data", (chunk) => {
    errors += chunk
  })
  const deadline = Date.now() + 15000
  let address
  while (Date.now() < deadline && !address) {
    address = (output + errors).match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0]
    if (!address) await new Promise((done) => setTimeout(done, 100))
  }
  assert.ok(address, "Copied executable GUI must report its bound address: " + output + errors)
  const capabilities = await (await fetch(address + "/api/capabilities")).json()
  assert.equal(capabilities.ok, true)
  const created = await (
    await fetch(address + "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: address },
      body: JSON.stringify({ name: "standalone-smoke" }),
    })
  ).json()
  assert.equal(created.ok, true, created.message)
  const state = JSON.parse(readFileSync(join(project, ".opencomms", "state.json"), "utf8"))
  assert.ok(state.channels["standalone-smoke"])
  const report = {
    version: "1.4.0",
    mode: `${npmMode ? "installed npm tarball" : "copied SEA binary"}; real local backend and adapter child processes; no live vendor or installer claim`,
    actions,
    gui: "passed",
  }
  mkdirSync(".verification", { recursive: true })
  writeFileSync(`.verification/${npmMode ? "npm" : "standalone"}-artifacts.json`, JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify(report))
} finally {
  if (gui && gui.exitCode === null) {
    gui.kill()
    await Promise.race([new Promise((done) => gui.once("exit", done)), new Promise((done) => setTimeout(done, 3000))])
  }
  rmSync(root, { recursive: true, force: true })
}
