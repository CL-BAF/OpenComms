/**
 * Runtime path architecture (SEA fix, 2026-09-11; see docs/adr-sea-path-resolution.md).
 *
 * FIVE locations a CLI process can care about — NEVER conflated again:
 *   1. Executable location  — process.execPath (the SEA exe itself, or node).
 *   2. Packaged resources   — files shipped INSIDE/with the exe (SEA assets,
 *      embedded bundles). Under SEA these are part of the binary; there is
 *      no on-disk resource dir to "find".
 *   3. Source-repo location — the checkout with package.json (DEVELOPMENT
 *      ONLY). The packaged exe must never require it.
 *   4. Target project dir   — the user project a command operates on
 *      (--project flag, or CWD as the documented default for project
 *      commands like status/install).
 *   5. CWD                  — where the user happens to run the exe. Affects
 *      ONLY (4)'s default. Never used for resource/executable resolution.
 *
 * Why this module exists (reproduced field failure, Debian 13): the CJS SEA
 * bundle has NO import.meta, so the old repoRootForCli() fell back to CWD
 * and `opencomms version` from /tmp resolved `<cwd>/opencomms` -> ENOENT,
 * and `install opencode` misparsed a repo-relative install.mjs path as a
 * subcommand. In SEA the binary IS the resource (plugins are embedded);
 * in development (node dist/cli/main.js) import.meta still works. The
 * resolution below is platform-neutral (win32 POSIX identical).
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type RuntimeMode = "sea-exe" | "node-source" | "unknown"

/**
 * Detect the runtime mode. `isSea` import is lazy/optional so tests can call
 * these helpers on plain node without the SEA flag present.
 */
export function runtimeMode(isSeaFn?: () => boolean): RuntimeMode {
  if (isSeaFn) return isSeaFn() ? "sea-exe" : "node-source"
  return "unknown"
}

/**
 * Locate the SOURCE-REPO root (package.json ancestor), starting from a
 * caller-supplied anchor. Returns null when there is no repo (packaged exe,
 * bare filesystem) — callers MUST treat that as "not available" instead of
 * falling back to CWD.
 */
export function findSourceRepoRoot(anchorDir: string | null): string | null {
  let dir = anchorDir
  while (dir) {
    if (existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Resolve a BUNDLED RESOURCE (a file that ships inside the package: the
 * opencode plugin bundle, manifest templates, etc.).
 *
 *   - sea-exe:  the resource is embedded (assets) or sits beside the exe;
 *     resolution anchors on the EXECUTABLE's directory (never CWD).
 *   - node:     anchors on this module's location via import.meta (available
 *     in the ESM dist; tests inject anchorDir to stay environment-free).
 *
 * The caller passes `sea` (whether we're running as the packaged exe) and an
 * anchorDir (its best local anchor). We return the first EXISTING path among
 * the candidate list, or the first candidate when none exists (so callers
 * produce actionable "missing resource" errors rather than path puzzles).
 */
export interface ResourceResolution {
  path: string | null
  /** How the path was resolved (for honest diagnostics + tests). */
  basis: "sea-asset" | "sea-beside-exe" | "repo" | "module" | "missing"
}

/**
 * Resolve a relative resource path against, in order:
 *   1. SEA: the executable's directory (dirname(process.execPath)) — the
 *      installer layout ships resources beside the exe (README, etc.).
 *   2. Development: the nearest package.json ancestor of the anchor (the
 *      repo root), where dist/ lives.
 * When `sea` is true, (2) is skipped entirely — the repo MUST NOT be
 * required; when no candidate exists the resolution reports "missing" with
 * the exe-relative candidate so error messages stay actionable.
 */
export function resolvePackagedResource(
  relativeResource: string[],
  opts: { sea: boolean; execPath: string; anchorDir: string | null },
): ResourceResolution {
  const exeDir = dirname(opts.execPath)
  if (opts.sea) {
    const beside = join(exeDir, ...relativeResource)
    if (existsSync(beside)) return { path: beside, basis: "sea-beside-exe" }
    return { path: null, basis: "missing" }
  }
  const repo = findSourceRepoRoot(opts.anchorDir)
  if (repo) {
    const candidate = join(repo, ...relativeResource)
    if (existsSync(candidate)) return { path: candidate, basis: "repo" }
    return { path: null, basis: "missing" }
  }
  const beside = join(exeDir, ...relativeResource)
  if (existsSync(beside)) return { path: beside, basis: "sea-beside-exe" }
  return { path: null, basis: "missing" }
}

/**
 * Version string resolution (src/version.ts). Order:
 *   1. OPENCOMMS_VERSION env (release builds stamp it deterministically).
 *   2. Development: nearest package.json ancestor (repo checkout).
 *   3. SEA: embedded build stamp — the exe build script writes the version
 *      beside the binary (VERSION file) at package time; read it.
 *   4. Static fallback (never 0.0.0; mirrors package.json at build time).
 * CWD is never consulted.
 */
export function resolveVersion(opts: {
  sea: boolean
  execPath: string
  anchorDir: string | null
  env?: Record<string, string | undefined>
  embeddedVersion?: string
}): string {
  const envVersion = opts.env?.["OPENCOMMS_VERSION"]?.trim()
  if (envVersion) return envVersion
  const repo = findSourceRepoRoot(opts.anchorDir)
  if (repo) {
    try {
      const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version?: unknown }
      if (typeof pkg.version === "string" && pkg.version) return pkg.version
    } catch {
      /* fall through */
    }
  }
  if (opts.embeddedVersion) return opts.embeddedVersion
  const exeDir = dirname(opts.execPath)
  try {
    const stamped = readFileSync(join(exeDir, "VERSION"), "utf8").trim()
    if (stamped) return stamped
  } catch {
    /* fall through */
  }
  return "1.1.0"
}

/**
 * The opencode PLUGIN resource (bundled plugin.js) location:
 *   - sea-exe:  embedded in the bundle itself (the installer copies the
 *     embedded asset), so the caller passes the ASSET CONTENTS through; this
 *     helper only reports WHERE a beside-exe copy would live.
 *   - node:     <repo>/dist/plugin.bundled.js.
 */
export function pluginBundlePath(opts: {
  sea: boolean
  execPath: string
  anchorDir: string | null
}): ResourceResolution {
  return resolvePackagedResource(["dist", "plugin.bundled.js"], opts)
}
