/**
 * Spawn-push delivery â€” real PUSH for hosts whose CLI can resume a session
 * non-interactively (verified against official docs, 2026-09-08):
 *
 *   Claude Code:  claude --resume <session-id> --print "<message>"
 *   Codex CLI:    codex exec resume <session-id> "<message>"
 *
 * This is a DOCUMENTED API, not terminal keystroke automation. The message
 * is passed as a single argv element via execFile-style spawn (no shell),
 * so untrusted peer content can never inject shell syntax. Delivery runs
 * the same two-phase protocol as push: drain marks in_flight (persisted),
 * the CLI resume accepting the message commits delivered, a failure
 * requeues in FIFO order.
 *
 * Honest limits:
 *   - Claude Code: resuming a session that is mid-turn in a live TUI can
 *     interleave; we serialize per member and requeue on failure, but the
 *     platform gives no busy-check API.
 *   - Codex CLI: `codex exec resume` is documented for exec sessions;
 *     resuming TUI-created sessions is NOT verified (guarded by live test
 *     when the codex CLI is present).
 *   - Claude Desktop / ChatGPT: no session identity and no resume API â€”
 *     they stay PULL (a platform limit, not an OpenComms one).
 */

import { execFile } from "node:child_process"
import type { Member, State } from "../core/types.js"
import {
  commitDelivery,
  drainForDelivery,
  effectiveEndpointCapabilities,
  formatUntrustedMessage,
  requeueFailedDelivery,
} from "../core/engine.js"

export interface SpawnCommand {
  /** Executable to spawn (resolved or bare name â€” resolved on PATH). */
  command: string
  /** argv WITHOUT the message; the framed message is appended LAST. */
  args: string[]
  /** Working directory: the member's project (session scoping). */
  cwd: string
}

export interface SpawnCommandBuilder {
  host: string
  /** CLI binary name used for detection + spawn. */
  binary: string
  /** Env var holding the binary-or-template override (P2-1). */
  envKey: string
  buildResumeCommand(input: { hostSessionId: string; cwd: string }): SpawnCommand
}

export const CLAUDE_CODE_SPAWN: SpawnCommandBuilder = {
  host: "claude-code",
  binary: "claude",
  envKey: "OPENCOMMS_CLAUDE_BIN",
  buildResumeCommand: ({ hostSessionId, cwd }) => {
    const { command, prependArgs } = resolveBinaryOverride(
      process.env[CLAUDE_CODE_SPAWN.envKey],
      CLAUDE_CODE_SPAWN.binary,
    )
    return { command, args: [...prependArgs, "--resume", hostSessionId, "--print"], cwd }
  },
}

export const CODEX_SPAWN: SpawnCommandBuilder = {
  host: "codex",
  binary: "codex",
  envKey: "OPENCOMMS_CODEX_BIN",
  buildResumeCommand: ({ hostSessionId, cwd }) => {
    const { command, prependArgs } = resolveBinaryOverride(process.env[CODEX_SPAWN.envKey], CODEX_SPAWN.binary)
    return { command, args: [...prependArgs, "exec", "resume", hostSessionId], cwd }
  },
}

const BUILDERS: Record<string, SpawnCommandBuilder> = {
  [CLAUDE_CODE_SPAWN.host]: CLAUDE_CODE_SPAWN,
  [CODEX_SPAWN.host]: CODEX_SPAWN,
}

/**
 * Windows argv budget (Reviewer P2-2): CreateProcess caps the WHOLE command
 * line at 32,767 chars; POSIX caps a single arg at 128 KiB
 * (MAX_ARG_STRLEN). Keep conservative headroom. Oversized batches are
 * refused BEFORE draining (queued mail preserved, never truncated) with an
 * actionable error.
 */
export const SPAWN_ARGV_BUDGET: Record<string, number> = { win32: 30_000, default: 120_000 }

export function spawnArgvBudget(platform: string = process.platform): number {
  return SPAWN_ARGV_BUDGET[platform] ?? SPAWN_ARGV_BUDGET["default"]!
}

/**
 * Split a command template safely WITHOUT shell semantics: tokens split on
 * whitespace, double-quoted segments stay ONE token (Windows paths with
 * spaces). No operators, variables, or escapes beyond `""` are interpreted.
 */
export function parseCommandTemplate(raw: string): string[] {
  const tokens: string[] = []
  let current = ""
  let inQuotes = false
  let hasContent = false
  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes
      hasContent = true
      continue
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0 || hasContent) {
        tokens.push(current)
        current = ""
        hasContent = false
      }
      continue
    }
    current += ch
    hasContent = true
  }
  if (inQuotes) throw new Error(`unterminated quote in command template: ${raw.slice(0, 80)}`)
  if (current.length > 0 || hasContent) tokens.push(current)
  return tokens
}

/**
 * Binary override resolution (Reviewer P2-1). The env value is either:
 *  - a plain executable path/name (argv[0] verbatim), or
 *  - a command template whose FIRST token is the executable and whose
 *    REMAINING tokens are PREPENDED to the builder's args — e.g.
 *    OPENCOMMS_CODEX_BIN="node C:\npm\codex.js" runs an npm shim's JS
 *    entrypoint on Windows without a shell (Node refuses to exec
 *    .bat/.cmd shims directly since the CVE-2024-27980 fix).
 */
export function resolveBinaryOverride(
  envValue: string | undefined,
  defaultBinary: string,
): { command: string; prependArgs: string[] } {
  const raw = envValue?.trim()
  if (!raw) return { command: defaultBinary, prependArgs: [] }
  if (!/["\s]/.test(raw)) return { command: raw, prependArgs: [] }
  const tokens = parseCommandTemplate(raw)
  if (tokens.length === 0) return { command: defaultBinary, prependArgs: [] }
  const [command = defaultBinary, ...prependArgs] = tokens
  return { command, prependArgs }
}

/** Windows .cmd/.bat shims cannot be execFile-spawned (EINVAL since Node's CVE-2024-27980 fix). */
export function isWindowsShimPath(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command.trim())
}

/** Builder for a member's host; null when the host has no resume API. */
export function spawnBuilderFor(host: string): SpawnCommandBuilder | null {
  return BUILDERS[host] ?? null
}

/**
 * Pure gate: is this member spawn-deliverable RIGHT NOW?
 * Requires an explicit spawn_push delivery mode (or resume capability)
 * AND a bound host session id (identity is never guessed). An explicit
 * endpoint_capabilities row can DOWNGRADE the endpoint (resume:false)
 * even in spawn_push mode — capabilities outrank the coarse mode.
 */
export function spawnDeliveryRefusal(member: Member): string | null {
  if (member.delivery_mode !== "spawn_push") {
    return `member delivery mode is "${member.delivery_mode}", not "spawn_push"`
  }
  const caps = effectiveEndpointCapabilities(member)
  if (!caps.resume) {
    return "member endpoint capabilities disable resume (endpoint_capabilities.resume=false)"
  }
  if (!caps.push) {
    return "member endpoint capabilities disable push (endpoint_capabilities.push=false)"
  }
  if (!member.host_session_id || !member.host_session_id.trim()) {
    return "member has no bound host_session_id (the host lifecycle hook has not bound a session yet)"
  }
  if (!spawnBuilderFor(member.host)) {
    return `host "${member.host}" has no documented non-interactive resume API`
  }
  return null
}

/** Result of one spawn delivery attempt. */
export type SpawnOutcome =
  { status: "delivered"; detail: string } | { status: "failed"; detail: string } | { status: "skipped"; detail: string }

/** Default spawner: execFile (argv array, NO shell â€” injection-proof). */
export function defaultSpawn(
  cmd: SpawnCommand,
  message: string,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd.command,
      [...cmd.args, message],
      { cwd: cmd.cwd, timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, error: `${error.message}${stdout ? ` | stdout: ${stdout.slice(0, 400)}` : ""}` })
        } else {
          resolve({ ok: true, stdout: stdout.slice(0, 2_000) })
        }
      },
    )
    // Never let a spawned host CLI keep the delivery process alive.
    child.unref?.()
  })
}

/** Minimal store surface the hook needs (satisfied by StateStore). */
export interface SpawnStoreAdapter {
  withLock<T>(fn: () => T): Promise<T>
  load(): State
  save(state: State): void
  projectDir: string
}

/**
 * Production hook for MCP entrypoints + the OpenCode plugin: after any send,
 * push to every recipient that is spawn-deliverable. Errors are recorded,
 * never thrown â€” the SEND itself already succeeded.
 */
export function createSpawnDeliveryHook(
  store: SpawnStoreAdapter,
  recordError: (msg: string) => void,
): (recipients: string[]) => void {
  const delivering = new Set<string>()
  return (recipients: string[]) => {
    void (async () => {
      for (const recipientSessionId of recipients) {
        try {
          let member: Member | null = null
          await store.withLock(() => {
            const state = store.load()
            for (const channel of Object.values(state.channels)) {
              const m = channel.members.find((mm) => mm.session_id === recipientSessionId)
              if (m) {
                member = m
                break
              }
            }
            return null
          })
          if (!member) continue
          const m: Member = member
          if (spawnDeliveryRefusal(m)) continue
          const outcome = await deliverViaSpawn(
            {
              withLock: (fn) => store.withLock(fn),
              load: () => store.load(),
              save: (s) => store.save(s),
              spawn: defaultSpawn,
              recordError,
              cwd: store.projectDir,
              isDelivering: (id) => delivering.has(id),
              setDelivering: (id, value) => {
                if (value) delivering.add(id)
                else delivering.delete(id)
              },
            },
            m,
          )
          if (outcome.status === "failed") {
            recordError(`Spawn delivery (${m.host}) for ${m.session_id}: ${outcome.detail}`)
          }
        } catch (error) {
          recordError(`Spawn delivery hook failed for ${recipientSessionId}: ${(error as Error).message}`)
        }
      }
    })()
  }
}

export interface SpawnRunnerDeps {
  /** State lock wrapper (exclusive, cross-process safe). */
  withLock<T>(fn: () => T): Promise<T>
  load(): State
  save(state: State): void
  /** Working directory for the resumed CLI session (the project dir). */
  cwd: string
  /** Injected process spawner (tests pass a fake). */
  spawn(cmd: SpawnCommand, message: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>
  recordError(message: string): void
  /** Optional per-member serialization guard shared with other deliverers. */
  isDelivering?(memberId: string): boolean
  setDelivering?(memberId: string, value: boolean): void
}

/** Message ids already reported by the size guard (dedup per process). */
const sizeGuardReported = new Set<string>()

/**
 * Deliver ALL pending messages for one spawn_push member by resuming its
 * host session once with the framed batch. Two-phase + FIFO-requeue on
 * failure, identical guarantees to the OpenCode push path.
 *
 * Oversized batches are refused BEFORE draining (Reviewer P2-2): queued
 * mail is preserved untouched, one actionable error is recorded, and no
 * doomed spawn loop is ever entered. Peer content is never truncated.
 */
export async function deliverViaSpawn(deps: SpawnRunnerDeps, member: Member): Promise<SpawnOutcome> {
  const refusal = spawnDeliveryRefusal(member)
  if (refusal) return { status: "skipped", detail: refusal }
  if (deps.isDelivering?.(member.session_id)) {
    return { status: "skipped", detail: "a spawn delivery is already in flight for this member" }
  }

  // Pre-spawn argv size guard (P2-2): estimate the framed batch size from
  // the PENDING queue without draining. Framing adds ~450 chars per
  // envelope; the builder's fixed argv adds a little more.
  const builder = spawnBuilderFor(member.host)!
  const budget = spawnArgvBudget()
  let estimated = 0
  let oversizedIds: string[] = []
  try {
    await deps.withLock(() => {
      const state = deps.load()
      const cmd = builder.buildResumeCommand({ hostSessionId: member.host_session_id as string, cwd: deps.cwd })
      const fixedOverhead = cmd.command.length + cmd.args.join(" ").length + 64
      for (const id of state.queues[member.session_id] ?? []) {
        const msg = state.messages[id]
        if (!msg || msg.delivery_status !== "pending") continue
        const framedEstimate = msg.content.length + 450
        if (fixedOverhead + estimated + framedEstimate > budget) oversizedIds.push(id)
        else estimated += framedEstimate + 6
      }
      return null
    })
  } catch (error) {
    deps.recordError(`Spawn delivery size check for ${member.session_id} failed: ${(error as Error).message}`)
  }
  if (oversizedIds.length > 0) {
    // Do NOT drain: leave the queue untouched so the operator can shrink
    // content or switch the member to pull. Record once per message id per
    // process lifetime to avoid error spam.
    const fresh = oversizedIds.filter((id) => !sizeGuardReported.has(id))
    for (const id of fresh) sizeGuardReported.add(id)
    if (fresh.length > 0) {
      deps.recordError(
        `Spawn delivery refused for ${member.session_id}: batch exceeds the spawn argv limit (~${budget} chars on ${process.platform}). Reduce message size or switch this member to pull delivery. Message ids: ${fresh.join(", ")}`,
      )
    }
    return { status: "skipped", detail: `batch exceeds the spawn argv limit (~${budget} chars); queue left untouched` }
  }

  // Phase 1 (locked): drain + persist in_flight.
  let batch: Array<{ id: string; channelName: string }> = []
  let framed = ""
  try {
    await deps.withLock(() => {
      const state = deps.load()
      const pairs = drainForDelivery(state, member.session_id)
      if (pairs.length > 0) deps.save(state)
      batch = pairs.map((p) => ({ id: p.message_id, channelName: p.channel_name }))
      return null
    })
  } catch (error) {
    deps.recordError(`Spawn delivery drain for ${member.session_id} failed: ${(error as Error).message}`)
    return { status: "failed", detail: `drain failed: ${(error as Error).message}` }
  }
  if (batch.length === 0) return { status: "skipped", detail: "no pending messages" }

  // Frame the batch from a fresh snapshot (per-envelope channel provenance).
  try {
    const snapshot = deps.load()
    const parts: string[] = []
    for (const item of batch) {
      const msg = snapshot.messages[item.id]
      if (msg) parts.push(formatUntrustedMessage(msg, item.channelName))
    }
    framed = parts.join("\n\n---\n\n")
  } catch {
    framed = ""
  }
  if (!framed) {
    // Snapshots lost the envelopes (pruned concurrently) â€” requeue by ids.
    try {
      await deps.withLock(() => {
        const state = deps.load()
        requeueFailedDelivery(
          state,
          member.session_id,
          batch.map((b) => b.id),
        )
        deps.save(state)
      })
    } catch {
      /* best effort */
    }
    return { status: "skipped", detail: "envelopes vanished before framing; re-queued" }
  }

  const cmd = builder.buildResumeCommand({
    hostSessionId: member.host_session_id as string,
    cwd: deps.cwd,
  })

  deps.setDelivering?.(member.session_id, true)
  try {
    const result = await deps.spawn(cmd, framed)
    if (result.ok) {
      // Phase 2 (locked): the host CLI accepted + ran the turn.
      await deps.withLock(() => {
        const state = deps.load()
        commitDelivery(
          state,
          member.session_id,
          batch.map((b) => b.id),
          "spawn_push",
        )
        deps.save(state)
      })
      return {
        status: "delivered",
        detail: `resumed ${builder.binary} session ${member.host_session_id} with ${batch.length} message(s)`,
      }
    }
    // Failure: requeue in original FIFO order + visible error. Windows
    // npm .cmd/.bat shims cannot be spawned without a shell (Node's
    // CVE-2024-27980 fix) — enrich EINVAL with the actionable override.
    const failureDetail =
      /\bEINVAL\b/.test(result.error) || isWindowsShimPath(cmd.command)
        ? result.error +
          ' | Windows shim/no-shell spawn failed: set OPENCOMMS_CLAUDE_BIN / OPENCOMMS_CODEX_BIN to a native executable or a command template, e.g. OPENCOMMS_CODEX_BIN="node C:\\path\\to\\codex.js"'
        : result.error
    await deps.withLock(() => {
      const state = deps.load()
      requeueFailedDelivery(
        state,
        member.session_id,
        batch.map((b) => b.id),
      )
      state.errors.push({
        at: Date.now(),
        message: `Spawn delivery to ${member.session_id} failed (${failureDetail}); ${batch.length} message(s) re-queued.`,
      })
      if (state.errors.length > 200) state.errors = state.errors.slice(-200)
      deps.save(state)
    })
    return { status: "failed", detail: failureDetail }
  } catch (error) {
    try {
      await deps.withLock(() => {
        const state = deps.load()
        requeueFailedDelivery(
          state,
          member.session_id,
          batch.map((b) => b.id),
        )
        deps.save(state)
      })
    } catch {
      /* best effort */
    }
    return { status: "failed", detail: (error as Error).message }
  } finally {
    deps.setDelivering?.(member.session_id, false)
  }
}
