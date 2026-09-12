/**
 * `opencomms agent` CLI (contract v0.2 §8, Platform).
 *
 * Thin HTTP client over the Orchestrator API on the loopback GUI server —
 * NEVER imports src/orchestrator/** (contract §8 rule: CLI consumes the same
 * API as the GUI). Verbs:
 *
 *   opencomms agent list     [--project <dir>] [--json]
 *   opencomms agent create --name <n> --host <h> --role <r> [--prompt <text>]
 *                          [--model <provider/model>] [--node <node_id>]
 *                          [--project <dir>] [--json]
 *   opencomms agent stop    <agent_id> [--force] [--json]
 *   opencomms agent restart <agent_id> [--json]
 *   opencomms agent status  <agent_id> [--json]
 *
 * Exit codes (contract v0.2 §8, adopted verbatim):
 *   0 ok · 1 generic failure (connection refused → hints the console may be
 *   down) · 2 CLI validation (pre-flight, no HTTP roundtrip) · 3 conflict
 *   (409) · 4 trust_denied (403) · 5 unknown (404) · 6 internal (500).
 * --json emits the raw API envelope verbatim (single line).
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

/** The GUI server's default port (opencomms gui). */
const DEFAULT_PORT = 4919
const BASE = `http://127.0.0.1:${process.env["OPENCOMMS_ORCH_API_PORT"] ?? DEFAULT_PORT}`

export interface AgentCliResult {
  code: number
  output: string
}

function ok(output: string): AgentCliResult {
  return { code: 0, output }
}
function fail(code: number, output: string): AgentCliResult {
  return { code, output }
}

function flagValue(tokens: string[], name: string): string | undefined {
  const idx = tokens.indexOf(name)
  return idx >= 0 ? tokens[idx + 1] : undefined
}

/** Map an HTTP status to the contract's exit code. */
function exitCodeForStatus(status: number): number {
  if (status === 400 || status === 422) return 2
  if (status === 403) return 4
  if (status === 404) return 5
  if (status === 409) return 3
  if (status >= 500) return 6
  return 1
}

interface ApiResponse {
  ok: boolean
  data?: unknown
  message?: string
}

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<globalThis.Response>

export interface AgentCommandDeps {
  /** Injected fetch for tests (default: global fetch). */
  fetch?: FetchLike
  /** Base URL override for tests (default: loopback console). */
  base?: string
}

let injectedDeps: AgentCommandDeps | null = null

/** Test hook: inject fetch/base before calling runAgentCommand. */
export function setAgentCommandDeps(deps: AgentCommandDeps | null): void {
  injectedDeps = deps
}

function effectiveDeps(): Required<Pick<AgentCommandDeps, "fetch" | "base">> {
  return { fetch: injectedDeps?.fetch ?? globalThis.fetch.bind(globalThis), base: injectedDeps?.base ?? BASE }
}

async function callApi(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; payload: ApiResponse }> {
  const deps = effectiveDeps()
  let response: globalThis.Response
  try {
    response = await deps.fetch(`${deps.base}${path}`, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    // Connection-level failure (server down): generic failure + hint.
    return {
      status: 0,
      payload: {
        ok: false,
        message: `cannot reach the OpenComms console at ${deps.base} (${(error as Error).message}). Is \`opencomms gui --server\` running?`,
      },
    }
  }
  let payload: ApiResponse
  try {
    payload = (await response.json()) as ApiResponse
  } catch {
    payload = { ok: false, message: `console returned non-JSON (HTTP ${response.status})` }
  }
  return { status: response.status, payload }
}

function jsonEnvelope(payload: ApiResponse): string {
  return JSON.stringify(payload)
}

/** Human renderer for the agents list (GET /api/orchestrator/agents). */
function renderAgentsList(data: unknown): string {
  const agents = (data as { agents?: Array<Record<string, unknown>> })?.agents ?? []
  if (agents.length === 0) return "No agents."
  const lines: string[] = []
  for (const a of agents) {
    const model = typeof a["model"] === "string" && a["model"] ? ` model=${a["model"]}` : ""
    lines.push(
      `${String(a["id"])} ${String(a["name"])} | ${String(a["role"])} (${String(a["host"])}) | ` +
        `${String(a["status"])} | node=${String(a["node_id"])}${model}`,
    )
  }
  return lines.join("\n")
}

/** Human renderer for a single agent (GET /agents/{id} or mutation result). */
function renderAgent(data: unknown): string {
  const a = data as Record<string, unknown>
  const fields: Array<[string, unknown]> = [
    ["id", a["id"]],
    ["name", a["name"]],
    ["status", a["status"]],
    ["role", a["role"]],
    ["host", a["host"]],
    ["node_id", a["node_id"]],
    ["model", a["model"]],
    ["worktree", a["worktree"]],
    ["host_session_id", a["host_session_id"]],
    ["last_heartbeat", a["last_heartbeat"]],
  ]
  return fields
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("\n")
}

/** Pre-flight validation (exit 2 before any HTTP call). */
function preValidate(sub: string, tokens: string[]): { ok: true; positional?: string } | { ok: false; usage: string } {
  switch (sub) {
    case "list":
      return { ok: true }
    case "create": {
      const missing: string[] = []
      if (!flagValue(tokens, "--name")) missing.push("--name <n>")
      if (!flagValue(tokens, "--host")) missing.push("--host <opencode>")
      if (!flagValue(tokens, "--role")) missing.push("--role <r>")
      if (missing.length > 0) {
        return {
          ok: false,
          usage: `agent create requires: ${missing.join(", ")}\nUsage: opencomms agent create --name <n> --host <h> --role <r> [--prompt "..."] [--model provider/model] [--node <id>] [--json]`,
        }
      }
      return { ok: true }
    }
    case "stop":
    case "restart":
    case "status": {
      const positional = tokens.find(
        (t, i) => i > 0 && !t.startsWith("--") && tokens[i - 1] !== "--project" && tokens[i - 1] !== "--prompt",
      )
      if (!positional) {
        return { ok: false, usage: `Usage: opencomms agent ${sub} <agent_id> [--json]` }
      }
      return { ok: true, positional }
    }
    default:
      return {
        ok: false,
        usage: "Usage: opencomms agent <list|create|stop|restart|status> [args] [--project <dir>] [--json]",
      }
  }
}

/**
 * Entry: `opencomms agent <sub> ...`. Async (HTTP). The GUI server's project
 * selection drives which orchestrator store is behind the API; --project is
 * accepted for CLI symmetry (the console resolves it from its workspace).
 */
export async function runAgentCommand(tokens: string[], projectDirFlag?: string): Promise<AgentCliResult> {
  const sub = (tokens[0] ?? "").toLowerCase()
  void projectDirFlag // the loopback API resolves the project server-side
  const pre = preValidate(sub, tokens)
  if (!pre.ok) return fail(2, pre.usage)

  const asJson = tokens.includes("--json")

  switch (sub) {
    case "list": {
      const { status, payload } = await callApi("/api/orchestrator/agents")
      if (asJson)
        return { code: status === 200 && payload.ok ? 0 : exitCodeForStatus(status), output: jsonEnvelope(payload) }
      if (!payload.ok || status !== 200) {
        return fail(exitCodeForStatus(status), payload.message ?? `agents list failed (HTTP ${status})`)
      }
      return ok(renderAgentsList(payload.data))
    }
    case "create": {
      const body: Record<string, unknown> = {
        name: flagValue(tokens, "--name"),
        host: flagValue(tokens, "--host") ?? "opencode",
        role: flagValue(tokens, "--role"),
        role_prompt: flagValue(tokens, "--prompt") ?? "",
      }
      const model = flagValue(tokens, "--model")
      if (model) body["model"] = model
      const nodeId = flagValue(tokens, "--node")
      if (nodeId) body["node_id"] = nodeId
      const { status, payload } = await callApi("/api/orchestrator/agents/create", { method: "POST", body })
      if (asJson)
        return { code: status === 200 && payload.ok ? 0 : exitCodeForStatus(status), output: jsonEnvelope(payload) }
      if (!payload.ok) {
        return fail(exitCodeForStatus(status), payload.message ?? `agent create failed (HTTP ${status})`)
      }
      const data = payload.data as Record<string, unknown> | undefined
      const agent = (data?.["agent"] ?? data) as Record<string, unknown> | undefined
      const lines = [`created: ${String(agent?.["id"] ?? "?")} (${String(agent?.["name"] ?? "")})`]
      if (typeof agent?.["spawn_cmd_redacted"] === "string") {
        lines.push(`spawn (redacted): ${agent["spawn_cmd_redacted"]}`)
      }
      return ok(lines.join("\n"))
    }
    case "stop": {
      const agentId = (pre as { ok: true; positional?: string }).positional ?? ""
      const body: Record<string, unknown> = { agent_id: agentId }
      if (tokens.includes("--force")) body["force"] = true
      const { status, payload } = await callApi("/api/orchestrator/agents/stop", { method: "POST", body })
      if (asJson)
        return { code: status === 200 && payload.ok ? 0 : exitCodeForStatus(status), output: jsonEnvelope(payload) }
      if (!payload.ok) return fail(exitCodeForStatus(status), payload.message ?? `agent stop failed (HTTP ${status})`)
      return ok(String(payload.message ?? `Agent ${agentId} stopped.`))
    }
    case "restart": {
      const agentId = (pre as { ok: true; positional?: string }).positional ?? ""
      const { status, payload } = await callApi("/api/orchestrator/agents/restart", {
        method: "POST",
        body: { agent_id: agentId },
      })
      if (asJson)
        return { code: status === 200 && payload.ok ? 0 : exitCodeForStatus(status), output: jsonEnvelope(payload) }
      if (!payload.ok)
        return fail(exitCodeForStatus(status), payload.message ?? `agent restart failed (HTTP ${status})`)
      return ok(String(payload.message ?? `Agent ${agentId} restarted.`))
    }
    case "status": {
      const agentId = (pre as { ok: true; positional?: string }).positional ?? ""
      const { status, payload } = await callApi(`/api/orchestrator/agents/${encodeURIComponent(agentId)}`)
      if (asJson)
        return { code: status === 200 && payload.ok ? 0 : exitCodeForStatus(status), output: jsonEnvelope(payload) }
      if (!payload.ok) return fail(exitCodeForStatus(status), payload.message ?? `agent status failed (HTTP ${status})`)
      return ok(renderAgent(payload.data))
    }
    default:
      return fail(2, "Usage: opencomms agent <list|create|stop|restart|status> [args] [--json]")
  }
}
