/**
 * Version resolution: release environment stamp, anchored package.json, static
 * fallback. CWD is never a resource anchor.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { findSourceRepoRoot } from "./cli/paths.js"
import { FALLBACK_VERSION } from "./version-constants.js"

export const VERSION: string = (() => {
  const stamped = process.env["OPENCOMMS_VERSION"]?.trim()
  if (stamped) return stamped
  // ESM dist (node): import.meta.dirname is available; CJS SEA bundle: it
  // is not — no repo lookup is attempted there (the exe is self-contained).
  try {
    const anchor = import.meta.dirname ?? null
    const repo = findSourceRepoRoot(anchor)
    if (repo) {
      const parsed = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version?: unknown }
      if (typeof parsed.version === "string" && parsed.version) return parsed.version
    }
  } catch {
    /* fall through */
  }
  return FALLBACK_VERSION
})()
