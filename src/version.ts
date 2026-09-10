import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Package version shared by CLI, GUI diagnostics, and release metadata. */
export const VERSION: string = (() => {
  try {
    let dir = import.meta.dirname ?? process.cwd()
    for (;;) {
      const candidate = join(dir, "package.json")
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown }
        if (typeof parsed.version === "string" && parsed.version) return parsed.version
      }
      const parent = dirname(dir)
      // SEA bundles do not ship package.json or import.meta.dirname. Keep a
      // release-safe fallback so `opencomms version` never reports 0.0.0.
      if (parent === dir) return "1.1.0"
      dir = parent
    }
  } catch {
    return "1.1.0"
  }
})()
