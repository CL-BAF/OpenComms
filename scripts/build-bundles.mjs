#!/usr/bin/env node
// Installed adapters are copied outside the package module tree. Each must
// therefore carry its own code, rather than importing absent ../core files.
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { copyFileSync, mkdirSync } from "node:fs"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
for (const [entry, outfile] of [
  ["src/plugin.ts", "dist/plugin.bundled.js"],
  ["src/mcp/main.ts", "dist/mcp/main.js"],
  ["src/adapters/claude-code/hook-cli.ts", "dist/adapters/claude-code/hook-cli.js"],
  ["src/adapters/gemini-cli/hook-cli.ts", "dist/adapters/gemini-cli/hook-cli.js"],
]) {
  execFileSync(
    process.execPath,
    [join(root, "scripts/bundle.mjs"), "--entry", entry, "--format", "esm", "--outfile", outfile],
    {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    },
  )
}
mkdirSync(join(root, "dist/adapters/claude-desktop"), { recursive: true })
copyFileSync(
  join(root, "adapters/claude-desktop/manifest.json"),
  join(root, "dist/adapters/claude-desktop/manifest.json"),
)
