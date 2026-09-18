/**
 * M4.6 MCP principal classes (docs/mcp-orchestrator-tools.md §1-§2).
 *
 * Identity-scoped tool sets: the pin's class is FIXED at install time and
 * determines which MCP tools the instance sees — agent pins get the
 * channel tools only; operator pins get the orchestrator tools. No tool
 * can re-classify a pin (no self-escalation — Reviewer condition 4).
 *
 * The class travels in the per-member pin file (`pins/<id>.json`) under
 * `principal`, additive + backfilled (absent = "member", the legacy
 * default — existing installs are channel members by definition).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { MEMBER_PINS_DIR, pinnedMember } from "./identity.js"

export type PrincipalClass = "member" | "operator"

export type PrincipalAuth = { ok: true; member_id: string; principal: PrincipalClass } | { ok: false; message: string }

/** Read the pin class from the per-member pin file (additive field). */
export function pinClass(projectDir: string, memberId: string): PrincipalClass {
  if (!isValidMemberIdShape(memberId)) return "member"
  const file = join(projectDir, ".opencomms", MEMBER_PINS_DIR, `${memberId}.json`)
  if (!existsSync(file)) return "member"
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { principal?: unknown }
    return parsed.principal === "operator" ? "operator" : "member"
  } catch {
    return "member"
  }
}

function isValidMemberIdShape(memberId: string): boolean {
  return MEMBER_ID_PATTERN_CACHE.test(memberId)
}

const MEMBER_ID_PATTERN_CACHE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * Authorize a principal-classed MCP call, fail closed:
 *   - No pin => denied (identity never caller-supplied — M1 rule).
 *   - Pinned member not on any channel roster => denied for MEMBER-class
 *     actions (operators may act without channel membership).
 *   - Required class > pin class => denied with the typed upgrade message.
 */
export function authorizePrincipal(input: {
  projectDir: string
  env: NodeJS.ProcessEnv
  admin: boolean
  required: "read" | "member" | "operator" | "human-present"
  /** Member-class calls additionally require live channel membership. */
  requireRoster?: boolean
  state: { channels: Record<string, { members: Array<{ session_id: string }> }> }
}): PrincipalAuth {
  const pin = pinnedMember(input.env)
  if (!pin) {
    return {
      ok: false,
      message:
        "OpenComms MCP has no pinned member identity (OPENCOMMS_MEMBER_ID unset). Repair this member's configuration; identity can never be supplied by the caller.",
    }
  }
  const principal = input.admin ? "operator" : pinClass(input.projectDir, pin.member_id)
  const rank: Record<PrincipalClass | "read", number> = { read: 0, member: 1, operator: 2 }
  // human-present calls are token-gated separately (the token IS the
  // authority); the caller class only needs to exist.
  if (input.required === "human-present") {
    return { ok: true, member_id: pin.member_id, principal }
  }
  if (rank[input.required] > rank[principal]) {
    return {
      ok: false,
      message: `This MCP identity is "${principal}"-class; "${input.required}"-class tools require an operator-class MCP instance (installer --admin).`,
    }
  }
  if (input.requireRoster !== false && principal === "member") {
    const onRoster = Object.values(input.state.channels).some((c) =>
      c.members.some((m) => m.session_id === pin.member_id),
    )
    if (!onRoster) {
      return {
        ok: false,
        message:
          "This pinned member is not a member of any channel (removed, disconnected, or state reset). Rejoin a channel to reactivate.",
      }
    }
  }
  return { ok: true, member_id: pin.member_id, principal }
}
