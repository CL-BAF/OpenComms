/**
 * OpenComms — OpenCode plugin entry point.
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
 */

import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { StateStore } from "./store.js"
import {
  channelForSession,
  clearStale,
  createChannel,
  disconnectChannel,
  drainQueue,
  history,
  inbox,
  isMember,
  joinChannel,
  markStale,
  normalizeChannelName,
  normalizeRole,
  pauseChannel,
  resumeChannel,
  rolePromptFor,
  sendMessage,
  status,
  timerAction,
  updateRole,
  assertRootSession,
} from "./engine.js"
import type { Role, State, TimerInput } from "./types.js"

const ROLE_PROMPT_HEADER = "## OpenComms role instructions"

function buildRolePrompt(role: Role, prompt: string): string {
  return `${ROLE_PROMPT_HEADER}\n\nYou are the ${role} on an OpenComms channel.\n\n${prompt.trim()}`
}

function parseArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]!
    out[key] = value
  }
  return out
}

function stripArgs(raw: string): string {
  return raw.replace(/([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g, "").trim()
}

export const OpenCommsPlugin: Plugin = async ({ client, project, directory, worktree }) => {
  const store = new StateStore(directory)
  const projectId = project.id
  const worktreePath = worktree || directory

  const load = (): State => store.load()
  const save = (state: State): void => store.save(state)

  const requireMember = (state: State, sessionId: string): string | null => {
    if (!isMember(state, sessionId)) {
      return "This session is not linked to any OpenComms channel. Create or join a channel first."
    }
    return null
  }

  // Invariant #1: OpenComms only links root OpenCode sessions. Fetch the
  // session's parentID from the OpenCode client and reject child sessions
  // before any channel state is mutated. Returns a rejection string or null.
  // On lookup failure we do not block channel creation (a transient SDK
  // error must not brick the plugin), but the failure is recorded visibly in
  // opencomms_status so it is not silently swallowed.
  const requireRootSession = async (sessionId: string): Promise<string | null> => {
    try {
      const res = await client.session.get({ path: { id: sessionId } })
      const parentID = res.data?.parentID
      return assertRootSession(parentID, sessionId)
    } catch (error) {
      const state = load()
      const msg = `Root-session lookup for ${sessionId} failed (${(error as Error).message}); treating it as root. Verify the session exists.`
      state.errors.push({ at: Date.now(), message: msg })
      if (state.errors.length > 200) state.errors = state.errors.slice(-200)
      save(state)
      return null
    }
  }

  const tools = {
    opencomms_create: tool({
      description:
        "Create an OpenComms channel and register the CURRENT session as a role (Builder or Reviewer). The current session's real session id is taken from the tool execution context — no new session is created. Role instructions in `role_prompt` become the persistent per-session system instructions.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        role: tool.schema.string().describe("Role: Builder or Reviewer."),
        role_prompt: tool.schema.string().describe("Persistent role instructions for this session."),
      },
      async execute(args, ctx: ToolContext) {
        const role = normalizeRole(args.role)
        if (!role) return "Invalid role. Use Builder or Reviewer."
        const rootReject = await requireRootSession(ctx.sessionID)
        if (rootReject) return rootReject
        const state = load()
        const result = createChannel(state, {
          channel: args.channel,
          role,
          role_prompt: args.role_prompt,
          session_id: ctx.sessionID,
          project_id: projectId,
          worktree: worktreePath,
        })
        if (result.ok) save(state)
        return JSON.stringify(result)
      },
    }),

    opencomms_join: tool({
      description:
        "Join an existing OpenComms channel with the CURRENT session as a role (Builder or Reviewer). The current session's real session id is taken from the tool execution context — no new session is created. Rejects joining the same session twice, using one session for both roles, replacing an existing member, child sessions, and sessions from incompatible projects or worktrees.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        role: tool.schema.string().describe("Role: Builder or Reviewer."),
        role_prompt: tool.schema.string().describe("Persistent role instructions for this session."),
      },
      async execute(args, ctx: ToolContext) {
        const role = normalizeRole(args.role)
        if (!role) return "Invalid role. Use Builder or Reviewer."
        const rootReject = await requireRootSession(ctx.sessionID)
        if (rootReject) return rootReject
        const state = load()
        const result = joinChannel(state, {
          channel: args.channel,
          role,
          role_prompt: args.role_prompt,
          session_id: ctx.sessionID,
          project_id: projectId,
          worktree: worktreePath,
        })
        if (result.ok) save(state)
        return JSON.stringify(result)
      },
    }),

    opencomms_send: tool({
      description:
        "Send a structured peer message to the other member of the current session's OpenComms channel. The message is queued and delivered to the peer session when it is idle. Never auto-forwards assistant responses — only explicit calls to this tool cross sessions.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        type: tool.schema
          .string()
          .optional()
          .describe("Message type: review_request, review_response, manual, or system. Defaults to manual."),
        content: tool.schema.string().describe("Message content."),
        reply_to: tool.schema.string().optional().nullable().describe("Optional message_id this message replies to."),
      },
      async execute(args, ctx: ToolContext) {
        const state = load()
        const blocked = requireMember(state, ctx.sessionID)
        if (blocked) return blocked
        const result = sendMessage(
          state,
          {
            channel: args.channel,
            type: (args.type as "review_request" | "review_response" | "manual" | "system" | undefined) ?? "manual",
            content: args.content,
            reply_to: args.reply_to ?? null,
          },
          ctx.sessionID,
        )
        if (result.ok) {
          save(state)
          // Proactively attempt delivery to the peer immediately, so the
          // recipient sees the message without needing a manual prompt or
          // waiting for the session.idle event. If the peer is busy the
          // queue is preserved and the idle event will drain it later.
          const channel = channelForSession(state, ctx.sessionID)
          const peer = channel?.members.find((m) => m.session_id !== ctx.sessionID)
          if (peer) void deliverPending(peer.session_id)
        }
        return JSON.stringify(result)
      },
    }),

    opencomms_status: tool({
      description:
        "Show OpenComms status: channels, members, roles, pause state, queue lengths, pending messages, and recorded errors.",
      args: {
        channel: tool.schema.string().optional().describe("Optional channel name to inspect."),
      },
      async execute(args) {
        const state = load()
        return JSON.stringify(status(state, { channel: args.channel }))
      },
    }),

    opencomms_inbox: tool({
      description:
        "List messages currently queued for the current session on a channel, without delivering them.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        limit: tool.schema.number().optional().describe("Max messages to list (default 20, max 100)."),
      },
      async execute(args, ctx: ToolContext) {
        const state = load()
        const blocked = requireMember(state, ctx.sessionID)
        if (blocked) return blocked
        return JSON.stringify(inbox(state, { channel: args.channel, session_id: ctx.sessionID, limit: args.limit }))
      },
    }),

    opencomms_history: tool({
      description:
        "Show the message history of a channel, newest first, including delivery status of each message.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        limit: tool.schema.number().optional().describe("Max messages to list (default 20, max 100)."),
      },
      async execute(args) {
        const state = load()
        return JSON.stringify(history(state, { channel: args.channel, limit: args.limit }))
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
        const state = load()
        const blocked = requireMember(state, ctx.sessionID)
        if (blocked) return blocked
        const result = updateRole(state, {
          channel: args.channel,
          session_id: ctx.sessionID,
          role_prompt: args.role_prompt,
        })
        if (result.ok) save(state)
        return JSON.stringify(result)
      },
    }),

    opencomms_pause: tool({
      description:
        "Pause a channel. No messages are delivered to either member until the channel is resumed.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
      },
      async execute(args, ctx: ToolContext) {
        const state = load()
        const blocked = requireMember(state, ctx.sessionID)
        if (blocked) return blocked
        const result = pauseChannel(state, { channel: args.channel, session_id: ctx.sessionID })
        if (result.ok) save(state)
        return JSON.stringify(result)
      },
    }),

    opencomms_resume: tool({
      description:
        "Resume a paused channel. Pending messages are delivered to idle members again.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
      },
      async execute(args, ctx: ToolContext) {
        const state = load()
        const blocked = requireMember(state, ctx.sessionID)
        if (blocked) return blocked
        const result = resumeChannel(state, { channel: args.channel, session_id: ctx.sessionID })
        if (result.ok) save(state)
        return JSON.stringify(result)
      },
    }),

    opencomms_disconnect: tool({
      description:
        "Disconnect the current session from a channel. The channel remains for the other member, or is removed if empty. No OpenCode sessions are ever deleted.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
      },
      async execute(args, ctx: ToolContext) {
        const state = load()
        const blocked = requireMember(state, ctx.sessionID)
        if (blocked) return blocked
        const result = disconnectChannel(state, { channel: args.channel, session_id: ctx.sessionID })
        if (result.ok) save(state)
        return JSON.stringify(result)
      },
    }),

    opencomms_timer: tool({
      description:
        "Manage the chess-clock timer for a channel. Tracks cumulative active time per role (Builder/Reviewer). Use 'status' to read elapsed time and check a hard limit. The timer auto-switches on send (sender stops, recipient starts), but can also be manually started, stopped, switched, reset, or given a limit via set_limit/clear_limit.",
      args: {
        channel: tool.schema.string().describe("Channel name (case-insensitive)."),
        action: tool.schema
          .string()
          .describe("start | stop | switch | reset | status | set_limit | clear_limit"),
        limit_ms: tool.schema
          .number()
          .optional()
          .nullable()
          .describe("For set_limit: the hard cap in milliseconds."),
        limit_role: tool.schema
          .string()
          .optional()
          .nullable()
          .describe("For set_limit: which role the limit applies to (Builder|Reviewer). Omit for total."),
      },
      async execute(args, ctx: ToolContext) {
        const state = load()
        const blocked = requireMember(state, ctx.sessionID)
        if (blocked) return blocked
        const role = args.limit_role ? normalizeRole(args.limit_role) : null
        const result = timerAction(state, {
          channel: args.channel,
          session_id: ctx.sessionID,
          action: args.action as TimerInput["action"],
          limit_ms: args.limit_ms ?? null,
          limit_role: role,
        })
        if (result.ok) save(state)
        return JSON.stringify(result)
      },
    }),
  }

  const deliverPending = async (sessionId: string): Promise<void> => {
    const state = load()
    const channel = channelForSession(state, sessionId)
    if (!channel) {
      console.error(`[OpenComms] deliverPending: no channel for session ${sessionId}`)
      return
    }
    if (channel.paused) {
      console.error(`[OpenComms] deliverPending: channel ${channel.name} is paused`)
      return
    }
    const queueBefore = state.queues[sessionId] ?? []
    const delivered = drainQueue(state, sessionId)
    if (delivered.length === 0) {
      console.error(`[OpenComms] deliverPending: queue empty for ${sessionId} (queue had ${queueBefore.length} ids)`)
      return
    }
    save(state)

    const text = delivered
      .map(
        (m) =>
          `[OpenComms message from ${m.sender_role} (${m.message_type}) — message_id ${m.message_id}, reply_to ${m.reply_to ?? "none"}, hop ${m.hop_count}]\n\n${m.content}`,
      )
      .join("\n\n---\n\n")

    try {
      console.error(`[OpenComms] deliverPending: prompting session ${sessionId} with ${delivered.length} message(s)`)
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: text }],
        },
      })
      console.error(`[OpenComms] deliverPending: prompt succeeded for ${sessionId}`)
    } catch (error) {
      // Delivery failed: do NOT leave messages marked "delivered" (that would
      // silently drop them). Re-queue each envelope back to pending so the
      // next idle event can retry, and record the failure visibly in
      // opencomms_status (spec: "Discard a message silently" is forbidden).
      const state2 = load()
      const ids = delivered.map((m) => m.message_id)
      for (const id of ids) {
        const msg = state2.messages[id]
        if (msg && msg.delivery_status === "delivered") {
          msg.delivery_status = "pending"
          msg.delivered_at = null
        }
      }
      const queue = state2.queues[sessionId] ?? []
      for (const id of ids) {
        const msg = state2.messages[id]
        if (msg && !queue.includes(id)) queue.unshift(id)
      }
      state2.queues[sessionId] = queue
      state2.errors.push({
        at: Date.now(),
        message: `Delivery to session ${sessionId} failed (${(error as Error).message}); ${ids.length} message(s) re-queued for retry.`,
      })
      if (state2.errors.length > 200) state2.errors = state2.errors.slice(-200)
      save(state2)
    }
  }

  return {
    tool: tools,

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const state = load()
      const prompt = rolePromptFor(state, input.sessionID)
      if (prompt) {
        output.system.push(buildRolePrompt(promptRole(state, input.sessionID) ?? "Builder", prompt))
      }
    },

    event: async ({ event }) => {
      const e = event as Event
      if (e.type === "session.idle") {
        const sessionId = e.properties.sessionID
        const state = load()
        if (isMember(state, sessionId)) {
          clearStale(state, sessionId)
          save(state)
          void deliverPending(sessionId)
        }
        return
      }
      if (e.type === "session.deleted") {
        const sessionId = e.properties.info.id
        const state = load()
        if (isMember(state, sessionId)) {
          markStale(state, sessionId)
          save(state)
        }
        return
      }
      if (e.type === "session.status") {
        const sessionId = e.properties.sessionID
        if (e.properties.status.type === "idle") {
          const state = load()
          if (isMember(state, sessionId)) {
            clearStale(state, sessionId)
            save(state)
            void deliverPending(sessionId)
          }
        }
        return
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "OpenComms") return
      const args = parseArgs(input.arguments)
      const rest = stripArgs(input.arguments)
      const sub = rest.split(/\s+/)[0]?.toLowerCase() ?? ""
      const channel = args["Channel"] ?? args["channel"]
      const role = args["As"] ?? args["role"]
      const rolePrompt = args["RolePrompt"] ?? args["role_prompt"] ?? rest.replace(/^\S+\s*/, "")

      const state = load()
      let result: { ok: boolean; message: string; data?: unknown }

      switch (sub) {
        case "create": {
          const r = normalizeRole(role ?? "")
          if (!r) {
            result = { ok: false, message: "Usage: /OpenComms Create Channel=<name> As=<Builder|Reviewer> [role instructions]" }
            break
          }
          const rootReject = await requireRootSession(input.sessionID)
          if (rootReject) {
            result = { ok: false, message: rootReject }
            break
          }
          result = createChannel(state, {
            channel: channel ?? "",
            role: r,
            role_prompt: rolePrompt,
            session_id: input.sessionID,
            project_id: projectId,
            worktree: worktreePath,
          })
          break
        }
        case "join": {
          const r = normalizeRole(role ?? "")
          if (!r) {
            result = { ok: false, message: "Usage: /OpenComms Join Channel=<name> As=<Builder|Reviewer> [role instructions]" }
            break
          }
          const rootReject = await requireRootSession(input.sessionID)
          if (rootReject) {
            result = { ok: false, message: rootReject }
            break
          }
          result = joinChannel(state, {
            channel: channel ?? "",
            role: r,
            role_prompt: rolePrompt,
            session_id: input.sessionID,
            project_id: projectId,
            worktree: worktreePath,
          })
          break
        }
        case "status":
          result = status(state, { channel })
          break
        case "pause":
          result = pauseChannel(state, { channel: channel ?? "", session_id: input.sessionID })
          break
        case "resume":
          result = resumeChannel(state, { channel: channel ?? "", session_id: input.sessionID })
          break
        case "disconnect":
          result = disconnectChannel(state, { channel: channel ?? "", session_id: input.sessionID })
          break
        case "update_role":
          result = updateRole(state, {
            channel: channel ?? "",
            session_id: input.sessionID,
            role_prompt: rolePrompt,
          })
          break
        case "inbox":
          result = inbox(state, { channel: channel ?? "", session_id: input.sessionID })
          break
        case "history":
          result = history(state, { channel: channel ?? "" })
          break
        case "timer": {
          const action = (args["Action"] ?? args["action"] ?? "status").toLowerCase() as
            | "start" | "stop" | "switch" | "reset" | "status" | "set_limit" | "clear_limit"
          const limitMs = args["LimitMs"] ?? args["limit_ms"]
          const limitRoleStr = args["LimitRole"] ?? args["limit_role"]
          const limitRole = limitRoleStr ? normalizeRole(limitRoleStr) : null
          result = timerAction(state, {
            channel: channel ?? "",
            session_id: input.sessionID,
            action,
            limit_ms: limitMs !== undefined ? Number(limitMs) : null,
            limit_role: limitRole,
          })
          break
        }
        default:
          result = {
            ok: false,
            message:
              "Unknown /OpenComms subcommand. Supported: Create, Join, Status, Pause, Resume, Disconnect, UpdateRole, Inbox, History, Timer.",
          }
      }

      if (result.ok) save(state)
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

function promptRole(state: State, sessionId: string): Role | null {
  for (const channel of Object.values(state.channels)) {
    const member = channel.members.find((m) => m.session_id === sessionId)
    if (member) return member.role
  }
  return null
}

export default OpenCommsPlugin
