/**
 * The REAL, currently-valid join command for a session on a given host —
 * single source of truth shared by the CLI, the GUI, and docs (users never
 * copy UUIDs; the GUI displays exactly what these functions return).
 */
import { normalizeChannelName } from "../core/engine.js"

export type JoinHost = "opencode" | "claude-code" | "codex" | "claude-desktop" | "chatgpt"

export interface JoinCommandResult {
  host: string
  /** Exact command/tool call to run INSIDE the host session. */
  command: string
  /** Where the command runs (UI hint). */
  where: string
}

export function joinCommandFor(sessionName: string, host: string = "opencode"): JoinCommandResult | { error: string } {
  const name = normalizeChannelName(sessionName)
  if (!name) return { error: "Session name is required." }
  const hostId = host.toLowerCase()
  switch (hostId) {
    case "opencode":
      return {
        host: hostId,
        where: "Inside an OpenCode session in this project (slash command, or let the agent call the tool)",
        command: `/OpenComms Join Channel=${name} As=<role> [role instructions]`,
      }
    case "claude-code":
      return {
        host: hostId,
        where: "Inside a Claude Code session (MCP tool call by the agent)",
        command: `opencomms_join(channel="${name}", role="<role>", role_prompt="...", spawn_push=true)`,
      }
    case "codex":
      return {
        host: hostId,
        where: "Inside a Codex session (MCP tool call by the agent)",
        command: `opencomms_join(channel="${name}", role="<role>", role_prompt="...", spawn_push=true)`,
      }
    case "claude-desktop":
      return {
        host: hostId,
        where: "Inside a Claude Desktop conversation (MCP tool call; PULL delivery)",
        command: `opencomms_join(channel="${name}", role="<role>", role_prompt="...")`,
      }
    case "chatgpt":
      return {
        host: hostId,
        where: "Inside a ChatGPT conversation (remote MCP; PULL delivery)",
        command: `opencomms_join(channel="${name}", role="<role>", role_prompt="...")`,
      }
    default:
      return { error: `Unknown host "${host}". Supported: opencode, claude-code, codex, claude-desktop, chatgpt.` }
  }
}
