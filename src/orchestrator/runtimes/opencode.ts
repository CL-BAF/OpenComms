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
 *    `prompt`/`promptAsync` → `abort`; status is SSE-driven (the spike proved
 *    GET /session/status unreliable mid-turn).
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
import type { AgentHandle, AgentRuntime, RuntimeDetectResult, SpawnRequest, SpawnResult } from "../runtime.js"
import type { AgentRecord, AgentRuntimeStatus } from "../state.js"

/** Env override for the native opencode binary (generalized M1 decision). */
export const OPENCODE_NATIVE_BIN_ENV = "OPENCOMMS_OPENCODE_BIN"

/** Resolve the spawnable native executable (npm shims cannot be execFile'd).
 *  Windows: APPDATA npm layout scan. Linux: bare PATH lookup — see Platform's
 *  doctor G5 note for daemon/systemd contexts (nvm shims are NOT on a systemd
 *  service PATH; configure OPENCOMMS_OPENCODE_BIN there). */
export function resolveOpencodeBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[OPENCODE_NATIVE_BIN_ENV]?.trim()
  if (override) return override
  const direct = join("node_modules", "opencode-ai", "bin", "opencode.exe")
  for (const base of [process.env.APPDATA ? join(process.env.APPDATA, "npm") : null].filter(Boolean) as string[]) {
    if (existsSync(join(base, direct))) return join(base, join("opencode-ai", "bin", "opencode.exe"))
  }
  // Fall back to the bare name (POSIX, or a caller-managed PATH resolution).
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
export function createHttpTransport(baseUrl: string, password: string, username = "orchestrator"): OpencodeTransport {
  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(username, password),
    "Content-Type": "application/json",
  }
  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, { headers, ...init })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`opencode ${path} failed (${res.status}): ${body.slice(0, 200)}`)
    }
    const text = await res.text()
    return text ? JSON.parse(text) : {}
  }
  return {
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
      await call(`/session/${sessionId}/message`, { method: "POST", body: JSON.stringify(body) })
    },
    async abort(sessionId) {
      await call(`/session/${sessionId}/abort`, { method: "POST", body: "{}" })
    },
    async messages(sessionId) {
      const payload = (await call(`/session/${sessionId}/message`)) as
        | Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
        | { data?: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> }
      return Array.isArray(payload) ? payload : (payload.data ?? [])
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
  let transport = opts.transport ?? null
  const detected: RuntimeDetectResult = { available: false }

  const ensureTransport = (): OpencodeTransport => {
    // Reviewer P4: an empty password would surface as an opaque 401 from the
    // serve; fail early with the actionable cause instead.
    if (!env["OPENCOMMS_ORCH_SERVE_PASSWORD"]?.trim()) {
      throw new Error("serve password not configured (OPENCOMMS_ORCH_SERVE_PASSWORD is empty)")
    }
    if (!transport) transport = createHttpTransport(baseUrl, env["OPENCOMMS_ORCH_SERVE_PASSWORD"] ?? "")
    return transport
  }

  const makeHandle = (sessionId: string): AgentHandle => ({
    async deliver(framed) {
      try {
        const t = ensureTransport()
        const model = parseModel(env["OPENCOMMS_ORCH_SERVE_MODEL"])
        await t.prompt(sessionId, framed, model)
        const turn = await waitTurn(t, sessionId, turnTimeoutMs, pollMs)
        if (turn.error) return "failed"
        return "delivered"
      } catch {
        return "failed"
      }
    },
    async abort() {
      try {
        await ensureTransport().abort(sessionId)
      } catch {
        /* abort is best-effort; the serve may already have ended the turn */
      }
    },
    async status() {
      // Honest snapshot only: without the SSE tap connected, "running" is the
      // neutral managed-state; the feed (SSE) remains the authority.
      return { status: "running" as AgentRuntimeStatus }
    },
    async stop() {
      // Per-agent stop on a SHARED serve is a session abort, not a process
      // kill (killing the serve would stop ALL agents — the accepted M1
      // tradeoff). Full teardown is shutdownNode().
      try {
        await ensureTransport().abort(sessionId)
      } catch {
        /* already stopped */
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
        detected.available = true
        detected.version = runVersion(binary)
        detected.providers = listModelsCatalog(binary, opts.projectDir)
      } catch (error) {
        detected.available = false
        detected.detail = (error as Error).message
      }
      return detected
    },
    async create(req: SpawnRequest) {
      try {
        const t = ensureTransport()
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
          handle: makeHandle(created.id),
        }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    },
    async resume(rec: AgentRecord) {
      if (!rec.host_session_id) return { ok: false, message: "agent record has no host_session_id to resume" }
      return { ok: true, handle: makeHandle(rec.host_session_id) }
    },
    async shutdownNode() {
      transport = null
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

export function listModelsCatalog(binary: string, cwd: string): Array<{ provider: string; models: string[] }> {
  let out: string
  try {
    out = execFileSync(binary, ["models"], { encoding: "utf8", timeout: MODELS_TIMEOUT_MS, cwd, windowsHide: true })
  } catch {
    return []
  }
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

function redact(exe: string, port: number): string {
  return `${exe} serve --port ${port} --hostname 127.0.0.1 (password via env only)`.replace(/\\+/g, "\\")
}
