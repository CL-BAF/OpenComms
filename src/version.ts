/**
 * Package version shared by CLI, GUI diagnostics, and release metadata.
 *
 * SEA path architecture (docs/adr-sea-path-resolution.md): resolution order
 * is (1) OPENCOMMS_VERSION env stamp (release builds), (2) development repo
 * package.json via the module anchor, (3) static fallback pinned to the
 * package version at build time. CWD is NEVER consulted — `opencomms
 * version` works identically from /, $HOME, /tmp, or a project dir.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { findSourceRepoRoot } from "./cli/paths.js"

/** Static fallback mirrors package.json; bumped only when package.json is. */
const FALLBACK_VERSION = "1.1.0"

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
