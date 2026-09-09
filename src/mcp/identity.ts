/**
 * Pinned member identity for OpenComms MCP servers and host hooks.
 *
 * One MCP server process serves exactly ONE channel member; hooks bind ONE
 * host session to ONE member. The installer pins the member's OpenComms id
 * in the process environment (OPENCOMMS_MEMBER_ID) and/or on disk under
 * .opencomms/pins/<member_id>.json. Identity is NEVER accepted from tool
 * arguments, and members removed from the roster lose access immediately
 * (fail closed).
 *
 * Per-member pin storage (Reviewer P1-1): the legacy single member-pin.json
 * could only ever hold ONE identity per project - a second `install-member`
 * silently destroyed the first member's identity, and SessionStart could
 * bind a Claude session to the WRONG member. Pins are now per-member files;
 * the legacy file is still READ for one-member installs written by older
 * installers (backward compatible), but never written again.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMember } from "../core/engine.js"
import type { State } from "../core/types.js"

export const OPENCOMMS_MEMBER_ID_ENV = "OPENCOMMS_MEMBER_ID"
export const OPENCOMMS_MEMBER_ROLE_ENV = "OPENCOMMS_MEMBER_ROLE"
export const OPENCOMMS_CHANNEL_ENV = "OPENCOMMS_CHANNEL"
/** Machine-local pin directory under .opencomms/ (one file per member). */
export const MEMBER_PINS_DIR = "pins"
/** Legacy v2.0 single-identity pin file; read-only fallback. */
export const LEGACY_MEMBER_PIN_FILE = "member-pin.json"

/** Member ids become pin FILE names: strictly bounded, traversal-safe. */
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isValidMemberId(memberId: string): boolean {
  return MEMBER_ID_PATTERN.test(memberId)
}

export interface PinnedMember {
  member_id: string
  host?: string
}

/**
 * Read the pinned identity from the current process environment; null when
 * unset. For MCP server processes this is THE identity source (the installer
 * writes it into the server's env block). Hook processes usually have no env
 * pin - they resolve through the per-member pin files instead.
 */
export function pinnedMember(env: NodeJS.ProcessEnv = process.env): PinnedMember | null {
  const id = env[OPENCOMMS_MEMBER_ID_ENV]?.trim()
  if (!id) return null
  return { member_id: id }
}

function pinsDir(projectDir: string): string {
  return join(projectDir, ".opencomms", MEMBER_PINS_DIR)
}

function pinFileFor(projectDir: string, memberId: string): string | null {
  if (!isValidMemberId(memberId)) return null
  return join(pinsDir(projectDir), `${memberId}.json`)
}

/**
 * Persist one member's pin file (.opencomms/pins/<member_id>.json).
 * Idempotent same-value overwrite; never touches other members' pins.
 * Returns false on write failure or an invalid member id (callers surface a
 * warning, never crash).
 */
export function saveMemberPin(projectDir: string, memberId: string, host: string): boolean {
  if (!isValidMemberId(memberId)) return false
  try {
    const dir = pinsDir(projectDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${memberId}.json`),
      JSON.stringify({ member_id: memberId, host, saved_at: Date.now() }, null, 2),
      "utf8",
    )
    return true
  } catch {
    return false
  }
}

/** Read one member's pin; null when absent, unreadable, or id-invalid. */
export function loadMemberPin(projectDir: string, memberId: string): PinnedMember | null {
  if (!isValidMemberId(memberId)) return null
  try {
    const raw = readFileSync(join(pinsDir(projectDir), `${memberId}.json`), "utf8")
    const parsed = JSON.parse(raw) as { member_id?: unknown }
    const id = typeof parsed["member_id"] === "string" ? parsed["member_id"].trim() : ""
    return id === memberId ? { member_id: id } : null
  } catch {
    return null
  }
}

/**
 * List every pin recorded for a host (or all hosts when omitted). Reads the
 * per-member pin directory; pins whose file contents disagree with their
 * file name are ignored (tamper guard).
 */
export function listMemberPins(projectDir: string, host?: string): PinnedMember[] {
  const dir = pinsDir(projectDir)
  if (!existsSync(dir)) return []
  const out: PinnedMember[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
  for (const entry of entries) {
    const expectedId = entry.slice(0, -".json".length)
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as {
        member_id?: unknown
        host?: unknown
      }
      const id = typeof parsed["member_id"] === "string" ? parsed["member_id"].trim() : ""
      if (id !== expectedId || !isValidMemberId(id)) continue
      if (host !== undefined && parsed["host"] !== host) continue
      out.push({ member_id: id, host: typeof parsed["host"] === "string" ? parsed["host"] : undefined })
    } catch {
      /* unreadable pin: skip, never fail the whole listing */
    }
  }
  return out
}

/**
 * LEGACY single-member pin file (v2.0 installers). Read-only: kept so
 * projects installed before per-member pins keep working. A legacy file is
 * only honored when NO per-member pins exist (the operator upgraded the
 * members but not the install yet).
 */
export function loadProjectPin(projectDir: string): PinnedMember | null {
  try {
    const raw = readFileSync(join(projectDir, ".opencomms", LEGACY_MEMBER_PIN_FILE), "utf8")
    const parsed = JSON.parse(raw) as { member_id?: unknown }
    const id = typeof parsed["member_id"] === "string" ? parsed["member_id"].trim() : ""
    return id && isValidMemberId(id) ? { member_id: id } : null
  } catch {
    return null
  }
}

export type MemberAuth = { ok: true; member_id: string } | { ok: false; message: string }

/**
 * Validate the pinned identity against the live roster, fail closed.
 * - No pin configured -> denied (identity is never caller-supplied).
 * - Pinned member absent from the current roster (kicked, disconnected, or
 *   state reset) -> denied until the member rejoins.
 */
export function authorizeMember(state: State, env: NodeJS.ProcessEnv = process.env): MemberAuth {
  const pin = pinnedMember(env)
  if (!pin) {
    return {
      ok: false,
      message:
        "OpenComms MCP has no pinned member identity (OPENCOMMS_MEMBER_ID unset). Repair this member's configuration; identity can never be supplied by the caller.",
    }
  }
  if (!isMember(state, pin.member_id)) {
    return {
      ok: false,
      message:
        "This pinned member is not a member of any channel (removed, disconnected, or state reset). Rejoin a channel to reactivate.",
    }
  }
  return { ok: true, member_id: pin.member_id }
}
