/**
 * One shared loopback serve per project, launched with argv and env-only credentials.
 * Managed sessions require a verified model pin and exact identity before delivery.
 * Session abort stops one agent; killing the shared serve stops every session.
 */

import { spawn as nodeSpawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import type { AgentHandle, AgentRuntime, RuntimeDetectResult, SpawnRequest } from "../runtime.js"
import type { AgentRecord } from "../state.js"

export const OPENCODE_NATIVE_BIN_ENV = "OPENCOMMS_OPENCODE_BIN"

export const SERVE_READY_TIMEOUT_MS = 30_000

/** Resolve a native executable: Windows npm shims cannot be spawned directly. */
export function resolveOpencodeBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OPENCODE_NATIVE_BIN_ENV]?.trim()
  if (override) return override
  const direct = join("node_modules", "opencode-ai", "bin", "opencode.exe")
  for (const base of [process.env.APPDATA ? join(process.env.APPDATA, "npm") : null].filter(Boolean) as string[]) {
    // Return exactly the path checked for existence.
    const candidate = join(base, direct)
    if (existsSync(candidate)) return candidate
  }
  // Fall back to PATH; ensureServe handles missing executables without unhandled errors.
  return "opencode"
}

export interface OpencodeRuntimeOptions {
  /** Project directory (serve cwd + agent worktree base). */
  projectDir: string
  /** Chosen serve port; the caller records it on the node record. */
  port: number
  /** Injected env (tests); defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Compatibility option; shared serve spawning is configured through ensureServe. */
  spawnFn?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
  /** Compatibility option; delivery no longer waits for assistant completion. */
  turnTimeoutMs?: number

  pollMs?: number
  /** Injected transport for SDK calls (tests); production builds fetch-based. */
  transport?: OpencodeTransport
}

/** Narrow host transport used by the managed runtime. */
export interface OpencodeTransport {
  /** Verify the persisted identity against this server, without creating it. */
  getSession?(sessionId: string): Promise<{ id: string }>
  sessionStatus?(sessionId: string): Promise<{ type: string; detail?: string } | null>
  createSession(title: string): Promise<{ id: string }>
  prompt(sessionId: string, text: string, model?: { providerID: string; modelID: string }): Promise<void>
  abort(sessionId: string): Promise<void>
  messages(sessionId: string): Promise<
    Array<{
      info: {
        role: string
        error?: { data?: { message?: string } } | null
        time?: { completed?: number }
      }
      parts: Array<{ type: string; text?: string }>
    }>
  >
  /**
   * The host's global permission list is filtered to this exact session.
   * Returns null only for an unsupported list route on older serves.
   */
  permissionsList(sessionId: string): Promise<Array<{ permission_id: string; request?: unknown }> | null>
  permissionsRespond(sessionId: string, permissionId: string, response: "allow" | "deny"): Promise<void>
}

/** Basic-auth header helper (loopback-only; header form, never ?auth_token=). */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

/** Return the last assistant text with its host completion and error fields. */
export function lastAssistantText(
  rows: Array<{
    info: {
      role: string
      error?: { data?: { message?: string } } | null
      time?: { completed?: number }
    }
    parts: Array<{ type: string; text?: string }>
  }>,
): { text: string; completed: boolean; error: string | null } {
  const assistantRows = rows.filter((r) => r.info?.role === "assistant")
  const last = assistantRows[assistantRows.length - 1]
  if (!last) return { text: "", completed: false, error: "no assistant message" }
  const text = (last.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" | ")
  return {
    text,
    completed: Boolean(last.info?.time?.completed),
    error: last.info?.error?.data?.message ?? null,
  }
}

/** Loopback transport with in-memory credentials and an explicit runtime directory. */
export function createHttpTransport(
  baseUrl: string,
  password: string,
  username = "orchestrator",
  directory?: string,
): OpencodeTransport {
  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(username, password),
    "Content-Type": "application/json",
  }
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const endpoint = new URL(path, baseUrl)
    if (directory) endpoint.searchParams.set("directory", directory)
    const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30_000), ...init })
    if (!res.ok) {
      // Host bodies may contain credentials, prompt contents or tool output.
      throw new Error(`opencode ${path} failed (${res.status})`)
    }
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }
  return {
    async getSession(sessionId) {
      const payload = (await call(`/session/${encodeURIComponent(sessionId)}`)) as { id?: string }
      if (payload.id !== sessionId) throw new Error("opencode returned a different session identity")
      return { id: payload.id }
    },
    async sessionStatus(sessionId) {
      // Idle rows are removed from SessionStatus.list by the host. Confirm
      // the identity first so absence cannot turn a deleted session into idle.
      const session = (await call(`/session/${encodeURIComponent(sessionId)}`)) as { id?: string }
      if (session.id !== sessionId) throw new Error("opencode session identity is unavailable")
      const payload = (await call("/session/status")) as Record<string, { type: string }>
      return payload[sessionId] ?? { type: "idle" }
    },
    async createSession(title) {
      const created = (await call("/session", { method: "POST", body: JSON.stringify({ title }) })) as {
        id?: string
        data?: { id?: string }
      }
      const id = created.id ?? created.data?.id
      if (!id) throw new Error("opencode session create returned no id")
      return { id }
    },
    async prompt(sessionId, text, model) {
      const body: Record<string, unknown> = { parts: [{ type: "text", text }] }
      if (model) body.model = model
      // 204 confirms host acceptance. Completion belongs to execution state,
      // so delivery never waits for an assistant response or retries its work.
      await call(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    },
    async abort(sessionId) {
      await call(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST", body: "{}" })
    },
    async messages(sessionId) {
      const payload = (await call(`/session/${encodeURIComponent(sessionId)}/message`)) as
        | Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
        | { data?: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> }
      return Array.isArray(payload) ? payload : (payload.data ?? [])
    },
    async permissionsList(sessionId) {
      // Official SDK permission.list: GET /permission. Its list spans all
      // sessions, so never expose another agent's approval requests.
      try {
        const payload = await call("/permission")
        if (!Array.isArray(payload)) throw new Error("opencode permission list returned an invalid response")
        return payload
          .filter((row: unknown): row is { id: string; sessionID: string } => {
            if (typeof row !== "object" || row === null) return false
            const value = row as Record<string, unknown>
            return value.sessionID === sessionId && typeof value.id === "string" && value.id.length > 0
          })
          .map((row) => ({ permission_id: row.id, request: row }))
      } catch (error) {
        if (/\(404\)/.test(String(error))) return null
        throw error
      }
    },
    async permissionsRespond(sessionId, permissionId, response) {
      const pending = await this.permissionsList(sessionId)
      if (pending === null) throw new Error("opencode permission API is unsupported by this server")
      if (!pending.some((row) => row.permission_id === permissionId))
        throw new Error("permission request is not pending for this agent")
      await call(`/permission/${encodeURIComponent(permissionId)}/reply`, {
        method: "POST",
        body: JSON.stringify({ reply: response === "allow" ? "once" : "reject" }),
      })
    },
  }
}

/** Shared serve child; credentials stay in memory and child env only. */
export interface ServeLaunchResult {
  ok: boolean
  port: number
  detail: string
  child: ChildProcess | null
  /** Memory-only serve auth header; never persist, log or return it through an API. */
  authHeader: string | null
}

/** Reuse the project serve or launch one with bounded readiness and failure cleanup. */
export async function ensureServe(opts: {
  projectDir: string
  preferredPort: number
  /** Injected env (tests); the generated password is WRITTEN here only. */
  env?: NodeJS.ProcessEnv
  spawnFn?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
  /** Existing managed child from a prior call (idempotence). */
  existing?: ChildProcess | null
  existingPort?: number
  readyTimeoutMs?: number
}): Promise<ServeLaunchResult> {
  const env = opts.env ?? process.env
  if (opts.existing && !opts.existing.killed && opts.existing.exitCode === null) {
    return {
      ok: true,
      port: opts.existingPort ?? opts.preferredPort,
      detail: "serve already running",
      child: opts.existing,
      authHeader: null,
    }
  }
  const exe = resolveOpencodeBinary(env)
  const password = `ocserve-${randomBytes(16).toString("base64url")}`
  const username = "orchestrator"
  let child: ChildProcess
  try {
    child = (opts.spawnFn ?? defaultServeSpawn)(
      exe,
      ["serve", "--port", String(opts.preferredPort), "--hostname", "127.0.0.1"],
      {
        cwd: opts.projectDir,
        env: { ...env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: username },
      },
    )
  } catch (error) {
    return {
      ok: false,
      port: 0,
      detail: `serve spawn failed: ${(error as Error).message}`,
      child: null,
      authHeader: null,
    }
  }
  // Prevent unhandled child errors; readiness fails on exit or timeout.
  child.on?.("error", () => {})

  const ready = await pollServeReady(child, opts.readyTimeoutMs ?? SERVE_READY_TIMEOUT_MS)
  if (!ready.ok) {
    try {
      child.kill("SIGTERM")
    } catch {
      /* best effort; nothing to orphan on a failed launch */
    }
    return { ok: false, port: 0, detail: ready.detail, child: null, authHeader: null }
  }
  return {
    ok: true,
    port: opts.preferredPort,
    detail: `serve ready on 127.0.0.1:${opts.preferredPort}`,
    child,
    authHeader: basicAuthHeader(username, password),
  }
}

function defaultServeSpawn(cmd: string, args: string[], spOpts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return nodeSpawn(cmd, args, { ...spOpts, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true })
}

/** Readiness resolves on a listening line, child exit or timeout. */
async function pollServeReady(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  let output = ""
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: { ok: true } | { ok: false; detail: string }): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const timer = setTimeout(() => {
      settle({
        ok: false,
        detail: `serve did not report listening within ${timeoutMs}ms${output ? ` (output: ${output.slice(0, 200)})` : ""}`,
      })
    }, timeoutMs)
    // Keep the timeout referenced: unref could leave the awaited promise unresolved.
    const onLine = (chunk: Buffer | string): void => {
      output += chunk.toString()
      if (output.includes("listening")) {
        settle({ ok: true })
      }
    }
    const onExit = (code: number | null): void => {
      settle({
        ok: false,
        detail: `serve exited during startup (code ${code})${output ? `: ${output.slice(0, 200)}` : ""}`,
      })
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off("data", onLine)
      child.stderr?.off("data", onLine)
      child.off("exit", onExit)
    }
    child.stdout?.on("data", onLine)
    child.stderr?.on("data", onLine)
    child.on("exit", onExit)
  })
}

export function createOpencodeRuntime(opts: OpencodeRuntimeOptions): AgentRuntime {
  const env = opts.env ?? process.env
  const exe = resolveOpencodeBinary(env)
  const port = opts.port
  const baseUrl = `http://127.0.0.1:${port}`
  const transports = new Map<string, OpencodeTransport>()
  const detected: RuntimeDetectResult = { available: false }

  const ensureTransport = (directory = opts.projectDir): OpencodeTransport => {
    if (!env["OPENCOMMS_ORCH_SERVE_PASSWORD"]?.trim()) {
      throw new Error("serve password not configured (OPENCOMMS_ORCH_SERVE_PASSWORD is empty)")
    }
    if (opts.transport) return opts.transport
    let transport = transports.get(directory)
    if (!transport) {
      transport = createHttpTransport(baseUrl, env["OPENCOMMS_ORCH_SERVE_PASSWORD"] ?? "", "orchestrator", directory)
      transports.set(directory, transport)
    }
    return transport
  }

  const makeHandle = (sessionId: string, directory: string): AgentHandle => ({
    async deliver(framed) {
      try {
        const t = ensureTransport(directory)
        const model = parseModel(env["OPENCOMMS_ORCH_SERVE_MODEL"])
        await t.prompt(sessionId, framed, model)
        return "delivered"
      } catch (error) {
        // A failed transport after submitting can leave accepted work. Never
        // label that safe to retry; the coordinator retains the delivery id.
        return /failed \((400|401|403|404|409|422)\)/.test(String(error)) ? "failed" : "uncertain"
      }
    },
    async abort() {
      await ensureTransport(directory).abort(sessionId)
    },
    async status() {
      try {
        const t = ensureTransport(directory)
        if (!t.sessionStatus) return { status: "stale", detail: "runtime status is unavailable" }
        const observed = await t.sessionStatus(sessionId)
        if (observed?.type === "idle") return { status: "idle" }
        if (observed?.type === "busy" || observed?.type === "retry") return { status: "running", detail: observed.type }
        return { status: "stale", detail: "host did not report this session's activity" }
      } catch (error) {
        return { status: "stale", detail: (error as Error).message }
      }
    },
    async stop() {
      // Abort this session; process shutdown would stop every shared-serve agent.
      await ensureTransport(directory).abort(sessionId)
    },
    async permissionsDrain() {
      const rows = await ensureTransport(directory).permissionsList(sessionId)
      if (rows === null) return null
      return rows.map((r) => ({ permission_id: r.permission_id, request: r.request as unknown }))
    },
    async permissionsRespond(permissionId, response) {
      try {
        await ensureTransport(directory).permissionsRespond(sessionId, permissionId, response)
        return { ok: true, message: `permission ${permissionId} ${response}ed` }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    },
  })

  return {
    runtime: "opencode",
    host: "opencode",
    async detect() {
      if (detected.available) return detected
      try {
        const binary = resolveOpencodeBinary(env)
        detected.version = runVersion(binary)
        detected.available = Boolean(detected.version)
        if (!detected.available) {
          detected.detail = "OpenCode executable did not answer --version; configure OPENCOMMS_OPENCODE_BIN"
          return detected
        }
        detected.providers = listModelsCatalog(binary, opts.projectDir)
      } catch (error) {
        detected.available = false
        detected.detail = (error as Error).message
      }
      return detected
    },
    async create(req: SpawnRequest) {
      try {
        const t = ensureTransport(req.worktree)
        const created = await t.createSession(req.name)
        // Inline the role prompt so headless sessions receive it without plugin injection.
        const first = `You are ${req.role} on OpenComms channel work. ${req.role_prompt}`.trim()
        const model = parseModel(env["OPENCOMMS_ORCH_SERVE_MODEL"])
        await t.prompt(created.id, first, model)
        return {
          ok: true,
          result: { host_session_id: created.id, spawn_cmd_redacted: redact(exe, port) },
          handle: makeHandle(created.id, req.worktree),
        }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    },
    async resume(rec: AgentRecord) {
      if (!rec.host_session_id) return { ok: false, message: "agent record has no host_session_id to resume" }
      try {
        const directory = rec.worktree || opts.projectDir
        const t = ensureTransport(directory)
        if (t.getSession) await t.getSession(rec.host_session_id)
        else await t.messages(rec.host_session_id)
        return { ok: true, handle: makeHandle(rec.host_session_id, directory) }
      } catch (error) {
        return { ok: false, message: `Cannot resume the recorded session: ${(error as Error).message}` }
      }
    },
    async shutdownNode() {
      transports.clear()
    },
  }
}

/** Parse an explicit provider/model pin; missing pins remain undefined. */
export function parseModel(value: string | undefined): { providerID: string; modelID: string } | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const [providerID, ...rest] = raw.split("/")
  if (!providerID || rest.length === 0) return undefined
  return { providerID, modelID: rest.join("/") }
}

/** Run `opencode --version` (15s timeout; detection only, never secrets). */
function runVersion(binary: string): string | undefined {
  try {
    const out = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true })
    return out.trim().split(/\s+/)[0]
  } catch {
    return undefined
  }
}

/** Cache the public provider/model catalogue for managed-agent selection. */
const MODELS_TIMEOUT_MS = 30_000

/** Parse public opencode models output without invoking a process. */
export function parseModelsOutput(out: string): Array<{ provider: string; models: string[] }> {
  const byProvider = new Map<string, Set<string>>()
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim()
    const slash = line.indexOf("/")
    if (slash <= 0 || slash === line.length - 1) continue
    const provider = line.slice(0, slash)
    const model = line.slice(slash + 1)
    if (!provider || !model) continue
    let set = byProvider.get(provider)
    if (!set) {
      set = new Set()
      byProvider.set(provider, set)
    }
    set.add(model)
  }
  return [...byProvider.entries()].map(([provider, models]) => ({ provider, models: [...models].sort() }))
}

export function listModelsCatalog(binary: string, cwd: string): Array<{ provider: string; models: string[] }> {
  let out: string
  try {
    out = execFileSync(binary, ["models"], { encoding: "utf8", timeout: MODELS_TIMEOUT_MS, cwd, windowsHide: true })
  } catch {
    return []
  }
  return parseModelsOutput(out)
}

function redact(exe: string, port: number): string {
  return `${exe} serve --port ${port} --hostname 127.0.0.1 (password via env only)`.replace(/\\+/g, "\\")
}
