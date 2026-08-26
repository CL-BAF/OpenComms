# ARCHITECTURE.md — System Design

## Overview

OpenComms is a **project-local OpenCode plugin**. It does not create sessions, manage models, or proxy LLM calls. It **links two pre-existing root OpenCode sessions** (e.g. Builder + Reviewer) via a named channel, queues structured messages from one, and delivers them to the other **only when that peer is idle**.

```
┌──────────────┐         ┌─────────────────────┐         ┌──────────────┐
│  Session A   │ create  │   StateStore        │   join  │  Session B   │
│  (Builder)   │────────>│ .opencode-comms/    │<────────│ (Reviewer)   │
│  ctx.session │  ch.    │   state.json  ──────┼──state──│ ctx.session  │
└──────┬───────┘         └──────────┬──────────┘         └──────┬───────┘
       │  sendMessage()             │  queues[peerId]           │
       │───────────────────────────>│──────────────────────────>│
       │   pending                  │   FIFO message_ids        │ drainQueue()
       │                            │   on session.idle         │<─ event hook
       │                            │   client.session.prompt() │
       │                            │──────────────────────────>│ delivered text
```

- `src/types.ts:1` — types, constants
- `src/store.ts:1` — persistence (pure I/O, no logic)
- `src/engine.ts:1` — pure deterministic logic (all validation, queueing, delivery)
- `src/plugin.ts:1` — OpenCode glue (tools, hooks, slash command)

## State Shape

Persisted at `<project>/.opencode-comms/state.json` (`types.ts:9-10`). Written atomically via `StateStore.save` (`store.ts:64`).

```ts
// types.ts:87
State {
  schema_version: 1,                          // types.ts:11 SCHEMA_VERSION
  channels: Record<normalizedName, Channel>,   // key = lowercased channel name
  messages: Record<message_id, MessageEnvelope>,
  queues: Record<recipientSessionId, string[]>,// FIFO per recipient
  delivered_to: Record<message_id, string[]>,  // sets (as arrays)
  errors: {at:number, message:string}[]        // capped 200, types.ts:95
}

// types.ts:60
Channel {
  id: string,               // chn_<uuid>  engine.ts:58
  name: string,             // normalized (lowercased)
  project_id: string,       // must match across members
  worktree: string,         // must match across members
  created_at: number,
  paused: boolean, paused_at: number|null,
  members: Member[≤2],      // each: session_id, role, role_prompt, joined_at, stale, stale_at
  rate: {window_start:number, count:number},   // 20/min default engine.ts:35
  cooldown_until: Record<sessionId, number>,   // next allowed delivery
  seen_content: Record<hash, timestamp>,        // dedup, engine.ts:50
  processed_correlations: string[],            // capped 500
  max_hops: 4,              // engine.ts:34
  rate_limit: 20,           // engine.ts:35
  delivery_cooldown_ms: 1000, // engine.ts:36
  stale_event_ms: 300_000,  // 5 min engine.ts:37
  timer: ChannelTimer,      // chess-clock: active_role, segment_started_at, elapsed_ms per role, optional limit_ms + limit_role
}

// types.ts:32
MessageEnvelope {
  message_id: string,       // ocm_<uuid> engine.ts:54
  channel_id: string,
  sender_session_id, sender_role, recipient_session_id, recipient_role,
  timestamp: number,
  message_type: "review_request"|"review_response"|"manual"|"system", // types.ts:26
  content: string,          // max 100_000 chars engine.ts:288
  reply_to: string|null,    // parent message_id
  hop_count: number,        // 0 for new chain, parent+1 for reply
  delivery_status: "pending"|"delivered"|"rejected"|"stale"|"failed", // types.ts:19
  correlation_id: string,   // cor_<uuid> engine.ts:62
  delivered_at: number|null,
  attempts: number
}
```

## Channel Lifecycle

```
createChannel("feat", Builder, sessA)          // engine.ts:91
  └─ validates: name≤64, session/project/worktree/role_prompt required, not exists
  └─ inserts Channel with 1 member

joinChannel("feat", Reviewer, sessB)           // engine.ts:142
  └─ validates: exists, project+worktree match, not already member,
               not holding both roles, role not already taken
  └─ pushes 2nd member

sendMessage(content, type?) from sessA         // engine.ts:268
  └─ validates: channel exists, sender is member, peer exists & not stale,
               not paused, content non-empty ≤100k, rate limit, dedup, hop count
  └─ creates MessageEnvelope, queues id into queues[peerId]

drainQueue(peerId) on idle                     // engine.ts:375 + plugin.ts:271
  └─ batch: stale check, cooldown (first msg only), paused check, canDeliver?
  └─ marks delivered, pushes via client.session.prompt({parts:[{type:"text", text}]})
  └─ on delivery failure: records error, does not crash

pause/resume/disconnect                        // engine.ts:212,225,238
  └─ pause: sets paused=true, blocks send+drain
  └─ disconnect: removes member, rejects its queue, deletes channel if empty
  └─ never deletes OpenCode sessions
```

## Delivery Pipeline Detail

1. **Trigger:** `plugin.ts:316` event hook listens for `session.idle` and `session.status→idle`. Also `plugin.ts:44` system.transform injects role prompt before every model dispatch (not delivery).
2. **Guard checks in `drainQueue` (`engine.ts:375`):** For each queued id in order:
   - Skip if `messages[id]` missing or `recipient_session_id` mismatch.
   - If channel gone → `rejected`.
   - If `channel.paused` → stays in `remaining`.
   - If already `delivered` → skip.
   - If `now - msg.timestamp > stale_event_ms` → `stale`.
   - If `now < cooldown_until[recipient]` and this is first `delivered` in batch → stays in `remaining` (only first msg respects cooldown; rest of batch drains immediately to avoid starvation — `engine.ts:410`).
   - If `opts.canDeliver(msg) === false` → stays.
   - Else: `delivered`, `delivered_at=now`, `attempts++`, `cooldown_until = now + delivery_cooldown_ms`, update `delivered_to`.
3. **Batch prompt:** `plugin.ts:271` `deliverPending` loads state, finds channel via `channelForSession`, returns if paused, calls `drainQueue`, saves, formats text as `[OpenComms message from ${role} (${type}) — message_id ${id}, reply_to ${reply_to}, hop ${hop}]\n\n${content}` joined with `\n\n---\n\n`, calls `client.session.prompt`. On throw, reloads state, pushes to `errors`, saves.

## State Persistence

`StateStore` (`store.ts:28`): `dir = join(projectDir, ".opencode-comms")`, `file = join(dir, "state.json")`.

- `load()` (`store.ts:37`): if missing → `emptyState()`. Try parse; on failure return `emptyState()` + push recovery error (never bricks).
- `save(state)` (`store.ts:64`): `mkdirSync(recursive)`, `writeFileSync(tmp)` where tmp = `.state.<pid>.<rand>.tmp` (`store.ts:66`), `renameSync(tmp, file)`. On error: `Atomics.wait` 50ms + retry rename; on second failure `writeFileSync(file)` directly; on third throw with combined message.
- `update(fn)` (`store.ts:95`): load → mutate → save.

## Hooks & Tools (plugin.ts)

| Hook/Feature | Location | Behavior |
|--------------|----------|----------|
| `experimental.chat.system.transform` | `plugin.ts:307` | If `input.sessionID` has a `rolePromptFor` result, pushes `buildRolePrompt(role, prompt)` into `output.system`. Header is `## OpenComms role instructions` (`plugin.ts:42`). |
| `event` — `session.idle` | `plugin.ts:318` | `clearStale(sessId)`, save, `void deliverPending(sessId)` |
| `event` — `session.deleted` | `plugin.ts:328` | `markStale(sessId)`, save |
| `event` — `session.status→idle` | `plugin.ts:337` | Same as `session.idle` |
| `command.execute.before` | `plugin.ts:351` | If `command === "OpenComms"`, parse with `parseArgs`/`stripArgs` (`plugin.ts:48,60`), dispatch subcommand (Create/Join/Status/Pause/Resume/Disconnect/UpdateRole/Inbox/History), save if ok, push result part. |
| `tools` (10) | `plugin.ts:79` | Bound per project session; each mutating tool does `load→engine→save if ok→JSON.stringify(result)`. |

## Invariants (must hold)

1. Channel names normalized: `engine.ts:39` `trim().toLowerCase()`, max 64.
2. Roles are `"Builder"` | `"Reviewer"` only (`types.ts:13-14`), matched case-insensitively via `normalizeRole` (`engine.ts:43`).
3. One session ↔ one role per channel; one role ↔ one session per channel (`engine.ts:163-181`).
4. Members share `project_id` + `worktree` (`engine.ts:151-161`).
5. Messages only cross via explicit `opencomms_send` / `sendMessage`; assistant text never auto-forwarded (`plugin.ts:130` description).
6. Delivery only when recipient idle (`plugin.ts:316`). Cooldown does not starve batch (`engine.ts:410`).
7. `max_hops=4` enforced on reply chains (`engine.ts:314-327`). `rate_limit=20/min` sliding window (`engine.ts:294-302`). Dedup window = `stale_event_ms` via sha256 hash (`engine.ts:305-310`).
8. `processed_correlations` capped 500 (`engine.ts:334`), `errors` capped 200 (`engine.ts:88`, `store.ts:56`).

## Edge Cases & Gotchas

- Channel key is normalized — `"My-Feature"` and `"my-feature"` are same; always call `normalizeChannelName` before direct `state.channels[]` access.
- `seen_content` is per-channel, not per-message — same content from either side is blocked within window.
- `drainQueue` first-msg cooldown quirk: second msg in same `drainQueue` call bypasses cooldown even if `now < cooldown_until`. This is intentional.
- `disconnectChannel` marks queued msgs for departing session as `rejected` and deletes `queues[sessionId]` (`engine.ts:249-254`).
- Stale marking: `session.deleted` → `markStale` sets `member.stale=true`; `session.idle`/`status→idle` → `clearStale` resets it. `sendMessage` rejects if `peer.stale` (`engine.ts:279`).
- `rolePromptFor` (`engine.ts:549`) and `channelForSession` (`engine.ts:557`) return first match scanning `Object.values(state.channels)` — a session is expected to be in one channel, but if in multiple the first channel wins.
- Slash command `RolePrompt` arg takes remainder after subcommand: `rest.replace(/^\S+\s*/, "")` (`plugin.ts:358`) — free-form prompt, not key=value trimmed.
