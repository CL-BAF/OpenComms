/** Managed ACP v1 sessions over an explicitly configured argv-only stdio agent. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { resolve } from "node:path"
import { resolveBinaryOverride, isWindowsShimPath } from "../../hosts/spawn-delivery.js"
import type { AgentHandle, AgentRuntime, PendingPermission, PermissionResponse } from "../runtime.js"
import type { AgentRecord, AgentRuntimeStatus } from "../state.js"

type Row = Record<string, unknown>
function row(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export interface AcpRuntimeOptions {
  projectDir: string
  /** Explicit operator configuration, e.g. { command:"gemini", args:["--experimental-acp"] }. */
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  turnTimeoutMs?: number
  /** Read-only protocol observation, useful for an explicit live verification harness. */
  onSessionUpdate?(params: unknown): void
}

class AcpConnection {
  private next = 0
  private buffer = ""
  private requests = new Map<
    number,
    { resolve(value: Row): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  private permissions = new Map<string, { id: string | number; payload: Row }>()
  private child: ChildProcessWithoutNullStreams
  private closed: Promise<void>
  private alive = true
  sessionId: string | null = null
  status: AgentRuntimeStatus = "starting"
  capabilities: Row = {}
  isAlive(): boolean {
    return this.alive
  }
  private promptPending: Promise<Row> | null = null

  constructor(
    readonly opts: AcpRuntimeOptions,
    command: string,
    args: string[],
  ) {
    this.child = spawn(command, args, {
      cwd: resolve(opts.projectDir),
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.closed = new Promise((resolve) => this.child.once("close", () => resolve()))
    // Stream decoding preserves UTF-8 characters split across pipe chunks.
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => this.receive(chunk))
    // Drain diagnostic output without logging host content or credentials.
    this.child.stderr.on("data", () => {})
    this.child.on("error", () => this.fail("ACP agent could not start; check configured executable/argv"))
    this.child.on("exit", () => this.fail("ACP agent disconnected; session outcome is unknown"))
    this.child.stdin.on("error", () => this.fail("ACP input stream disconnected"))
  }
  private fail(message: string): void {
    this.alive = false
    this.status = "stale"
    for (const request of this.requests.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(message))
    }
    this.requests.clear()
    this.permissions.clear()
  }
  private receive(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, "utf8") > 1_000_000) {
      this.fail("ACP response exceeded bounded protocol buffer")
      this.child.kill()
      return
    }
    for (;;) {
      const end = this.buffer.indexOf("\n")
      if (end < 0) return
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.fail("ACP agent emitted invalid protocol JSON")
        this.child.kill()
        return
      }
      if (!row(message) || message.jsonrpc !== "2.0") {
        this.fail("ACP agent emitted an invalid JSON-RPC envelope")
        this.child.kill()
        return
      }
      if (typeof message.method === "string") {
        if (message.id !== undefined) {
          if (
            message.method === "session/request_permission" &&
            row(message.params) &&
            message.params.sessionId === this.sessionId &&
            (typeof message.id === "string" || typeof message.id === "number")
          ) {
            if (this.permissions.size >= 128 && !this.permissions.has(String(message.id)))
              this.write({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32000, message: "Pending operator permission limit reached" },
              })
            else this.permissions.set(String(message.id), { id: message.id, payload: message.params })
          } else
            this.write({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Client capability unavailable or session identity mismatched" },
            })
        }
        // Observation never interprets host output as workflow control or task completion.
        if (message.method === "session/update" && row(message.params) && message.params.sessionId === this.sessionId) {
          try {
            this.opts.onSessionUpdate?.(message.params)
          } catch {
            /* observers cannot break protocol state */
          }
        }
        continue
      }
      if (typeof message.id !== "number") continue
      const request = this.requests.get(message.id)
      if (!request) continue
      this.requests.delete(message.id)
      clearTimeout(request.timer)
      if (message.error !== undefined) {
        const code = row(message.error) && typeof message.error.code === "number" ? message.error.code : "unknown"
        request.reject(new Error(`ACP request rejected (code ${code}); inspect host authentication/configuration`))
      } else if (row(message.result)) request.resolve(message.result)
      else request.reject(new Error("ACP response result must be an object"))
    }
  }
  private write(message: Row): void {
    if (!this.alive) throw new Error("ACP agent is disconnected")
    const wire = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(wire, "utf8") > 1_000_000) throw new Error("ACP request exceeds protocol size limit")
    this.child.stdin.write(wire)
  }
  request(method: string, params: Row, timeoutMs = this.opts.requestTimeoutMs ?? 15_000): Promise<Row> {
    return new Promise((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => {
        this.requests.delete(id)
        reject(new Error(`ACP ${method} timed out; outcome unknown`))
      }, timeoutMs)
      this.requests.set(id, { resolve, reject, timer })
      try {
        this.write({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.requests.delete(id)
        reject(error)
      }
    })
  }
  async initialize(): Promise<void> {
    const initialized = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "opencomms", version: "1.4.0" },
    })
    if (initialized.protocolVersion !== 1) throw new Error("ACP agent did not negotiate supported protocol version 1")
    this.capabilities = row(initialized.agentCapabilities) ? initialized.agentCapabilities : {}
  }
  handle(roleContext: string): AgentHandle {
    const connection = this
    return {
      async deliver(framed) {
        if (!connection.alive) return "failed"
        if (connection.promptPending || connection.status === "running") return "failed"
        connection.status = "running"
        connection.promptPending = connection.request(
          "session/prompt",
          { sessionId: connection.sessionId, prompt: [{ type: "text", text: `${roleContext}\n\n${framed}` }] },
          connection.opts.turnTimeoutMs ?? 180_000,
        )
        try {
          const result = await connection.promptPending
          if (typeof result.stopReason !== "string")
            throw new Error("ACP prompt response lacks stopReason; outcome unknown")
          connection.status = "idle"
          return "delivered"
        } catch (error) {
          connection.status = "stale"
          return /request rejected/.test(String(error)) ? "failed" : "uncertain"
        } finally {
          connection.promptPending = null
        }
      },
      async abort() {
        for (const permission of connection.permissions.values())
          connection.write({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "cancelled" } } })
        connection.permissions.clear()
        connection.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: connection.sessionId } })
        if (connection.promptPending) await connection.promptPending
      },
      async status() {
        return {
          status: connection.alive ? connection.status : "stale",
          detail: connection.permissions.size ? "awaiting operator permission" : undefined,
        }
      },
      async permissionsDrain() {
        return [...connection.permissions.entries()].map(([id, permission]): PendingPermission => ({
          permission_id: id,
          request: permission.payload,
        }))
      },
      async permissionsRespond(id: string, response: PermissionResponse) {
        const permission = connection.permissions.get(id)
        if (!permission) return { ok: false, message: "ACP permission request is absent or expired" }
        const options = Array.isArray(permission.payload.options) ? permission.payload.options.filter(row) : []
        // Never broaden a one-time operator answer into permanent authority.
        const selected = options.find((option) => option.kind === (response === "allow" ? "allow_once" : "reject_once"))
        if (response === "allow" && (!selected || typeof selected.optionId !== "string"))
          return { ok: false, message: "ACP host offers no allow_once option; permission was not expanded" }
        connection.write({
          jsonrpc: "2.0",
          id: permission.id,
          result: {
            outcome: selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" },
          },
        })
        connection.permissions.delete(id)
        return { ok: true, message: `ACP permission ${response} answer sent` }
      },
      async stop() {
        await this.abort()
        await connection.close()
        connection.status = "stopped"
      },
    }
  }
  async close(): Promise<void> {
    this.child.kill()
    this.fail("ACP managed process stopped")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.child.kill("SIGKILL")
            reject(new Error("ACP managed process termination was not confirmed"))
          }, 2_000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

/** One runtime instance owns its managed child sessions; no interactive-session attachment. */
export function createAcpRuntime(opts: AcpRuntimeOptions): AgentRuntime {
  const commandValue = opts.command ?? opts.env?.OPENCOMMS_ACP_COMMAND ?? process.env.OPENCOMMS_ACP_COMMAND
  const sessions = new Map<string, { connection: AcpConnection; handle: AgentHandle }>()
  const command = (): { command: string; args: string[] } => {
    if (!commandValue?.trim())
      throw new Error("ACP is not configured. Set OPENCOMMS_ACP_COMMAND to an explicit agent command/argv template.")
    const parsed = resolveBinaryOverride(commandValue, "")
    if (!parsed.command || isWindowsShimPath(parsed.command))
      throw new Error(
        "ACP requires a native executable or node plus a JS entrypoint; Windows .cmd/.bat shell launchers are unsupported",
      )
    return { command: parsed.command, args: [...parsed.prependArgs, ...(opts.args ?? [])] }
  }
  const connect = async (): Promise<AcpConnection> => {
    const launch = command()
    const connection = new AcpConnection(opts, launch.command, launch.args)
    try {
      await connection.initialize()
      return connection
    } catch (error) {
      await connection.close().catch(() => {})
      throw error
    }
  }
  return {
    runtime: "acp",
    host: "acp",
    async detect() {
      try {
        const connection = await connect()
        await connection.close()
        return {
          available: true,
          detail: "ACP v1 handshake verified; host authentication and live prompt require a separate check",
          providers: [],
        }
      } catch (error) {
        return { available: false, detail: (error as Error).message }
      }
    },
    async create(req) {
      let connection: AcpConnection | undefined
      try {
        if (req.model)
          return {
            ok: false,
            message: "This ACP adapter preserves the host's configured model; explicit model switching is unsupported",
          }
        connection = await connect()
        const created = await connection.request("session/new", { cwd: resolve(req.worktree), mcpServers: [] })
        if (typeof created.sessionId !== "string" || !created.sessionId)
          throw new Error("ACP session/new returned no session identity")
        connection.sessionId = created.sessionId
        connection.status = "idle"
        const handle = connection.handle(`OpenComms role ${req.role}: ${req.role_prompt}`)
        sessions.set(created.sessionId, { connection, handle })
        return {
          ok: true,
          result: {
            host_session_id: created.sessionId,
            spawn_cmd_redacted: "<configured ACP executable> (stdio, managed mode)",
          },
          handle,
        }
      } catch (error) {
        await connection?.close().catch(() => {})
        return { ok: false, message: (error as Error).message }
      }
    },
    async resume(rec: AgentRecord) {
      if (!rec.host_session_id) return { ok: false, message: "ACP managed record has no session identity" }
      const existing = sessions.get(rec.host_session_id)
      if (existing?.connection.isAlive()) return { ok: true, handle: existing.handle }
      let connection: AcpConnection | undefined
      try {
        connection = await connect()
        if (connection.capabilities.loadSession !== true)
          throw new Error("ACP agent did not advertise loadSession; recorded identity was preserved")
        connection.sessionId = rec.host_session_id
        await connection.request("session/load", {
          sessionId: rec.host_session_id,
          cwd: resolve(rec.worktree),
          mcpServers: [],
        })
        connection.status = "idle"
        const handle = connection.handle(`OpenComms role ${rec.role}: ${rec.role_prompt}`)
        sessions.set(rec.host_session_id, { connection, handle })
        return { ok: true, handle }
      } catch (error) {
        await connection?.close().catch(() => {})
        return { ok: false, message: (error as Error).message }
      }
    },
    async shutdownNode() {
      await Promise.all([...sessions.values()].map((entry) => entry.connection.close()))
      sessions.clear()
    },
  }
}
