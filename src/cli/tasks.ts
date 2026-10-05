/** Loopback clients for task, member and session operations. */

import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

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

export interface TaskDeps {
  fetch?: typeof globalThis.fetch
  base?: string
}

let injectedDeps: TaskDeps | null = null

export function setTaskDeps(deps: TaskDeps | null): void {
  injectedDeps = deps
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
      `${String(t["task_id"])} ${String(t["title"])} | owner=${String(t["owner"] ?? t["agent_id"])} | execution=${String(t["execution_state"] ?? "unknown")} | delivery=${String(t["delivery_state"] ?? t["status"])}${t["blocker"] ? ` | blocker=${String(t["blocker"])}` : ""}${t["channel"] ? ` | channel=${String(t["channel"])}` : ""}`,
  )
  return ok(lines.join("\n"))
}

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
  const requestId = flagValue(argv, "--request-id") ?? randomUUID()
  const repeated = (flag: string): string[] =>
    argv.flatMap((token, i) => (token === flag && argv[i + 1] ? [argv[i + 1]!] : []))
  const { status, payload } = await fetchJson("/api/orchestrator/tasks/assign", {
    method: "POST",
    body: {
      agent_id: agentId,
      request_id: requestId,
      task: {
        title,
        body,
        channel,
        scope: flagValue(argv, "--scope"),
        acceptance_criteria: repeated("--criterion"),
        dependencies: repeated("--dependency"),
        ownership: repeated("--owns"),
      },
    },
  })
  if (asJson)
    return {
      code: status === 200 && payload.ok ? 0 : exitCodeForStatus(status),
      output: JSON.stringify({ ...payload, request_id: requestId }),
    }
  if (!payload.ok)
    return fail(
      exitCodeForStatus(status),
      `${payload.message ?? `task assign failed (HTTP ${status})`}\nrequest_id=${requestId}`,
    )
  return ok(`${payload.message ?? `Task assigned to ${agentId}.`}\nrequest_id=${requestId}`)
}

export async function taskShow(argv: string[]): Promise<TaskCliResult> {
  const id = flagValue(argv, "--id") ?? argv.find((t) => t.startsWith("tsk_"))
  if (!id) return fail(2, "Usage: opencomms task show <task_id> [--json]")
  const { status, payload } = await fetchJson(`/api/orchestrator/tasks/${encodeURIComponent(id)}`)
  return {
    code: payload.ok && status === 200 ? 0 : exitCodeForStatus(status),
    output: JSON.stringify(payload, null, argv.includes("--json") ? undefined : 2),
  }
}

/** Human operator transition; evidence/review JSON files avoid shell quoting. */
export async function taskTransition(argv: string[]): Promise<TaskCliResult> {
  const id = flagValue(argv, "--id") ?? argv.find((t) => t.startsWith("tsk_"))
  const state = flagValue(argv, "--state")
  const revision = Number(flagValue(argv, "--revision"))
  if (!id || !state || !Number.isInteger(revision) || revision < 1)
    return fail(
      2,
      "Usage: opencomms task transition <task_id> --state <state> --revision <n> [--blocker <reason>] [--evidence-file <json>] [--review-file <json>] [--json]",
    )
  const body: Record<string, unknown> = {
    state,
    expected_revision: revision,
    actor_id: "operator",
    blocker: flagValue(argv, "--blocker"),
  }
  try {
    for (const [flag, key] of [
      ["--evidence-file", "evidence"],
      ["--review-file", "review"],
      ["--criteria-file", "acceptance_criteria"],
      ["--artifacts-file", "artifacts"],
    ]) {
      const file = flagValue(argv, flag!)
      if (file) body[key!] = JSON.parse(readFileSync(file, "utf8"))
    }
  } catch (error) {
    return fail(2, `Cannot read transition JSON: ${(error as Error).message}`)
  }
  const { status, payload } = await fetchJson(`/api/orchestrator/tasks/${encodeURIComponent(id)}/transition`, {
    method: "POST",
    body,
  })
  return {
    code: payload.ok && status === 200 ? 0 : exitCodeForStatus(status),
    output: argv.includes("--json")
      ? JSON.stringify(payload)
      : (payload.message ?? `Transition failed (HTTP ${status})`),
  }
}

export async function taskReassign(argv: string[]): Promise<TaskCliResult> {
  const id = flagValue(argv, "--id") ?? argv.find((t) => t.startsWith("tsk_"))
  const agent = flagValue(argv, "--agent"),
    reason = flagValue(argv, "--reason")
  const revision = Number(flagValue(argv, "--revision"))
  if (!id || !agent || !reason || !Number.isInteger(revision) || revision < 1)
    return fail(
      2,
      "Usage: opencomms task reassign <task_id> --agent <id> --reason <context> --revision <n> [--channel <existing>] [--handoff-confirmed] [--allow-ownership-conflict] [--request-id <id>] [--json]",
    )
  const requestId = flagValue(argv, "--request-id") ?? randomUUID()
  const { status, payload } = await fetchJson(`/api/orchestrator/tasks/${encodeURIComponent(id)}/reassign`, {
    method: "POST",
    body: {
      actor_id: "operator",
      agent_id: agent,
      expected_revision: revision,
      request_id: requestId,
      reason,
      channel: flagValue(argv, "--channel"),
      handoff_confirmed: argv.includes("--handoff-confirmed"),
      allow_ownership_conflict: argv.includes("--allow-ownership-conflict"),
    },
  })
  return {
    code: payload.ok && status === 200 ? 0 : exitCodeForStatus(status),
    output: argv.includes("--json")
      ? JSON.stringify({ ...payload, request_id: requestId })
      : `${payload.message ?? `Handoff failed (HTTP ${status})`}\nrequest_id=${requestId}`,
  }
}

export async function taskContext(argv: string[]): Promise<TaskCliResult> {
  const sub = argv[0] ?? "list"
  let path = "/api/orchestrator/context"
  let init: { method?: string; body?: unknown } | undefined
  if (sub === "handoff") path += "/handoff"
  else if (sub === "list") path += `?query=${encodeURIComponent(flagValue(argv, "--search") ?? "")}`
  else if (sub === "add") {
    const file = flagValue(argv, "--record-file")
    if (!file) return fail(2, "Usage: opencomms task context add --record-file <context.json>")
    try {
      init = { method: "POST", body: JSON.parse(readFileSync(file, "utf8")) }
    } catch (error) {
      return fail(2, `Cannot read context JSON: ${(error as Error).message}`)
    }
  } else
    return fail(2, "Usage: opencomms task context <list|add|handoff> [--search <text>] [--record-file <json>] [--json]")
  const { status, payload } = await fetchJson(path, init)
  return {
    code: payload.ok && status === 200 ? 0 : exitCodeForStatus(status),
    output: JSON.stringify(payload, null, argv.includes("--json") ? undefined : 2),
  }
}

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

/** Channel creation has no loopback route; report the API-only limitation explicitly. */
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
