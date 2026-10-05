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

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { readAdapterResource } from "../../cli/adapter-resources.js"

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
  return validateManifestContent(readFileSync(manifestPath, "utf8"))
}

function validateManifestContent(content: string): { ok: true } | { ok: false; reason: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
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
  let manifest: string
  let server: string
  try {
    manifest = readAdapterResource("claude-desktop-manifest")
    server = readAdapterResource("opencomms-mcp")
  } catch (error) {
    return {
      ok: false,
      bundleDir: null,
      manifestValid: false,
      warnings: [(error as Error).message],
      capabilities: DESKTOP_CAPABILITIES,
    }
  }
  const check = validateManifestContent(manifest)
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
  writeFileSync(join(bundleDir, "manifest.json"), manifest, "utf8")

  // The published/embedded bundle is already self-contained. Installation
  // requires neither a source checkout nor build-time dependencies.
  const serverDir = join(bundleDir, "server")
  mkdirSync(serverDir, { recursive: true })
  writeFileSync(join(serverDir, "main.mjs"), server, "utf8")

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
