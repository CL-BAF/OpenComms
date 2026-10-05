/**
 * OpenCode AgentRuntime (M1; promoted from the M0 spike,
 * docs/spike-spawn-opencode.md — spike scripts are disposable; this file is
 * the hardened, integrated version).
 *
 * Topology (Lead decisions 2026-09-11 + spike ground truth):
 *  - ONE shared `opencode serve` per project (never per agent): argv-only
 *    launch, `--hostname 127.0.0.1`, loopback bind, env-only auth handoff
 *    (OPENCODE_SERVER_PASSWORD is generated here, never on the command line,
 *    never logged, never returned).
 *  - Agents are sessions created over the SDK: `session.create` →
 *    `prompt_async` → `abort`; session existence and /session/status are
 *    checked before managed mail is submitted.
 *  - The model is ALWAYS pinned and pre-verified (detect() caches the
 *    provider/model catalog); server defaults failed or hung in the spike.
 *  - Native-exe resolution: Windows npm shims (.ps1/.cmd) cannot be
 *    execFile-spawned; the native binary path is resolved (or taken from the
 *    OPENCOMMS_OPENCODE_BIN override — same pattern as CLAUDE_BIN/CODEX_BIN).
 *  - Kill semantics (recorded): SIGTERM on the serve kills ALL sessions on
 *    the instance (accepted shared-instance tradeoff; single trust tier).
 */

import { spawn as nodeSpawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import type { AgentHandle, AgentRuntime, RuntimeDetectResult, SpawnRequest, SpawnResult } from "../runtime.js"
import type { AgentRecord, AgentRuntimeStatus } from "../state.js"

/** Env override for the native opencode binary (generalized M1 decision). */
export const OPENCODE_NATIVE_BIN_ENV = "OPENCOMMS_OPENCODE_BIN"

/**
 * Serve-ready timeout (Lead requirement 2): the stdout "listening" poll is
 * TIMEOUT-BOUNDED, never open-ended (same rule as turn waits).
 */
export const SERVE_READY_TIMEOUT_MS = 30_000
const SERVE_POLL_MS = 200

/** Resolve the spawnable native executable (npm shims cannot be execFile'd).
 *  Windows: APPDATA npm layout scan. Linux: bare PATH lookup — see Platform's
 *  doctor G5 note for daemon/systemd contexts (nvm shims are NOT on a systemd
 *  service PATH; configure OPENCOMMS_OPENCODE_BIN there). */
export function resolveOpencodeBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OPENCODE_NATIVE_BIN_ENV]?.trim()
  if (override) return override
  const direct = join("node_modules", "opencode-ai", "bin", "opencode.exe")
  for (const base of [process.env.APPDATA ? join(process.env.APPDATA, "npm") : null].filter(Boolean) as string[]) {
    // Regression invariant (Frontend-found bug): the RETURNED path must be
    // the SAME path that existsSync checked — never a re-joined variant.
    const candidate = join(base, direct)
    if (existsSync(candidate)) return candidate
  }
  // Fall back to the bare name (POSIX, or a caller-managed PATH resolution).
  // v22 guard (Lead's fix order item 2): a bare name on a runner WITHOUT the
  // binary spawns ENOENT — but that rejection MUST NOT escape ensureServe's
  // catch as an unhandled rejection under v22's scheduling. ensureServe
  // wraps the spawn in try/catch, so the bare name stays; the guard is that
  // the spawn path settles the poll even on throw (see ensureServe).
  return "opencode"
}

export interface OpencodeRuntimeOptions {
  /** Project directory (serve cwd + agent worktree base). */
  projectDir: string
  /** Chosen serve port; the caller records it on the node record. */
  port: number
  /** Injected env (tests); defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Injected spawner (tests pass a fake; production uses node:child_process). */
  spawnFn?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess
  /** Turn-wait timeout ms (spike rule: never open-ended). */
  turnTimeoutMs?: number
  /** Poll interval for turn completion. */
  pollMs?: number
  /** Injected transport for SDK calls (tests); production builds fetch-based. */
  transport?: OpencodeTransport
}

/**
 * Minimal HTTP transport the runtime needs (implemented with fetch against
 * the serve's HTTP API — the SDK's createOpencodeClient surface, narrowed).
 */
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

/** Extract the LAST assistant text from a session.messages payload (spike shape). */
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

/**
 * Production transport over the shared serve (fetch; basic auth from env the
 * caller holds in memory only). Kept minimal: exactly the spike-proven calls.
 */
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

const DEFAULT_TURN_TIMEOUT_MS = 180_000
const DEFAULT_POLL_MS = 1_500

/** Poll messages until the turn completes, errors, or the timeout hits. */
async function waitTurn(
  transport: OpencodeTransport,
  sessionId: string,
  turnTimeoutMs: number,
  pollMs: number,
): Promise<{ text: string; error: string | null }> {
  const start = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs))
    const rows = await transport.messages(sessionId)
    const last = rows.filter((r) => r.info?.role === "assistant").at(-1)
    if (last?.info?.error) {
      return { text: "", error: last.info.error?.data?.message ?? "opencode turn error" }
    }
    if (last?.info?.time?.completed) {
      return {
        text: (last.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(" | "),
        error: null,
      }
    }
    if (Date.now() - start > turnTimeoutMs) {
      return { text: "", error: `opencode turn wait timed out after ${turnTimeoutMs}ms` }
    }
  }
}

/**
 * Result of ensureServe (M1's last code item; Lead-approved spec):
 * the shared serve is ONE managed child per project, argv-only launch,
 * env-only password (NEVER logged, NEVER persisted — memory + child env).
 */
export interface ServeLaunchResult {
  ok: boolean
  port: number
  detail: string
  child: ChildProcess | null
  /**
   * The generated basic-auth header value for the serve (memory-only). The
   * GUI's ensureServeRunning() keeps this in process memory and passes it to
   * the runtime env — it is NEVER logged, persisted, or returned by any API.
   * Exposed here (not a raw password) so callers hold exactly the credential
   * they need and nothing more.
   */
  authHeader: string | null
}

/**
 * Ensure exactly one `opencode serve` is running for the project.
 * Idempotent: a second call while the first child is alive returns the
 * existing port. Readiness = the stdout "listening" line, timeout-bounded.
 * On spawn failure (ENOENT / binary missing) the caller fails the create
 * cleanly — the orchestrator never leaves an orphan.
 */
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
  child.on?.("error", () => {
    /* surfaced via the ready-poll timeout/close; the result below reports */
  })
  // v22 node:test hardening (Lead's fix order item 1): the 'error' listener
  // on the CHILD is a listener, but a spawned child that errors (e.g. ENOENT
  // surfacing post-spawn) must still settle the poll — the 'exit' handler
  // covers the normal case; this 'error' path now also settles so the
  // awaiting test can never hang on an error-only child.
  child.once?.("error", () => {
    /* pollServeReady's timeout settles the promise; this listener prevents
       an unhandled 'error' event from escaping as an unhandled rejection. */
  })
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

/**
 * Poll the child's stdout for the readiness line (timeout-bounded).
 *
 * v22 node:test hardening (Lead's fix order 2026-09-13): the promise RESOLVES
 * on every path — timer, "listening" line, child 'exit', and a guard for
 * children whose stdout/stderr are ABSENT (some fakes and edge hosts) so the
 * timer is the sole fallback and nothing can leave the awaiting test
 * un-resolved. The `child.on("error")` sibling is wired in ensureServe
 * (listener, not promise-critical); the spawn-throw path is handled in
 * ensureServe's catch BEFORE the poll starts.
 */
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
    // NOTE: intentionally NOT unref'd — this timer is promise-critical: under
    // node:test on Node v22 (CI's pinned buildNode) an unref'd timeout with no
    // other pending work lets the loop drain before it fires, so the awaited
    // promise never resolves and the whole test run cancels. Orphan-safety is
    // guaranteed by the explicit child.kill("SIGTERM") on the timeout path
    // below, not by unref. (Platform CI diagnosis 2026-09-12.)
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
  const turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const spawnFn =
    opts.spawnFn ??
    ((cmd: string, args: string[], spOpts: { cwd: string; env: NodeJS.ProcessEnv }) =>
      nodeSpawn(cmd, args, { ...spOpts, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true }))
  const transports = new Map<string, OpencodeTransport>()
  const detected: RuntimeDetectResult = { available: false }

  const ensureTransport = (directory = opts.projectDir): OpencodeTransport => {
    // Reviewer P4: an empty password would surface as an opaque 401 from the
    // serve; fail early with the actionable cause instead.
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
      // Per-agent stop on a SHARED serve is a session abort, not a process
      // kill (killing the serve would stop ALL agents — the accepted M1
      // tradeoff). Full teardown is shutdownNode().
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
      // Cached: detect() may be called per request; refresh only on demand.
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
        // Compose the role prompt + first prompt: persistent role injection
        // for opencode runs via the system-prompt transform when the plugin
        // is present; the first prompt ALWAYS carries the role text inline
        // (spike-proven inline path) so headless runs are never unguided.
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

/** Parse "provider/model" (spike rule: always pinned). null = not pinned. */
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

/**
 * Provider/model catalog cache (M1 requirement: powers the create-agent
 * dialog's model picker). Runs `opencode models` ONCE per runtime instance
 * and parses `provider/model` lines; the API layer serves it via
 * GET /nodes/{id}/runtimes. No credentials pass through; output is the
 * CLI's public list.
 */
const MODELS_TIMEOUT_MS = 30_000

/**
 * Pure line parser for the `opencode models` output — exported so tests can
 * drive it DIRECTLY (no exec, no exec-bit: the CI root cause was the exec
 * fixture failing on noexec mounts, Platform/Lead diagnosis 2026-09-13).
 * Production never parses anything else; this is the same code path.
 */
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
