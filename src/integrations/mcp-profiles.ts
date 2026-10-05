/** Read-only, documented configuration fragments for user-owned MCP hosts. */
import { resolve } from "node:path"
import { isValidMemberId } from "../mcp/identity.js"

export const MCP_PROFILE_HOSTS = [
  "goose",
  "cursor",
  "cline",
  "roo",
  "continue",
  "vscode-copilot",
  "windsurf-cascade",
] as const
export type McpProfileHost = (typeof MCP_PROFILE_HOSTS)[number]

export interface McpProfile {
  host: McpProfileHost
  format: "json" | "yaml"
  /** Merge the fragment into the user-selected file; never overwrite it. */
  destination: string
  content: string
}

const destinations: Record<McpProfileHost, string> = {
  goose: "Goose config.yaml, extensions section (see official config location)",
  cursor: ".cursor/mcp.json",
  cline: "Cline IDE Configure MCP Servers, or CLI ~/.cline/mcp.json",
  roo: ".roo/mcp.json",
  continue: ".continue/mcpServers/opencomms.json",
  "vscode-copilot": ".mcp.json (portable workspace configuration)",
  "windsurf-cascade": "Legacy Cascade: Actions > Open MCP config file",
}

/**
 * The member pin identifies an OpenComms member, never a native conversation.
 * Profiles grant no automatic tool approval, admin mode, resume or push.
 */
export function createMcpProfile(opts: {
  host: string
  projectDir: string
  memberId: string
  serverPath: string
  nodeCommand?: string
}): McpProfile {
  if (!MCP_PROFILE_HOSTS.includes(opts.host as McpProfileHost))
    throw new Error(`Unknown MCP profile; choose ${MCP_PROFILE_HOSTS.join(" | ")}.`)
  if (!isValidMemberId(opts.memberId))
    throw new Error("Member id must be 1–64 letters, digits, underscores or hyphens.")
  const command = opts.nodeCommand ?? "node"
  if (!command.trim() || /[\x00-\x1f\x7f]/.test(command))
    throw new Error("Node command must be an executable name or path, without shell arguments.")
  const host = opts.host as McpProfileHost
  const args = [resolve(opts.serverPath), resolve(opts.projectDir), "--host", host]
  const env = { OPENCOMMS_MEMBER_ID: opts.memberId, OPENCOMMS_NO_SPAWN: "1" }
  if (host === "goose") {
    // JSON-quoted scalars and flow arrays/maps are valid YAML; paths stay argv.
    return {
      host,
      format: "yaml",
      destination: destinations[host],
      content: [
        "extensions:",
        "  opencomms:",
        "    type: stdio",
        "    name: opencomms",
        "    enabled: true",
        `    cmd: ${JSON.stringify(command)}`,
        `    args: ${JSON.stringify(args)}`,
        `    envs: ${JSON.stringify(env)}`,
        "    env_keys: []",
        "    timeout: 300",
        "",
      ].join("\n"),
    }
  }
  const server: Record<string, unknown> = { command, args, env }
  if (host === "cursor" || host === "vscode-copilot") server.type = "stdio"
  if (host === "cline") Object.assign(server, { disabled: false, autoApprove: [] })
  if (host === "roo") Object.assign(server, { disabled: false, alwaysAllow: [] })
  return {
    host,
    format: "json",
    destination: destinations[host],
    content: JSON.stringify({ mcpServers: { opencomms: server } }, null, 2) + "\n",
  }
}
