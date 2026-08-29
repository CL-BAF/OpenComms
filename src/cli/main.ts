/**
 * Shared OpenComms CLI.
 *
 * Commands:
 *   opencomms status [project]        - channels/members/queues for a project
 *   opencomms channels [project]      - channel summaries only
 *   opencomms members <channel> ...   - member roster for one channel
 *   opencomms install opencode ...    - per-host installer
 *   opencomms install-member ...      - pin a member for hooks (identity file)
 *   opencomms uninstall <host> ...    - remove OpenComms integration
 *   opencomms doctor [project]        - detection + capability report
 *   opencomms version                 - version information
 *
 * Never prints secrets (env values, pin contents are summarized, not dumped).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { installClaudeCode, registerProjectMember } from "../adapters/claude-code/install.js"
import { installCodex, detectCodex } from "../adapters/codex/install.js"
import { buildDesktopBundle, DESKTOP_CAPABILITIES } from "../adapters/claude-desktop/package.js"
import { scaffoldChatGptIntegration, detectChatGptDesktop } from "../adapters/chatgpt/install.js"
import { StateStore } from "../core/store.js"
import { status } from "../core/engine.js"
import { SCHEMA_VERSION } from "../core/types.js"
import { loadProjectPin } from "../mcp/identity.js"

export const VERSION = "2.0.0"

function flagValue(tokens: string[], name: string): string | undefined {
  const idx = tokens.indexOf(name)
  return idx >= 0 ? tokens[idx + 1] : undefined
}

function projectDirFromFlag(tokens: string[], name: string): string | undefined {
  const value = flagValue(tokens, name)
  return value ? resolve(value) : undefined
}

function repoRootForCli(): string {
  let dir: string = import.meta.dirname ?? process.cwd()
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return process.cwd()
    dir = parent
  }
}

interface CliResult {
  code: number
  output: string
}

function ok(output: string): CliResult {
  return { code: 0, output }
}
function fail(output: string): CliResult {
  return { code: 1, output }
}

function fmtStatus(projectDir: string): CliResult {
  const store = new StateStore(resolve(projectDir))
  const state = store.load()
  const report = status(state, {})
  const data = report.data as {
    channels: Array<{
      name: string
      paused: boolean
      members: Array<{ role: string; host: string; delivery_mode?: string }>
    }>
    total_messages: number
    pending_messages: number
    errors: unknown[]
  }
  const lines: string[] = []
  lines.push(`OpenComms v${VERSION} - project ${resolve(projectDir)}`)
  lines.push(`State schema: v${SCHEMA_VERSION} at .opencomms/state.json`)
  if (state.errors.some((e) => e.message.includes("Migrated"))) {
    lines.push("Migrated from v1 legacy dir (see README 'Upgrading from 1.x').")
  }
  lines.push(`Channels: ${data.channels.length}, messages: ${data.total_messages}, pending: ${data.pending_messages}`)
  for (const channel of data.channels) {
    lines.push("")
    lines.push(`  ${channel.name}${channel.paused ? " [PAUSED]" : ""}`)
    for (const member of channel.members) {
      lines.push(`    ${member.role} (${member.host}, delivery: ${member.delivery_mode ?? "push"})`)
    }
  }
  if (data.errors.length > 0) {
    lines.push("")
    lines.push(`Recent errors (${Math.min(data.errors.length, 5)} shown):`)
    for (const e of state.errors.slice(-5)) {
      lines.push(`  ${e.message.slice(0, 140)}`)
    }
  }
  return ok(lines.join("\n"))
}

function fmtChannels(projectDir: string): CliResult {
  const store = new StateStore(resolve(projectDir))
  const data = status(store.load(), {}).data as {
    channels: Array<{ name: string; paused: boolean; members: unknown[]; delivery_modes?: unknown }>
  }
  if (data.channels.length === 0) return ok("No channels in this project.")
  return ok(
    data.channels
      .map((c) => `${c.name}${c.paused ? " [paused]" : ""} (${(c.members as unknown[]).length} members)`)
      .join("\n"),
  )
}

function fmtMembers(projectDir: string, channel: string | undefined): CliResult {
  if (!channel) return fail("Usage: opencomms members <channel> --project <dir>")
  const store = new StateStore(resolve(projectDir))
  const data = status(store.load(), { channel }).data as {
    channels: Array<{
      name: string
      members: Array<{
        role: string
        host: string
        surface: string
        delivery_mode: string
        host_session_id: string | null
        stale: boolean
      }>
    }>
  }
  const found = data.channels.find((c) => c.name === channel.toLowerCase())
  if (!found) return fail(`Channel "${channel}" not found (or you are not a member).`)
  const lines = found.members.map(
    (m) => `${m.role}: host=${m.host} surface=${m.surface} delivery=${m.delivery_mode}${m.stale ? " [STALE]" : ""}`,
  )
  return ok(lines.join("\n"))
}

function fmtDoctor(projectDir: string): CliResult {
  const lines: string[] = []
  lines.push(`OpenComms doctor (v${VERSION})`)
  lines.push("")

  // State health.
  const store = new StateStore(resolve(projectDir))
  const state = store.load()
  lines.push(`State: .opencomms/state.json (schema v${state.schema_version})`)
  if (!existsSync(join(resolve(projectDir), ".opencomms", "state.json"))) {
    lines.push("  no state yet (fresh project)")
  }
  const migrationError = state.errors.find((e) => e.message.includes("Migrated") || e.message.includes("Legacy"))
  if (migrationError) lines.push(`  ${migrationError.message.slice(0, 120)}`)

  // Hosts.
  lines.push("")
  lines.push("Hosts:")
  const claudeCode = existsSync(join(resolve(projectDir), ".mcp.json"))
  lines.push(
    `  OpenCode: plugin path ${existsSync(join(resolve(projectDir), ".opencode", "plugins", "plugin.js")) ? "installed" : "not installed"} | delivery: PUSH | role injection: system-prompt`,
  )
  lines.push(
    `  Claude Code: .mcp.json ${claudeCode ? "registered" : "not registered"} | delivery: hook-boundary (PARTIAL) | push: UNSUPPORTED (documented)`,
  )
  const codex = detectCodex()
  lines.push(
    `  Codex CLI: ${codex.detected ? `detected (${codex.version ?? "?"})` : "not detected"} | config.toml MCP: ${existsSync(join(resolve(projectDir), ".codex", "config.toml")) ? "registered" : "not registered"} | delivery: PULL`,
  )
  lines.push(
    `  Claude Desktop: extension bundle ${existsSync(join(resolve(projectDir), "opencomms-claude-desktop")) ? "built" : "not built"} | delivery: PULL ONLY | push: UNSUPPORTED`,
  )
  const gpt = detectChatGptDesktop()
  lines.push(
    `  ChatGPT Desktop: not directly detectable (${gpt.detected ? "?" : "by design; no documented API"}) | remote MCP scaffold: ${existsSync(join(resolve(projectDir), "opencomms-chatgpt")) ? "scaffolded" : "not scaffolded"}`,
  )

  // Member pin.
  lines.push("")
  const pin = loadProjectPin(resolve(projectDir))
  lines.push(
    `Member pin: ${pin ? `present (${pin.member_id.slice(0, 12)}...)` : "not set"} - run install-member inside a host session`,
  )
  return ok(lines.join("\n"))
}

/** opencomms install <host> [project] */
function runInstall(host: string | undefined, projectDir: string): CliResult {
  switch ((host ?? "").toLowerCase()) {
    case "opencode": {
      // The existing installer is a standalone script; keep parity by invoking it.
      try {
        execFileSync(process.execPath, [join(repoRootForCli(), "install.mjs"), projectDir], { stdio: "inherit" })
        return ok("OpenCode plugin installed (see install.mjs output).")
      } catch (error) {
        return fail(`OpenCode install failed: ${(error as Error).message}`)
      }
    }
    case "claude-code": {
      const report = installClaudeCode(projectDir)
      const out = [
        `Claude Code: detected=${report.claudeDetected} version=${report.claudeVersion ?? "n/a"}`,
        ...report.filesInstalled.map((f) => `  wrote ${f}`),
        ...report.configPatches.map((p) => `  ${p}`),
        ...report.warnings.map((w) => `  ! ${w}`),
        "  capabilities: " + JSON.stringify(report.capabilities),
      ].join("\n")
      return report.ok ? ok(out) : fail(out)
    }
    case "claude-desktop": {
      const bundle = buildDesktopBundle({ projectDir })
      const out = [
        bundle.ok ? "Bundle laid out:" : "Bundle failed:",
        `  ${bundle.bundleDir ?? "(n/a)"}`,
        ...bundle.warnings.map((w) => `  ${w}`),
        "  capabilities: " + JSON.stringify(DESKTOP_CAPABILITIES),
      ].join("\n")
      return bundle.ok ? ok(out) : fail(out)
    }
    case "codex": {
      const report = installCodex(projectDir)
      const out = [
        `Codex: detected=${report.codexDetected}`,
        ...report.patches.map((p) => `  ${p}`),
        ...report.warnings.map((w) => `  ${w}`),
      ].join("\n")
      return report.ok ? ok(out) : fail(out)
    }
    case "chatgpt": {
      const report = scaffoldChatGptIntegration(projectDir)
      return ok(
        [
          "ChatGPT integration scaffold (EXPERIMENTAL):",
          ...report.filesWritten.map((f) => `  wrote ${f.path} (${f.purpose})`),
          ...report.warnings.map((w) => `  ${w}`),
        ].join("\n"),
      )
    }
    default:
      return fail(`Unknown host "${host ?? ""}". Supported: opencode, claude-code, claude-desktop, codex, chatgpt.`)
  }
}

/** opencomms uninstall <host> [project] */
function runUninstall(host: string | undefined, projectDir: string): CliResult {
  switch ((host ?? "").toLowerCase()) {
    case "claude-code": {
      // Remove ONLY OpenComms entries; never touch unrelated config.
      const settingsPath = join(resolve(projectDir), ".claude", "settings.json")
      let removed = false
      if (existsSync(settingsPath)) {
        const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, unknown> }
        if (raw.hooks) {
          for (const event of Object.keys(raw.hooks)) {
            const entries = raw.hooks[event]
            if (Array.isArray(entries)) {
              const filtered = entries.filter((e) => !JSON.stringify(e).includes("claude-code-hooks.mjs"))
              if (filtered.length !== entries.length) {
                raw.hooks[event] = filtered
                removed = true
              }
            }
          }
          writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8")
        }
      }
      return ok(
        removed
          ? "OpenComms hooks removed from .claude/settings.json (other config untouched)."
          : "No OpenComms hooks found (nothing to remove).",
      )
    }
    case "codex": {
      const configPath = join(resolve(projectDir), ".codex", "config.toml")
      if (!existsSync(configPath)) return ok("No Codex config present.")
      const toml = readFileSync(configPath, "utf8")
      const sectionStart = toml.indexOf("[mcp_servers.opencomms]")
      if (sectionStart === -1) return ok("No opencomms section in config.toml.")
      // Cut from the section to the next top-level [section] after it.
      const rest = toml.slice(sectionStart)
      const nextSection = rest.slice(1).search(/\n\[/)
      const end = nextSection === -1 ? rest.length : 1 + nextSection + 1
      const cleaned = (toml.slice(0, sectionStart) + rest.slice(end)).replace(/\n{3,}/g, "\n\n")
      writeFileSync(configPath, cleaned, "utf8")
      return ok("[mcp_servers.opencomms] removed from .codex/config.toml (other sections untouched).")
    }
    case "claude-desktop":
      return ok(
        "Delete the extension via Claude Desktop > Settings > Extensions (OpenComms). The bundle directory can be removed manually: opencomms-claude-desktop/. Note: state.json is shared project state and is NOT removed.",
      )
    case "chatgpt":
      return ok("Scaffold is inert until deployed; remove the opencomms-chatgpt/ directory to discard it.")
    case "opencode":
      return fail(
        "Use the host's plugin management: remove .opencode/plugins/plugin.js and the 'plugin' entry from opencode.json (see README).",
      )
    default:
      return fail(`Unknown host "${host ?? ""}".`)
  }
}

/** opencomms install-member [--host <host>] [--id <memberId>] */
function runInstallMember(projectDir: string, host: string | undefined, memberId: string | null): CliResult {
  const result = registerProjectMember(resolve(projectDir), {
    host: host ?? "claude-code",
    memberId: memberId ?? undefined,
  })
  if (!result.ok) return fail(result.reason)
  return ok(
    `Member registered: ${result.memberId} (pin file .opencomms/member-pin.json). Now run create/join inside the host session to link it to a channel.`,
  )
}

export function runCli(argv: string[]): CliResult {
  // Find the subcommand's positional arguments and --project wherever they
  // appear ("opencomms members <ch> --project <dir>" AND
  // "opencomms --project <dir> members <ch>" both work).
  const tokens = argv.filter(Boolean) as string[]
  const cmd = tokens[0]
  const projectDir = projectDirFromFlag(tokens, "--project") ?? process.cwd()
  // The positional (host/channel name) = first token after the command that
  // is not a flag or a flag value.
  let positional: string | undefined
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === "--project") {
      i++ // skip its value
      continue
    }
    if (positional === undefined) positional = t
  }
  switch (cmd) {
    case "status":
      return fmtStatus(projectDir)
    case "channels":
      return fmtChannels(projectDir)
    case "members":
      return fmtMembers(projectDir, positional)
    case "doctor":
      return fmtDoctor(projectDir)
    case "version":
      return ok(`opencomms ${VERSION} (state schema v${SCHEMA_VERSION})`)
    case "install":
      return runInstall(positional, projectDir)
    case "install-member":
      return runInstallMember(projectDir, flagValue(tokens, "--host"), flagValue(tokens, "--id") ?? null)
    case "uninstall":
      return runUninstall(positional, projectDir)
    case "help":
    case undefined:
      return ok(
        [
          "opencomms - cross-agent communication channels",
          "",
          "  opencomms status [--project <dir>]",
          "  opencomms channels [--project <dir>]",
          "  opencomms members <channel> [--project <dir>]",
          "  opencomms doctor [--project <dir>]",
          "  opencomms install <opencode|claude-code|claude-desktop|codex|chatgpt> [--project <dir>]",
          "  opencomms install-member [--host <id>] [--id <memberId>] [--project <dir>]",
          "  opencomms uninstall <host> [--project <dir>]",
          "  opencomms version",
        ].join("\n"),
      )
    default:
      return fail(`Unknown command "${cmd}". Run \`opencomms help\`.`)
  }
}

// CLI invocation only (not when imported by tests).
import { realpathSync } from "node:fs"
const invoked = process.argv[1] ? realpathSync(process.argv[1]).replace(/\\/g, "/") : ""
if (/(^|[\\/])cli[\\/](opencomms|main|cli)\.(js|mjs|ts)$/.test(invoked)) {
  const result = runCli(process.argv.slice(2))
  if (result.output) process.stdout.write(result.output + "\n")
  process.exitCode = result.code
}
