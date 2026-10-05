import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { readAdapterResource } from "../../cli/adapter-resources.js"
import { replaceStateFile } from "../../core/atomic-file.js"
import { compareVersions, getInstalledVersion, removeIntegrationMarker, setInstalledVersion } from "../versioning.js"
import {
  PLACEHOLDER_ISSUE,
  failureReport,
  type HostIntegration,
  type IntegrationContext,
  type IntegrationReport,
} from "../types.js"

const capabilities = {
  mode: "LINKED (existing user-run Gemini CLI session)",
  delivery: "SessionStart / BeforeAgent context and explicit MCP pull",
  identity: "documented session_id hook field; MCP identity remains pinned",
  managedCreation: "UNSUPPORTED by this integration",
  autonomousPush: "UNSUPPORTED by this integration",
  verification: "configuration and artifact checks; live round-trip is a separate gate",
}
const events = ["SessionStart", "BeforeAgent", "SessionEnd"] as const
const hookName = "opencomms-linked-session"
const hookFile = "gemini-cli-hooks.mjs"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function settings(ctx: IntegrationContext): Record<string, unknown> {
  const path = join(ctx.projectDir, ".gemini/settings.json")
  if (!existsSync(path)) return {}
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!record(parsed)) throw new Error(".gemini/settings.json must contain an object; no configuration was changed")
  for (const key of ["hooks", "mcpServers"]) {
    if (parsed[key] !== undefined && !record(parsed[key]))
      throw new Error(`.gemini/settings.json ${key} must be an object; no configuration was changed`)
  }
  return parsed
}
function saveSettings(ctx: IntegrationContext, value: Record<string, unknown>): void {
  const path = join(ctx.projectDir, ".gemini/settings.json")
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const backup = join(ctx.projectDir, ".opencomms/config-backups")
    mkdirSync(backup, { recursive: true })
    copyFileSync(path, join(backup, `gemini-settings-${Date.now()}.json`))
  }
  const temp = `${path}.${process.pid}.tmp`
  replaceStateFile(path, temp, `${JSON.stringify(value, null, 2)}\n`)
}
function owned(entry: unknown): boolean {
  if (!record(entry) || !Array.isArray(entry.hooks)) return false
  return entry.hooks.some(
    (hook) =>
      record(hook) && hook.name === hookName && typeof hook.command === "string" && hook.command.includes(hookFile),
  )
}
async function install(ctx: IntegrationContext): Promise<IntegrationReport> {
  try {
    const config = settings(ctx) // parse before ANY mutation
    const mcpServer = readAdapterResource("opencomms-mcp")
    const hookRunner = readAdapterResource("gemini-hook")
    const opencommsDir = join(resolve(ctx.projectDir), ".opencomms")
    const servers = record(config.mcpServers) ? config.mcpServers : {}
    // Preserve host permission and trust settings. MCP trust is never enabled
    // automatically and the host prompts the user to approve project hooks.
    if (!servers.opencomms)
      servers.opencomms = {
        command: "node",
        args: [join(opencommsDir, "opencomms-mcp.mjs"), resolve(ctx.projectDir), "--host", "gemini-cli"],
        cwd: resolve(ctx.projectDir),
        env: { OPENCOMMS_MEMBER_ID: "<set by: opencomms install-member>", OPENCOMMS_MEMBER_ROLE: "<role label>" },
      }
    config.mcpServers = servers
    const hooks = record(config.hooks) ? config.hooks : {}
    for (const event of events) {
      if (hooks[event] !== undefined && !Array.isArray(hooks[event]))
        return failureReport(`hooks.${event} must be an array; nothing was changed.`, capabilities)
      const entries = (hooks[event] ?? []) as unknown[]
      if (!entries.some(owned))
        hooks[event] = [
          ...entries,
          {
            hooks: [
              {
                name: hookName,
                type: "command",
                command: "node $GEMINI_PROJECT_DIR/.opencomms/gemini-cli-hooks.mjs",
                timeout: 15_000,
              },
            ],
          },
        ]
    }
    config.hooks = hooks
    mkdirSync(opencommsDir, { recursive: true })
    writeFileSync(join(opencommsDir, "opencomms-mcp.mjs"), mcpServer, "utf8")
    writeFileSync(join(opencommsDir, hookFile), hookRunner, "utf8")
    saveSettings(ctx, config)
    setInstalledVersion(ctx.projectDir, "gemini-cli", ctx.currentVersion)
    return {
      ok: true,
      actions: ["Gemini project MCP and SessionStart/BeforeAgent/SessionEnd hooks configured"],
      warnings: [
        "Review project hook and MCP trust in Gemini CLI. Register one gemini-cli member pin and replace MCP OPENCOMMS_MEMBER_ID before connecting. Configuration does not prove authentication or a live round-trip.",
      ],
      capabilities,
      changedFiles: [".gemini/settings.json", ".opencomms/opencomms-mcp.mjs", `.opencomms/${hookFile}`],
    }
  } catch (error) {
    return failureReport((error as Error).message, capabilities)
  }
}

export const geminiCliAdapter: HostIntegration = {
  id: "gemini-cli",
  name: "Gemini CLI",
  scope: "project",
  install,
  update: install,
  repair: install,
  async detect(ctx) {
    const installedVersion = getInstalledVersion(ctx.projectDir, "gemini-cli")
    try {
      const config = settings(ctx)
      const server = record(config.mcpServers) ? config.mcpServers.opencomms : undefined
      const hooks = record(config.hooks) ? config.hooks : {}
      const present = [
        existsSync(join(ctx.projectDir, ".opencomms", hookFile)),
        Boolean(server),
        ...events.map((event) => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(owned)),
      ]
      const issues: string[] = []
      const env = record(server) && record(server.env) ? server.env : {}
      if (env.OPENCOMMS_MEMBER_ID === "<set by: opencomms install-member>") issues.push(PLACEHOLDER_ISSUE)
      if (!existsSync(join(ctx.projectDir, ".opencomms/opencomms-mcp.mjs")) && present.some(Boolean))
        issues.push("MCP artifact missing")
      let status: "absent" | "broken" | "installed" | "outdated" = present.every((p) => !p)
        ? "absent"
        : present.every(Boolean) && issues.length === 0
          ? "installed"
          : "broken"
      if (status === "installed" && installedVersion && compareVersions(installedVersion, ctx.currentVersion) < 0)
        status = "outdated"
      return {
        status,
        installedVersion,
        currentVersion: ctx.currentVersion,
        details: ["Configuration inspection only; Gemini application/authentication/round-trip status is unknown"],
        issues,
      }
    } catch (error) {
      return {
        status: "broken",
        installedVersion,
        currentVersion: ctx.currentVersion,
        details: [],
        issues: [(error as Error).message],
      }
    }
  },
  async verify(ctx) {
    const detection = await this.detect(ctx)
    return detection.status === "installed"
      ? {
          ok: true,
          actions: ["Gemini integration configuration verified"],
          warnings: ["Live Gemini authentication and round-trip remain unverified"],
          capabilities,
          changedFiles: [],
        }
      : failureReport(
          `Configuration verification failed (${detection.status}): ${detection.issues.join("; ")}`,
          capabilities,
        )
  },
  async uninstall(ctx) {
    try {
      const config = settings(ctx)
      const servers = record(config.mcpServers) ? config.mcpServers : {}
      if (
        record(servers.opencomms) &&
        Array.isArray(servers.opencomms.args) &&
        servers.opencomms.args.includes("gemini-cli")
      )
        delete servers.opencomms
      const hooks = record(config.hooks) ? config.hooks : {}
      for (const event of events)
        if (Array.isArray(hooks[event])) hooks[event] = (hooks[event] as unknown[]).filter((entry) => !owned(entry))
      config.hooks = hooks
      if (existsSync(join(ctx.projectDir, ".gemini/settings.json"))) saveSettings(ctx, config)
      const changedFiles = existsSync(join(ctx.projectDir, ".gemini/settings.json")) ? [".gemini/settings.json"] : []
      const hookPath = join(ctx.projectDir, ".opencomms", hookFile)
      if (existsSync(hookPath)) {
        unlinkSync(hookPath)
        changedFiles.push(`.opencomms/${hookFile}`)
      }
      removeIntegrationMarker(ctx.projectDir, "gemini-cli")
      return {
        ok: true,
        actions: ["Removed Gemini OpenComms configuration entries"],
        warnings: ["Project state, pins, archives and shared MCP adapter bundle were preserved."],
        capabilities,
        changedFiles,
      }
    } catch (error) {
      return failureReport((error as Error).message, capabilities)
    }
  },
}
