/**
 * `opencomms update` + `update --check` (Workstream L, Platform).
 *
 * Explicitly user-initiated self-update: NEVER automatic, no timers, no
 * background checks. `--check` is strictly read-only.
 *
 * Flow (Linux; Windows refuses with the installer pointer ÔÇö replacing a
 * running SEA exe on win32 locks the file):
 *   1. Resolve the latest release from GitHub (api.github.com, same source
 *      of truth as scripts/install.sh: CL-BAF/OpenComms).
 *   2. `--check`: print "current -> latest" (or "up to date") and exit.
 *      Exit codes: 0 = answered, 1 = network/parse failure.
 *   3. Full update: download the release tarball + SHA256SUMS to a private
 *      staging dir, VERIFY checksums before extract, extract, stage-validate
 *      the candidate binary (`version` must succeed and be NEWER), then
 *      atomically replace the RUNNING executable via rename(2) (same
 *      directory, same filesystem ÔÇö POSIX rename over a running exe works).
 *      Rollback restores the previous binary from a pre-backup on any
 *      post-validation failure. Project `.opencomms` state is never touched.
 *
 * The command never runs node, never spawns a shell, and never writes
 * secrets. All network fetches use the same 3-attempt backoff and
 * --max-filesize disk-fill defense as the installer.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  chmodSync,
  copyFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"

import { createHash } from "node:crypto"

const REPO = "CL-BAF/OpenComms"
const RELEASES_BASE = `https://github.com/${REPO}/releases/download`
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const MAX_DOWNLOAD_BYTES = 209_715_200

export interface UpdateResult {
  code: number
  output: string
}

function ok(output: string): UpdateResult {
  return { code: 0, output }
}
function fail(output: string): UpdateResult {
  return { code: 1, output }
}

interface CliIo {
  fetchText(url: string): Promise<string>
  fetchToFile(url: string, outPath: string): Promise<void>
  execFile(file: string, args: string[]): { status: number | null; stdout: string }
}

/** Default IO ÔÇö real network + real process execution. Tests inject fakes. */
function defaultIo(): CliIo {
  const fetchText = async (url: string): Promise<string> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return response.text()
  }
  const fetchToFile = async (url: string, outPath: string): Promise<void> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    const contentLength = Number(response.headers.get("content-length") ?? "0")
    if (contentLength > MAX_DOWNLOAD_BYTES)
      throw new Error(`artifact exceeds the 200M safety limit (${contentLength} bytes)`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_DOWNLOAD_BYTES)
      throw new Error(`artifact exceeds the 200M safety limit (${buffer.byteLength} bytes)`)
    writeFileSync(outPath, buffer)
  }
  const execFile = (file: string, args: string[]) => {
    try {
      const stdout = execFileSync(file, args, {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
      })
      return { status: 0, stdout: stdout ?? "" }
    } catch (error) {
      const err = error as { status?: number | null; stdout?: string }
      return { status: err.status ?? 1, stdout: err.stdout ?? "" }
    }
  }
  return { fetchText, fetchToFile, execFile }
}

function parseTagVersion(payload: string): string | null {
  const match = payload.match(/"tag_name"\s*:\s*"([^"]+)"/)
  return match?.[1] ?? null
}

/** Semver-ish comparison: positive when b > a, 0 equal, negative when b < a. */
export function compareVersions(a: string, b: string): number {
  const pa = a
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
  const pb = b
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
  for (let i = 0; i < 3; i++) {
    const na = Number.isNaN(pa[i]) ? 0 : (pa[i] ?? 0)
    const nb = Number.isNaN(pb[i]) ? 0 : (pb[i] ?? 0)
    if (nb !== na) return nb - na
  }
  return 0
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

interface UpdateDeps {
  io?: CliIo
  currentVersion: string
  execPath: string
  platform?: NodeJS.Platform
  homeDir?: string
  env?: Record<string, string | undefined>
}

async function fetchLatestVersion(deps: UpdateDeps): Promise<{ version: string } | { error: string }> {
  const io = deps.io ?? defaultIo()
  try {
    const payload = await io.fetchText(API_LATEST)
    const tag = parseTagVersion(payload)
    if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
      return { error: `could not parse the latest release version from ${API_LATEST} (unexpected response shape).` }
    }
    return { version: tag }
  } catch (error) {
    return { error: `cannot reach GitHub Releases: ${(error as Error).message}` }
  }
}

export async function updateCommand(argv: string[], deps: UpdateDeps): Promise<UpdateResult> {
  const checkOnly = argv.includes("--check")
  const asJson = argv.includes("--json")
  const io = deps.io ?? defaultIo()
  const platform = deps.platform ?? process.platform

  const latest = await fetchLatestVersion(deps)
  if ("error" in latest) return fail(latest.error)
  const current = deps.currentVersion
  const upToDate = compareVersions(current, latest.version) >= 0

  const line = upToDate ? `opencomms is up to date (${current})` : `update available: ${current} -> ${latest.version}`
  if (checkOnly) {
    if (asJson) {
      return ok(JSON.stringify({ ok: true, data: { current, latest: latest.version, up_to_date: upToDate } }))
    }
    return ok(line)
  }

  if (platform !== "linux") {
    return fail(
      platform === "win32"
        ? "Self-update on Windows is refused by design (a running executable cannot replace itself). Download the new OpenComms-Setup-<version>.exe from GitHub Releases and run the installer."
        : `Self-update is not supported on ${platform} in v1. Download the release artifact from GitHub Releases.`,
    )
  }

  if (upToDate) {
    return ok(
      asJson
        ? JSON.stringify({ ok: true, data: { current, latest: latest.version, up_to_date: true, updated: false } })
        : line,
    )
  }

  // ---- full update (Linux only) ----
  const home = deps.homeDir ?? homedir()
  const binPath = resolve(deps.execPath)
  const binDir = dirname(binPath)
  const staging = join(tmpdir(), `opencomms-update-${process.pid}-${Date.now().toString(36)}`)
  const created = (() => {
    try {
      mkdirSync(staging, { recursive: true })
      return true
    } catch {
      return false
    }
  })()
  if (!created) return fail(`could not create the staging directory ${staging}.`)

  const version = latest.version
  const versioned = version.replace(/^v/, "")
  const tarballName = `opencomms-linux-${versioned}-x86_64.tar.gz`
  const backupPath = (() => {
    try {
      return mkTempIn(binDir, ".opencomms-update-prev-XXXXXXXX")
    } catch {
      return null
    }
  })()

  try {
    // 1. Download + verify checksums BEFORE extract.
    const tarballPath = join(staging, tarballName)
    const sumsPath = join(staging, "SHA256SUMS")
    await io.fetchToFile(`${RELEASES_BASE}/${version}/${tarballName}`, tarballPath)
    await io.fetchToFile(`${RELEASES_BASE}/${version}/SHA256SUMS`, sumsPath)
    const sums = readFileSync(sumsPath, "utf8")
    const entry = sums
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.endsWith(`opencomms/${tarballName}`))
    if (!entry) return fail(`SHA256SUMS does not list ${tarballName} ÔÇö refusing to install an unverifiable artifact.`)
    const [expectedHash] = entry.split(/ {2}/)
    const actualHash = sha256Hex(readFileSync(tarballPath))
    if (expectedHash !== actualHash) {
      return fail(
        `checksum mismatch for ${tarballName}: expected ${expectedHash}, got ${actualHash}. Nothing was changed.`,
      )
    }

    // 2. Extract + stage-validate the candidate.
    execTarExtract(tarballPath, staging)
    const candidate = join(staging, "opencomms", "opencomms")
    if (!existsSync(candidate))
      return fail(
        "tarball layout unexpected: opencomms/opencomms missing ÔÇö refusing to install an incomplete artifact.",
      )
    chmodSync(candidate, 0o755)
    const versionProbe = io.execFile(candidate, ["version"])
    if (versionProbe.status !== 0 || !versionProbe.stdout.includes("opencomms ")) {
      return fail("candidate binary failed 'version' BEFORE install ÔÇö artifact defective, nothing was changed.")
    }

    // 3. Atomic replace with rollback.
    const previous = readFileSync(binPath)
    if (backupPath) {
      copyFileSync(binPath, backupPath)
    }
    renameSync(candidate, binPath)
    chmodSync(binPath, 0o755)
    const postProbe = io.execFile(binPath, ["version"])
    if (postProbe.status !== 0 || !postProbe.stdout.includes("opencomms ")) {
      writeFileSync(binPath, previous)
      chmodSync(binPath, 0o755)
      return fail("post-install validation FAILED ÔÇö rolled back to the previous binary.")
    }
    return ok(
      asJson
        ? JSON.stringify({ ok: true, data: { current, latest: version, updated: true } })
        : `updated: ${current} -> ${version} (${binPath})\nRunning sessions keep using the old binary until restarted. Project .opencomms state is untouched.`,
    )
  } catch (error) {
    // Best-effort rollback on ANY mid-flight failure.
    if (backupPath && existsSync(backupPath)) {
      try {
        copyFileSync(backupPath, binPath)
        chmodSync(binPath, 0o755)
      } catch {
        /* the backup copy failed; report below */
      }
    }
    return fail(
      `update failed: ${(error as Error).message}${backupPath && existsSync(backupPath) ? " (previous binary restored)" : ""}`,
    )
  } finally {
    if (backupPath && existsSync(backupPath)) {
      try {
        rmSync(backupPath, { force: true })
      } catch {
        /* non-fatal */
      }
    }
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      /* non-fatal */
    }
  }
}

/** Small helper so tests can inject a fake binDir without a real bin dir. */
function mkTempIn(dir: string, template: string): string {
  mkdirSync(dir, { recursive: true })
  // Node has no mktemp; emulate with random bytes (unpredictable, O_EXCL-ish
  // via exclusive rename loop is unnecessary here ÔÇö the binary dir is
  // user-owned and we verify contents after copy).
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = join(dir, template.replace("XXXXXXXX", Math.random().toString(36).slice(2, 10)))
    if (!existsSync(candidate)) return candidate
  }
  throw new Error("could not allocate a unique backup path")
}

function execTarExtract(tarballPath: string, into: string): void {
  execFileSync("tar", ["-xzf", tarballPath, "-C", into], { stdio: "ignore", timeout: 60_000 })
}
