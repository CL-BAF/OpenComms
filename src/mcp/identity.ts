/**
 * Pinned member identity for OpenComms MCP servers.
 *
 * One MCP server process serves exactly ONE channel member. The installer
 * pins the member's OpenComms session id in that process's environment;
 * tools derive the caller from this pin and NEVER from a tool argument.
 * Members removed from the roster lose access immediately (fail closed).
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMember } from "../core/engine.js"
import type { State } from "../core/types.js"

export const OPENCOMMS_MEMBER_ID_ENV = "OPENCOMMS_MEMBER_ID"
export const OPENCOMMS_MEMBER_ROLE_ENV = "OPENCOMMS_MEMBER_ROLE"
export const OPENCOMMS_CHANNEL_ENV = "OPENCOMMS_CHANNEL"
/** Machine-local pin file under .opencomms/ (zero-config hook identity). */
export const MEMBER_PIN_FILE = "member-pin.json"

export interface PinnedMember {
  member_id: string
}

/**
 * Read the pinned identity from a hook process's environment; null when
 * unset. NOTE: for Claude Code hooks the env pin is usually ABSENT in real
 * installs (hook commands carry no env); use loadPinForProject instead.
 */
export function pinnedMember(env: NodeJS.ProcessEnv = process.env): PinnedMember | null {
  const id = env["OPENCOMMS_MEMBER_ID"]?.trim()
  if (!id) return null
  return { member_id: id }
}

/**
 * Read the persisted per-member pin file (<project>/.opencomms/member-pin.json).
 * Written by the installer at member registration so hook processes get a
 * zero-config identity source (Reviewer Issue 9). Machine-local identity
 * data — same trust boundary as state.json.
 */
export function loadProjectPin(projectDir: string): PinnedMember | null {
  try {
    const raw = readFileSync(join(projectDir, ".opencomms", MEMBER_PIN_FILE), "utf8")
    const parsed = JSON.parse(raw) as { member_id?: unknown }
    const id = typeof parsed["member_id"] === "string" ? parsed["member_id"].trim() : ""
    return id ? { member_id: id } : null
  } catch {
    return null
  }
}

/**
 * Persist the pin file (idempotent same-value overwrite).
 * Returns false when the write failed (callers surface a warning, never crash).
 */
export function saveProjectPin(projectDir: string, memberId: string, host: string): boolean {
  try {
    const dir = join(projectDir, ".opencomms")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, MEMBER_PIN_FILE),
      JSON.stringify({ member_id: memberId, host, saved_at: Date.now() }, null, 2),
      "utf8",
    )
    return true
  } catch {
    return false
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
