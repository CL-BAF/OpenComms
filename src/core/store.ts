/**
 * OpenComms â€” persistent state store.
 *
 * State is stored in `<project>/.opencomms/state.json`. Writes are
 * atomic: we serialize to a temp file in the same directory, flush it, then
 * rename over the target. On Windows, `rename` over an existing file is
 * supported by Node's fs.rename (it maps to MoveFileEx with REPLACE_EXISTING),
 * but we defensively retry once after a short delay because antivirus or
 * OneDrive can briefly hold a handle.
 *
 * Concurrency: multiple host sessions share one state.json. A bare
 * loadâ†’mutateâ†’save sequence can lose updates when interleaved across
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
  copyFileSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  type PathOrFileDescriptor,
} from "node:fs"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import {
  DEFAULT_MAX_MEMBERS,
  MAX_MEMBERS_CEILING,
  LEGACY_HOST_ID,
  LEGACY_STATE_DIR,
  MIGRATION_MARKER,
  SCHEMA_VERSION,
  STATE_DIR,
  STATE_FILE,
  type Channel,
  type DeliveryMode,
  type HostSurface,
  type State,
  type StalePolicy,
} from "./types.js"
import { defaultTimer, effectiveEndpointCapabilities, makeMember } from "./engine.js"

const LOCK_FILE = ".state.lock"
/** How long to keep retrying lock acquisition before giving up. */
export const LOCK_TIMEOUT_MS = 5_000
/** Locks older than this are presumed abandoned by a dead process and broken. */
export const LOCK_STALE_MS = 15_000

/** Classic PUSH-distribution stale window (v1 behavior). */
export const DEFAULT_STALE_POLICY: StalePolicy = { mode: "window", window_ms: 5 * 60_000 }
/** PULL members never age out; retention + explicit expiry bound the queue. */
export const PULL_STALE_POLICY: StalePolicy = { mode: "none", window_ms: null }

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

// â”€â”€ Load-time validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isValidMember(m: unknown, legacy = false): boolean {
  if (!isRecord(m)) return false
  return (
    typeof m["session_id"] === "string" &&
    typeof m["session_id"].length === "number" &&
    m["session_id"].length > 0 &&
    typeof m["role"] === "string" &&
    ROLE_PATTERN.test(m["role"]) &&
    typeof m["role_prompt"] === "string" &&
    typeof m["joined_at"] === "number" &&
    // v2 rows must carry the full member model; v1 rows are migrated instead.
    (legacy ||
      (typeof m["host"] === "string" && typeof m["surface"] === "string" && typeof m["delivery_mode"] === "string"))
  )
}

function isValidChannel(ch: unknown, legacy = false): boolean {
  if (!isRecord(ch)) return false
  if (typeof ch["id"] !== "string" || typeof ch["name"] !== "string") return false
  if (typeof ch["project_id"] !== "string" || typeof ch["worktree"] !== "string") return false
  if (!Array.isArray(ch["members"])) return false
  const members = ch["members"] as unknown[]
  // Empty channels are transiently possible but never persisted EXCEPT the
  // precise resumed-not-yet-repopulated case: an ACTIVE session linked to a
  // parent archive with zero members is the documented resume state.
  const isResumedEmpty =
    members.length === 0 &&
    ch["lifecycle"] === "active" &&
    typeof ch["parent_channel_id"] === "string" &&
    (ch["parent_channel_id"] as string).length > 0
  if (members.length === 0 && !isResumedEmpty) return false
  if (members.length > MAX_MEMBERS_CEILING) return false
  return members.every((m) => isValidMember(m, legacy))
}

/**
 * Structural + integrity validation of untrusted on-disk state. Tampered or
 * stale files must be rejected outright rather than partially trusted: a
 * forged member row would let arbitrary text into the system prompt
 * (role_prompt injection), and a wrong schema_version would silently skip
 * guards this version assumes.
 *
 * `legacy` true relaxes member validation for v1 rows (which lack the v2
 * member fields; migration backfills them).
 */
function validateState(
  parsed: unknown,
  opts: { legacy?: boolean } = {},
): { ok: true; state: State } | { ok: false; reason: string } {
  if (!isRecord(parsed)) return { ok: false, reason: "state root is not an object" }
  if (parsed["schema_version"] !== (opts.legacy ? 1 : SCHEMA_VERSION)) {
    return {
      ok: false,
      reason: `schema_version mismatch: expected ${opts.legacy ? 1 : SCHEMA_VERSION}, got ${String(parsed["schema_version"])}`,
    }
  }
  const channels = parsed["channels"]
  const messages = parsed["messages"]
  const queues = parsed["queues"]
  const deliveredTo = parsed["delivered_to"]
  const errors = parsed["errors"]
  if (!isRecord(channels)) return { ok: false, reason: "channels is not an object" }
  for (const key of Object.keys(channels)) {
    if (!isValidChannel((channels as Record<string, unknown>)[key], opts.legacy)) {
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
    for (const member of channel.members) {
      // Endpoint capabilities are DERIVED from delivery_mode when absent
      // (additive evolution of spawn_push — see engine
      // effectiveEndpointCapabilities). Never a schema bump: the field is
      // optional and mode-derived defaults keep old rows correct.
      if (!member.endpoint_capabilities) {
        member.endpoint_capabilities = effectiveEndpointCapabilities(member)
      }
    }
    if (typeof channel.max_members !== "number" || Number.isNaN(channel.max_members)) {
      channel.max_members = DEFAULT_MAX_MEMBERS
    } else {
      // Clamp out-of-range (possibly tampered) caps into sane bounds.
      channel.max_members = Math.max(2, Math.min(MAX_MEMBERS_CEILING, Math.floor(channel.max_members)))
    }
    if (channel.paused === undefined) channel.paused = false
    if (channel.rate === undefined || typeof channel.rate.window_start !== "number") {
      channel.rate = { window_start: Date.now(), count: 0 }
    }
    if (!channel.cooldown_until) channel.cooldown_until = {}
    if (!channel.seen_content) channel.seen_content = {}
    if (!Array.isArray(channel.processed_correlations)) channel.processed_correlations = []
    // Conversation budgets (additive; old channels default to unlimited).
    if (!channel.budgets || typeof channel.budgets !== "object") {
      channel.budgets = { max_runtime_ms: null, max_delivered_messages: null }
    } else {
      if (channel.budgets.max_runtime_ms === undefined) channel.budgets.max_runtime_ms = null
      if (channel.budgets.max_delivered_messages === undefined) channel.budgets.max_delivered_messages = null
      if (!Number.isFinite(channel.budgets.max_runtime_ms)) channel.budgets.max_runtime_ms = null
      if (!Number.isFinite(channel.budgets.max_delivered_messages)) channel.budgets.max_delivered_messages = null
    }
    // Session lifecycle + description + lineage (additive; old channels are
    // and always were ACTIVE sessions with no description and no parent).
    if (channel.lifecycle !== "active" && channel.lifecycle !== "saved" && channel.lifecycle !== "deleted") {
      channel.lifecycle = "active"
    }
    if (channel.description === undefined) channel.description = null
    if (channel.parent_channel_id === undefined) channel.parent_channel_id = null
    if (typeof channel.delivered_total !== "number" || !Number.isFinite(channel.delivered_total)) {
      // First backfill of an old channel: count already-delivered envelopes
      // so lifetime budget accounting does not start from zero.
      channel.delivered_total = Object.values(state.messages).filter(
        (m) => m.channel_id === channel.id && (m.delivery_status === "delivered" || m.delivery_status === "in_flight"),
      ).length
    }
    // Timer migration: pre-multi-agent timers keyed roles as active_role;
    // current timers key members by session id.
    const legacyTimer = channel.timer as unknown as Record<string, unknown> | undefined
    if (!legacyTimer || typeof legacyTimer !== "object") {
      channel.timer = defaultTimer()
    } else if (
      (legacyTimer.active_member_id === undefined || legacyTimer.elapsed_ms === undefined) &&
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
        segment_started_at: typeof legacyTimer.segment_started_at === "number" ? legacyTimer.segment_started_at : null,
        elapsed_ms: elapsed,
        limit_ms: typeof legacyTimer.limit_ms === "number" ? legacyTimer.limit_ms : null,
        limit_member_id: byRole?.session_id ?? null,
      }
    } else {
      // Ensure every field exists even on partially-written timers.
      channel.timer = {
        active_member_id: typeof legacyTimer.active_member_id === "string" ? legacyTimer.active_member_id : null,
        segment_started_at: typeof legacyTimer.segment_started_at === "number" ? legacyTimer.segment_started_at : null,
        elapsed_ms:
          legacyTimer.elapsed_ms && isRecord(legacyTimer.elapsed_ms)
            ? (legacyTimer.elapsed_ms as Record<string, number>)
            : {},
        limit_ms: typeof legacyTimer.limit_ms === "number" ? legacyTimer.limit_ms : null,
        limit_member_id: typeof legacyTimer.limit_member_id === "string" ? legacyTimer.limit_member_id : null,
      }
    }
  }
  // Envelope debug fields (additive): old envelopes get explicit nulls so
  // reads never see undefined; new envelopes carry root_message_id (lineage)
  // and delivery_method (transport actually used).
  for (const msg of Object.values(state.messages)) {
    if (msg.root_message_id === undefined) msg.root_message_id = null
    if (msg.delivery_method === undefined) msg.delivery_method = null
  }
  if (!Array.isArray(state.errors)) state.errors = []
}

// â”€â”€ Store â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Yield to the event loop instead of blocking it. Lock acquisition can wait
 * up to LOCK_TIMEOUT_MS; freezing every session sharing this process for
 * that long (Atomics.wait) would turn one wedged lock-holder into a
 * whole-process stall. Callers must therefore treat withLock as async.
 */
function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class StateStore {
  readonly dir: string
  readonly file: string
  readonly projectDir: string
  private lockPath: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
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
   *
   * Async on purpose: waiting for the lock yields to the event loop
   * (setTimeout polling) rather than blocking the whole process, so one
   * contended lock can never freeze unrelated sessions.
   */
  async withLock<T>(fn: () => T): Promise<T> {
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
          /* stat failed â†’ lock vanished between open and stat; just retry */
        }
        if (Date.now() >= deadline) {
          throw new Error(
            "OpenComms: timed out waiting for the state lock (.state.lock). Another session may be stuck holding it.",
          )
        }
        await sleepAsync(10)
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

  /**
   * One-time cutover from the legacy single-host layout:
   *   legacy state dir / state.json (schema v1)
   *     -> <project>/.opencomms/state.json (schema v2)
   *
   * Discipline (Reviewer Item 4): when the new dir is absent and a VALID v1
   * state exists, back it up, migrate it, and write MIGRATED_FROM_V1 so a
   * second load never re-migrates (no double-members, no duplication). The
   * legacy dir is left untouched; the legacy plugin, if still loaded, reads
   * v1 with its own validator â€” it cannot fork v2 state (it fails validation
   * and starts empty with a recorded error, never dual-writes).
   *
   * Tampered legacy files are NOT migrated: fail-closed to empty state, with
   * the reason recorded in errors.
   *
   * Returns a migration notice for the errors/audit trail (or null).
   */
  migrateFromLegacyIfPresent(): string | null {
    const markerPath = join(this.dir, MIGRATION_MARKER)
    if (existsSync(markerPath) || existsSync(this.file)) return null
    const legacyFile = join(this.projectDir, LEGACY_STATE_DIR, STATE_FILE)
    if (!existsSync(legacyFile)) return null

    let legacyRaw: string
    try {
      legacyRaw = readFileSync(legacyFile, "utf8")
    } catch (error) {
      return `Legacy state at ${LEGACY_STATE_DIR}/ unreadable (${(error as Error).message}); starting fresh in ${STATE_DIR}/.`
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(legacyRaw)
    } catch (error) {
      return `Legacy state unreadable (not JSON: ${(error as Error).message}); starting fresh in ${STATE_DIR}/.`
    }
    const result = validateState(parsed, { legacy: true })
    if (!result.ok) {
      return `Legacy state rejected (${result.reason}); starting fresh in ${STATE_DIR}/. Original file left untouched.`
    }

    // Migrate: v1 -> v2 member model (legacy rows keep their era defaults), keep everything
    // else verbatim; backfill handles timer/max_members normalization.
    const migrated = result.state
    migrated.schema_version = SCHEMA_VERSION
    backfillState(migrated)
    for (const channel of Object.values(migrated.channels)) {
      channel.members = channel.members.map((m) =>
        makeMember(
          {
            session_id: m.session_id,
            role: m.role,
            role_prompt: m.role_prompt,
            host: LEGACY_HOST_ID,
            surface: "cli",
            delivery_mode: "push",
            host_session_id: m.session_id,
            stale_policy: { mode: "window", window_ms: DEFAULT_STALE_POLICY.window_ms },
          },
          m.joined_at,
        ),
      )
    }
    if (!Array.isArray(migrated.errors)) migrated.errors = []
    migrated.errors.push({
      at: Date.now(),
      message: `Migrated OpenComms state from ${LEGACY_STATE_DIR}/state.json (schema v1) to ${STATE_DIR}/state.json (schema v2); legacy file backed up as state.v1.bak.json and left in place.`,
    })

    mkdirSync(this.dir, { recursive: true })
    try {
      copyFileSync(legacyFile, join(this.dir, "state.v1.bak.json"))
    } catch {
      /* backup is best-effort; migration itself is still safe */
    }
    this.save(migrated)
    writeFileSync(
      markerPath,
      JSON.stringify({ migrated_at: Date.now(), from: LEGACY_STATE_DIR, schema: 1 }, null, 2),
      "utf8",
    )
    return `Migrated OpenComms state from ${LEGACY_STATE_DIR}/state.json (schema v1) to ${STATE_DIR}/state.json (schema v2). Channels, members, queues, and timers preserved.`
  }

  load(): State {
    // Cutover: migrate legacy v1 state before any read path can miss it.
    if (!existsSync(this.file) && !existsSync(join(this.dir, MIGRATION_MARKER))) {
      const notice = this.migrateFromLegacyIfPresent()
      if (notice) {
        // Return the MIGRATED state (not just a notice): the migration already
        // persisted it, and the caller expects the channels to be live.
        const migrated = this.readStateFile()
        if (migrated) return migrated
        const base = emptyState()
        base.errors.push({ at: Date.now(), message: notice })
        return base
      }
    }
    const state = this.readStateFile()
    if (state) return state
    return emptyState()
  }

  /** Read + validate + backfill <new-dir>/state.json; null when absent/broken. */
  private readStateFile(): State | null {
    if (!existsSync(this.file)) return null
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
      // Windows: retry once after a short yielding pause (AV/OneDrive races).
      // A blocking 50ms stall is acceptable here: the write already happened,
      // and this path is rare; the atomic-rename guarantee is what matters.
      try {
        // save() is intentionally synchronous (callers rely on durability
        // when it returns), so this rare retry path uses a bounded 50ms
        // blocking wait rather than async. LOCK acquisition â€” the path that
        // can wait seconds â€” uses yielding sleepAsync instead.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
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

  /** Convenience: load, mutate, save â€” all under the cross-process lock. */
  async update(mutate: (state: State) => void): Promise<State> {
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
