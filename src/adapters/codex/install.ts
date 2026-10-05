/** Project-scoped MCP pull registration; interactive TUI injection is not claimed. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve, dirname } from "node:path"
import { readAdapterResource } from "../../cli/adapter-resources.js"

export interface CodexInstallReport {
  ok: boolean
  codexDetected: boolean
  codexVersion: string | null
  configPath: string | null
  patches: string[]
  warnings: string[]
  capabilities: Record<string, string>
}

export function detectCodex(): { detected: boolean; version: string | null } {
  try {
    // Windows: `codex` is typically codex.cmd (needs cmd resolution); running
    // through cmd with the FIXED argument string avoids DEP0190 (Node's
    // shell:true-with-args deprecation) — the command contains no user input.
    if (process.platform === "win32") {
      const out = execFileSync("cmd.exe", ["/d", "/s", "/c", "codex --version"], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      return { detected: true, version: out.trim() }
    }
    const out = execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 15_000 })
    return { detected: true, version: out.trim() }
  } catch {
    return { detected: false, version: null }
  }
}

/**
 * Register the OpenComms MCP server in the project Codex config
 * (.codex/config.toml, trusted-project scope). TOML is edited with a
 * minimal section writer — we never rewrite unrelated sections.
 *
 * opts.distMain: override the server source path (tests). When absent, the
 * repo dist layout is located from the compiled module's package root.
 */
export function installCodex(
  projectDir: string,
  opts: { bundleDir?: string; distMain?: string } = {},
): {
  ok: boolean
  codexDetected: boolean
  codexVersion: string | null
  configPath: string
  patches: string[]
  warnings: string[]
  capabilities: Record<string, string>
} {
  const detection = detectCodex()
  const target = resolve(projectDir)
  const configPath = join(target, ".codex", "config.toml")

  let mcpServer: string
  try {
    mcpServer = readAdapterResource(
      "opencomms-mcp",
      opts.distMain ?? (opts.bundleDir ? join(opts.bundleDir, "mcp", "main.js") : undefined),
    )
  } catch (error) {
    return {
      ok: false,
      codexDetected: detection.detected,
      codexVersion: detection.version,
      configPath,
      patches: [],
      warnings: [(error as Error).message],
      capabilities: CODEX_CAPABILITIES,
    }
  }
  const opencommsDir = join(target, ".opencomms")
  mkdirSync(opencommsDir, { recursive: true })
  writeFileSync(join(opencommsDir, "opencomms-mcp.mjs"), mcpServer, "utf8")

  // Pin cwd and absolute paths; project-scoped MCP launch cwd is not guaranteed.
  let toml = existsSync(configPath) ? readFileSync(configPath, "utf8") : ""
  if (!toml.includes("[mcp_servers.opencomms]")) {
    const absProject = JSON.stringify(target.replace(/\\/g, "/"))
    const block = [
      "",
      "[mcp_servers.opencomms]",
      'command = "node"',
      `args = [${JSON.stringify(join(opencommsDir, "opencomms-mcp.mjs").replace(/\\/g, "/"))}, ${absProject}, "--host", "codex"]`,
      'cwd = "."',
      "",
      "[mcp_servers.opencomms.env]",
      'OPENCOMMS_MEMBER_ID = "<set by: opencomms install-member>"',
      'OPENCOMMS_MEMBER_ROLE = "<role label>"',
      "",
    ].join("\n")
    toml = toml.replace(/\n*$/, "\n") + block
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, toml, "utf8")
  }

  return {
    ok: true,
    codexDetected: detection.detected,
    codexVersion: detection.version,
    configPath,
    patches: ["[mcp_servers.opencomms] registered in .codex/config.toml (idempotent)"],
    warnings: [
      ...(detection.detected
        ? []
        : ["Codex CLI not detected on PATH; files installed anyway. Re-run `opencomms doctor` after installing."]),
      "MCP tools are PULL: Codex invokes opencomms_* tools when the model decides; OpenComms cannot push into a running Codex TUI session (documented).",
      "Codex hooks (optional, trust-gated) require /hooks review on first use — OpenComms registers nothing silently.",
      "Project-scope .codex/config.toml is read only for TRUSTED projects — run /trust, or move the server to ~/.codex/config.toml (user scope), if tools don't appear.",
    ],
    capabilities: CODEX_CAPABILITIES,
  }
}

export const CODEX_CAPABILITIES: Record<string, string> = {
  installation: "PARTIAL (.codex/config.toml MCP registration)",
  delivery: "PULL (MCP tools); hook-boundary possible with user-reviewed hooks",
  existingSessionPush: "UNSUPPORTED (no documented injection into TUI sessions)",
  managedThreads: "UNSUPPORTED (App Server runtime is not implemented in this build)",
  roleInjection: "PARTIAL (AGENTS.md global; hooks trust-gated)",
  memberIdentity: "PARTIAL (pinned per-instance env in config.toml)",
}
