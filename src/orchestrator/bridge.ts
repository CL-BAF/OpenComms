/**
 * Allowlisted stdio bridge to the same core operations as HTTP.
 * Announce first; execute nothing before handshake acknowledgement.
 * Requests run sequentially with bounded frames. Args and tokens are never logged.
 */

import { StringDecoder } from "node:string_decoder"
import { VERSION } from "../version.js"
import type { OrchestratorApi, ApiResult } from "./api.js"

/** The identity string the Rust host expects in the handshake. */
export const BRIDGE_IDENTITY = "opencomms-coordinator"
/** Wire protocol version (bump only on a breaking shape change). */
export const BRIDGE_PROTOCOL = 1

/** Deny-by-default command list; the Rust allowlist must match exactly. */
export const BRIDGE_COMMANDS = [
  "nodes_list",
  "agents_list",
  "tasks_list",
  "events_list",
  "trust_view",
  "sessions_list",
  "session_members",
  "session_detail",
  "session_join_command",
  "capabilities",
  "workspace_state",
  "integrations_list",
  "integrations_overview",
  "diagnostics",
  "runtimes_list",
  "audit_log",
  "task_get",
  "context_list",
  "context_handoff",
  "permissions_list",
  "integration_bootstrap",
  "team_template_list",

  "session_create",
  "session_save",
  "session_resume",
  "session_delete",
  "session_pause",
  "session_unpause",
  "member_remove",
  "agent_create",
  "agent_link",
  "emergency_stop",
  "agent_stop",
  "agent_restart",
  "task_assign",
  "task_transition",
  "task_reassign",
  "team_template_save",
  "team_template_delete",
  "context_add",
  "node_approve",
  "node_revoke",
  "workspace_select",
  "integration_action",
  "permission_respond",
] as const

export type BridgeCommand = (typeof BRIDGE_COMMANDS)[number]

/** The handshake announcement — the sidecar's FIRST stdout line. */
export function handshakeAnnouncement(): string {
  return JSON.stringify({
    hello: BRIDGE_IDENTITY,
    protocol: BRIDGE_PROTOCOL,
    version: VERSION,
    api: [...BRIDGE_COMMANDS],
  })
}

export interface BridgeDeps {
  /** The SAME OrchestratorApi the HTTP routes call (no logic duplication). */
  api: OrchestratorApi
  /** Refresh project-bound API and closures before each serialized command. */
  getCoreDeps?: () => BridgeCoreDeps | null
  /** Shared transport envelope/redaction supplied by the active project. */
  normalizeResult?: (result: ApiResult) => ApiResult
  /** Share mutation lifetime tracking with HTTP before project selection. */
  withMutation?: <T>(fn: () => Promise<T>) => Promise<T>
  /** Inject active GUI closures so both transports share project-bound state. */
  guiReads: {
    sessions: () => ApiResult
    sessionMembers: (name: string) => ApiResult
    sessionDetail?: (name: string) => ApiResult
    sessionJoinCommand?: (name: string, host: string, role: string) => ApiResult
    capabilities?: () => ApiResult
    workspaceState: () => ApiResult
    integrationsList: () => ApiResult
    integrationsOverview?: () => Promise<ApiResult>
    integrationBootstrap?: () => ApiResult | Promise<ApiResult>
    diagnostics: () => ApiResult
  }
  /** The GUI-server session mutations (same lock + engine fns as routes). */
  guiWrites: {
    sessionCreate: (body: Record<string, unknown>) => Promise<ApiResult>
    sessionSave: (body: Record<string, unknown>) => Promise<ApiResult>
    sessionResume: (body: Record<string, unknown>) => Promise<ApiResult>
    sessionDelete: (body: Record<string, unknown>) => Promise<ApiResult>
    setSessionPaused: (body: Record<string, unknown>, paused: boolean) => Promise<ApiResult>
    memberRemove: (body: Record<string, unknown>) => Promise<ApiResult>
    workspaceSelect: (body: Record<string, unknown>) => Promise<ApiResult>
    integrationAction?: (body: Record<string, unknown>) => Promise<ApiResult>
    agentCreate?: (body: Record<string, unknown>) => Promise<ApiResult>
    taskAssign?: (body: Record<string, unknown>) => Promise<ApiResult>
    taskReassign?: (taskId: string, body: Record<string, unknown>) => Promise<ApiResult>
    agentLink?: (body: Record<string, unknown>) => Promise<ApiResult>
    emergencyStop?: (body: Record<string, unknown>) => Promise<ApiResult>
  }
  /** Test seam / production: write one response line (process.stdout). */
  write: (line: string) => void
  /** Handshake timeout (gate A): ms the sidecar waits before its first line. */
  handshakeTimeoutMs?: number
  /** Injected error sink (production: process.stderr; tests: collector). */
  error: (message: string) => void
}

export type BridgeCoreDeps = Omit<BridgeDeps, "write" | "error" | "handshakeTimeoutMs">

/** One enumerated command contract: no wildcard or URL/proxy dispatch. */
const COMMAND_SET: ReadonlySet<string> = new Set(BRIDGE_COMMANDS)
const MUTATING_COMMANDS: ReadonlySet<string> = new Set(BRIDGE_COMMANDS.slice(BRIDGE_COMMANDS.indexOf("session_create")))

export interface BridgeRequest {
  id: string
  cmd: string
  args: Record<string, unknown>
}

/** Parse one request line; null when unparseable (responds with an error). */
export function parseBridgeRequest(line: string): BridgeRequest | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // JSON parser errors can quote the input (including tokens).
    return { error: "invalid JSON request" }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { error: "request must be a JSON object" }
  const rec = parsed as Record<string, unknown>
  const id = typeof rec["id"] === "string" ? rec["id"] : null
  const cmd = typeof rec["cmd"] === "string" ? rec["cmd"] : null
  if (!id || !cmd) return { error: 'request requires string "id" and "cmd"' }
  if (id.length > 128 || cmd.length > 64) return { error: "request identifier or command is too long" }
  if (
    rec["args"] !== undefined &&
    (typeof rec["args"] !== "object" || rec["args"] === null || Array.isArray(rec["args"]))
  )
    return { error: "request args must be a JSON object" }
  const args = (rec["args"] ?? {}) as Record<string, unknown>
  return { id, cmd, args }
}

/** Route one allowlisted request; the delegated core enforces authorization. */
export async function dispatchBridgeCommand(deps: BridgeDeps, req: BridgeRequest): Promise<ApiResult> {
  if (!COMMAND_SET.has(req.cmd)) {
    return {
      ok: false,
      message: "unknown command; native operations must use the explicit operation allowlist",
      data: { code: "unsupported" },
    }
  }
  if (deps.getCoreDeps) {
    const current = deps.getCoreDeps()
    if (!current)
      return { ok: false, message: "Select a project before this operation.", data: { code: "not_configured" } }
    deps = { ...deps, ...current }
  }
  // Stable caller identifiers are retained for durable task idempotency;
  // otherwise the originating transport request supplies the correlation.
  req = { ...req, args: { request_id: req.id, operation_id: req.args["request_id"] ?? req.id, ...req.args } }
  const dispatch = async () => {
    const result = await dispatchResolvedCommand(deps, req)
    return deps.normalizeResult?.(result) ?? result
  }
  return MUTATING_COMMANDS.has(req.cmd) && deps.withMutation ? deps.withMutation(dispatch) : dispatch()
}

async function dispatchResolvedCommand(deps: BridgeDeps, req: BridgeRequest): Promise<ApiResult> {
  const api = deps.api
  switch (req.cmd) {
    case "nodes_list":
      return api.listNodes()
    case "agents_list":
      return api.listAgents()
    case "tasks_list":
      return api.listTasks()
    case "events_list": {
      const since = Number(req.args["since"] ?? "0")
      return api.listEvents(Number.isFinite(since) ? since : 0)
    }
    case "trust_view":
      return api.trustView()
    case "sessions_list":
      return deps.guiReads.sessions()
    case "capabilities":
      return deps.guiReads.capabilities?.() ?? unavailable("capabilities")
    case "session_detail": {
      const name = stringArg(req.args, "name")
      if (!name) return invalid("session_detail requires args.name")
      return deps.guiReads.sessionDetail?.(name) ?? unavailable("session_detail")
    }
    case "session_join_command": {
      const name = stringArg(req.args, "name")
      const host = stringArg(req.args, "host") || "opencode"
      const role = stringArg(req.args, "role") || "<role>"
      if (!name) return invalid("session_join_command requires args.name")
      return deps.guiReads.sessionJoinCommand?.(name, host, role) ?? unavailable("session_join_command")
    }
    case "audit_log":
      // Owner-only (confirm-token gate enforced inside auditLog); relays the
      // token verbatim — the bridge never logs bodies.
      return api.auditLog(req.args)
    case "session_members": {
      const name = typeof req.args["name"] === "string" ? req.args["name"] : ""
      if (!name) return { ok: false, message: "session_members requires args.name" }
      return deps.guiReads.sessionDetail?.(name) ?? deps.guiReads.sessionMembers(name)
    }
    case "workspace_state":
      return deps.guiReads.workspaceState()
    case "integrations_list":
      return deps.guiReads.integrationsList()
    case "integrations_overview":
      return deps.guiReads.integrationsOverview?.() ?? unavailable("integrations_overview")
    case "integration_bootstrap":
      return deps.guiReads.integrationBootstrap?.() ?? unavailable("integration_bootstrap")
    case "diagnostics":
      return deps.guiReads.diagnostics()
    case "runtimes_list": {
      const nodeId = typeof req.args["node_id"] === "string" ? req.args["node_id"] : ""
      if (!nodeId) return { ok: false, message: "runtimes_list requires args.node_id" }
      return api.listRuntimes(nodeId)
    }

    case "session_create":
      return deps.guiWrites.sessionCreate(req.args)
    case "session_save":
      return deps.guiWrites.sessionSave(req.args)
    case "session_resume":
      return deps.guiWrites.sessionResume(req.args)
    case "session_delete":
      return deps.guiWrites.sessionDelete(req.args)
    case "session_pause":
    case "session_unpause": {
      const paused = req.cmd === "session_pause"
      return deps.guiWrites.setSessionPaused(req.args, paused)
    }
    case "member_remove":
      return deps.guiWrites.memberRemove(req.args)
    case "agent_create":
      return deps.guiWrites.agentCreate?.(req.args) ?? api.createAgent(req.args)
    case "agent_link":
      return deps.guiWrites.agentLink?.(req.args) ?? unavailable("agent_link")
    case "emergency_stop":
      return deps.guiWrites.emergencyStop?.(req.args) ?? unavailable("emergency_stop")
    case "agent_stop":
      return api.stopAgent(req.args)
    case "agent_restart":
      return api.restartAgent(req.args)
    case "task_assign":
      return deps.guiWrites.taskAssign?.(req.args) ?? api.assignTask(req.args)
    case "task_get": {
      const taskId = stringArg(req.args, "task_id")
      return taskId ? api.getTask(taskId) : invalid("task_get requires args.task_id")
    }
    case "task_transition": {
      const taskId = stringArg(req.args, "task_id")
      return taskId ? api.transitionTask(taskId, req.args) : invalid("task_transition requires args.task_id")
    }
    case "task_reassign": {
      const taskId = stringArg(req.args, "task_id")
      return taskId
        ? (deps.guiWrites.taskReassign?.(taskId, { ...req.args, actor_id: "operator" }) ??
            api.reassignTask(taskId, { ...req.args, actor_id: "operator" }))
        : invalid("task_reassign requires args.task_id")
    }
    case "team_template_list":
      return api.listTeamTemplates()
    case "team_template_save":
      return api.saveTeamTemplate(req.args)
    case "team_template_delete": {
      const templateId = stringArg(req.args, "template_id")
      return templateId
        ? api.deleteTeamTemplate(templateId, req.args)
        : invalid("team_template_delete requires args.template_id")
    }
    case "context_list":
      return api.listContext(stringArg(req.args, "query") || stringArg(req.args, "q"))
    case "context_add":
      return api.addContext(req.args)
    case "context_handoff":
      return api.contextHandoff()
    case "permissions_list": {
      const agentId = stringArg(req.args, "agent_id")
      return agentId ? api.listPermissions(agentId) : invalid("permissions_list requires args.agent_id")
    }
    case "permission_respond": {
      const agentId = stringArg(req.args, "agent_id")
      const permissionId = stringArg(req.args, "permission_id")
      return agentId && permissionId
        ? api.respondPermission(agentId, permissionId, req.args)
        : invalid("permission_respond requires args.agent_id and args.permission_id")
    }
    case "node_approve":
      return api.approveOrRevoke(req.args, "approve")
    case "node_revoke":
      return api.approveOrRevoke(req.args, "revoke")
    case "workspace_select":
      return deps.guiWrites.workspaceSelect(req.args)
    case "integration_action":
      return deps.guiWrites.integrationAction?.(req.args) ?? unavailable("integration_action")
    default:
      return { ok: false, message: `unknown command "${req.cmd}"` }
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? args[key] : ""
}

function unavailable(operation: string): ApiResult {
  return {
    ok: false,
    message: `This coordinator does not support ${operation}. Update or repair OpenComms.`,
    data: { code: "unsupported", operation },
  }
}

function invalid(message: string): ApiResult {
  return { ok: false, message, data: { code: "invalid_request" } }
}

function respond(deps: BridgeDeps, req: BridgeRequest, result: ApiResult): void {
  const metadata = result as ApiResult & { code?: string; error?: { state: string; recovery?: string } }
  const data = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : null
  const code = metadata.code ?? data?.["code"] ?? "failed"
  const state = [
    "unsupported",
    "not_configured",
    "authentication_required",
    "permission_denied",
    "temporarily_unavailable",
  ].includes(String(code))
    ? code
    : "execution_failed"
  const line = JSON.stringify({
    ...result,
    id: req.id,
    request_id: req.id,
    operation: req.cmd,
    ...(!result.ok
      ? {
          code,
          error: metadata.error ?? {
            state,
            recovery: "Inspect Diagnostics using the request ID; check the operation outcome before retrying.",
          },
        }
      : {}),
    data: result.data ?? null,
  })
  deps.write(line)
}

/**
 * Announce first, then process one bounded request and response at a time.
 * Pre-ack input cannot execute. Errors never include bodies or credentials.
 */
export const BRIDGE_MAX_LINE_CHARS = 1_000_000

type BridgeLine = { line: string } | { error: "oversized" | "partial" }

/** Bound incomplete frames while receiving them, before JSON parsing. */
export async function* boundedBridgeLines(input: NodeJS.ReadableStream): AsyncGenerator<BridgeLine> {
  const decoder = new StringDecoder("utf8")
  let buffered = ""
  let oversized = false
  for await (const chunk of input as NodeJS.ReadableStream & AsyncIterable<Buffer | string>) {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk)
    let start = 0
    while (start < text.length) {
      const newline = text.indexOf("\n", start)
      const end = newline < 0 ? text.length : newline
      const fragment = text.slice(start, end)
      if (!oversized) {
        if (buffered.length + fragment.length > BRIDGE_MAX_LINE_CHARS) {
          buffered = ""
          oversized = true
        } else buffered += fragment
      }
      if (newline < 0) break
      yield oversized ? { error: "oversized" } : { line: buffered.replace(/\r$/, "") }
      buffered = ""
      oversized = false
      start = newline + 1
    }
  }
  const tail = decoder.end()
  if (oversized || buffered.length + tail.length > BRIDGE_MAX_LINE_CHARS) yield { error: "oversized" }
  else if (buffered.length > 0 || tail.length > 0) yield { error: "partial" }
}

export async function runBridge(deps: BridgeDeps, input: NodeJS.ReadableStream): Promise<void> {
  // HANDSHAKE FIRST: speak before listening (anti-spoofing; the Rust host
  // validates this line before writing any command).
  deps.write(handshakeAnnouncement())
  let handshakeDone = false
  const handshakeTimer = setTimeout(() => {
    // Stop if the host does not acknowledge the handshake within the timeout.
    deps.error(`bridge: no handshake validation within ${deps.handshakeTimeoutMs ?? 10_000}ms; exiting`)
    process.exit(2)
  }, deps.handshakeTimeoutMs ?? 10_000)
  handshakeTimer.unref?.()

  try {
    // Sequential dispatch and the bounded frame reader apply backpressure
    // without retaining arbitrary incomplete lines in readline's buffer.
    for await (const frame of boundedBridgeLines(input)) {
      if ("error" in frame) {
        if (!handshakeDone) continue
        const message =
          frame.error === "oversized"
            ? `request line too large (max ${BRIDGE_MAX_LINE_CHARS} chars)`
            : "incomplete request line; operation was not executed"
        deps.error(
          frame.error === "oversized" ? "bridge: oversized request rejected" : "bridge: incomplete request rejected",
        )
        deps.write(JSON.stringify({ id: null, ok: false, code: "invalid_request", message }))
        continue
      }
      const line = frame.line
      if (!handshakeDone) {
        // The sidecar ignores stdin until the host has acknowledged the
        // handshake (the Rust side sends `{"hello_ok":true}` as the ack).
        // Anything else pre-ack is dropped WITHOUT execution.
        let ack: unknown = null
        try {
          ack = JSON.parse(line)
        } catch {
          continue
        }
        if (ack !== null && typeof ack === "object" && (ack as Record<string, unknown>)["hello_ok"] === true) {
          handshakeDone = true
          clearTimeout(handshakeTimer)
        }
        continue
      }
      const req = parseBridgeRequest(line)
      if ("error" in req) {
        deps.write(JSON.stringify({ id: null, ok: false, message: req.error }))
        continue
      }
      try {
        const result = await dispatchBridgeCommand(deps, req)
        respond(deps, req, result)
      } catch {
        // Exception messages can contain request bodies or credentials.
        // Log the bounded allowlisted operation and correlation id only.
        deps.error(`bridge dispatch failed for ${req.cmd}`)
        respond(deps, req, { ok: false, message: "Operation failed. Use the request identifier in diagnostics." })
      }
    }
  } finally {
    clearTimeout(handshakeTimer)
  }
}

export function handshakeAnnouncementLine(): string {
  return handshakeAnnouncement()
}
