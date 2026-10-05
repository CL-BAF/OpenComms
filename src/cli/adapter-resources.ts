/** Standalone host adapters are embedded in SEA builds and shipped in npm dist. */
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { isSea, getAsset } from "node:sea"
import { fileURLToPath } from "node:url"
import { resolvePackagedResource } from "./paths.js"

export type AdapterResource = "opencomms-mcp" | "claude-hook" | "gemini-hook" | "claude-desktop-manifest"
const paths: Record<AdapterResource, string[]> = {
  "opencomms-mcp": ["dist", "mcp", "main.js"],
  "claude-hook": ["dist", "adapters", "claude-code", "hook-cli.js"],
  "gemini-hook": ["dist", "adapters", "gemini-cli", "hook-cli.js"],
  "claude-desktop-manifest": ["dist", "adapters", "claude-desktop", "manifest.json"],
}

/** Explicit paths are test/packaging overrides; SEA never searches the caller's cwd. */
export function readAdapterResource(resource: AdapterResource, sourcePath?: string): string {
  if (sourcePath) return readFileSync(sourcePath, "utf8")
  if (isSea()) {
    try {
      return getAsset(resource, "utf8")
    } catch {
      throw new Error(`Standalone OpenComms executable is missing the ${resource} adapter asset; reinstall this build.`)
    }
  }
  let anchorDir: string | null = null
  try {
    anchorDir = dirname(fileURLToPath(import.meta.url))
  } catch {
    // Bundled CommonJS has no import.meta. Only SEA assets or a deliberate
    // explicit source path are valid there; cwd belongs to the target project.
  }
  const found = resolvePackagedResource(paths[resource], { sea: false, execPath: process.execPath, anchorDir })
  if (!found.path) throw new Error(`Built ${resource} adapter is missing; run npm run build or reinstall OpenComms.`)
  return readFileSync(found.path, "utf8")
}
