/**
 * Resolve executable, bundled resources and development checkout separately.
 * CWD supplies only the default target project; SEA never requires a checkout.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { FALLBACK_VERSION } from "../version-constants.js"

export type RuntimeMode = "sea-exe" | "node-source" | "unknown"

export function runtimeMode(isSeaFn?: () => boolean): RuntimeMode {
  if (isSeaFn) return isSeaFn() ? "sea-exe" : "node-source"
  return "unknown"
}

/** Return the checkout ancestor or null; callers must never substitute CWD. */
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

/** Resolution records its anchor; missing files retain an actionable candidate path. */
export interface ResourceResolution {
  path: string | null
  /** How the path was resolved (for honest diagnostics + tests). */
  basis: "sea-asset" | "sea-beside-exe" | "repo" | "module" | "missing"
}

/** Resolve from the executable for SEA or an anchored checkout for development; never CWD. */
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

/** Version precedence: environment, anchored package.json, SEA VERSION file, static fallback. */
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
  return FALLBACK_VERSION
}

/** Report the plugin bundle path; SEA installation reads its embedded asset instead. */
export function pluginBundlePath(opts: {
  sea: boolean
  execPath: string
  anchorDir: string | null
}): ResourceResolution {
  return resolvePackagedResource(["dist", "plugin.bundled.js"], opts)
}
