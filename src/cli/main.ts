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
import { tmpdir } from "node:os"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { installClaudeCode, registerProjectMember } from "../adapters/claude-code/install.js"
import { installCodex, detectCodex } from "../adapters/codex/install.js"
import { buildDesktopBundle, DESKTOP_CAPABILITIES } from "../adapters/claude-desktop/package.js"
import { scaffoldChatGptIntegration, detectChatGptDesktop } from "../adapters/chatgpt/install.js"
import { StateStore } from "../core/store.js"
import { status } from "../core/engine.js"
import { buildSessionArchive, commitSessionSave, deleteSession, resumeSession } from "../core/engine.js"
import { ArchiveStore } from "../core/archive.js"
import { startGuiServer } from "../gui/server.js"
import { SCHEMA_VERSION } from "../core/types.js"
import { listMemberPins, loadProjectPin } from "../mcp/identity.js"
import { joinCommandFor } from "./join-command.js"
import { WIZARD_PS1 } from "./wizard.js"
import { iconIcoBytes } from "./icon-base64.js"

/** Package version, derived from package.json so the CLI can never drift. */
export const VERSION: string = (() => {
  try {
    let dir: string = import.meta.dirname ?? process.cwd()
    for (;;) {
      const candidate = join(dir, "package.json")
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown }
        if (typeof parsed.version === "string" && parsed.version) return parsed.version
      }
      const parent = dirname(dir)
      if (parent === dir) return "0.0.0"
      dir = parent
    }
  } catch {
    return "0.0.0"
  }
})()

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

  // Member pins.
  lines.push("")
  const pins = listMemberPins(resolve(projectDir))
  if (pins.length > 0) {
    lines.push(`Member pins: ${pins.length} (${pins.map((p) => p.member_id.slice(0, 12) + "...").join(", ")})`)
  } else {
    const legacy = loadProjectPin(resolve(projectDir))
    lines.push(
      legacy
        ? `Member pin: legacy single-member file (${legacy.member_id.slice(0, 12)}...) - re-register members to migrate to per-member pins`
        : "Member pins: none - run install-member inside a host session",
    )
  }
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
          let changedAny = false
          for (const event of Object.keys(raw.hooks)) {
            const entries = raw.hooks[event]
            if (Array.isArray(entries)) {
              const filtered = entries.filter((e) => !JSON.stringify(e).includes("claude-code-hooks.mjs"))
              if (filtered.length !== entries.length) {
                raw.hooks[event] = filtered
                removed = true
                changedAny = true
              }
            }
          }
          // Write only when something was actually removed (no format churn).
          if (changedAny) writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n", "utf8")
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

/** opencomms install-member [--host <host>] [--id <memberId> | --name <name>] */
function runInstallMember(projectDir: string, host: string | undefined, memberId: string | null): CliResult {
  const result = registerProjectMember(resolve(projectDir), {
    host: host ?? "claude-code",
    memberId: memberId ?? undefined,
  })
  if (!result.ok) return fail(result.reason)
  return ok(
    `Member registered: ${result.memberId} (pin file ${result.pinFile.replace(/\\/g, "/")}). Now run create/join inside the host session to link it to a channel.`,
  )
}

/**
 * Session lifecycle commands (operator backend surface, work order
 * 2026-09-08): list / get / save / delete / resume. Provider-independent —
 * operates directly on project state + archives.
 */
function runSession(tokens: string[], projectDir: string): Promise<CliResult> {
  const sub = (tokens[0] ?? "list").toLowerCase()
  const rest = tokens.slice(1)
  // First non-flag token after the subcommand is the session name.
  let name: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (t === "--project" || t === "--summary" || t === "--as" || t === "--host") {
      i++
      continue
    }
    if (t.startsWith("--")) continue
    if (name === undefined) name = t
  }
  const store = new StateStore(resolve(projectDir))
  const archives = new ArchiveStore(resolve(projectDir))
  const summary = flagValue(rest, "--summary") ?? null
  const newName = flagValue(rest, "--as") ?? null
  const confirmed = rest.includes("--confirm")

  const run = async (): Promise<CliResult> =>
    store.withLock(() => {
      const state = store.load()
      switch (sub) {
        case "list": {
          const live = Object.values(state.channels).map((c) => ({
            name: c.name,
            lifecycle: c.lifecycle,
            members: `${c.members.length}/${c.max_members}`,
            description: c.description ?? "No description yet",
            parent: c.parent_channel_id ?? "-",
          }))
          const saved = archives.list()
          const lines = [
            "Live sessions:",
            ...(live.length > 0
              ? live.map((s) => `  ${s.name} [${s.lifecycle}] ${s.members} agents — ${s.description}`)
              : ["  (none)"]),
            "",
            "Archived sessions:",
            ...(saved.length > 0
              ? saved.map(
                  (a) =>
                    `  ${a.name} [saved ${new Date(a.saved_at).toISOString().slice(0, 10)}] ${a.message_count} messages — ${a.description ?? "No description yet"}`,
                )
              : ["  (none)"]),
          ]
          return ok(lines.join("\n"))
        }
        case "get": {
          if (!name) return fail("Usage: opencomms session get <name>")
          const ch = Object.values(state.channels).find((c) => c.name === name.toLowerCase())
          if (ch) {
            return ok(
              [
                `Session: ${ch.name} [${ch.lifecycle}]`,
                `Description: ${ch.description ?? "No description yet"}`,
                `Members (${ch.members.length}/${ch.max_members}):`,
                ...ch.members.map(
                  (m) => `  ${m.session_id} | ${m.role} | ${m.host} | ${m.delivery_mode}${m.stale ? " | STALE" : ""}`,
                ),
              ].join("\n"),
            )
          }
          const archive = archives.findByName(name) ?? archives.get(name)
          if (!archive) return fail(`No live or archived session matches "${name}".`)
          return ok(
            [
              `Archived session: ${archive.name} (saved ${new Date(archive.saved_at).toISOString()})`,
              `Description: ${archive.description ?? "No description yet"}`,
              `Summary: ${archive.summary || "(none recorded)"}`,
              `Messages archived: ${archive.message_count} | Roster: ${archive.members.map((m) => `${m.role}(${m.host})`).join(", ")}`,
            ].join("\n"),
          )
        }
        case "save": {
          if (!name) return fail('Usage: opencomms session save <name> [--summary "..."]')
          const built = buildSessionArchive(state, { channel: name, session_id: null, summary })
          if (!built.ok) return fail(built.message)
          const inputs = (built.data as { archive_inputs: Record<string, unknown> }).archive_inputs
          const archive = archives.fromChannel(
            inputs as never,
            inputs["messages"] as never,
            null,
            null,
            (inputs["summary"] as string | null) ?? null,
          )
          if (!archive.summary)
            archive.summary = `Session "${archive.name}" archived. ${archive.description ?? "No description recorded."}`
          archives.save(archive)
          commitSessionSave(state, archive.channel_id)
          store.save(state)
          return ok(
            `Session "${archive.name}" SAVED (${archive.message_count} messages archived). Resume with: opencomms session resume ${archive.name}`,
          )
        }
        case "delete": {
          if (!name) return fail("Usage: opencomms session delete <name> --confirm")
          const decided = deleteSession(state, { channel: name, session_id: null, confirm: confirmed, operator: true })
          if (!decided.ok) return fail(decided.message)
          const { phase, channel_id: channelId } = decided.data as { phase: string; channel_id: string }
          if (phase === "live") {
            // Collect THIS channel's doomed ids BEFORE deleting anything
            // (a post-delete snapshot would contain other channels' ids).
            const doomed = new Set(
              Object.values(state.messages)
                .filter((mm) => mm.channel_id === channelId)
                .map((mm) => mm.message_id),
            )
            for (const id of doomed) {
              delete state.messages[id]
              delete state.delivered_to[id]
            }
            for (const key of Object.keys(state.queues)) {
              const ids = state.queues[key] ?? []
              const filtered = ids.filter((id) => !doomed.has(id))
              if (filtered.length !== ids.length) state.queues[key] = filtered
            }
            for (const key of Object.keys(state.channels)) {
              if (state.channels[key]!.id === channelId) delete state.channels[key]
            }
            store.save(state)
            return ok(`Session ${channelId} DELETED (live state purged).`)
          }
          const byId = archives.get(channelId)
          const removed = archives.delete(channelId)
          return ok(
            removed ? `Archived session "${byId?.name ?? channelId}" DELETED.` : `No archive found for ${channelId}.`,
          )
        }
        case "resume": {
          if (!name) return fail("Usage: opencomms session resume <name> [--as <new-name>]")
          const archive = archives.findByName(name) ?? archives.get(name)
          if (!archive) return fail(`No archived session matches "${name}".`)
          const resumed = resumeSession(state, {
            archive,
            new_name: newName,
            project_id: "cli-local-project",
            worktree: resolve(projectDir),
          })
          if (!resumed.ok) return fail(resumed.message)
          store.save(state)
          const data = resumed.data as { name: string }
          return ok(
            `Resumed "${archive.name}" as NEW active session "${data.name}". Agents join it normally; joiners receive the compact archived context.`,
          )
        }
        default:
          return fail(
            "Usage: opencomms session <list|get|save|delete|resume> [name] [--summary ...] [--as name] [--confirm]",
          )
      }
    })
  return run().catch((error: Error) => fail(`Session command failed: ${error.message}`))
}

/**
 * Print the REAL, currently-valid join command for a session on a given
 * host (work order: the GUI shows this; users never copy UUIDs).
 */
function runJoinCommand(projectDir: string, sessionName: string | undefined, host: string | undefined): CliResult {
  // Shared helper keeps CLI and GUI on ONE definition of the real command.
  if (!sessionName) return fail("Usage: opencomms join-command <session> [--host <opencode|claude-code|codex>]")
  const result = joinCommandFor(sessionName, host ?? "opencode")
  if ("error" in result) return fail(result.error)
  return ok(`Run ${result.where}:\n  ${result.command}`)
}

/**
 * `opencomms gui` — start the loopback-only local console (blocks until
 * Ctrl+C). No network exposure; no provider credentials pass through.
 */
function startGui(projectDir: string, portFlag: string | undefined): CliResult {
  const port = portFlag ? Number(portFlag) : 4919
  if (!Number.isFinite(port) || port < 1 || port > 65_535) return fail(`Invalid --port "${portFlag}".`)
  void (async () => {
    const handle = await startGuiServer({ projectDir: resolve(projectDir), port, hostname: "127.0.0.1" })
    process.stdout.write(
      `OpenComms console: http://127.0.0.1:${handle.port}\nLoopback-only (no network exposure). Ctrl+C to stop.\n`,
    )
    const shutdown = (): void => {
      void handle.close().then(() => process.exit(0))
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
    // Keep the event loop alive for the server + SSE timers.
    setInterval(() => {}, 60_000).unref?.()
  })().catch((error: Error) => process.stderr.write(`GUI failed: ${error.message}\n`))
  return ok("Starting OpenComms console...")
}

/**
 * True when this process runs as the packaged standalone exe (Node SEA):
 * the double-click case has NO argv[1], the explicit-command case has
 * argv[1] === execPath. Under plain `node`, argv[1] is a script path.
 */
function runningAsPackagedExe(): boolean {
  return process.argv[1] === undefined || process.argv[1] === process.execPath
}

/**
 * Double-click behavior (spec: the exe must DO something visible): with no
 * arguments on a Windows console, launch the install wizard instead of
 * flashing help text. Escapes: OPENCOMMS_NO_WIZARD=1, or any argument.
 */
function shouldLaunchWizard(argv: string[]): boolean {
  return (
    process.platform === "win32" &&
    argv.length === 0 &&
    process.stdin.isTTY === true &&
    runningAsPackagedExe() &&
    process.env["OPENCOMMS_NO_WIZARD"] !== "1"
  )
}

/**
 * Launch the PowerShell/WinForms install wizard as a DETACHED process (the
 * exe exits right away; the wizard window is independent). The script is
 * passed via -EncodedCommand so no temp .ps1 file and no execution-policy
 * change is needed; the exe + icon paths travel via env defaults.
 */
function launchWizard(): CliResult {
  if (process.platform !== "win32") {
    return fail(
      "The installer wizard is Windows-only (Windows first, per spec). On macOS/Linux build on the target OS (npm run build:exe) and run scripts/install.sh.",
    )
  }
  if (!runningAsPackagedExe()) {
    return fail(
      "The wizard installs the packaged exe. Build it first (npm run build:exe), then run opencomms.exe install-wizard.",
    )
  }
  const iconPath = join(tmpdir(), "opencomms-wizard-icon.ico")
  try {
    writeFileSync(iconPath, iconIcoBytes())
  } catch (error) {
    return fail(`Could not extract the icon: ${(error as Error).message}`)
  }
  const encoded = Buffer.from(WIZARD_PS1, "utf16le").toString("base64")
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OPENCOMMS_WIZARD_EXE: process.execPath,
      OPENCOMMS_WIZARD_ICON: iconPath,
    },
  })
  child.unref()
  return ok("Installer wizard launched (a setup window will open shortly).")
}

/**
 * `opencomms uninstall-self` — remove the installed integration: user PATH
 * entry, Start Menu shortcuts, desktop shortcut, then delete the install
 * directory once this process has exited (detached delayed cleanup).
 */
function runUninstallSelf(): CliResult {
  if (process.platform !== "win32") {
    return fail("uninstall-self is Windows-only. On macOS/Linux remove the binary from ~/.local/bin manually.")
  }
  if (!runningAsPackagedExe()) {
    return fail("uninstall-self removes the PACKAGED exe install. Build it first: npm run build:exe.")
  }
  const installDir = dirname(process.execPath)
  const encoded = Buffer.from(WIZARD_PS1, "utf16le").toString("base64")
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    timeout: 120_000,
    encoding: "utf8",
    env: { ...process.env, OPENCOMMS_WIZARD_DIR: installDir },
  })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
  if (result.status !== 0) {
    return fail(`Uninstall failed (status ${result.status}):\n${output}`)
  }
  // Schedule removal of the install dir once this process has exited.
  try {
    const cleaner = spawn("cmd.exe", ["/c", `ping -n 3 127.0.0.1 > nul & rmdir /s /q "${installDir}"`], {
      detached: true,
      stdio: "ignore",
    })
    cleaner.unref()
  } catch {
    /* the user can delete the folder manually */
  }
  return ok(`${output}\nInstall folder removal scheduled: ${installDir}`)
}

/** Session commands hit the async state lock and are awaited by main()/tests directly. */
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
    case "gui":
      return startGui(projectDir, flagValue(tokens, "--port"))
    case "install-wizard":
      return launchWizard()
    case "uninstall-self":
      return runUninstallSelf()
    case "session":
      return fail('Session commands are async: await runSession(["save", "<name>"]) (CLI main handles this).')
    case "join-command":
    case "join":
      return runJoinCommand(projectDir, positional, flagValue(tokens, "--host"))
    case "install-member":
      return runInstallMember(
        projectDir,
        flagValue(tokens, "--host"),
        flagValue(tokens, "--id") ?? flagValue(tokens, "--name") ?? null,
      )
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
          "  opencomms install-member [--host <id>] [--id <memberId> | --name <name>] [--project <dir>]",
          "  opencomms session <list|get|save|delete|resume> [name] [--summary ...] [--as name] [--confirm]",
          "  opencomms gui [--port <port>]        # local console (loopback-only)",
          "  opencomms install-wizard             # Windows setup wizard (also launched by double-clicking the exe)",
          "  opencomms uninstall-self             # remove PATH entry, shortcuts, and the install folder",
          "  opencomms join-command <session> [--host <opencode|claude-code|codex|claude-desktop|chatgpt>]",
          "  opencomms uninstall <host> [--project <dir>]",
          "  opencomms version",
        ].join("\n"),
      )
    default:
      return fail(`Unknown command "${cmd}". Run \`opencomms help\`.`)
  }
}

// CLI invocation only (not when imported by tests). Under a Node SEA
// single executable, process.execPath IS the CLI itself (argv[1] = exe).
import { realpathSync } from "node:fs"
const invoked = process.argv[1] ? realpathSync(process.argv[1]).replace(/\\/g, "/") : ""
const isCliEntry =
  /(^|[\\/])cli[\\/](opencomms|main|cli)\.(js|mjs|ts)$/.test(invoked) ||
  (process.argv[1] !== undefined && process.execPath === realpathSync(process.argv[1]))
if (isCliEntry) {
  const emit = (result: { code: number; output: string }): void => {
    if (result.output) process.stdout.write(result.output + "\n")
    process.exitCode = result.code
  }
  const argv = process.argv.slice(2)
  if (shouldLaunchWizard(argv)) {
    emit(launchWizard())
    process.exit(process.exitCode ?? 0)
  }
  if (argv[0] === "gui") {
    // The GUI server blocks; never take the sync exit path.
    const guiResult = runCli(argv)
    if (guiResult.output) process.stdout.write(guiResult.output + "\n")
  } else if (argv[0] === "session") {
    void runSession(argv.slice(1), projectDirFromFlag(argv, "--project") ?? process.cwd()).then(emit)
  } else {
    emit(runCli(argv))
  }
}
