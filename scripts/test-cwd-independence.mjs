#!/usr/bin/env node
/**
 * Binary contract test — cwd independence + 5-location separation
 * (Workstream L gate-2; Platform-owned; Backend's SEA/path fix must pass
 * this against an exe BUILT WITH THE PINNED NODE 22.14.0).
 *
 * Contract (OVERHAUL_PLAN §4 Workstream L + Reviewer gate-2 (a)-(e)):
 *   (a) `version` works from ANY cwd (resource resolution is executable-relative)
 *   (b) `doctor` works from any cwd; never resolves state from the exe's dir
 *   (c) `install opencode` must NOT exec a wrong-path install.mjs (the
 *       "Unknown command <cwd>/install.mjs" failure class must be dead); a
 *       standalone failure is acceptable ONLY as a clear early message
 *   (d) repo-root is NOT required: binary works with no repo present
 *   (e) repo-root behavior KEEPS WORKING after the fix (run inside the repo too)
 *
 * 5-location separation asserted:
 *   1. executable   — resolves its own resources from the EXECUTABLE location
 *   2. packaged resources — never from cwd (decoy files in cwd must be ignored)
 *   3. source repo — never required (tests run in repo-less sandboxes)
 *   4. target project — state read/written at --project
 *   5. cwd — used ONLY for implicit project resolution when --project is absent
 *
 * Usage: node scripts/test-cwd-independence.mjs <path-to-opencomms-binary>
 * Exit 0 = contract passes. Any failure = Backend's fix is incomplete.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(join(fileURLToPath(new URL("..", import.meta.url))))
const binary = process.argv[2]
if (!binary || !existsSync(binary)) {
  console.error("usage: node scripts/test-cwd-independence.mjs <path-to-opencomms-binary>")
  console.error("build the binary with the pinned toolchain first: npm run build:exe")
  process.exit(2)
}

let failures = 0
function check(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`)
  } else {
    failures++
    console.error(`  FAIL: ${label}`)
  }
}

function runFrom(cwd, args, opts = {}) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    ...opts,
  })
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/** Decoy resource: a file that cwd-resolution would WRONGLY pick up. */
function plantDecoy(dir) {
  writeFileSync(join(dir, "package.json"), '{"name":"decoy","version":"0.0.0"}\n', "utf8")
}

// Build the set of cwd contexts. / and /tmp exist on Linux; on Windows CI the
// equivalents are the drive root and %TEMP%. The REAL test runs on Linux.
const isLinux = process.platform === "linux"
const contexts = []
if (isLinux) {
  contexts.push(["/tmp", "cwd=/tmp"])
  contexts.push(["/", "cwd=/"])
  contexts.push([process.env.HOME ?? "/root", "cwd=$HOME"])
} else {
  contexts.push([tmpdir(), "cwd=%TEMP% (Windows stand-in)"])
}
const scratch = mkdtempSync(join(tmpdir(), "ocm-cwd-"))
chmodSync(scratch, 0o755)
contexts.push([scratch, "cwd=scratch"])
// A project dir with planted decoy resources.
const projectDir = join(scratch, "My Project")
mkdirSync(join(projectDir, ".opencomms"), { recursive: true })
plantDecoy(projectDir)
contexts.push([projectDir, "cwd=project-with-decoy"])

console.log(`binary: ${binary}`)
console.log(`platform: ${process.platform} (Linux is the authoritative gate; Windows run is pre-verification only)`)

// ---- (a) version from every cwd ----
for (const [cwd, label] of contexts) {
  const r = runFrom(cwd, ["version"])
  check(r.status === 0 && r.stdout.includes("opencomms "), `(a) version succeeds from ${label}`)
}

// ---- (b) doctor from every cwd (with --project to a known project) ----
for (const [cwd, label] of contexts) {
  const r = runFrom(cwd, ["doctor", "--project", projectDir])
  check(r.status === 0 && r.stdout.includes("OpenComms doctor"), `(b) doctor succeeds from ${label}`)
}

// ---- (c) install opencode must not wrong-path exec install.mjs ----
for (const [cwd, label] of contexts) {
  const r = runFrom(cwd, ["install", "opencode", "--project", projectDir])
  const wrongPathExec = /Unknown command[^\n]*install\.mjs/.test(`${r.stdout}\n${r.stderr}`)
  check(!wrongPathExec, `(c) install opencode does NOT wrong-path exec install.mjs from ${label}`)
  if (r.status !== 0) {
    // Allowed ONLY as a clear early failure (gate-2 option (b)): a short,
    // actionable message, not a stack trace and not a wrong-path exec.
    const output = `${r.stdout}\n${r.stderr}`
    const clearEarlyMessage = output.length < 400 && !/at\s+/.test(output) && !/Error:/.test(output)
    check(clearEarlyMessage, `(c) standalone install failure is a clear early message from ${label}`)
  }
}

// ---- (d) repo-less sandbox: rename-free check via env isolation ----
// The binary must not depend on the SOURCE REPO being present. We cannot
// rename the real repo in CI, so we assert the binary works with cwd set
// anywhere AND with no repo marker in cwd (decoy has no node_modules/dist).
const repoless = mkdtempSync(join(tmpdir(), "ocm-repoless-"))
const r4 = runFrom(repoless, ["version"])
check(r4.status === 0 && r4.stdout.includes("opencomms "), "(d) version succeeds in repo-less sandbox")
const r4b = runFrom(repoless, ["doctor", "--project", projectDir])
check(r4b.status === 0, "(d) doctor succeeds in repo-less sandbox")
rmSync(repoless, { recursive: true, force: true })

// ---- (e) repo-root keeps working (run inside the actual repo) ----
const r5 = runFrom(repoRoot, ["version"])
check(r5.status === 0 && r5.stdout.includes("opencomms "), "(e) version works from repo root")
const r5b = runFrom(repoRoot, ["doctor", "--project", projectDir])
check(r5b.status === 0, "(e) doctor works from repo root")

// ---- 5-location separation: cwd decoy resources must be ignored ----
const r6 = runFrom(projectDir, ["version"])
check(r6.status === 0, "decoy package.json in cwd does not break version (resources resolve from executable)")

// ---- project state at --project (location 4) ----
const stateBefore = existsSync(join(projectDir, ".opencomms", "state.json"))
runFrom(scratch, ["status", "--project", projectDir])
const stateAfter = existsSync(join(projectDir, ".opencomms", "state.json"))
check(stateBefore === stateAfter, "status --project touches only the target project state")

// ---- cleanup + verdict ----
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* best effort */
}
if (failures > 0) {
  console.error(`\nCONTRACT: FAILED (${failures} failures) — Backend's SEA/path fix is incomplete.`)
  process.exit(1)
}
console.log("\nCONTRACT: PASS — binary is cwd-independent with 5-location separation.")
console.log("Built with pinned Node 22.14.0? (verify the builder's pin log before trusting this pass)")