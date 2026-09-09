/**
 * Claude Code adapter — hook handlers.
 *
 * Claude Code hooks (verified 2026-08-29 against code.claude.com/docs/en/hooks)
 * fire at lifecycle boundaries and can inject context via stdout JSON
 * (hookSpecificOutput.additionalContext on SessionStart / UserPromptSubmit /
 * Stop). Hooks receive { session_id, cwd, hook_event_name, ... } on stdin.
 *
 * DELIVERY HONESTY: hook-boundary injection is NOT mid-turn push. Messages
 * arrive at the next hook boundary — documented as PARTIAL in
 * CAPABILITIES.md, never "push".
 *
 * IDENTITY NAMESPACE (Reviewer Issue 2): MCP-joined members are keyed by
 * their pinned OPENCOMMS_MEMBER_ID, while hooks observe CLAUDE CODE session
 * ids (a different namespace). The bridge is host_session_id: the
 * SessionStart hook records hostSessionId -> memberId binding; delivery
 * hooks resolve the incoming Claude session id through that index
 * (fail-closed on ambiguity). See core memberIndexByHostSession.
 *
 * All handlers are ASYNC end-to-end: Node keeps a CLI alive while promises
 * and timers are pending, so there is no blocking/spinning anywhere.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { StateStore } from "../../core/store.js"
import { listMemberPins, loadProjectPin } from "../../mcp/identity.js"
import {
  clearStale,
  commitDelivery,
  drainForDelivery,
  formatDeliveryBatch,
  isMember,
  markStale,
  resolveMemberByHostSession,
} from "../../core/engine.js"
import type { Member, State } from "../../core/types.js"

/** Subset of Claude Code's documented hook stdin payload. */
export interface ClaudeHookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  /** SessionStart matcher: startup | resume | clear | compact | fork */
  source?: string
  [key: string]: unknown
}

export interface ClaudeHookOutput {
  /** hookSpecificOutput.additionalContext for context-injecting events. */
  hookSpecificOutput?: {
    hookEventName: string
    additionalContext?: string
  }
  /** Non-blocking notice shown to the user. */
  systemMessage?: string
  suppressOutput?: boolean
}

function readStdinJson(): ClaudeHookInput {
  try {
    return JSON.parse(readFileSync(0, "utf8")) as ClaudeHookInput
  } catch {
    return {}
  }
}

/**
 * SessionStart hook: bind the host session id to the pinned member (if any),
 * clear staleness, deliver queued messages as additionalContext.
 * Fail-open: a broken OpenComms must never block a session from starting.
 */
export async function hookSessionStart(projectDir?: string): Promise<ClaudeHookOutput> {
  const input = readStdinJson()
  if (!input.session_id) return {}
  const dir = resolve(projectDir ?? input.cwd ?? process.cwd())
  return drainForHook(dir, input.session_id, "SessionStart", { bindHostSession: true })
}

/** UserPromptSubmit hook: deliver queued peer messages at the prompt boundary. */
export async function hookUserPromptSubmit(projectDir?: string): Promise<ClaudeHookOutput> {
  const input = readStdinJson()
  if (!input.session_id) return {}
  const dir = resolve(projectDir ?? input.cwd ?? process.cwd())
  return drainForHook(dir, input.session_id, "UserPromptSubmit")
}

/** Stop hook: deliver at turn end — the last boundary before full idle. */
export async function hookStop(projectDir?: string): Promise<ClaudeHookOutput> {
  const input = readStdinJson()
  if (!input.session_id) return {}
  const dir = resolve(projectDir ?? input.cwd ?? process.cwd())
  return drainForHook(dir, input.session_id, "Stop")
}

/** SessionEnd hook: mark the member stale (cleared again at next SessionStart). */
export async function hookSessionEnd(projectDir?: string): Promise<ClaudeHookOutput> {
  const input = readStdinJson()
  if (!input.session_id) return {}
  try {
    const store = new StateStore(resolve(projectDir ?? input.cwd ?? process.cwd()))
    await store.withLock(() => {
      const state = store.load()
      const memberId = resolveOpenCommsMember(state, input.session_id!)
      if (memberId) markStale(state, memberId)
      store.save(state)
    })
  } catch {
    /* fail-open */
  }
  return {}
}

/**
 * Resolve the OpenComms member id for an observed host (Claude) session id
 * via the host_session_id index. Returns null when unknown — the caller
 * treats that as "not linked" (fail closed, no guessing).
 */
function resolveOpenCommsMember(state: State, hostSessionId: string): string | null {
  return resolveMemberByHostSession(state, "claude-code", hostSessionId)
}

/**
 * Core boundary logic shared by all delivery hooks.
 *
 * 1. Resolve the incoming Claude session_id -> OpenComms member (binding it
 *    first when asked — SessionStart records host_session_id for the pinned
 *    member whose binding is missing).
 * 2. Clear staleness (the session is demonstrably live).
 * 3. Drain that member's queue and frame every envelope as untrusted.
 */
async function drainForHook(
  dir: string,
  hostSessionId: string,
  eventName: string,
  opts: { bindHostSession?: boolean } = {},
): Promise<ClaudeHookOutput> {
  try {
    const store = new StateStore(dir)
    let boundMemberId: string | null = null
    const linked = await store.withLock(() => {
      const state = store.load()

      // 1. Bind host identity: SessionStart associates the live Claude
      //    session with its OpenComms member (env pin, per-member pin files,
      //    or the legacy single-member pin).
      let memberId = resolveOpenCommsMember(state, hostSessionId)
      let guidance: string | undefined
      if (!memberId && opts.bindHostSession) {
        const bound = bindPinnedMemberToHostSession(state, hostSessionId, dir)
        memberId = bound.memberId
        guidance = bound.guidance
        if (memberId) {
          // Binding recorded — persist immediately.
          store.save(state)
        }
      }
      if (!memberId) return { pairs: [] as Array<{ id: string; channelName: string }>, guidance }
      boundMemberId = memberId

      // 2. The session is live: clear staleness (mirrors OpenCode's
      //    clearStale-on-idle; without this a member stays stale forever
      //    after its first SessionEnd — Reviewer Issue 3).
      clearStaleIfMember(state, memberId)

      // 3. Drain + frame, then persist the delivery marks (in_flight state,
      //    cleared staleness, and any binding) in ONE atomic save. The
      //    commit to "delivered" happens right after the context is handed
      //    to the host below — hook-boundary delivery completes inside this
      //    process, so the crash window is a single synchronous step.
      const pairs = drainForDelivery(state, memberId)
      store.save(state)
      return { pairs: pairs.map((p) => ({ id: p.message_id, channelName: p.channel_name })), guidance: undefined }
    })
    if (linked.guidance && linked.pairs.length === 0) {
      return { systemMessage: linked.guidance }
    }
    if (linked.pairs.length === 0) return {}

    const snapshot = store.load()
    const parts: string[] = []
    for (const item of linked.pairs) {
      const msg = snapshot.messages[item.id]
      if (!msg) continue
      parts.push(formatDeliveryBatch([msg], item.channelName))
    }
    if (parts.length === 0) return {}
    // Commit in_flight -> delivered: the additionalContext is returned to
    // the host in this same response, so delivery is now complete.
    await store.withLock(() => {
      const state2 = store.load()
      if (boundMemberId)
        commitDelivery(
          state2,
          boundMemberId,
          linked.pairs.map((p) => p.id),
        )
      store.save(state2)
    })
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        additionalContext: parts.join("\n\n---\n\n"),
      },
    }
  } catch {
    // Never break the host session because of OpenComms problems.
    return {}
  }
}

/**
 * Bind the CURRENT host session to a member. Resolution order:
 *   1. env OPENCOMMS_MEMBER_ID (explicit operator intent — tests, scripted
 *      multi-instance setups): binds (or REBINDS) exactly that member.
 *   2. Per-member pin files (.opencomms/pins/<member_id>.json, written by the
 *      installer): bind only when EXACTLY ONE claude-code member is both
 *      pinned and unbound (Reviewer P1-1: the old single pin file could bind
 *      the WRONG member or destroy another member's identity).
 *   3. Legacy member-pin.json (v2.0 single-member installs): same
 *      exactly-one-unbound rule, honored only when no per-member pins exist.
 *
 * Fail-closed: never rebinds an already-bound member via pins (a fresh
 * Claude session id must not silently steal a binding), never guesses among
 * multiple candidates. Ambiguity returns guidance for the systemMessage.
 */
function bindPinnedMemberToHostSession(
  state: State,
  hostSessionId: string,
  projectDir: string,
): { memberId: string | null; guidance?: string } {
  const envPin = process.env["OPENCOMMS_MEMBER_ID"]?.trim()
  if (envPin) {
    for (const channel of Object.values(state.channels)) {
      const member = channel.members.find((m) => m.session_id === envPin)
      if (member && member.host === "claude-code") {
        member.host_session_id = hostSessionId
        return { memberId: member.session_id }
      }
    }
    return { memberId: null, guidance: `OPENCOMMS_MEMBER_ID ${envPin} is not a claude-code member of any channel.` }
  }

  // Pin-file path: candidates are pinned claude-code members with no binding.
  const pins = listMemberPins(projectDir, "claude-code")
  const legacyPin = pins.length === 0 ? loadProjectPin(projectDir) : null
  const pinnedIds = [...pins.map((p) => p.member_id), ...(legacyPin ? [legacyPin.member_id] : [])]
  if (pinnedIds.length === 0) return { memberId: null }

  const unbound: Array<{ member: Member; pin: string }> = []
  for (const channel of Object.values(state.channels)) {
    for (const member of channel.members) {
      if (member.host !== "claude-code") continue
      const pin = pinnedIds.find((id) => id === member.session_id)
      // Rebindable = never bound, OR bound to a session that ENDED
      // (SessionEnd marks stale). Without the stale case a Claude restart
      // (new session id) would strand the member forever — silent loss.
      if (pin && (!member.host_session_id || member.stale)) unbound.push({ member, pin })
    }
  }
  if (unbound.length === 1) {
    unbound[0]!.member.host_session_id = hostSessionId
    return { memberId: unbound[0]!.member.session_id }
  }
  if (unbound.length > 1) {
    return {
      memberId: null,
      guidance:
        `OpenComms: ${unbound.length} pinned members are unbound (${unbound
          .map((u) => u.pin)
          .join(", ")}) — binding is ambiguous, so no member was auto-bound. ` +
        "Start sessions one at a time (install member -> start session), or set OPENCOMMS_MEMBER_ID for this session.",
    }
  }
  return { memberId: null }
}

function clearStaleIfMember(state: State, memberId: string): void {
  clearStale(state, memberId)
}
