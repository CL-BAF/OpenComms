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
import {
  clearStale,
  createChannel,
  disconnectChannel,
  drainForDelivery,
  formatDeliveryBatch,
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
  const projectId = project.id
  const worktreePath = worktree || directory

  // Read-only loads need no lock: state.json is replaced atomically, so a
  // reader never observes a torn write.
  const load = (): State => store.load()

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

  const recordError = (message: string): void => {
    void store.withLock(() => {
      const state = load()
      state.errors.push({ at: Date.now(), message })
      if (state.errors.length > 200) state.errors = state.errors.slice(-200)
      store.save(state)
    })
  }

  const deliverPending = async (sessionId: string): Promise<void> => {
    // Phase 1 (locked): atomically drain queues and persist delivery marks.
    // Each envelope carries its own channel's name â€” a session may belong to
    // multiple channels, so provenance is resolved per message, never once
    // for the batch. Per-channel pause handling happens inside drainQueue.
    let batch: Array<{ id: string; channelName: string }> = []
    try {
      const drained = await store.withLock(() => {
        const state = load()
        const pairs = drainForDelivery(state, sessionId)
        if (pairs.length > 0) store.save(state)
        return pairs.map((p) => ({ id: p.message_id, channelName: p.channel_name }))
      })
      batch = drained
    } catch (error) {
      recordError(`Delivery drain for ${sessionId} failed: ${(error as Error).message}`)
      return
    }
    if (batch.length === 0) return

    // Phase 2 (unlocked): prompt the peer once per batch. Peer content is
    // framed as untrusted data with per-envelope provenance â€” see
    // formatDeliveryBatch.
    const ids = batch.map((b) => b.id)
    const text = batch.map((b) => formatOne(b)).join("\n\n---\n\n")

    function formatOne(b: { id: string; channelName: string }): string {
      const snapshot = load()
      const msg = snapshot.messages[b.id]
      if (!msg) return `(OpenComms: message ${b.id} no longer exists)`
      return formatDeliveryBatch([msg], b.channelName)
    }

    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
        },
      })
    } catch (error) {
      // Delivery failed: do NOT leave messages marked "delivered" (that
      // would silently drop them). Rebuild the FIFO in original order and
      // record the failure visibly in opencomms_status.
      try {
        await store.withLock(() => {
          const state2 = load()
          requeueFailedDelivery(state2, sessionId, ids)
          state2.errors.push({
            at: Date.now(),
            message: `Delivery to session ${sessionId} failed (${(error as Error).message}); ${ids.length} message(s) re-queued for retry.`,
          })
          if (state2.errors.length > 200) state2.errors = state2.errors.slice(-200)
          store.save(state2)
        })
      } catch (lockError) {
        recordError(`Requeue after failed delivery to ${sessionId} also failed: ${(lockError as Error).message}`)
      }
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
            }),
          (r) => r.ok,
        )
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
        for (const rid of notifyRecipients) void deliverPending(rid)
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
        for (const rid of notifyRecipients) void deliverPending(rid)
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
  }

  return {
    tool: tools,

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const state = load()
      // A session may belong to multiple channels; inject one labeled section
      // per membership so roles/prompts never blur across channels.
      for (const info of memberInfosFor(state, input.sessionID)) {
        output.system.push(buildRolePrompt(info.role, info.prompt, info.channel_name))
      }
    },

    event: async ({ event }) => {
      const e = event as Event
      if (e.type === "session.idle") {
        const sessionId = e.properties.sessionID
        const linked = await store.withLock(() => {
          const state = load()
          if (!isMember(state, sessionId)) return false
          clearStale(state, sessionId)
          store.save(state)
          return true
        })
        if (linked) void deliverPending(sessionId)
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
          if (linked) void deliverPending(sessionId)
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
                })
              : joinChannel(state, {
                  channel: channel ?? "",
                  role,
                  role_prompt: rolePrompt,
                  session_id: input.sessionID,
                  project_id: projectId,
                  worktree: worktreePath,
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
          for (const rid of notifyRecipients) void deliverPending(rid)
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
