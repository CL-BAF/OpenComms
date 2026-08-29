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
import { loadProjectPin } from "../../mcp/identity.js"
import {
  clearStale,
  drainForDelivery,
  formatDeliveryBatch,
  isMember,
  markStale,
  resolveMemberByHostSession,
} from "../../core/engine.js"
import type { State } from "../../core/types.js"

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
    const linked = await store.withLock(() => {
      const state = store.load()

      // 1. Bind host identity: SessionStart associates the live Claude
      //    session with its OpenComms member (pin file or env pin -> row).
      let memberId = resolveOpenCommsMember(state, hostSessionId)
      if (!memberId && opts.bindHostSession) {
        memberId = bindPinnedMemberToHostSession(state, hostSessionId, dir)
        if (memberId) {
          // Binding recorded — persist immediately.
          store.save(state)
        }
      }
      if (!memberId) return [] as Array<{ id: string; channelName: string }>

      // 2. The session is live: clear staleness (mirrors OpenCode's
      //    clearStale-on-idle; without this a member stays stale forever
      //    after its first SessionEnd — Reviewer Issue 3).
      clearStaleIfMember(state, memberId)

      // 3. Drain + frame, then persist the delivery marks (delivered state,
      //    cleared staleness, and any binding) in ONE atomic save.
      const pairs = drainForDelivery(state, memberId)
      store.save(state)
      return pairs.map((p) => ({ id: p.message_id, channelName: p.channel_name }))
    })
    if (linked.length === 0) return {}

    const snapshot = store.load()
    const parts: string[] = []
    for (const item of linked) {
      const msg = snapshot.messages[item.id]
      if (!msg) continue
      parts.push(formatDeliveryBatch([msg], item.channelName))
    }
    if (parts.length === 0) return {}
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
 * Bind the CURRENT host session to a member whose row has no host_session_id
 * yet. Pin resolution order (Reviewer Issue 9):
 *   1. env OPENCOMMS_MEMBER_ID (explicit override — tests/multi-instance)
 *   2. .opencomms/member-pin.json written by the installer (production path)
 * The bridge is needed because Claude Code hook commands carry no env block;
 * only an UNBOUND claude-code member can claim this session (fail-closed:
 * no rebind of an already-bound member here).
 */
function bindPinnedMemberToHostSession(state: State, hostSessionId: string, projectDir: string): string | null {
  const pin = process.env["OPENCOMMS_MEMBER_ID"]?.trim() ?? loadProjectPin(projectDir)?.member_id
  if (!pin) return null
  for (const channel of Object.values(state.channels)) {
    const member = channel.members.find((m) => m.session_id === pin)
    if (member && member.host === "claude-code" && !member.host_session_id) {
      member.host_session_id = hostSessionId
      return member.session_id
    }
  }
  return null
}

function clearStaleIfMember(state: State, memberId: string): void {
  clearStale(state, memberId)
}
