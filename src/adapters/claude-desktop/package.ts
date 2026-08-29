/**
 * Claude Desktop adapter â€” Desktop Extension (.mcpb) packaging + install.
 *
 * Verified 2026-08-29 against official sources (see docs/CLAUDE_DESKTOP.md):
 * - .mcpb = ZIP containing manifest.json (spec v0.3) + server code
 *   (github.com/modelcontextprotocol/mcpb).
 * - Claude Desktop spawns the server per mcp_config over stdio; user_config
 *   values substitute as ${user_config.KEY}; sensitive values go to the OS
 *   keychain.
 * - Delivery is STRICTLY PULL: no conversation identity, no push, no
 *   lifecycle. The model/user must call tools for anything to happen.
 *
 * The adapter therefore:
 *   - registers PULL members (stale_policy "none": messages survive until read),
 *   - exposes only non-privileged tools by default (no kick),
 *   - never claims push/role injection/lifecycle.
 */

import { existsSync, mkdirSync, copyFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Locate the repo/package root robustly: the nearest ancestor (including
 * this module's dir) containing package.json. Works identically whether
 * this module runs from src/, dist/, or dist-test/.
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return startDir // filesystem root; give up
    dir = parent
  }
}

const packageRoot = findPackageRoot(here)

export interface DesktopPackageResult {
  ok: boolean
  /** Directory laid out in MCPB format (zip with `mcpb pack` to ship). */
  bundleDir: string | null
  manifestValid: boolean
  warnings: string[]
  capabilities: Record<string, string>
}

const REQUIRED_MANIFEST_FIELDS = ["manifest_version", "name", "version", "description", "author", "server"] as const

/** Validate the Desktop extension manifest (MCPB spec v0.3 essentials). */
export function validateDesktopManifest(manifestPath: string): { ok: true } | { ok: false; reason: string } {
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: `manifest not found: ${manifestPath}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    return { ok: false, reason: `manifest JSON invalid: ${(error as Error).message}` }
  }
  if (!isRecord(parsed)) return { ok: false, reason: "manifest root is not an object" }
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!(field in parsed)) return { ok: false, reason: `manifest missing "${field}"` }
  }
  const server = parsed["server"]
  if (!isRecord(server) || !isRecord(server["mcp_config"])) {
    return { ok: false, reason: "manifest.server.mcp_config missing" }
  }
  const mcpConfig = server["mcp_config"] as Record<string, unknown>
  if (typeof mcpConfig["command"] !== "string") {
    return { ok: false, reason: "manifest.server.mcp_config.command missing" }
  }
  return { ok: true }
}

/**
 * Lay out the .mcpb bundle contents for the Desktop adapter:
 *   <outDir>/manifest.json
 *   <outDir>/server/main.mjs        (SELF-CONTAINED esbuild bundle — the
 *                                    un-bundled dist/mcp/main.js imports
 *                                    relative modules that don't ship)
 * Package with the official CLI: npx @anthropic-ai/mcpb pack <bundleDir>.
 */
export function buildDesktopBundle(opts: { projectDir: string; outDir?: string }): DesktopPackageResult {
  // Manifest lookup order: repo source (src layout), the compiled sibling
  // copy (dist layout), and up from compiled test trees. All point at the
  // same source-managed file; first existing wins.
  const candidates = [
    join(here, "manifest.json"),
    resolve(here, "..", "..", "..", "adapters", "claude-desktop", "manifest.json"),
    resolve(here, "..", "..", "..", "..", "adapters", "claude-desktop", "manifest.json"),
    resolve(here, "..", "..", "..", "..", "..", "adapters", "claude-desktop", "manifest.json"),
  ]
  const manifestPath = candidates.find((p) => existsSync(p))
  if (!manifestPath) {
    return {
      ok: false,
      bundleDir: null,
      manifestValid: false,
      warnings: [`manifest.json not found in any known location (tried: ${candidates.join(", ")})`],
      capabilities: DESKTOP_CAPABILITIES,
    }
  }
  const check = validateDesktopManifest(manifestPath)
  if (!check.ok) {
    return {
      ok: false,
      bundleDir: null,
      manifestValid: false,
      warnings: [check.reason],
      capabilities: DESKTOP_CAPABILITIES,
    }
  }

  const bundleDir = resolve(opts.outDir ?? join(opts.projectDir, "opencomms-claude-desktop"))
  mkdirSync(bundleDir, { recursive: true })
  copyFileSync(manifestPath, join(bundleDir, "manifest.json"))

  // The MCP server must be SELF-CONTAINED: the plain dist output imports
  // relative modules (../core/*) that a .mcpb zip does not carry. Produce a
  // single-file esbuild bundle at packaging time (no extra deps; esbuild is
  // already a devDependency).
  const serverDir = join(bundleDir, "server")
  mkdirSync(serverDir, { recursive: true })
  let bundled = false
  try {
    const esbuildBin = join(packageRoot, "node_modules", "esbuild", "bin", "esbuild")
    const mainSource = join(packageRoot, "src", "mcp", "main.ts")
    execFileSync(
      process.execPath,
      [
        esbuildBin,
        mainSource,
        "--bundle",
        "--format=esm",
        "--platform=node",
        `--outfile=${join(serverDir, "main.mjs")}`,
        "--log-level=warning",
      ],
      { stdio: "pipe", timeout: 120_000 },
    )
    bundled = existsSync(join(serverDir, "main.mjs"))
  } catch (error) {
    return {
      ok: false,
      manifestValid: true,
      bundleDir,
      warnings: [`Failed to produce the self-contained server bundle: ${(error as Error).message}`],
      capabilities: DESKTOP_CAPABILITIES,
    }
  }
  if (!bundled) {
    return {
      ok: false,
      manifestValid: true,
      bundleDir,
      warnings: ["Server bundle missing after esbuild run — check esbuild availability."],
      capabilities: DESKTOP_CAPABILITIES,
    }
  }

  return {
    ok: true,
    manifestValid: check.ok,
    bundleDir,
    warnings: [
      "Manifest + server laid out. Produce the installable with the official CLI: `npm i -g @anthropic-ai/mcpb && mcpb pack <bundleDir>` (see docs/CLAUDE_DESKTOP.md).",
    ],
    capabilities: DESKTOP_CAPABILITIES,
  }
}

/** Honest capability report for the Desktop adapter (no fake push). */
export const DESKTOP_CAPABILITIES: Record<string, string> = {
  installation: "PARTIAL (.mcpb bundle; install via Claude Desktop > Settings > Extensions)",
  delivery: "PULL ONLY (model/user invokes opencomms_inbox; no push into conversations)",
  sessionIdentity: "UNSUPPORTED (Claude Desktop exposes no conversation id to MCP servers)",
  existingConversationPush: "UNSUPPORTED (documented)",
  roleInjection: "UNSUPPORTED (paste role instructions into the conversation)",
  lifecycle: "UNSUPPORTED",
  memberIdentity: "PARTIAL (pinned per-instance env; machine-local, not cryptographic)",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
