#!/usr/bin/env node
/** Linux release smoke: verify payload, installer rollback and state preservation. */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

if (process.platform !== "linux") {
  throw new Error(
    "The Linux release smoke test must run on Linux (scripts/test-windows-release.mjs is its Windows counterpart).",
  )
}

const repoRoot = resolve(join(fileURLToPath(new URL("..", import.meta.url))))
const releaseDir = join(repoRoot, "dist-release")
const tarball = readdirSync(releaseDir)
  .filter((name) => /^opencomms-linux-.*\.tar\.gz$/.test(name))
  .map((name) => join(releaseDir, name))[0]
if (!tarball || !existsSync(tarball))
  throw annotated(
    new Error("No opencomms-linux-*.tar.gz found in dist-release (run npm run build:release on Linux first)."),
  )

const root = join(tmpdir(), `opencomms-linux-smoke-${process.pid}`)
const extractDir = join(root, "extract")
const homeDir = join(root, "home")
const configDir = join(homeDir, ".config")
const projectDir = join(root, "Project")
const projectState = join(projectDir, ".opencomms", "state.json")
const preservedState = '{"schema_version":2,"channels":{},"messages":{},"queues":{},"delivered_to":{},"errors":[]}\n'
const port = String(49400 + (process.pid % 500))
let smokeProcess = null

function check(condition, message) {
  if (!condition) {
    // Emit the failed assertion as a GitHub ::error annotation so CI shows
    // WHICH stage failed without needing the (auth-gated) job log.
    console.log(`::error file=scripts/test-linux-release.mjs::${message.replaceAll("\n", " ").slice(0, 380)}`)
    throw new Error(message)
  }
}

/** Wrap a thrown error so non-check() failure paths are observable too. */
function annotated(error) {
  console.log(
    `::error file=scripts/test-linux-release.mjs::${String(error.message ?? error)
      .replaceAll("\n", " ")
      .slice(0, 380)}`,
  )
  return error
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
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
  throw annotated(new Error(`GUI did not answer at ${url}: ${lastError}`))
}

function stopSmokeGui() {
  if (!smokeProcess?.pid) return
  try {
    // SIGTERM = the unit's default KillSignal; the process has graceful
    // SIGTERM handling (src/cli/main.ts). Escalate to SIGKILL only on hang.
    process.kill(smokeProcess.pid, "SIGTERM")
  } catch {
    // Already exited.
    return
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(smokeProcess.pid, 0)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    } catch {
      return // exited
    }
  }
  try {
    process.kill(smokeProcess.pid, "SIGKILL")
  } catch {
    /* raced exit */
  }
}

try {
  mkdirSync(extractDir, { recursive: true })
  execFileSync("tar", ["-xzf", tarball, "-C", extractDir], { stdio: "inherit" })
  const payloadDir = join(extractDir, "opencomms")

  // SHA256SUMS lists payload files and cannot include its own hash.
  const expected = ["opencomms", "opencomms.service", "install.sh", "README-linux.txt", "SHA256SUMS"]
  for (const name of expected) {
    check(existsSync(join(payloadDir, name)), `Tarball payload missing: opencomms/${name}`)
  }
  const extra = readdirSync(payloadDir).filter((name) => !expected.includes(name))
  check(extra.length === 0, `Unexpected tarball payload entries: ${extra.join(", ")}`)
  // Exec-bit assertions (copyFileSync does not preserve modes — the builder
  // must chmod; without this the smoke test's direct exec fails EACCES).
  for (const name of ["opencomms", "install.sh"]) {
    const mode = statSync(join(payloadDir, name)).mode
    check((mode & 0o111) === 0o111, `Tarball payload opencomms/${name} is not executable (mode ${mode.toString(8)}).`)
  }

  // Normalize CRLF and trailing whitespace before checking checksum entries.
  const sums = readFileSync(join(payloadDir, "SHA256SUMS"), "utf8")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line !== "")
  const checksummed = expected.filter((name) => name !== "SHA256SUMS")
  check(sums.length === checksummed.length, `SHA256SUMS has ${sums.length} entries, expected ${checksummed.length}.`)
  for (const line of sums) {
    const parts = line.split(/ {2}/).map((part) => part.trim())
    check(parts.length === 2, `SHA256SUMS entry is malformed (expected "hash  name"): ${line}`)
    const [hash, name] = parts
    check(/^[0-9a-f]{64}$/.test(hash), `SHA256SUMS hash is malformed: ${hash}`)
    check(/^opencomms\//.test(name), `SHA256SUMS entry escapes payload dir: ${name}`)
    check(existsSync(join(extractDir, name)), `SHA256SUMS references a file the tarball does not contain: ${name}`)
    const actual = sha256(join(extractDir, name))
    check(actual === hash, `SHA256 mismatch for ${name}.`)
  }

  const exe = join(payloadDir, "opencomms")
  check(execFileSync(exe, ["version"], { encoding: "utf8" }).includes("opencomms "), "Exe did not answer to version.")
  const doctor = execFileSync(exe, ["doctor", "--project", projectDir], { encoding: "utf8" })
  check(doctor.includes("OpenComms doctor"), "Exe did not answer to doctor.")

  const spacedProject = join(root, "My Projects", "demo repo")
  mkdirSync(join(spacedProject, ".opencomms"), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(projectDir, ".opencomms"), { recursive: true })
  writeFileSync(projectState, preservedState, "utf8")
  const binDir = join(homeDir, ".local", "bin")
  execFileSync(
    join(payloadDir, "install.sh"),
    ["--exe", exe, "--bin-dir", binDir, "--project", spacedProject, "--service"],
    {
      env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: configDir },
      stdio: "inherit",
    },
  )
  const installedExe = join(binDir, "opencomms")
  check(existsSync(installedExe), "install.sh did not install the binary.")
  const unitFile = join(configDir, "systemd", "user", "opencomms.service")
  check(existsSync(unitFile), "install.sh did not write the unit.")
  const unit = readFileSync(unitFile, "utf8")
  check(/^WorkingDirectory="[^"]+"$/m.test(unit), "Unit WorkingDirectory is not quoted (spaced paths would misparse).")
  check(
    /^ExecStart="[^"]+" gui --project "[^"]+" --server --no-open$/m.test(unit),
    "Unit ExecStart is not the exact approved argv with quoted values.",
  )
  check(/^AssertPathIsDirectory="[^"]+"$/m.test(unit), "Unit AssertPathIsDirectory is not quoted.")
  check(unit.includes(spacedProject), "Unit does not reference the spaced project path.")
  check(!/[@]BIN@|[@]PROJECT_DIR@/.test(unit), "Unit still contains unresolved placeholders.")
  // Only daemon-reload may run; service activation and privilege commands remain instructions.
  // Exclude comments, printed help and heredocs when inspecting executed commands.
  const rawInstaller = readFileSync(join(payloadDir, "install.sh"), "utf8")
  check(
    !rawInstaller.includes("\r"),
    "install.sh contains CR bytes (must be LF-only for Linux; CRLF breaks sh on some values and breaks this file's static analysis).",
  )
  const installerSource = rawInstaller.replace(/\r\n/g, "\n")
  const installerLines = installerSource.split("\n")
  const isHeredocRange = (() => {
    const ranges = []
    let start = null
    for (let i = 0; i < installerLines.length; i++) {
      const marker = installerLines[i].match(/<<\s*(?:'([^']+)'|(\w+))/)
      if (marker) {
        start = { begin: i, endTag: marker[1] ?? marker[2] }
      } else if (start && installerLines[i].trim() === start.endTag) {
        ranges.push([start.begin, i])
        start = null
      }
    }
    return (index) => ranges.some(([begin, end]) => index > begin && index < end)
  })()
  const codeLines = installerLines
    .map((line, index) => {
      // Ignore full-line shell comments; printed text is filtered separately.
      const stripped = line.replace(/(^|\s)#.*$/, "$1")
      return { line: stripped, index }
    })
    .filter(({ index }) => !isHeredocRange(index))
  const sudoInCode = codeLines.filter((entry) => /\bsudo\b/.test(entry.line))
  check(sudoInCode.length === 0, `install.sh references sudo in code: ${sudoInCode[0]?.line.trim().slice(0, 80)}`)
  const executedLines = codeLines
    .map((entry) => entry.line.trim())
    .filter((trimmed) => {
      if (trimmed === "") return false
      if (/printf/.test(trimmed)) return false
      if (/command\s+-v\s+systemctl/.test(trimmed) || /systemctl\s+--version/.test(trimmed)) return false
      return /systemctl|loginctl/.test(trimmed)
    })
  for (const line of executedLines) {
    check(
      /systemctl\s+--user\s+daemon-reload/.test(line),
      `install.sh executes a systemctl action other than the approved daemon-reload: ${line.trim()}`,
    )
  }
  check(
    executedLines.every((line) => /daemon-reload/.test(line)),
    "install.sh executes non-daemon-reload systemctl/loginctl commands.",
  )

  const gui = spawn(installedExe, ["gui", "--project", spacedProject, "--server", "--no-open", "--port", port], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: configDir },
  })
  smokeProcess = gui
  gui.unref()
  let workspaceOk = false
  for (let i = 0; i < 120 && !workspaceOk; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workspace`)
      if (response.ok) {
        const workspace = await response.json()
        check(workspace.ok === true, "GUI workspace endpoint failed.")
        workspaceOk = true
      }
    } catch {
      await new Promise((done) => setTimeout(done, 250))
    }
  }
  check(workspaceOk, `GUI did not answer at http://127.0.0.1:${port}/api/workspace within 30s.`)
  check(!existsSync(join(root, "extract", ".opencomms")), "GUI created state inside the extraction dir.")
  check(!existsSync(join(payloadDir, ".opencomms")), "GUI created state inside the payload dir.")

  stopSmokeGui()
  check(readFileSync(projectState, "utf8") === preservedState, "GUI smoke modified the project .opencomms state.")

  execFileSync(join(payloadDir, "install.sh"), ["--uninstall"], {
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: configDir },
    stdio: "pipe",
  })
  check(!existsSync(installedExe), "Uninstall left the binary behind.")
  check(!existsSync(unitFile), "Uninstall left the unit behind.")
  check(readFileSync(projectState, "utf8") === preservedState, "Uninstall modified project .opencomms state.")

  const regBinDir = join(homeDir, ".local", "bin")
  const regExe = installedExe

  const regProject = join(root, "Update Project")
  mkdirSync(join(regProject, ".opencomms"), { recursive: true })
  const regState = join(regProject, ".opencomms", "state.json")
  writeFileSync(regState, preservedState, "utf8")
  execFileSync(join(payloadDir, "install.sh"), ["--exe", exe, "--bin-dir", binDir, "--no-path-edit"], {
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: configDir },
    stdio: "pipe",
  })
  check(existsSync(regExe), "Re-install did not restore the binary (9a precondition).")

  execFileSync(join(payloadDir, "install.sh"), ["--exe", exe, "--bin-dir", binDir, "--no-path-edit"], {
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: configDir },
    stdio: "pipe",
  })
  const binDirEntries = readdirSync(binDir)
  check(
    binDirEntries.filter((name) => name.startsWith(".opencomms-new-") || name.startsWith(".opencomms-prev-")).length ===
      0,
    `Installer left staging residue in the bin dir: ${binDirEntries.join(", ")}`,
  )
  check(
    execFileSync(regExe, ["version"], { encoding: "utf8" }).includes("opencomms "),
    "Re-installed binary does not answer version (idempotency).",
  )

  const profile = join(homeDir, ".profile")
  rmSync(profile, { force: true })
  execFileSync(join(payloadDir, "install.sh"), ["--exe", exe, "--bin-dir", binDir], {
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: configDir },
    stdio: "pipe",
  })
  const firstCount = readFileSync(profile, "utf8").split(binDir).length - 1
  check(firstCount === 1, `~/.profile has ${firstCount} PATH entries after first install, expected 1.`)
  execFileSync(join(payloadDir, "install.sh"), ["--exe", exe, "--bin-dir", binDir], {
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: configDir },
    stdio: "pipe",
  })
  const secondCount = readFileSync(profile, "utf8").split(binDir).length - 1
  check(
    secondCount === 1,
    `~/.profile has ${secondCount} PATH entries after second install, expected 1 (no duplicate appends).`,
  )

  const defective = join(homeDir, "defective-opencomms")
  writeFileSync(defective, "#!/bin/sh\nexit 1\n", "utf8")
  chmodSync(defective, 0o755)
  let rollbackCaught = false
  try {
    execFileSync(join(payloadDir, "install.sh"), ["--exe", defective, "--bin-dir", binDir, "--no-path-edit"], {
      env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: configDir },
      stdio: "pipe",
    })
  } catch {
    rollbackCaught = true
  }
  check(rollbackCaught, "Installer ACCEPTED a defective binary (execute-before-install must refuse it).")
  check(
    execFileSync(regExe, ["version"], { encoding: "utf8" }).includes("opencomms "),
    "GOOD binary was clobbered by the defective one (atomic replace/rollback failed).",
  )
  rmSync(defective, { force: true })

  check(readFileSync(regState, "utf8") === preservedState, "Re-install modified project .opencomms state.")

  execFileSync(join(payloadDir, "install.sh"), ["--uninstall"], {
    env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: configDir },
    stdio: "pipe",
  })
  check(!existsSync(regExe), "Uninstall (post-regression) left the binary behind.")

  console.log(
    "[opencomms-linux-release] extraction, checksums, exe smoke, unit quoting, headless GUI, SIGTERM, installer regressions, and uninstall passed",
  )
} catch (error) {
  console.log(
    `::error file=scripts/test-linux-release.mjs::${String(error.message ?? error)
      .replaceAll("\n", " ")
      .slice(0, 380)}`,
  )
  throw error
} finally {
  stopSmokeGui()
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // Best effort cleanup.
  }
}
