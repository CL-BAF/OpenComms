/**
 * `opencomms task` + `opencomms members remove` + `opencomms session create`
 * (M4 CLI-parity verbs, Platform — docs/gui-cli-parity.md §3).
 *
 * Thin loopback HTTP clients over the Orchestrator API (contract v0.3 §3 +
 * the session engine operator routes) — never imports src/orchestrator/**
 * (contract §8 rule). Exit codes follow contract v0.2 §8: 0 ok · 1 generic ·
 * 2 validation · 3 conflict · 4 trust_denied · 5 unknown · 6 internal.
 */

export interface TaskCliResult {
  code: number
  output: string
}

function ok(output: string): TaskCliResult {
  return { code: 0, output }
}
function fail(code: number, output: string): TaskCliResult {
  return { code, output }
}

function flagValue(tokens: string[], name: string): string | undefined {
  const idx = tokens.indexOf(name)
  return idx >= 0 ? tokens[idx + 1] : undefined
}

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

const BASE = `http://127.0.0.1:${process.env["OPENCOMMS_ORCH_API_PORT"] ?? 4919}`

async function callApi(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; payload: ApiResponse }> {
  let response: globalThis.Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return {
      status: 0,
      payload: {
        ok: false,
        message: `cannot reach the OpenComms console at ${BASE} (${(error as Error).message}). Is \`opencomms gui --server\` running?`,
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

export interface TaskDeps {
  fetch?: typeof globalThis.fetch
  base?: string
}

let injectedDeps: TaskDeps | null = null

/** Test hook: inject fetch/base before calling the task verbs. */
export function setTaskDeps(deps: TaskDeps | null): void {
  injectedDeps = deps
}

function effectiveBase(): string {
  return injectedDeps?.base ?? BASE
}

async function fetchJson(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; payload: ApiResponse }> {
  const base = injectedDeps?.base ?? BASE
  const fetchFn = injectedDeps?.fetch ?? globalThis.fetch.bind(globalThis)
  try {
    const response = await fetchFn(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30_000),
    })
    let payload: ApiResponse
    try {
      payload = (await response.json()) as ApiResponse
    } catch {
      payload = { ok: false, message: `console returned non-JSON (HTTP ${response.status})` }
    }
    return { status: response.status, payload }
  } catch (error) {
    return {
      status: 0,
      payload: {
        ok: false,
        message: `cannot reach the OpenComms console at ${base} (${(error as Error).message}). Is \`opencomms gui --server\` running?`,
      },
    }
  }
}

/** `opencomms task list` — wraps GET /api/orchestrator/tasks. */
export async function taskList(argv: string[]): Promise<TaskCliResult> {
  const asJson = argv.includes("--json")
  const { status, payload } = await fetchJson("/api/orchestrator/tasks")
  if (asJson)
    return { code: status === 200 && payload.ok ? 0 : exitCodeForStatus(status), output: JSON.stringify(payload) }
  if (!payload.ok || status !== 200) {
    return fail(exitCodeForStatus(status), payload.message ?? `task list failed (HTTP ${status})`)
  }
  const tasks = (payload.data as { tasks?: Array<Record<string, unknown>> })?.tasks ?? []
  if (tasks.length === 0) return ok("No tasks.")
  const lines = tasks.map(
    (t) =>
      `${String(t["id"])} ${String(t["title"])} | agent=${String(t["agent_id"])} | ${String(t["status"])}${t["channel"] ? ` | channel=${String(t["channel"])}` : ""}`,
  )
  return ok(lines.join("\n"))
}

/** `opencomms task assign` — wraps POST /api/orchestrator/tasks/assign. */
export async function taskAssign(argv: string[]): Promise<TaskCliResult> {
  const agentId = flagValue(argv, "--agent")
  const title = flagValue(argv, "--title")
  const body = flagValue(argv, "--body")
  const channel = flagValue(argv, "--channel")
  const missing: string[] = []
  if (!agentId) missing.push("--agent <agent_id>")
  if (!title) missing.push("--title <title>")
  if (!body) missing.push("--body <text>")
  if (!channel) missing.push("--channel <channel>")
  if (missing.length > 0) {
    return fail(
      2,
      `task assign requires: ${missing.join(", ")}\nUsage: opencomms task assign --agent <id> --title <t> --body <text> --channel <ch> [--json]`,
    )
  }
  const asJson = argv.includes("--json")
  const { status, payload } = await fetchJson("/api/orchestrator/tasks/assign", {
    method: "POST",
    body: { agent_id: agentId, task: { title, body, channel } },
  })
  if (asJson)
    return { code: status === 200 && payload.ok ? 0 : exitCodeForStatus(status), output: JSON.stringify(payload) }
  if (!payload.ok) return fail(exitCodeForStatus(status), payload.message ?? `task assign failed (HTTP ${status})`)
  return ok(String(payload.message ?? `Task assigned to ${agentId}.`))
}

/**
 * `opencomms members remove <channel> <session_id>` — wraps the existing
 * operator remove route (POST /api/sessions/{name}/members/remove).
 */
export async function membersRemove(argv: string[]): Promise<TaskCliResult> {
  const positional = argv.filter((t) => !t.startsWith("--"))
  const channel = positional[0]
  const sessionId = positional[1]
  if (!channel || !sessionId) {
    return fail(2, "Usage: opencomms members remove <channel> <session_id> [--json]")
  }
  const asJson = argv.includes("--json")
  const { status, payload } = await fetchJson(`/api/sessions/${encodeURIComponent(channel)}/members/remove`, {
    method: "POST",
    body: { target_session_id: sessionId },
  })
  if (asJson)
    return { code: status === 200 && payload.ok ? 0 : exitCodeForStatus(status), output: JSON.stringify(payload) }
  if (!payload.ok) return fail(exitCodeForStatus(status), payload.message ?? `member remove failed (HTTP ${status})`)
  return ok(String(payload.message ?? `Member ${sessionId} removed from ${channel}.`))
}

/**
 * `opencomms session create` — HONEST PARTIAL (gui-cli-parity.md §3, Lead
 * decision M4): there is NO loopback HTTP route for channel creation in
 * src/gui/server.ts (the engine's create flow is engine-function-only),
 * so this verb intentionally returns the honest "API-only" answer instead
 * of inventing a route. If Backend adds /api/channels, wire it here.
 */
export async function sessionCreate(argv: string[]): Promise<TaskCliResult> {
  const name = flagValue(argv, "--channel") ?? flagValue(argv, "--name")
  const as = flagValue(argv, "--as")
  const rolePrompt = flagValue(argv, "--role-prompt") ?? flagValue(argv, "--prompt")
  if (!name || !as || !rolePrompt) {
    return fail(2, 'Usage: opencomms session create --channel <name> --as <role> --prompt "..." [--json]')
  }
  return fail(
    5,
    "session create has no loopback HTTP route (the engine's create flow is API-only in M4). " +
      "Use the GUI (Sessions → New session) or the API directly; the CLI verb lands when the server route exists.",
  )
}
