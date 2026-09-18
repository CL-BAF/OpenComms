/**
 * M4.5 bridge — line-based JSON-RPC over the sidecar's stdio
 * (docs/tauri-native-gui.md §8; ADR-0006 supersedes ADR-0004).
 *
 * The sidecar is spawned by the Rust host with the fixed argv
 * `bridge` and speaks FIRST (the handshake), then answers one line per
 * request. Every command maps 1:1 to the existing OrchestratorApi fns —
 * the same core the HTTP routes call, no logic duplication, and ALL
 * trust enforcement stays in the TS core (the Rust relay is shape +
 * routing only, per §3).
 *
 * Gate conditions implemented here:
 *   (A) HANDSHAKE TIMEOUT + IDEMPOTENCE: the adapter announces itself as
 *       its FIRST stdout line, then ignores stdin until the handshake is
 *       complete — no partial command execution pre-handshake. The RUST
 *       side kills on mismatch/timeout; the sidecar's own contribution is
 *       that it never treats pre-handshake input as commands.
 *   (C) IPC ALLOWLIST: only the §2 enumerated commands dispatch; unknown
 *       commands get a typed error, never a proxy.
 *   (D) token-over-IPC: token-bearing commands flow through the same
 *       OrchestratorApi gates; the adapter never logs args.
 *
 * One request line -> one response line. The sidecar NEVER writes
 * unprompted lines after the handshake (Phase 1: events via polling).
 */

import { createInterface } from "node:readline"
import { VERSION } from "../version.js"
import type { OrchestratorApi, ApiResult } from "./api.js"

/** The identity string the Rust host expects in the handshake. */
export const BRIDGE_IDENTITY = "opencomms-coordinator"
/** Wire protocol version (bump only on a breaking shape change). */
export const BRIDGE_PROTOCOL = 1

/**
 * The §2 IPC command surface — deny-by-default; unknown commands get a
 * typed error. Every entry maps to an OrchestratorApi call; the Rust
 * capabilities file must match this list EXACTLY (gate condition C).
 */
export const BRIDGE_COMMANDS = [
  // Read-only
  "nodes_list",
  "agents_list",
  "tasks_list",
  "events_list",
  "trust_view",
  "sessions_list",
  "session_members",
  "workspace_state",
  "integrations_list",
  "diagnostics",
  "runtimes_list",
  "audit_log",
  // Mutating (owner/operator actions)
  "session_create",
  "session_save",
  "session_resume",
  "session_delete",
  "session_pause",
  "session_unpause",
  "member_remove",
  "agent_create",
  "agent_stop",
  "agent_restart",
  "task_assign",
  "node_approve",
  "node_revoke",
  "workspace_select",
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
  /**
   * The GUI-server closures (sessions payload, workspace, integrations,
   * diagnostics) live in the HTTP route file — the bridge consumes them via
   * injected callables so BOTH transports share the same closures.
   */
  guiReads: {
    sessions: () => ApiResult
    sessionMembers: (name: string) => ApiResult
    workspaceState: () => ApiResult
    integrationsList: () => ApiResult
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
  }
  /** Test seam / production: write one response line (process.stdout). */
  write: (line: string) => void
  /** Handshake timeout (gate A): ms the sidecar waits before its first line. */
  handshakeTimeoutMs?: number
  /** Injected error sink (production: process.stderr; tests: collector). */
  error: (message: string) => void
}

/**
 * The core-half of BridgeDeps that the GUI server provides (api + closures);
 * the CLI's `bridge` dispatch supplies write/error (stdout/stderr).
 */
export type BridgeCoreDeps = Omit<BridgeDeps, "write" | "error" | "handshakeTimeoutMs">

/** Command name -> arg-shape validator (whitelist; unknown => typed error). */
const COMMAND_TABLE: Record<string, "none" | "body" | "nameArg"> = {
  nodes_list: "none",
  agents_list: "none",
  tasks_list: "none",
  events_list: "body", // { since }
  trust_view: "none",
  sessions_list: "none",
  session_members: "body", // { name }
  workspace_state: "none",
  integrations_list: "none",
  diagnostics: "none",
  runtimes_list: "body", // { node_id }
  audit_log: "body", // { confirm_token, since? } — owner-only; token never logged
  session_create: "body",
  session_save: "body",
  session_resume: "body",
  session_delete: "body",
  session_pause: "body",
  session_unpause: "body",
  member_remove: "body",
  agent_create: "body",
  agent_stop: "body",
  agent_restart: "body",
  task_assign: "body",
  node_approve: "body",
  node_revoke: "body",
  workspace_select: "body",
}

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
  } catch (error) {
    return { error: `invalid JSON request: ${(error as Error).message.slice(0, 120)}` }
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "request must be a JSON object" }
  const rec = parsed as Record<string, unknown>
  const id = typeof rec["id"] === "string" ? rec["id"] : null
  const cmd = typeof rec["cmd"] === "string" ? rec["cmd"] : null
  if (!id || !cmd) return { error: 'request requires string "id" and "cmd"' }
  const args =
    typeof rec["args"] === "object" && rec["args"] !== null && !Array.isArray(rec["args"])
      ? (rec["args"] as Record<string, unknown>)
      : {}
  return { id, cmd, args }
}

/**
 * Dispatch ONE request to the OrchestratorApi. Shape/routing only —
 * enforcement is in the core fns this delegates to.
 */
export async function dispatchBridgeCommand(deps: BridgeDeps, req: BridgeRequest): Promise<ApiResult> {
  const shape = COMMAND_TABLE[req.cmd]
  if (!shape) {
    return {
      ok: false,
      message: `unknown command "${req.cmd}" (the IPC surface is enumerated; see tauri-native-gui.md §2)`,
    }
  }
  const api = deps.api
  switch (req.cmd) {
    // ---- read-only ----
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
    case "audit_log":
      // Owner-only (confirm-token gate enforced inside auditLog); relays the
      // token verbatim — the bridge never logs bodies.
      return api.auditLog(req.args)
    case "session_members": {
      const name = typeof req.args["name"] === "string" ? req.args["name"] : ""
      if (!name) return { ok: false, message: "session_members requires args.name" }
      return deps.guiReads.sessionMembers(name)
    }
    case "workspace_state":
      return deps.guiReads.workspaceState()
    case "integrations_list":
      return deps.guiReads.integrationsList()
    case "diagnostics":
      return deps.guiReads.diagnostics()
    case "runtimes_list": {
      const nodeId = typeof req.args["node_id"] === "string" ? req.args["node_id"] : ""
      if (!nodeId) return { ok: false, message: "runtimes_list requires args.node_id" }
      return api.listRuntimes(nodeId)
    }
    // ---- mutating ----
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
      return api.createAgent(req.args)
    case "agent_stop":
      return api.stopAgent(req.args)
    case "agent_restart":
      return api.restartAgent(req.args)
    case "task_assign":
      return api.assignTask(req.args)
    case "node_approve":
      return api.approveOrRevoke(req.args, "approve")
    case "node_revoke":
      return api.approveOrRevoke(req.args, "revoke")
    case "workspace_select":
      return deps.guiWrites.workspaceSelect(req.args)
    default:
      return { ok: false, message: `unknown command "${req.cmd}"` }
  }
}

function respond(deps: BridgeDeps, req: BridgeRequest, result: ApiResult): void {
  const line =
    result.ok && result.data !== undefined
      ? JSON.stringify({ id: req.id, ok: true, data: result.data })
      : result.ok
        ? JSON.stringify({ id: req.id, ok: true, data: null })
        : JSON.stringify({ id: req.id, ok: false, message: result.message })
  deps.write(line)
}

/**
 * The bridge run loop: announce (handshake line), then one request line ->
 * one response line until stdin closes. Gate condition (A): stdin is
 * IGNORED until the handshake is written — no partial execution.
 * Gate condition (B): args are never logged — errors carry only the
 * command name and a typed reason.
 *
 * M5 (3) hardening:
 *  - PARTIAL LINES: requests are buffered per line (readline) and an
 *    oversized line (BRIDGE_MAX_LINE_CHARS) is rejected with a typed
 *    error — a truncated/hostile stream can never wedge the parser.
 *  - BACKPRESSURE: requests are processed SEQUENTIALLY (one at a time,
 *    await each dispatch before reading the next line) — the sidecar
 *    never interleaves responses or drops a request under load. The
 *    ordering guarantee matches the HTTP transport (one in-flight
 *    mutation per project at the lock level).
 *  - OVERSIZED PAYLOAD: args larger than the line cap are refused before
 *    dispatch (same class as the engine's 100k content cap).
 */
export const BRIDGE_MAX_LINE_CHARS = 1_000_000

export async function runBridge(deps: BridgeDeps, input: NodeJS.ReadableStream): Promise<void> {
  // HANDSHAKE FIRST: speak before listening (anti-spoofing; the Rust host
  // validates this line before writing any command).
  deps.write(handshakeAnnouncement())
  let handshakeDone = false
  const handshakeTimer = setTimeout(() => {
    // Gate (A): if the host never speaks after the announcement, the
    // sidecar stops serving (the Rust side also enforces its own timeout;
    // this is the sidecar-side idempotence half).
    deps.error(`bridge: no handshake validation within ${deps.handshakeTimeoutMs ?? 10_000}ms; exiting`)
    process.exit(2)
  }, deps.handshakeTimeoutMs ?? 10_000)
  handshakeTimer.unref?.()

  const rl = createInterface({ input, crlfDelay: Infinity })
  // Backpressure: sequential processing — one request fully dispatched and
  // responded before the next line is pulled from the queue. readline
  // buffers lines internally; we never skip or reorder.
  for await (const line of rl) {
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
    // M5 hardening: oversized line rejected BEFORE parsing (a truncated
    // stream or hostile host cannot wedge the adapter or exhaust memory).
    if (line.length > BRIDGE_MAX_LINE_CHARS) {
      deps.error(`bridge: request line exceeds ${BRIDGE_MAX_LINE_CHARS} chars; rejected`)
      deps.write(
        JSON.stringify({ id: null, ok: false, message: `request line too large (max ${BRIDGE_MAX_LINE_CHARS} chars)` }),
      )
      continue
    }
    const req = parseBridgeRequest(line)
    if ("error" in req) {
      deps.write(JSON.stringify({ id: null, ok: false, message: req.error }))
      continue
    }
    try {
      // Sequential dispatch = backpressure: slow core work naturally
      // paces the read loop; responses stay ordered per connection.
      const result = await dispatchBridgeCommand(deps, req)
      respond(deps, req, result)
    } catch (error) {
      // Gate (B): never log token-bearing args; the message only.
      deps.error(`bridge dispatch failed for ${req.cmd}: ${(error as Error).message}`)
      respond(deps, req, { ok: false, message: "bridge dispatch failed (see sidecar logs)" })
    }
  }
}

/** The handshake announcement line (exported for tests). */
export function handshakeAnnouncementLine(): string {
  return handshakeAnnouncement()
}
