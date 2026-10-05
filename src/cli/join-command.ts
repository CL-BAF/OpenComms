/** Host-specific join commands shared by the CLI and GUI. */
import { normalizeChannelName } from "../core/engine.js"

export type JoinHost = "opencode" | "claude-code" | "codex" | "gemini-cli" | "claude-desktop" | "chatgpt"

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
    case "gemini-cli":
      return {
        host: hostId,
        where: "Inside the existing Gemini CLI session in this project (MCP tool call; hooks/pull delivery)",
        command: `opencomms_join(channel="${name}", role="<role>", role_prompt="...")`,
      }
    case "chatgpt":
      return {
        host: hostId,
        where: "Inside a ChatGPT conversation (remote MCP; PULL delivery)",
        command: `opencomms_join(channel="${name}", role="<role>", role_prompt="...")`,
      }
    default:
      return {
        error: `Unknown host "${host}". Supported: opencode, claude-code, codex, gemini-cli, claude-desktop, chatgpt.`,
      }
  }
}
