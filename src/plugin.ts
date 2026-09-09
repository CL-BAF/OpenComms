/**
 * OpenComms â€” OpenCode plugin entry point.
 *
 * Registers:
 *  - deterministic custom tools (opencomms_create, opencomms_join, ...)
 *  - the /OpenComms slash command (parses arguments deterministically and
 *    forwards the raw arguments to the matching tool)
 *  - the experimental.chat.system.transform hook, which injects the
 *    persistent per-session role prompt before model dispatch
 *  - the event hook, which tracks session idle/busy state and drains
 *    pending queues when a linked session becomes idle
 *
 * The plugin never creates sessions. It only links sessions the user has
 * already opened.
 *
 * Concurrency: every load->mutate->save cluster runs inside store.withLock so
 * two OpenCode processes sharing one project cannot lose each other's writes.
 * Bare reads (system-prompt transform, status) stay lock-free because saves
 * are atomic renames â€” readers see either the old or the new file intact.
 */

import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { StateStore } from "./core/store.js"
import { createDeliveryController } from "./hosts/opencode/delivery.js"
import { createSpawnDeliveryHook } from "./hosts/spawn-delivery.js"
import { ArchiveStore, buildArchiveContext } from "./core/archive.js"
import {
  buildSessionArchive,
  clearStale,
  commitSessionSave,
  createChannel,
  deleteSession,
  disconnectChannel,
  history,
  inbox,
  isMember,
  joinChannel,
  kickChannel,
  markStale,
  memberInfosFor,
  normalizeRole,
  pauseChannel,
  requeueFailedDelivery,
  REJECT_REASON_INVALID_MESSAGE_TYPE,
  resumeChannel,
  resumeSession,
  sendMessage,
  status,
  timerAction,
  updateRole,
  assertNotChildSession,
} from "./core/engine.js"
import type { SenderMessageType, State, TimerInput, ToolResult } from "./core/types.js"

const ROLE_PROMPT_HEADER = "## OpenComms role instructions"
const ROLE_RULES = 'Role must be 1-32 characters: letters first, then letters, digits, spaces, "-" or "_".'

function buildRolePrompt(role: string, prompt: string, channelName?: string): string {
  const scope = channelName ? ` on OpenComms channel "${channelName}"` : " on an OpenComms channel"
  return `${ROLE_PROMPT_HEADER}\n\nYou are the ${role}${scope}.\n\n${prompt.trim()}`
}

/** Slash-command keys we recognize. Unknown `key=value` pairs stay in the prompt text. */
const SLASH_KEYS = [
  "Channel",
  "As",
  "RolePrompt",
  "Action",
  "LimitMs",
  "LimitRole",
  "To",
  "Broadcast",
  "Target",
] as const

interface SlashArgs {
  params: Record<string, string>
  rest: string
}

/**
 * Extract only RECOGNIZED key=value tokens; free-form role prompts survive:
 * unknown `x=y` substrings in prose are no longer swallowed by a blanket
 * key=value stripper.
 */
function extractSlashArgs(raw: string): SlashArgs {
  const params: Record<string, string> = {}
  let rest = raw
  for (const key of SLASH_KEYS) {
    const valuePattern = String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))`
    const re = new RegExp(String.raw`(^|\s)(${key})\s*=\s*${valuePattern}`, "i")
    const m = re.exec(rest)
    if (m) {
      const quotedDouble = m[3]
      const quotedSingle = m[4]
      const bare = m[5]
      params[key.toLowerCase()] = quotedDouble ?? quotedSingle ?? bare ?? ""
      rest = rest.slice(0, m.index) + m[1] + rest.slice(m.index + m[0].length)
    }
  }
  return { params, rest: rest.trim() }
}

function slashSub(raw: string): string {
  const first = raw.trim().split(/\s+/)[0] ?? ""
  return first.replace(/[_-]/g, "").toLowerCase()
}

export const OpenCommsPlugin: Plugin = async ({ client, project, directory, worktree }) => {
  const store = new StateStore(directory)
  const archives = new ArchiveStore(directory)
  const projectId = project.id
  const worktreePath = worktree || directory

  // Read-only loads need no lock: state.json is replaced atomically, so a
  // reader never observes a torn write.
  const load = (): State => store.load()

  const recordError = (message: string): void => {
    void store.withLock(() => {
      const state = load()
      state.errors.push({ at: Date.now(), message })
      if (state.errors.length > 200) state.errors = state.errors.slice(-200)
      store.save(state)
    })
  }

  // Owner-side delivery controller (see src/hosts/opencode/delivery.ts):
  // multi-server topology fix + two-phase in_flight delivery + fs-watch wake.
  // spawnPush routes cross-host members (claude-code / codex spawn_push) to
  // their host's documented CLI resume instead of client.session.prompt.
  const spawnPush = createSpawnDeliveryHook(store, recordError)
  const delivery = createDeliveryController({
    store,
    load,
    client,
    recordError,
    spawnDelivery: (recipientSessionId) => spawnPush([recipientSessionId]),
  })
  void delivery
    .startupSweep()
    .catch((error) => recordError(`Startup in-flight sweep failed: ${(error as Error).message}`))

  /** Mutating update that persists when `shouldSave(result)` holds true. */
  const withLockedState = async (
    mutate: (state: State) => ToolResult,
    shouldSave: (result: ToolResult) => boolean,
  ): Promise<ToolResult> => {
    return store.withLock(() => {
      const state = load()
      const result = mutate(state)
      if (shouldSave(result)) store.save(state)
      return result
    })
  }

  const requireMember = (state: State, sessionId: string): ToolResult | null => {
    if (!isMember(state, sessionId)) {
      return {
        ok: false,
        message: "This session is not linked to any OpenComms channel. Create or join a channel first.",
      }
    }
    return null
  }

  /**
   * Invariant #1: OpenComms only links root OpenCode sessions. FAIL CLOSED:
   * if the SDK lookup errors we cannot verify root status, so we refuse to
   * mutate channel membership and record why in opencomms_status. A transient
   * server hiccup must not open the door to child-session linking.
   */
  const requireRootSession = async (sessionId: string): Promise<string | null> => {
    try {
      const res = await client.session.get({ path: { id: sessionId } })
      const parentID = res.data?.parentID
      return assertNotChildSession(parentID, sessionId)
    } catch (error) {
      const msg = `Root-session lookup for ${sessionId} failed (${(error as Error).message}); refusing to link until the session can be verified as a root session. Retry shortly.`
      await store.withLock(() => {
        const state = load()
        state.errors.push({ at: Date.now(), message: msg })
        if (state.errors.length > 200) state.errors = state.errors.slice(-200)
        store.save(state)
      })
      return msg
    }
  }

  const tools = {
    opencomms_create: tool({
      description:
        "Create an OpenComms channel and register the CURRENT session under a role label (e.g. Builder, Reviewer â€” any short unique label). The current session's real session id is taken from the tool execution context â€” no new session is created. Role instructions in `role_prompt` become the persistent per-session system instructions.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive slug)."),
        role: tool.schema.string().describe(`Role label. ${ROLE_RULES}`),
        role_prompt: tool.schema.string().describe("Persistent role instructions for this session."),
        max_members: tool.schema.number().optional().describe(`Optional membership cap (default ${8}).`),
        rate_limit: tool.schema
          .number()
          .optional()
          .describe("Optional messages-per-minute cap (1-1000, default 20). Autonomous-loop safeguard."),
        max_hops: tool.schema
          .number()
          .optional()
          .describe("Optional reply-chain depth cap (1-50, default 4). Autonomous-loop safeguard."),
        budget_runtime_ms: tool.schema
          .number()
          .optional()
          .describe("Optional conversation runtime budget in ms (min 60000). Sends are rejected past it."),
        budget_messages: tool.schema
          .number()
          .optional()
          .describe("Optional lifetime budget of delivered messages (incl. retries)."),
      },
      async execute(args, ctx: ToolContext) {
        const role = normalizeRole(args.role)
        if (!role) return ROLE_RULES
        const rootReject = await requireRootSession(ctx.sessionID)
        if (rootReject) return rootReject
        const result = await withLockedState(
          (state) =>
            createChannel(state, {
              channel: args.channel,
              role,
              role_prompt: args.role_prompt,
              session_id: ctx.sessionID,
              project_id: projectId,
              worktree: worktreePath,
              max_members: args.max_members,
              rate_limit: args.rate_limit,
              max_hops: args.max_hops,
              budgets: {
                max_runtime_ms: args.budget_runtime_ms ?? null,
                max_delivered_messages: args.budget_messages ?? null,
              },
              host: "opencode",
              host_session_id: ctx.sessionID,
            }),
          (r) => r.ok,
        )
        return JSON.stringify(result)
      },
    }),

    opencomms_join: tool({
      description:
        "Join an existing OpenComms channel with the CURRENT session under a role label (e.g. Builder, Reviewer â€” any short unique label not already taken on that channel). The current session's real session id is taken from the tool execution context â€” no new session is created. Rejects joining the same session twice, using one session for two roles, replacing an existing member, full channels, child sessions, and sessions from incompatible projects or worktrees.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        role: tool.schema.string().describe(`Role label (unique within the channel). ${ROLE_RULES}`),
        role_prompt: tool.schema.string().describe("Persistent role instructions for this session."),
      },
      async execute(args, ctx: ToolContext) {
        const role = normalizeRole(args.role)
        if (!role) return ROLE_RULES
        const rootReject = await requireRootSession(ctx.sessionID)
        if (rootReject) return rootReject
        const result = await withLockedState(
          (state) =>
            joinChannel(state, {
              channel: args.channel,
              role,
              role_prompt: args.role_prompt,
              session_id: ctx.sessionID,
              project_id: projectId,
              worktree: worktreePath,
              host: "opencode",
              host_session_id: ctx.sessionID,
            }),
          (r) => r.ok,
        )
        // Resumed sessions hand the joiner the COMPACT archived context
        // (purpose/summary/roster) — never the full transcript.
        if (result.ok) {
          const parentId = (result.data as { parent_channel_id?: string | null } | undefined)?.parent_channel_id
          if (parentId) {
            const archive = archives.get(parentId)
            if (archive) {
              const enriched: ToolResult = {
                ...result,
                message: `${result.message}\n\n${buildArchiveContext(archive, String((result.data as { name?: string }).name ?? args.channel))}`,
              }
              return JSON.stringify(enriched)
            }
          }
        }
        return JSON.stringify(result)
      },
    }),

    opencomms_send: tool({
      description:
        "Send a structured peer message on the current session's OpenComms channel. Queued and delivered when recipients are idle. On channels with more than one other member, target one member with `to` (session id or role label) or fan out with broadcast=true. Never auto-forwards assistant responses â€” only explicit calls to this tool cross sessions.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        type: tool.schema
          .string()
          .optional()
          .describe("Message type: review_request, review_response, or manual. Defaults to manual."),
        content: tool.schema.string().describe("Message content."),
        reply_to: tool.schema.string().optional().nullable().describe("Optional message_id this message replies to."),
        to: tool.schema
          .string()
          .optional()
          .nullable()
          .describe("Recipient on multi-member channels: another member's session id or role label."),
        broadcast: tool.schema
          .boolean()
          .optional()
          .describe("Deliver to every other member of the channel instead of one recipient."),
        session_description: tool.schema
          .string()
          .optional()
          .describe(
            "One-sentence session purpose (max 140 chars). Set ONCE by the first responding agent; later values are ignored.",
          ),
      },
      async execute(args, ctx: ToolContext) {
        let invalidType = false
        let notifyRecipients: string[] = []
        const result = await withLockedState(
          (state) => {
            const blocked = requireMember(state, ctx.sessionID)
            if (blocked) return blocked
            const requestedType = (args.type ?? undefined) as SenderMessageType | undefined
            const sendResult = sendMessage(
              state,
              {
                channel: args.channel,
                type: requestedType,
                content: args.content,
                reply_to: args.reply_to ?? null,
                to: args.to ?? null,
                broadcast: args.broadcast,
                session_description: args.session_description ?? null,
              },
              ctx.sessionID,
            )
            // Branch on the structured reason code, never on error text.
            if (!sendResult.ok) {
              const reason = (sendResult.data as { reason?: string } | undefined)?.reason
              if (reason === REJECT_REASON_INVALID_MESSAGE_TYPE) invalidType = true
            }
            return sendResult
          },
          (r) => r.ok === true,
        )
        // Fire deliveries only AFTER the state lock is released â€”
        // deliverPending acquires the lock itself and must never nest.
        if (result.ok) {
          notifyRecipients = ((result.data as { recipients?: string[] } | undefined)?.recipients ?? []).slice()
        }
        for (const rid of notifyRecipients) delivery.notifyRecipient(rid)
        if (invalidType) return "Invalid message type. Valid types: review_request, review_response, manual."
        return JSON.stringify(result)
      },
    }),

    opencomms_status: tool({
      description:
        "Show OpenComms status for channels the CURRENT session belongs to: members, roles, pause state, queue lengths, pending messages, and recorded errors. (The /OpenComms slash command shows the full project view.)",
      args: {
        channel: tool.schema.string().optional().describe("Optional channel name to inspect."),
      },
      async execute(args, ctx: ToolContext) {
        const state = load()
        // Member-scoped: session ids are capability handles; the roster is not
        // handed to unlinked sessions. (The /OpenComms slash command keeps
        // the full project view.)
        return JSON.stringify(status(state, { channel: args.channel, session_id: ctx.sessionID }))
      },
    }),

    opencomms_inbox: tool({
      description: "List messages currently queued for the current session on a channel, without delivering them.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        limit: tool.schema.number().optional().describe("Max messages to list (default 20, max 100)."),
      },
      async execute(args, ctx: ToolContext) {
        const state = load()
        const blocked = requireMember(state, ctx.sessionID)
        if (blocked) return blocked.message
        return JSON.stringify(inbox(state, { channel: args.channel, session_id: ctx.sessionID, limit: args.limit }))
      },
    }),

    opencomms_history: tool({
      description:
        "Show the message history of a channel you belong to, newest first, including delivery status. Member-only: sessions outside the channel cannot read its transcript.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        limit: tool.schema.number().optional().describe("Max messages to list (default 20, max 100)."),
      },
      async execute(args, ctx: ToolContext) {
        const state = load()
        return JSON.stringify(history(state, { channel: args.channel, session_id: ctx.sessionID, limit: args.limit }))
      },
    }),

    opencomms_update_role: tool({
      description:
        "Replace the persistent role instructions for the current session on a channel. Applies to all subsequent turns, including peer messages.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        role_prompt: tool.schema.string().describe("New persistent role instructions."),
      },
      async execute(args, ctx: ToolContext) {
        const result = await withLockedState(
          (state) => {
            const blocked = requireMember(state, ctx.sessionID)
            if (blocked) return blocked
            return updateRole(state, {
              channel: args.channel,
              session_id: ctx.sessionID,
              role_prompt: args.role_prompt,
            })
          },
          (r) => r.ok,
        )
        return JSON.stringify(result)
      },
    }),

    opencomms_pause: tool({
      description: "Pause a channel. No messages are delivered to any member until the channel is resumed.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
      },
      async execute(args, ctx: ToolContext) {
        const result = await withLockedState(
          (state) => {
            const blocked = requireMember(state, ctx.sessionID)
            if (blocked) return blocked
            return pauseChannel(state, { channel: args.channel, session_id: ctx.sessionID })
          },
          (r) => r.ok,
        )
        return JSON.stringify(result)
      },
    }),

    opencomms_resume: tool({
      description: "Resume a paused channel. Pending messages are delivered to idle members again.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
      },
      async execute(args, ctx: ToolContext) {
        const result = await withLockedState(
          (state) => {
            const blocked = requireMember(state, ctx.sessionID)
            if (blocked) return blocked
            return resumeChannel(state, { channel: args.channel, session_id: ctx.sessionID })
          },
          (r) => r.ok,
        )
        return JSON.stringify(result)
      },
    }),

    opencomms_disconnect: tool({
      description:
        "Disconnect the current session from a channel. The channel remains for other members, or is removed if empty. No OpenCode sessions are ever deleted.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
      },
      async execute(args, ctx: ToolContext) {
        const result = await withLockedState(
          (state) => {
            const blocked = requireMember(state, ctx.sessionID)
            if (blocked) return blocked
            return disconnectChannel(state, { channel: args.channel, session_id: ctx.sessionID })
          },
          (r) => r.ok,
        )
        return JSON.stringify(result)
      },
    }),

    opencomms_kick: tool({
      description:
        "Remove ANOTHER member from a channel (Builder only). Kicking only severs the channel link â€” the kicked OpenCode session keeps running; it just stops receiving this channel's traffic and gets clean 'not a member' errors. Remaining members are notified with a system message. The channel survives even with one member and can be rejoined.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        target_session_id: tool.schema.string().optional().nullable().describe("Session id of the member to remove."),
        target_role: tool.schema
          .string()
          .optional()
          .nullable()
          .describe("Role label of the member to remove (alternative to target_session_id)."),
      },
      async execute(args, ctx: ToolContext) {
        let notifyRecipients: string[] = []
        const result = await withLockedState(
          (state) => {
            const blocked = requireMember(state, ctx.sessionID)
            if (blocked) return blocked
            const kickResult = kickChannel(state, {
              channel: args.channel,
              session_id: ctx.sessionID,
              target_session_id: args.target_session_id ?? null,
              target_role: args.target_role ?? null,
            })
            if (kickResult.ok) {
              notifyRecipients = (
                (kickResult.data as { remaining_session_ids?: string[] } | undefined)?.remaining_session_ids ?? []
              ).slice()
            }
            return kickResult
          },
          (r) => r.ok,
        )
        // Drain the queued system notices immediately, post-lock.
        for (const rid of notifyRecipients) delivery.notifyRecipient(rid)
        return JSON.stringify(result)
      },
    }),

    opencomms_timer: tool({
      description:
        "Manage the chess-clock timer for a channel. Tracks cumulative active time PER MEMBER. Use 'status' to read elapsed time and check a hard limit. The timer auto-switches on send (sender stops, primary recipient starts), but can also be manually started, stopped, switched, reset, or given a limit via set_limit/clear_limit.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        action: tool.schema.string().describe("start | stop | switch | reset | status | set_limit | clear_limit"),
        limit_ms: tool.schema.number().optional().nullable().describe("For set_limit: the hard cap in milliseconds."),
        to: tool.schema
          .string()
          .optional()
          .nullable()
          .describe("For set_limit/switch on multi-member channels: target member by session id or role label."),
      },
      async execute(args, ctx: ToolContext) {
        const result = await withLockedState(
          (state) => {
            const blocked = requireMember(state, ctx.sessionID)
            if (blocked) return blocked
            return timerAction(state, {
              channel: args.channel,
              session_id: ctx.sessionID,
              action: args.action as TimerInput["action"],
              limit_ms: args.limit_ms ?? null,
              to: args.to ?? null,
            })
          },
          (r) => r.ok,
        )
        return JSON.stringify(result)
      },
    }),

    opencomms_save_session: tool({
      description:
        "SAVE the current session (archival, NOT deletion): stops autonomous activity, preserves an ARCHIVE (description, summary, final roster, role prompts, full message history) and removes the session from live state. Pass a short structured `summary` of decisions/completed work/known issues for future agents. Resume later with opencomms_resume_session (creates a NEW session linked to this archive).",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        summary: tool.schema
          .string()
          .optional()
          .describe(
            "Structured summary for future agents: purpose, decisions, completed work, known issues (<= 2000 chars).",
          ),
      },
      async execute(args, ctx: ToolContext) {
        // Phase A (locked): build + persist the archive, then purge live state.
        const result = await store.withLock(() => {
          const state = load()
          const built = buildSessionArchive(state, {
            channel: args.channel,
            session_id: ctx.sessionID,
            summary: args.summary ?? null,
          })
          if (!built.ok) return built
          const inputs = (built.data as { archive_inputs: Record<string, unknown> }).archive_inputs
          const archive = archives.fromChannel(
            inputs as never,
            inputs["messages"] as never,
            (inputs["saved_by"] as string | null) ?? null,
            (inputs["saved_by_role"] as string | null) ?? null,
            (inputs["summary"] as string | null) ?? null,
          )
          if (!archive.summary)
            archive.summary = `Session "${archive.name}" archived. ${archive.description ?? "No description recorded."}`
          archives.save(archive)
          commitSessionSave(state, archive.channel_id)
          store.save(state)
          return {
            ok: true,
            message: `Session "${archive.name}" SAVED. Autonomous activity stopped; archive written (id ${archive.channel_id}). Resume with opencomms_resume_session.`,
            data: {
              archive_id: archive.channel_id,
              message_count: archive.message_count,
              summary: archive.summary,
            },
          } satisfies ToolResult
        })
        return JSON.stringify(result)
      },
    }),

    opencomms_resume_session: tool({
      description:
        "Resume a SAVED session as a NEW active session: the archive stays intact, the new session is linked to it (parent_channel_id), and joiners receive the compact archived context. Requires membership in the archived session. Agents then join the new session normally.",
      args: {
        channel: tool.schema.string().describe("Saved session name (or archive id)."),
        new_name: tool.schema
          .string()
          .optional()
          .describe("Name for the new session (default: original, suffixed -r2.. when taken)."),
      },
      async execute(args, ctx: ToolContext) {
        let result: ToolResult | null = null
        await store.withLock(() => {
          const state = load()
          const byName = archives.findByName(args.channel)
          const archive = byName ?? archives.get(args.channel)
          if (!archive) {
            result = { ok: false, message: `No saved session matches "${args.channel}".` }
            return
          }
          if (!archive.members.some((m) => m.session_id === ctx.sessionID)) {
            result = {
              ok: false,
              message: `Only archived members may resume "${archive.name}" (you are not in the archived roster). Ask an archived member or the operator (opencomms session resume via CLI).`,
            }
            return
          }
          result = resumeSession(state, {
            archive,
            new_name: args.new_name ?? null,
            project_id: projectId,
            worktree: worktreePath,
          })
          if (result.ok) store.save(state)
        })
        return JSON.stringify(result)
      },
    }),

    opencomms_delete_session: tool({
      description:
        "DELETE a session permanently (destructive: live state AND archive; no future context). Active sessions require membership; saved sessions are operator-managed via the CLI. Requires confirm=true.",
      args: {
        channel: tool.schema.string().describe("Session name (or archive id for saved sessions via CLI only)."),
        confirm: tool.schema.boolean().describe("Must be true — deletion is permanent."),
      },
      async execute(args, ctx: ToolContext) {
        const result = await store.withLock(() => {
          const state = load()
          const decided = deleteSession(state, {
            channel: args.channel,
            session_id: ctx.sessionID,
            confirm: args.confirm === true,
          })
          if (!decided.ok) return decided
          const phase = (decided.data as { phase: string; channel_id: string }).phase
          const channelId = (decided.data as { phase: string; channel_id: string }).channel_id
          if (phase === "live") {
            // Deletion (unlike save) discards everything.
            const doomed = Object.values(state.messages).filter((m) => m.channel_id === channelId)
            for (const m of doomed) {
              delete state.messages[m.message_id]
              delete state.delivered_to[m.message_id]
            }
            for (const key of Object.keys(state.queues)) {
              const ids = state.queues[key] ?? []
              const filtered = ids.filter((id) => !doomed.some((m) => m.message_id === id))
              if (filtered.length !== ids.length) state.queues[key] = filtered
            }
            for (const [name, ch] of Object.entries(state.channels)) {
              if (ch.id === channelId) delete state.channels[name]
            }
            store.save(state)
            return {
              ok: true,
              message: `Session ${channelId} DELETED (live state purged; no archive existed for an active session).`,
            } satisfies ToolResult
          }
          const removed = archives.delete(channelId)
          return {
            ok: removed,
            message: removed ? `Archived session ${channelId} DELETED.` : `No archive found for ${channelId}.`,
          } satisfies ToolResult
        })
        return JSON.stringify(result)
      },
    }),

    opencomms_archive: tool({
      description:
        "Read SAVED session archives (queries, never auto-dumps): mode=list shows all archives; mode=summary gives the COMPACT context (purpose/summary/roster); mode=messages returns the archived message history (bounded). Archives are readable by archived members; operators use the opencomms CLI.",
      args: {
        channel: tool.schema
          .string()
          .optional()
          .describe("Session name or archive id (required for summary/messages)."),
        mode: tool.schema.string().optional().describe("list (default) | summary | messages"),
        limit: tool.schema.number().optional().describe("Max messages for mode=messages (default 50, max 500)."),
      },
      async execute(args, ctx: ToolContext) {
        const mode = args.mode ?? "list"
        if (mode === "list") {
          const all = archives.list()
          return JSON.stringify({
            ok: true,
            message: `${all.length} archived session(s).`,
            data: { archives: all },
          })
        }
        const byName = archives.findByName(args.channel ?? "")
        const archive = byName ?? archives.get(args.channel ?? "")
        if (!archive) return JSON.stringify({ ok: false, message: `No saved session matches "${args.channel ?? ""}".` })
        if (!archive.members.some((m) => m.session_id === ctx.sessionID)) {
          return JSON.stringify({
            ok: false,
            message: `Only archived members may read "${archive.name}" (you are not in the archived roster).`,
          })
        }
        if (mode === "summary") {
          return JSON.stringify({
            ok: true,
            message: `Compact archived context for "${archive.name}".`,
            data: { compact_context: buildArchiveContext(archive, archive.name), archive_id: archive.channel_id },
          })
        }
        const limit = args.limit && args.limit > 0 ? Math.min(args.limit, 500) : 50
        const messages = [...archive.messages].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit)
        return JSON.stringify({
          ok: true,
          message: `${messages.length} of ${archive.message_count} archived messages (newest first).`,
          data: {
            messages: messages.map((m) => ({
              message_id: m.message_id,
              sender_role: m.sender_role,
              recipient_role: m.recipient_role,
              message_type: m.message_type,
              content: m.content,
              timestamp: m.timestamp,
              reply_to: m.reply_to,
              hop_count: m.hop_count,
              delivery_status: m.delivery_status,
            })),
          },
        })
      },
    }),
  }

  return {
    tool: tools,

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      // The transform runs inside THIS server for THIS session - direct
      // ownership evidence, stronger than event inference.
      delivery.markLocal(input.sessionID)
      const state = load()
      // A session may belong to multiple channels; inject one labeled section
      // per membership so roles/prompts never blur across channels.
      for (const info of memberInfosFor(state, input.sessionID)) {
        output.system.push(buildRolePrompt(info.role, info.prompt, info.channel_name))
      }
    },

    event: async ({ event }) => {
      const e = event as Event
      // Any session.* event on this bus proves the session is hosted on THIS
      // server: register ownership before acting on the event.
      if (e.type.startsWith("session.")) {
        const props = e.properties as { sessionID?: string; info?: { id?: string } }
        delivery.markLocal(props.info?.id ?? props.sessionID)
      }
      if (e.type === "session.idle") {
        const sessionId = e.properties.sessionID
        const linked = await store.withLock(() => {
          const state = load()
          if (!isMember(state, sessionId)) return false
          clearStale(state, sessionId)
          store.save(state)
          return true
        })
        if (linked) void delivery.deliverPending(sessionId)
        return
      }
      if (e.type === "session.deleted") {
        const sessionId = e.properties.info.id
        const linked = await store.withLock(() => {
          const state = load()
          if (!isMember(state, sessionId)) return false
          markStale(state, sessionId)
          store.save(state)
          return true
        })
        void linked
        return
      }
      if (e.type === "session.status") {
        const sessionId = e.properties.sessionID
        if (e.properties.status.type === "idle") {
          const linked = await store.withLock(() => {
            const state = load()
            if (!isMember(state, sessionId)) return false
            clearStale(state, sessionId)
            store.save(state)
            return true
          })
          if (linked) void delivery.deliverPending(sessionId)
        }
        return
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "OpenComms") return
      const sub = slashSub(input.arguments)
      const { params, rest } = extractSlashArgs(input.arguments)
      const channel = params["channel"]
      const roleRaw = params["as"]
      // Free-form prompt: recognized keys removed, then drop the leading
      // subcommand word; explicit RolePrompt wins when present.
      const remainder = rest.replace(/^\S+\s*/, "")
      const rolePrompt = params["roleprompt"] ?? remainder

      let result: { ok: boolean; message: string; data?: unknown }

      switch (sub) {
        case "create":
        case "join": {
          const isCreate = sub === "create"
          const usage = isCreate
            ? "Usage: /OpenComms Create Channel=<name> As=<role> [role instructions]"
            : "Usage: /OpenComms Join Channel=<name> As=<role> [role instructions]"
          const role = roleRaw ? normalizeRole(roleRaw) : null
          if (!role) {
            result = { ok: false, message: `${ROLE_RULES} ${usage}` }
            break
          }
          const rootReject = await requireRootSession(input.sessionID)
          if (rootReject) {
            result = { ok: false, message: rootReject }
            break
          }
          result = await store.withLock(() => {
            const state = load()
            const r = isCreate
              ? createChannel(state, {
                  channel: channel ?? "",
                  role,
                  role_prompt: rolePrompt,
                  session_id: input.sessionID,
                  project_id: projectId,
                  worktree: worktreePath,
                  host: "opencode",
                  host_session_id: input.sessionID,
                })
              : joinChannel(state, {
                  channel: channel ?? "",
                  role,
                  role_prompt: rolePrompt,
                  session_id: input.sessionID,
                  project_id: projectId,
                  worktree: worktreePath,
                  host: "opencode",
                  host_session_id: input.sessionID,
                })
            if (r.ok) store.save(state)
            return r
          })
          break
        }
        case "status":
          result = status(load(), { channel })
          break
        case "pause":
        case "resume":
        case "disconnect":
        case "inbox": {
          result = await store.withLock(() => {
            const state = load()
            let r: ToolResult
            if (sub === "pause") r = pauseChannel(state, { channel: channel ?? "", session_id: input.sessionID })
            else if (sub === "resume") r = resumeChannel(state, { channel: channel ?? "", session_id: input.sessionID })
            else if (sub === "disconnect")
              r = disconnectChannel(state, { channel: channel ?? "", session_id: input.sessionID })
            else r = inbox(state, { channel: channel ?? "", session_id: input.sessionID })
            const shouldSave = r.ok && sub !== "inbox"
            if (shouldSave) store.save(state)
            return r
          })
          break
        }
        case "kick": {
          let notifyRecipients: string[] = []
          result = await store.withLock(() => {
            const state = load()
            const r = kickChannel(state, {
              channel: channel ?? "",
              session_id: input.sessionID,
              target_session_id: params["target"] ?? null,
              target_role: params["target"] ?? null,
            })
            if (r.ok) {
              notifyRecipients = (
                (r.data as { remaining_session_ids?: string[] } | undefined)?.remaining_session_ids ?? []
              ).slice()
            }
            if (r.ok) store.save(state)
            return r
          })
          for (const rid of notifyRecipients) delivery.notifyRecipient(rid)
          break
        }
        case "history":
          result = history(load(), { channel: channel ?? "", session_id: input.sessionID })
          break
        case "updaterole": {
          result = await store.withLock(() => {
            const state = load()
            const r = updateRole(state, {
              channel: channel ?? "",
              session_id: input.sessionID,
              role_prompt: rolePrompt,
            })
            if (r.ok) store.save(state)
            return r
          })
          break
        }
        case "timer": {
          const action = (params["action"] ?? "status").toLowerCase() as TimerInput["action"]
          const limitMsRaw = params["limitms"]
          const toRaw = params["to"] ?? params["limitrole"] // legacy LimitRole alias
          result = await store.withLock(() => {
            const state = load()
            const r = timerAction(state, {
              channel: channel ?? "",
              session_id: input.sessionID,
              action,
              limit_ms: limitMsRaw !== undefined ? Number(limitMsRaw) : null,
              to: toRaw ?? null,
            })
            if (r.ok) store.save(state)
            return r
          })
          break
        }
        default:
          result = {
            ok: false,
            message:
              "Unknown /OpenComms subcommand. Supported: Create, Join, Status, Pause, Resume, Disconnect, Kick, UpdateRole, Inbox, History, Timer.",
          }
      }

      output.parts.push({
        type: "text",
        text: `OpenComms: ${result.message}`,
        id: `ocm_${Date.now()}`,
        sessionID: input.sessionID,
        messageID: input.sessionID,
      } as never)
    },
  }
}

export default OpenCommsPlugin
