/**
 * M4.6 orchestrator MCP tools (docs/mcp-orchestrator-tools.md §3).
 *
 * Thin wrappers on the existing OrchestratorApi — every trust gate
 * (confirm token, agent eligibility, condition C grant checks, Lead
 * protection) lives in the API fns and applies identically over MCP.
 * NO new enforcement surface.
 *
 * Principal classes gate the tool registry (§1): read/tools for everyone,
 * operator tools only for operator-class instances (--admin), and
 * human-present tools (node approve/revoke/pair) REQUIRE the confirm
 * token as a tool argument — apps can never self-supply it because the
 * token is never tool-readable (M1 design, transport-independent).
 */

import type { OrchestratorApi, ApiResult } from "../orchestrator/api.js"
import type { McpToolDef, ToolPayload } from "./server.js"

export interface OrchestratorToolDeps {
  /** The SAME OrchestratorApi (constructed beside the HTTP/bridge core). */
  api: OrchestratorApi
  /** MCP server flags (§1): admin enables operator-class tools. */
  admin: boolean
}

export function orchestratorTools(api: OrchestratorApi, admin: boolean): Array<McpToolDef> {
  const tools: Array<McpToolDef> = []

  // ---------- read ----------
  tools.push({
    name: "opencomms_agent_list",
    description: "List orchestrator-managed agents (id, name, role, status, node, designated Lead marker). Read-only.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>): Promise<ToolPayload> {
      const result = api.listAgents()
      return toPayload(result)
    },
  })
  tools.push({
    name: "opencomms_agent_status",
    description: "Full record for one orchestrator agent (spawn command redacted). Read-only.",
    inputSchema: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] },
    async execute(args: Record<string, unknown>): Promise<ToolPayload> {
      return toPayload(api.getAgent(String(args["agent_id"] ?? "")))
    },
  })
  tools.push({
    name: "opencomms_task_list",
    description: "List tasks with engine-derived status (queued/delivered/acked). Read-only.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>): Promise<ToolPayload> {
      return toPayload(api.listTasks())
    },
  })
  tools.push({
    name: "opencomms_node_list",
    description: "List orchestrator nodes (local + approved/pending remote). Read-only.",
    inputSchema: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>): Promise<ToolPayload> {
      return toPayload(api.listNodes())
    },
  })
  tools.push({
    name: "opencomms_events_list",
    description: "Orchestrator activity feed (cursor-paginated via since). Read-only.",
    inputSchema: { type: "object", properties: { since: { type: "number" } } },
    async execute(args: Record<string, unknown>): Promise<ToolPayload> {
      const since = typeof args["since"] === "number" ? args["since"] : 0
      return toPayload(api.listEvents(since))
    },
  })

  if (admin) {
    // ---------- operator (requires --admin MCP instance) ----------
    tools.push({
      name: "opencomms_agent_create",
      description:
        "Create + spawn an orchestrator agent (name, role, role_prompt, model REQUIRED, optional remote node_id — condition C grant check applies server-side). Operator-class.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          role_prompt: { type: "string" },
          model: { type: "string" },
          node_id: { type: "string" },
          designated: { type: "string" },
        },
        required: ["name", "role", "role_prompt"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolPayload> {
        return toPayload(await api.createAgent(args))
      },
    })
    tools.push({
      name: "opencomms_agent_stop",
      description: "Stop an orchestrator agent (Lead-protected server-side). Operator-class.",
      inputSchema: {
        type: "object",
        properties: { agent_id: { type: "string" }, force: { type: "boolean" } },
        required: ["agent_id"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolPayload> {
        return toPayload(await api.stopAgent(args))
      },
    })
    tools.push({
      name: "opencomms_agent_restart",
      description: "Restart an orchestrator agent (identity adoption server-side). Operator-class.",
      inputSchema: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] },
      async execute(args: Record<string, unknown>): Promise<ToolPayload> {
        return toPayload(await api.restartAgent(args))
      },
    })
    tools.push({
      name: "opencomms_task_assign",
      description:
        "Assign a task to an agent via its channel (title, body, channel). Agent eligibility + channel budgets server-enforced. Operator-class.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string" },
          task: {
            type: "object",
            properties: { title: { type: "string" }, body: { type: "string" }, channel: { type: "string" } },
          },
        },
        required: ["agent_id", "task"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolPayload> {
        return toPayload(await api.assignTask(args))
      },
    })
  }

  // ---------- human-present (confirm token REQUIRED as an argument) ----------
  tools.push({
    name: "opencomms_node_approve",
    description:
      "OWNER ACTION: approve a pending remote node. REQUIRES confirm_token (the owner's token, typed into this call — apps cannot self-supply it).",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string" }, confirm_token: { type: "string" } },
      required: ["node_id", "confirm_token"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolPayload> {
      return toPayload(await api.approveOrRevoke(args, "approve"))
    },
  })
  tools.push({
    name: "opencomms_node_revoke",
    description:
      "OWNER ACTION: revoke a remote node (stops its agents gracefully or marks them lost). REQUIRES confirm_token.",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string" }, confirm_token: { type: "string" } },
      required: ["node_id", "confirm_token"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolPayload> {
      return toPayload(await api.approveOrRevoke(args, "revoke"))
    },
  })
  tools.push({
    name: "opencomms_node_pair",
    description:
      "OWNER ACTION: generate a one-time pairing code for a new node. REQUIRES confirm_token. The raw code is shown once.",
    inputSchema: {
      type: "object",
      properties: { node_name: { type: "string" }, confirm_token: { type: "string" } },
      required: ["node_name", "confirm_token"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolPayload> {
      return toPayload(await api.createPairingCode(args))
    },
  })

  return tools
}

function toPayload(result: ApiResult): ToolPayload {
  if (result.ok) {
    return {
      text: JSON.stringify({ ok: true, message: result.message, data: result.data }),
      isError: false,
    }
  }
  return {
    text: JSON.stringify({ ok: false, message: result.message }),
    isError: true,
  }
}
