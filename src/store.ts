/**
 * OpenComms — persistent state store.
 *
 * State is stored in `<project>/.opencode-comms/state.json`. Writes are
 * atomic: we serialize to a temp file in the same directory, flush it, then
 * rename over the target. On Windows, `rename` over an existing file is
 * supported by Node's fs.rename (it maps to MoveFileEx with REPLACE_EXISTING),
 * but we defensively retry once after a short delay because antivirus or
 * OneDrive can briefly hold a handle.
 *
 * Concurrency: two OpenCode sessions share one state.json. A bare
 * load→mutate→save sequence can lose updates when interleaved across
 * processes. Every mutating read-modify-write therefore runs under an
 * exclusive-create lockfile (`.state.lock`) via `withLock`. The lock carries
 * PID + timestamp and is considered stale (breakable) after LOCK_STALE_MS so
 * a crashed process cannot wedge the channel forever.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  type PathOrFileDescriptor,
} from "node:fs"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { DEFAULT_MAX_MEMBERS, SCHEMA_VERSION, STATE_DIR, STATE_FILE, type Channel, type State } from "./types.js"
import { defaultTimer } from "./engine.js"

const LOCK_FILE = ".state.lock"
/** How long to keep retrying lock acquisition before giving up. */
export const LOCK_TIMEOUT_MS = 5_000
/** Locks older than this are presumed abandoned by a dead process and broken. */
export const LOCK_STALE_MS = 15_000

export function emptyState(): State {
  return {
    schema_version: SCHEMA_VERSION,
    channels: {},
    messages: {},
    queues: {},
    delivered_to: {},
    errors: [],
  }
}

// ── Load-time validation ────────────────────────────────────────────────────

const ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isValidMember(m: unknown): boolean {
  if (!isRecord(m)) return false
  return (
    typeof m["session_id"] === "string" &&
    typeof m["session_id"].length === "number" &&
    m["session_id"].length > 0 &&
    typeof m["role"] === "string" &&
    ROLE_PATTERN.test(m["role"]) &&
    typeof m["role_prompt"] === "string" &&
    typeof m["joined_at"] === "number"
  )
}

function isValidChannel(ch: unknown): boolean {
  if (!isRecord(ch)) return false
  if (typeof ch["id"] !== "string" || typeof ch["name"] !== "string") return false
  if (typeof ch["project_id"] !== "string" || typeof ch["worktree"] !== "string") return false
  if (!Array.isArray(ch["members"])) return false
  const members = ch["members"] as unknown[]
  // Empty channels are transiently possible but never persisted; treat any
  // member count beyond the hard cap as tampering.
  if (members.length === 0 || members.length > DEFAULT_MAX_MEMBERS) return false
  return members.every(isValidMember)
}

/**
 * Structural + integrity validation of untrusted on-disk state. Tampered or
 * stale files must be rejected outright rather than partially trusted: a
 * forged member row would let arbitrary text into the system prompt
 * (role_prompt injection), and a wrong schema_version would silently skip
 * guards this version assumes.
 */
function validateState(parsed: unknown): { ok: true; state: State } | { ok: false; reason: string } {
  if (!isRecord(parsed)) return { ok: false, reason: "state root is not an object" }
  if (parsed["schema_version"] !== SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `schema_version mismatch: expected ${SCHEMA_VERSION}, got ${String(parsed["schema_version"])}`,
    }
  }
  const channels = parsed["channels"]
  const messages = parsed["messages"]
  const queues = parsed["queues"]
  const deliveredTo = parsed["delivered_to"]
  const errors = parsed["errors"]
  if (!isRecord(channels)) return { ok: false, reason: "channels is not an object" }
  for (const key of Object.keys(channels)) {
    if (!isValidChannel((channels as Record<string, unknown>)[key])) {
      return { ok: false, reason: `channel "${key}" has invalid shape or members` }
    }
    // Keys must equal the normalized channel name inside.
    const ch = (channels as Record<string, Channel>)[key]!
    if (ch.name !== key) return { ok: false, reason: `channel key "${key}" does not match channel name "${ch.name}"` }
  }
  if (!isRecord(messages)) return { ok: false, reason: "messages is not an object" }
  for (const id of Object.keys(messages)) {
    const msg = (messages as Record<string, unknown>)[id]!
    if (!isRecord(msg) || typeof msg["channel_id"] !== "string" || typeof msg["timestamp"] !== "number") {
      return { ok: false, reason: `message "${id}" has invalid shape` }
    }
  }
  if (!isRecord(queues)) return { ok: false, reason: "queues is not an object" }
  for (const key of Object.keys(queues)) {
    const q = (queues as Record<string, unknown>)[key]!
    if (!Array.isArray(q) || !q.every((v) => typeof v === "string")) {
      return { ok: false, reason: `queue "${key}" is not a string array` }
    }
  }
  if (!isRecord(deliveredTo)) return { ok: false, reason: "delivered_to is not an object" }
  for (const key of Object.keys(deliveredTo)) {
    const d = (deliveredTo as Record<string, unknown>)[key]!
    if (!Array.isArray(d) || !d.every((v) => typeof v === "string")) {
      return { ok: false, reason: `delivered_to["${key}"] is not a string array` }
    }
  }
  if (!Array.isArray(errors)) return { ok: false, reason: "errors is not an array" }

  const state = parsed as unknown as State
  return { ok: true, state }
}

/** Backfill/migrate older persisted shapes into the current schema. */
function backfillState(state: State): void {
  for (const channel of Object.values(state.channels)) {
    if (typeof channel.max_members !== "number" || Number.isNaN(channel.max_members)) {
      channel.max_members = DEFAULT_MAX_MEMBERS
    } else {
      // Clamp out-of-range (possibly tampered) caps into sane bounds.
      channel.max_members = Math.max(2, Math.min(DEFAULT_MAX_MEMBERS, Math.floor(channel.max_members)))
    }
    if (channel.paused === undefined) channel.paused = false
    if (channel.rate === undefined || typeof channel.rate.window_start !== "number") {
      channel.rate = { window_start: Date.now(), count: 0 }
    }
    if (!channel.cooldown_until) channel.cooldown_until = {}
    if (!channel.seen_content) channel.seen_content = {}
    if (!Array.isArray(channel.processed_correlations)) channel.processed_correlations = []
    // Timer migration: pre-multi-agent timers keyed roles as active_role;
    // current timers key members by session id.
    const legacyTimer = channel.timer as unknown as Record<string, unknown> | undefined
    if (!legacyTimer || typeof legacyTimer !== "object") {
      channel.timer = defaultTimer()
    } else if (
      (legacyTimer.active_member_id === undefined ||
        legacyTimer.elapsed_ms === undefined) &&
      typeof legacyTimer.active_role === "string"
    ) {
      // Map role -> first matching live member where possible, and re-key
      // that role's accumulated time under the member session id.
      const byRole = channel.members.find((m) => m.role === legacyTimer.active_role)
      const rawElapsed =
        legacyTimer.elapsed_ms && isRecord(legacyTimer.elapsed_ms)
          ? (legacyTimer.elapsed_ms as Record<string, unknown>)
          : {}
      const elapsed: Record<string, number> = {}
      for (const [k, v] of Object.entries(rawElapsed)) {
        if (typeof v !== "number") continue
        if (byRole && k === legacyTimer.active_role && k !== byRole.session_id) {
          elapsed[byRole.session_id] = (elapsed[byRole.session_id] ?? 0) + v
        } else {
          elapsed[k] = v
        }
      }
      channel.timer = {
        active_member_id: byRole?.session_id ?? null,
        segment_started_at:
          typeof legacyTimer.segment_started_at === "number" ? legacyTimer.segment_started_at : null,
        elapsed_ms: elapsed,
        limit_ms: typeof legacyTimer.limit_ms === "number" ? legacyTimer.limit_ms : null,
        limit_member_id: byRole?.session_id ?? null,
      }
    } else {
      // Ensure every field exists even on partially-written timers.
      channel.timer = {
        active_member_id:
          typeof legacyTimer.active_member_id === "string" ? legacyTimer.active_member_id : null,
        segment_started_at:
          typeof legacyTimer.segment_started_at === "number" ? legacyTimer.segment_started_at : null,
        elapsed_ms:
          legacyTimer.elapsed_ms && isRecord(legacyTimer.elapsed_ms)
            ? (legacyTimer.elapsed_ms as Record<string, number>)
            : {},
        limit_ms: typeof legacyTimer.limit_ms === "number" ? legacyTimer.limit_ms : null,
        limit_member_id:
          typeof legacyTimer.limit_member_id === "string" ? legacyTimer.limit_member_id : null,
      }
    }
  }
  if (!Array.isArray(state.errors)) state.errors = []
}

// ── Store ───────────────────────────────────────────────────────────────────

function sleepBusy(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export class StateStore {
  readonly dir: string
  readonly file: string
  private lockPath: string

  constructor(projectDir: string) {
    this.dir = join(projectDir, STATE_DIR)
    this.file = join(this.dir, STATE_FILE)
    this.lockPath = join(this.dir, LOCK_FILE)
  }

  /**
   * Run `fn` while holding an exclusive cross-process state lock. The lock is
   * an exclusive-create file carrying PID + acquired-at; locks older than
   * LOCK_STALE_MS are treated as abandoned and broken. Throws when no lock
   * could be acquired within LOCK_TIMEOUT_MS (callers should surface that;
   * refusing to proceed is what prevents lost updates).
   */
  withLock<T>(fn: () => T): T {
    mkdirSync(this.dir, { recursive: true })
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    let fd: number | null = null
    for (;;) {
      try {
        fd = openSync(this.lockPath, "wx")
        break
      } catch {
        // Either EEXIST (someone else holds it) or a race lost. Inspect age.
        try {
          const st = statSync(this.lockPath)
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            // Presumed dead owner: break the lock. openSync wx re-checks
            // exclusivity after removal, so concurrent stealers serialize.
            try {
              unlinkSync(this.lockPath)
            } catch {
              /* another process broke/removed it first; fine */
            }
          }
        } catch {
          /* stat failed → lock vanished between open and stat; just retry */
        }
        if (Date.now() >= deadline) {
          throw new Error(
            "OpenComms: timed out waiting for the state lock (.state.lock). Another session may be stuck holding it.",
          )
        }
        sleepBusy(10)
      }
    }
    try {
      try {
        writeFileSync(fd as unknown as PathOrFileDescriptor, `${process.pid}@${Date.now()}`, "utf8")
      } catch {
        /* content is advisory only; holding the exclusive create is what matters */
      }
      return fn()
    } finally {
      closeSync(fd)
      try {
        unlinkSync(this.lockPath)
      } catch {
        /* best effort */
      }
    }
  }

  load(): State {
    if (!existsSync(this.file)) return emptyState()
    try {
      const raw = readFileSync(this.file, "utf8")
      const parsed: unknown = JSON.parse(raw)
      const result = validateState(parsed)
      if (!result.ok) {
        // Invalid/tampered/stale-schema state must never be trusted: start
        // fresh and record why, visible via opencomms_status.
        const base = emptyState()
        base.errors.push({
          at: Date.now(),
          message: `State file rejected (${result.reason}); started with empty state.`,
        })
        return base
      }
      backfillState(result.state)
      return result.state
    } catch (error) {
      // Corrupt state must never brick the plugin: start fresh and record the
      // recovery so the user can see what happened via opencomms_status.
      const base = emptyState()
      base.errors.push({
        at: Date.now(),
        message: `State file unreadable; started with empty state: ${(error as Error).message}`,
      })
      return base
    }
  }

  save(state: State): void {
    mkdirSync(this.dir, { recursive: true })
    const tmp = join(this.dir, `.state.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
    const payload = JSON.stringify(state, null, 2)
    writeFileSync(tmp, payload, "utf8")
    try {
      renameSync(tmp, this.file)
    } catch (error) {
      // Windows: retry once after a short blocking pause (AV/OneDrive races).
      try {
        sleepBusy(50)
        renameSync(tmp, this.file)
      } catch (second) {
        try {
          writeFileSync(this.file, payload, "utf8")
        } catch {
          throw new Error(
            `OpenComms: failed to persist state (${(error as Error).message}; ${(second as Error).message})`,
          )
        }
      }
    }
  }

  /** Convenience: load, mutate, save — all under the cross-process lock. */
  update(mutate: (state: State) => void): State {
    return this.withLock(() => {
      const state = this.load()
      mutate(state)
      this.save(state)
      return state
    })
  }
}

export function stateDirFor(projectDir: string): string {
  return join(projectDir, STATE_DIR)
}

export function isInsideStateDir(projectDir: string, candidate: string): boolean {
  const dir = dirname(candidate)
  return dir === stateDirFor(projectDir)
}
