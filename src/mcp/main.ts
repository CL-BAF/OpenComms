/**
 * OpenComms MCP stdio server entrypoint.
 *
 * One process serves ONE pinned channel member. The installer writes the pin:
 *   OPENCOMMS_MEMBER_ID=<member session id>   (required)
 *   OPENCOMMS_MEMBER_ROLE=<role label>        (informational)
 *   OPENCOMMS_CHANNEL=<channel>               (informational)
 *
 * JSON-RPC 2.0 over stdio only — no network listener, no LAN exposure.
 */

import { resolve } from "node:path"
import { McpStdioServer } from "./server.js"
import { buildMcpToolDefs } from "./opencomms-tools.js"
import { pinnedMember } from "./identity.js"
import { StateStore } from "../core/store.js"
import type { State, ToolResult } from "../core/types.js"
import type { McpToolDef } from "./server.js"

/** Programmatic entry (used by tests and host launchers). */
export function serve(opts: { projectDir: string; host: string; admin: boolean }): void {
  const store = new StateStore(resolve(opts.projectDir))
  const projectId = process.env["OPENCOMMS_PROJECT_ID"] ?? "local-project"
  const tools = buildMcpToolDefs(
    store,
    { host: opts.host, admin: opts.admin, projectId, worktree: resolve(opts.projectDir) },
    {
      mutate: (mutate: (state: State) => ToolResult) =>
        store.withLock(() => {
          const state = store.load()
          const result = mutate(state)
          if (result.ok) store.save(state)
          return result
        }),
      readState: () => store.load(),
    },
  )
  const server = new McpStdioServer({ name: "opencomms", version: "2.0.0", tools })
  const pin = pinnedMember()
  server.log(
    `ready (pinned: ${pin ? "yes" : "NO — tools will deny"}, host: ${opts.host}, admin: ${opts.admin ? "yes" : "no"}, project: ${opts.projectDir})`,
  )
  server.listen()
}

/** CLI entry: node opencomms-mcp.mjs <project-dir> [--host <id>] [--admin] */
function cli(argv: string[]): void {
  let projectDir = process.cwd()
  let host = "mcp"
  let admin = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--host") host = argv[++i] ?? host
    else if (a === "--admin") admin = true
    else if (a && !a.startsWith("--")) projectDir = a
  }
  serve({ projectDir: resolve(projectDir), host, admin })
}

// Run the CLI only when executed directly (not when imported by tests).
// Matches every shipped filename: dist/mcp/main.js, installed
// opencomms-mcp.mjs, .mcpb bundle server/main.mjs.
const invoked = process.argv[1]?.replace(/\\/g, "/") ?? ""
if (
  /mcp[\\/]main\.(js|mjs|ts)$/.test(invoked) ||
  /opencomms-mcp\.mjs$/.test(invoked) ||
  /[\\/]server[\\/]main\.(mjs|js)$/.test(invoked)
) {
  cli(process.argv.slice(2))
}
