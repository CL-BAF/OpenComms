#!/usr/bin/env node
/** Build all distributable release artifacts in one reproducible step. */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"

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

if (process.platform === "linux") {
  buildLinuxTarball(node, repoRoot, outDir)
}

console.log(`[opencomms-release] executable: ${exe}`)

/**
 * Linux release tarball (M1, Platform): exe + systemd user unit + installer +
 * README + SHA256SUMS. Zero new tooling — plain tar from a staging dir.
 * Layout:
 *   opencomms/opencomms  opencomms/opencomms.service  opencomms/install.sh
 *   opencomms/README-linux.txt  SHA256SUMS
 */
function buildLinuxTarball(node, repoRoot, outDir) {
  const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version
  const staging = resolve(join(tmpdir(), `opencomms-stage-${process.pid}-${Date.now()}`))
  const payloadDir = join(staging, "opencomms")
  mkdirSync(payloadDir, { recursive: true })

  copyFileSync(join(outDir, "opencomms"), join(payloadDir, "opencomms"))
  // copyFileSync does NOT preserve the exec bit: without chmod, the staged
  // exe and installer land 644 and the smoke test's direct exec (and real
  // users running ./opencomms/install.sh) gets EACCES. Windows releases are
  // unaffected (Inno Setup ACLs differ); this is tarball-layout specific.
  chmodSync(join(payloadDir, "opencomms"), 0o755)
  const unitSource = join(repoRoot, "installer", "linux", "opencomms.service")
  if (!existsSync(unitSource)) throw new Error("Missing installer/linux/opencomms.service (unit template)")
  copyFileSync(unitSource, join(payloadDir, "opencomms.service"))
  const installShSource = join(repoRoot, "scripts", "install.sh")
  if (!existsSync(installShSource)) throw new Error("Missing scripts/install.sh (Linux installer)")
  copyFileSync(installShSource, join(payloadDir, "install.sh"))
  chmodSync(join(payloadDir, "install.sh"), 0o755)
  writeFileSync(join(payloadDir, "README-linux.txt"), readmeLinux(version), "utf8")

  // Keyed by basename (Lead FIX 1) — no fragile index lookups.
  const payloadFiles = ["opencomms", "opencomms.service", "install.sh", "README-linux.txt"]
  const sums = payloadFiles
    .map((base) => {
      const file = join(payloadDir, base)
      return `${createHash("sha256").update(readFileSync(file)).digest("hex")}  opencomms/${base}`
    })
    .join("\n")
  writeFileSync(join(staging, "SHA256SUMS"), `${sums}\n`, "utf8")

  const tarball = join(outDir, `opencomms-linux-${version}.tar.gz`)
  execFileSync("tar", ["-czf", tarball, "-C", staging, "opencomms"], { cwd: repoRoot, stdio: "inherit" })
  const tarChecksum = createHash("sha256").update(readFileSync(tarball)).digest("hex")
  writeFileSync(join(outDir, `${tarball.split(/[\\/]/).pop()}.sha256`), `${tarChecksum}  ${tarball.split(/[\\/]/).pop()}\n`, "utf8")
  console.log(`[opencomms-release] linux tarball: ${tarball}`)
}

function readmeLinux(version) {
  return `OpenComms ${version} — Linux server release (tarball)

Contents:
  opencomms/opencomms           standalone executable (Node SEA, no Node.js needed)
  opencomms/opencomms.service   systemd USER unit template (@BIN@/@PROJECT_DIR@ placeholders)
  opencomms/install.sh          installer (binary, unit, PATH note; prints
                                systemctl/linger instructions, never runs them)
  opencomms/README-linux.txt    this file

Quick start (no root required):
  tar -xzf opencomms-linux-*.tar.gz
  opencomms/opencomms doctor                      # verify it runs
  opencomms/opencomms gui --project /path --server --no-open

Headless service (recommended on servers):
  ./opencomms/install.sh --exe /abs/path/opencomms \\
    --project /path/to/project --service
Then (printed by install.sh, never auto-run):
  systemctl --user daemon-reload
  systemctl --user enable --now opencomms
  loginctl enable-linger \$USER     # optional: run the service before login

Uninstall:
  ./opencomms/install.sh --uninstall   # prints systemctl/linger instructions first

Headless daemon = \`opencomms gui --server --no-open\` (loopback-only, never
network-exposed). Verify with \`opencomms doctor\`.

Secrets: this release writes no secrets anywhere; pairing tokens and API
keys are an M2+ concern (OS keyring first, encrypted-file fallback).

Verify checksums:   sha256sum -c SHA256SUMS   (from the extraction dir)
`
}
