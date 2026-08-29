/**
 * Codex adapter.
 *
 * Verified 2026-08-29 against official docs (developers.openai.com/codex):
 * - MCP client config: [mcp_servers.<name>] in ~/.codex/config.toml or
 *   project .codex/config.toml â€” stdio via { command, args, env }.
 * - Hooks exist (SessionStart/UserPromptSubmit/Stop/...) but are
 *   TRUST-GATED (user must review via /hooks) â€” the installer can only
 *   REGISTER them; first use requires /hooks review by the user.
 * - External injection into a TUI-owned interactive session: NOT documented.
 *   OpenComms does NOT attempt it. MCP tools are PULL.
 *
 * The adapter therefore: registers the MCP server (PULL) + optional hooks
 * file, marks delivery PULL (hook-boundary where the user opts in), and
 * never touches the terminal UI.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

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

  // 1. Copy the MCP server bundle into .opencomms/. Compiled tests resolve
  //    the repo root by package.json (works from dist/ and dist-test/).
  const distMain =
    opts.distMain ??
    (() => {
      let dir = here
      for (;;) {
        if (existsSync(join(dir, "package.json"))) return join(dir, "dist", "mcp", "main.js")
        const parent = dirname(dir)
        if (parent === dir) return join(here, "..", "..", "..", "dist", "mcp", "main.js")
        dir = parent
      }
    })()
  if (!existsSync(distMain)) {
    return {
      ok: false,
      codexDetected: detection.detected,
      codexVersion: detection.version,
      configPath,
      patches: [],
      warnings: ["dist/mcp/main.js missing — run `npm run build` first."],
      capabilities: CODEX_CAPABILITIES,
    }
  }
  const opencommsDir = join(target, ".opencomms")
  mkdirSync(opencommsDir, { recursive: true })
  copyFileSync(distMain, join(opencommsDir, "opencomms-mcp.mjs"))

  // 2. Append/patch the [mcp_servers.opencomms] section (idempotent).
  //    Launch cwd is EXPLICIT (documented `cwd` option; Codex docs do not
  //    guarantee the cwd for project-scope stdio servers), and the project
  //    path is absolute — never rely on relative-path assumptions.
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
  managedThreads: "EXPERIMENTAL (App Server client â€” separate, clearly labeled)",
  roleInjection: "PARTIAL (AGENTS.md global; hooks trust-gated)",
  memberIdentity: "PARTIAL (pinned per-instance env in config.toml)",
}
