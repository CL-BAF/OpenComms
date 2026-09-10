/**
 * Claude Code installer (shared CLI stage 9 uses this module).
 *
 * What it does (idempotent, clobber-free):
 *   1. Verifies Claude Code is installed (claude --version).
 *   2. Copies the bundled hook runner + MCP server into <project>/.opencomms/.
 *   3. Registers hooks + the OpenComms MCP server in project settings
 *      (.claude/settings.json) MERGING with existing config â€” never
 *      overwriting unrelated keys (Reviewer: "no unrelated-config clobbering").
 *   4. Registers the MCP server in .mcp.json (project scope) with a pinned
 *      member env placeholder.
 *   5. Reports capabilities honestly (hook-boundary delivery, no mid-turn push).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"
import { saveMemberPin, listMemberPins, isValidMemberId } from "../../mcp/identity.js"

const __dirname2 = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return process.cwd()
  }
})()

export interface ClaudeCodeInstallReport {
  ok: boolean
  claudeDetected: boolean
  claudeVersion: string | null
  filesInstalled: string[]
  configPatches: string[]
  warnings: string[]
  capabilities: Record<string, string>
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Could not parse existing ${path} (${(error as Error).message}). Back it up, then re-run.`)
  }
}

function writeJsonStable(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

export function detectClaudeCode(): { detected: boolean; version: string | null } {
  try {
    const out = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      shell: process.platform === "win32",
    })
    return { detected: true, version: out.trim() }
  } catch {
    return { detected: false, version: null }
  }
}

/** Merge our hook commands into an existing hooks config (idempotent). */
function mergeHookEntry(hooks: Record<string, unknown>, event: string, command: string): { changed: boolean } {
  const entries = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
  const already = entries.some((entry) => JSON.stringify(entry).includes("claude-code-hooks.mjs"))
  if (already) return { changed: false }
  hooks[event] = [
    ...entries,
    {
      hooks: [
        {
          type: "command",
          command,
          timeout: 15,
        },
      ],
    },
  ]
  return { changed: true }
}

export function installClaudeCode(projectDir: string, opts: { bundleDir?: string } = {}): ClaudeCodeInstallReport {
  const report: ClaudeCodeInstallReport = {
    ok: true,
    claudeDetected: false,
    claudeVersion: null,
    filesInstalled: [],
    configPatches: [],
    warnings: [],
    capabilities: {
      delivery: "hook-boundary (SessionStart / UserPromptSubmit / Stop)",
      pullInbox: "SUPPORTED (MCP tools)",
      roleInjection: "hook-boundary",
      existingSessionLinking: "PARTIAL",
      pushIntoRunningSession: "UNSUPPORTED (documented)",
    },
  }

  const detection = detectClaudeCode()
  report.claudeDetected = detection.detected
  report.claudeVersion = detection.version
  if (!detection.detected) {
    report.warnings.push(
      "Claude Code CLI not detected on PATH. Files were still installed; install Claude Code and re-run `opencomms doctor`.",
    )
  }

  const target = resolve(projectDir)
  const opencommsDir = join(target, ".opencomms")
  mkdirSync(opencommsDir, { recursive: true })

  // 1. Bundle dir: resolve the package root by package.json (works from
  //    src/, dist/, and dist-test/) and use its dist/; caller can override.
  const bundleDir =
    opts.bundleDir ??
    (() => {
      let dir = __dirname2
      for (;;) {
        if (existsSync(join(dir, "package.json"))) return join(dir, "dist")
        const parent = dirname(dir)
        if (parent === dir) return join(__dirname2, "..", "..", "..", "dist")
        dir = parent
      }
    })()
  const hookRunner = join(bundleDir, "adapters", "claude-code", "hook-cli.js")
  const mcpServer = join(bundleDir, "mcp", "main.js")
  if (!existsSync(hookRunner) || !existsSync(mcpServer)) {
    report.ok = false
    report.warnings.push(
      "Built adapter files missing (dist/adapters/claude-code/hook-cli.js, dist/mcp/main.js). Run `npm run build` first.",
    )
    return report
  }

  copyFileSync(hookRunner, join(opencommsDir, "claude-code-hooks.mjs"))
  copyFileSync(mcpServer, join(opencommsDir, "opencomms-mcp.mjs"))
  report.filesInstalled.push(".opencomms/claude-code-hooks.mjs", ".opencomms/opencomms-mcp.mjs")

  // Hooks into project settings (.claude/settings.json), merged.
  // ${CLAUDE_PROJECT_DIR} is the documented placeholder Claude Code expands
  // inside hook command strings on ALL platforms (verified 2026-08-29;
  // PowerShell gets an automatic ${env:...} rewrite — %VAR% is NOT
  // documented, so never use it).
  const settingsPath = join(target, ".claude", "settings.json")
  const settings = readJson(settingsPath)
  const hooksRecord = isRecord(settings["hooks"]) ? (settings["hooks"] as Record<string, unknown>) : {}
  const hookCommand = 'node "${CLAUDE_PROJECT_DIR}/.opencomms/claude-code-hooks.mjs"'
  let hooksChanged = false
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
    const { changed } = mergeHookEntry(hooksRecord, event, hookCommand)
    hooksChanged = hooksChanged || changed
  }
  if (hooksChanged) {
    settings["hooks"] = hooksRecord
    writeJsonStable(settingsPath, settings)
    report.configPatches.push(`${settingsPath}: hooks merged (SessionStart/UserPromptSubmit/Stop/SessionEnd)`)
  } else {
    report.configPatches.push("hooks already registered (idempotent skip)")
  }

  // 3. MCP server registration in project .mcp.json (project scope, committed).
  const mcpJsonPath = join(target, ".mcp.json")
  const mcpConfig = readJson(mcpJsonPath)
  const servers = isRecord(mcpConfig["mcpServers"]) ? (mcpConfig["mcpServers"] as Record<string, unknown>) : {}
  if (!servers["opencomms"]) {
    // Absolute paths (Reviewer P3-3): a relative command path only works when
    // Claude Code happens to cwd the MCP server at the project root; the
    // project dir is known at install time, so pin it.
    servers["opencomms"] = {
      type: "stdio",
      command: "node",
      args: [join(opencommsDir, "opencomms-mcp.mjs"), target, "--host", "claude-code"],
      env: {
        OPENCOMMS_MEMBER_ID: "<set by: opencomms install-member>",
        OPENCOMMS_MEMBER_ROLE: "<role label>",
      },
    }
    mcpConfig["mcpServers"] = servers
    writeJsonStable(mcpJsonPath, mcpConfig)
    report.configPatches.push(`${mcpJsonPath}: opencomms MCP server registered (project scope)`)
  } else {
    report.configPatches.push(".mcp.json already has opencomms server (idempotent)")
  }

  report.warnings.push(
    "Claude Code receives NO session identity inside MCP tools: each member links via a hook-correlated session id. Delivery is hook-boundary (next SessionStart/UserPromptSubmit/Stop), never mid-turn push.",
  )
  report.warnings.push(
    "Next step: run `opencomms install-member --project <dir> --host claude-code --role <label>` inside a Claude Code session to create the pinned member (writes .opencomms/pins/<member_id>.json). Additional members REQUIRE --id.",
  )

  return report
}

/**
 * Register a member identity for this project: writes a PER-MEMBER pin file
 * (.opencomms/pins/<member_id>.json) that SessionStart binds against
 * (Reviewer P1-1 production wiring). The member id is minted here when not
 * supplied (opencomms-style id) and is validated against/created in state on
 * first join (bootstrap).
 *
 * Clobber protection: when pins already exist for this host and no explicit
 * memberId was given, the registration REFUSES (a second blind run must not
 * mint a fresh identity and orphan the first member). Pass --id to add
 * another member; per-member files make concurrent members safe.
 */
export function registerProjectMember(
  projectDir: string,
  opts: { host: string; memberId?: string },
): { ok: true; memberId: string; pinFile: string } | { ok: false; reason: string } {
  const target = resolve(projectDir)
  const opencommsDir = join(target, ".opencomms")
  if (!existsSync(join(opencommsDir, "state.json"))) {
    return { ok: false, reason: "No OpenComms state in this project yet — run the host adapter's create/join first." }
  }
  let memberId = opts.memberId?.trim() ?? ""
  if (!memberId) {
    const existing = listMemberPins(target, opts.host)
    if (existing.length > 0) {
      return {
        ok: false,
        reason:
          `Pins already exist for host "${opts.host}" (${existing.map((p) => p.member_id).join(", ")}). ` +
          "Re-running without --id would orphan an existing member. Pass --id <member_id> to register an ADDITIONAL member explicitly.",
      }
    }
    memberId = `sess_${randomBytes(12).toString("hex")}`
  }
  if (!isValidMemberId(memberId)) {
    return { ok: false, reason: `Invalid member id "${memberId}" (allowed: letters/digits/-/_ , max 64).` }
  }
  const ok = saveMemberPin(target, memberId, opts.host)
  if (!ok) return { ok: false, reason: `Could not write .opencomms/pins/${memberId}.json (permissions?)` }
  return { ok: true, memberId, pinFile: join(opencommsDir, "pins", `${memberId}.json`) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
