# ARCHITECTURE.md â€” System Design

## Overview

OpenComms is a **project-local OpenCode plugin**. It does not create sessions, manage models, or proxy LLM calls. It **links pre-existing root OpenCode sessions** (N members up to max_members, the classic pair being Builder + Reviewer) via a named channel, queues structured messages from senders, and delivers them to recipients **only when those peers are idle**.

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”         â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”         â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚  Session A   â”‚ create  â”‚   StateStore        â”‚   join  â”‚  Session B   â”‚
â”‚  (Builder)   â”‚â”€â”€â”€â”€â”€â”€â”€â”€>â”‚ .opencomms/    â”‚<â”€â”€â”€â”€â”€â”€â”€â”€â”‚ (Reviewer)   â”‚
â”‚  ctx.session â”‚  ch.    â”‚   state.json  â”€â”€â”€â”€â”€â”€â”¼â”€â”€stateâ”€â”€â”‚ ctx.session  â”‚
â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜         â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜         â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”˜
       â”‚  sendMessage()             â”‚  queues[peerId]           â”‚
       â”‚â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€>â”‚â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€>â”‚
       â”‚   pending                  â”‚   FIFO message_ids        â”‚ drainQueue()
       â”‚                            â”‚   on session.idle         â”‚<â”€ event hook
       â”‚                            â”‚   client.session.prompt() â”‚
       â”‚                            â”‚â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€>â”‚ delivered text
```

- `src/core/types.ts` . types, constants
- `src/core/store.ts` . persistence (pure I/O, no logic), v1->v2 migration
- `src/core/engine.ts` . pure deterministic logic (all validation, queueing, delivery)
- `src/plugin.ts` . OpenCode adapter (tools, hooks, slash command)

## State Shape

Persisted at `<project>/.opencomms/state.json` (`src/core/types.ts`). Written atomically via `StateStore.save`; every mutation runs under the `.state.lock` cross-process lock (see State Persistence below).

```ts
// types.ts
State {
  schema_version: 2,                          // src/core/types.ts SCHEMA_VERSION
  channels: Record<normalizedName, Channel>,   // key = lowercased channel name
  messages: Record<message_id, MessageEnvelope>,
  queues: Record<recipientSessionId, string[]>,// FIFO per recipient
  delivered_to: Record<message_id, string[]>,  // sets (as arrays)
  errors: {at:number, message:string}[]        // capped 200
}

// src/core/types.ts State
Channel {
  id: string,               // chn_<uuid>
  name: string,             // normalized (lowercased slug, ^[a-z0-9][a-z0-9-_]*$)
  project_id: string,       // must match across members
  worktree: string,         // must match across members
  created_at: number,
  paused: boolean, paused_at: number|null,
  members: Member[],        // capped by max_members; each: session_id, role (open vocab), role_prompt, joined_at, stale, stale_at
  max_members: number,      // default 8 (DEFAULT_MAX_MEMBERS), clamped >=2 at creation
  rate: {window_start:number, count:number},   // 20/min default
  cooldown_until: Record<sessionId, number>,   // next allowed delivery
  seen_content: Record<"sessionId:hash", timestamp>,  // per-sender dedup + TTL sweep
  processed_correlations: string[],            // capped 500
  max_hops: 4,
  rate_limit: 20,
  delivery_cooldown_ms: 1000,
  stale_event_ms: 300_000,  // 5 min
  timer: ChannelTimer,      // chess-clock keyed BY MEMBER: active_member_id, segment_started_at, elapsed_ms[sessionId], limit_ms, limit_member_id
}

// src/core/types.ts Member
MessageEnvelope {
  message_id: string,       // ocm_<uuid>
  channel_id: string,
  sender_session_id, sender_role, recipient_session_id, recipient_role,
  timestamp: number,
  message_type: "review_request"|"review_response"|"manual"|"system", // "system" reserved for internal notices
  content: string,          // max 100_000 chars
  reply_to: string|null,    // parent message_id
  hop_count: number,        // 0 for new chain, parent+1 for reply
  delivery_status: "pending"|"delivered"|"rejected"|"stale"|"failed",
  correlation_id: string,   // cor_<uuid>
  delivered_at: number|null,
  attempts: number
}
```

## Channel Lifecycle

```
createChannel("feat", role, sessA)             // engine createChannel
  â””â”€ validates: slug pattern ^[a-z0-9][a-z0-9-_]*$ + â‰¤64, session/project/worktree/role_prompt required,
                open-vocab role label, not exists, max_members clamp [2..8]
  â””â”€ inserts Channel with 1 member

joinChannel("feat", role, sessB)               // engine joinChannel
  â””â”€ validates: exists, project+worktree match, not already member,
                MAX_MEMBERS cap FIRST, role not already taken (case-insensitive)
  â””â”€ pushes member

sendMessage(content, type?, to?, broadcast?)   // engine sendMessage
  â””â”€ validates: channel exists, sender is member, not paused,
                type âˆˆ {review_request|review_response|manual} ("system" reserved),
                recipients resolved: to=id|role â†’ one; broadcast=true â†’ all others;
                single-peer channel implies peer; >1 other members without either = ERROR (never guessed),
                content non-empty â‰¤100k, rate limit (broadcast counts as ONE send),
                per-sender dedup (sender:hash, TTL sweep), hop count
  â””â”€ creates one MessageEnvelope PER recipient sharing correlation_id,
     queues each into queues[recipientId], auto-switches chess clock to primary recipient

drainForDelivery(recipientId) on idle          // engine drainQueue + plugin deliverPending (locked phase)
  â””â”€ batch: stale check, cooldown (first msg only), paused check per OWN channel, canDeliver?
  â””â”€ marks delivered; each envelope annotated with ITS channel's name

pause/resume/disconnect/kick                   // engine lifecycle fns
  â””â”€ pause: sets paused=true, blocks send+drain
  â””â”€ disconnect: removes caller via shared removeMember (reject their queued msgs, fold their timer segment), deletes channel if empty
  â””â”€ kick (Builder-only): same removal path for a TARGET member + system notice envelope per remaining member,
     returns remaining_session_ids so the plugin drains notices immediately; channel survives with â‰¥1 member
  â””â”€ never deletes OpenCode sessions â€” only channel links die
```

## Delivery Pipeline Detail

1. **Trigger:** plugin event hook listens for `session.idle` and `session.statusâ†’idle` (each locked clearStaleâ†’save, then `void deliverPending`). Also `experimental.chat.system.transform` injects one labeled role prompt PER channel membership before every model dispatch.
2. **Guard checks in `drainQueue`:** For each queued id in order:
   - Skip if `messages[id]` missing or `recipient_session_id` mismatch.
   - If channel gone â†’ `rejected`.
   - If its own `channel.paused` â†’ stays in `remaining`.
   - If already `delivered` â†’ skip.
   - If `now - msg.timestamp > stale_event_ms` â†’ `stale`.
   - If `now < cooldown_until[recipient]` and this is first `delivered` in batch â†’ stays in `remaining` (only first msg respects cooldown; rest of batch drains immediately to avoid starvation).
   - If `opts.canDeliver(msg) === false` â†’ stays.
   - Else: `delivered`, `delivered_at=now`, `attempts++`, `cooldown_until = now + delivery_cooldown_ms`, update `delivered_to`, opportunistic `pruneMessages`.
3. **Batch prompt:** plugin `deliverPending` Phase 1 (inside `withLock`) calls `drainForDelivery` and saves if anything delivered; Phase 2 (unlocked) formats each message via `formatUntrustedMessage` â€” `<<<UNTRUSTED_PEER_MESSAGE>>>` delimiters + provenance header/footer naming the SENDING channel and session â€” joins with `\n\n---\n\n`, calls `client.session.prompt`. On throw, re-acquires lock: `requeueFailedDelivery` restores FIFO order + pending status, records error, saves. Notices/kicks queue system-type envelopes that are drained proactively post-lock (never while holding it).

## State Persistence

`StateStore` (`src/core/store.ts`): `dir = join(projectDir, ".opencomms")`, `file = join(dir, "state.json")`.

- **Locking:** every loadâ†’mutateâ†’save runs under `withLock(fn)` (`src/core/store.ts` withLock) â€” exclusive-create `.state.lock` carrying `<pid>@<ts>`; acquisition retries (10ms busy waits) until `LOCK_TIMEOUT_MS=5s`, locks older than `LOCK_STALE_MS=15s` are presumed abandoned and broken. Bare reads stay lock-free because saves are atomic renames.
  - *Known tradeoff (R5):* a live-but-slow holder whose critical section exceeds 15s can get its lock broken mid-fn, briefly allowing concurrent mutation. All current critical sections are ms-scale synchronous blocks, so this is accepted rather than heartbeat-managed; revisit if async work ever moves inside the lock.
- `load()` (`src/core/store.ts`): if missing â†’ `emptyState()`. Parses then runs `validateState`: wrong `schema_version`, non-object roots, malformed member rows (bad role label / non-string role_prompt), channel keyâ‰ name aliasing, malformed messages/queues/delivered_to â€” ALL rejected to `emptyState()` + recovery error. Survivors run `backfillState` (`src/core/store.ts`): clamp `max_membersâˆˆ[2,8]`, default timers for pre-timer files, migrate legacy ROLE-keyed timers to session-id keys (remapping the active role's elapsed onto its member).
- `save(state)` (`src/core/store.ts`): `mkdirSync(recursive)`, `writeFileSync(tmp)` where tmp = `.state.<pid>.<rand>.tmp`, `renameSync(tmp, file)`. On error: blocking 50ms sleep + retry rename; on second failure direct `writeFileSync(file)`; on third throw with combined message.
- `update(fn)` (`src/core/store.ts`): `withLock(load â†’ mutate â†’ save)`.

## Hooks & Tools (plugin.ts)

| Hook/Feature | Behavior |
|--------------|----------|
| `experimental.chat.system.transform` | For EACH channel membership of `input.sessionID` (`memberInfosFor`), pushes `buildRolePrompt(role, prompt, channelName)` into `output.system`. Header is `## OpenComms role instructions`. |
| `event` â€” `session.idle` | locked `clearStale` + save, then `void deliverPending(sessionId)` |
| `event` â€” `session.deleted` | locked `markStale` + save |
| `event` â€” `session.statusâ†’idle` | Same as `session.idle` |
| `command.execute.before` | If `command === "OpenComms"`, parse via `extractSlashArgs` + `slashSub`, dispatch subcommand (Create/Join/Status/Pause/Resume/Disconnect/Kick/UpdateRole/Inbox/History/Timer) inside the lock where mutating, push result part. |
| `tools` (12) | Bound per project session; each mutating tool runs `withLock(load â†’ engine â†’ save if ok)` then `JSON.stringify(result)`; send/kick drain recipients proactively AFTER lock release. |

## Invariants (must hold)

1. Channel names normalized via `normalizeChannelName` (`trim().toLowerCase()`), max 64, matching `^[a-z0-9][a-z0-9-_]*$`.
2. Roles are an OPEN vocabulary validated by `/^[A-Za-z][A-Za-z0-9 _-]{0,31}$/` (`normalizeRole`); spelling preserved verbatim; unique per channel; all lookups case-insensitive.
3. One session â†” one role per channel; one role â†” one session per channel. Membership capped at `Channel.max_members` (default 8, clamped â‰¥2).
4. Members share `project_id` + `worktree`.
5. Messages only cross via explicit `opencomms_send` / slash command; assistant text never auto-forwarded. On 3+ member channels sends REQUIRE `to=<id|role>` or `broadcast=true` â€” never guessed. Same policy for timer `switch`.
6. Delivery only when recipient idle; per-channel pause handled inside `drainQueue`; cooldown does not starve batch.
7. `max_hops=4` on reply chains; `rate_limit=20/min` window counts a broadcast as ONE logical send; dedup keys are `${sender_session_id}:${sha256_32}` with `stale_event_ms` TTL sweep.
8. Sender message types whitelisted to `review_request|review_response|manual`; `"system"` reserved for internal notices (kick). Delivered content is always wrapped in `<<<UNTRUSTED_PEER_MESSAGE>>>` framing with per-envelope provenance.
9. Reads member-scoped (`inbox`, `history` take/derive a `session_id`). Create/Join fail CLOSED when root-session verification errors.
10. Retention cap: `MAX_PERSISTED_MESSAGES = 2000` enforced by `pruneMessages` after sends/drains/kicks; history scans bounded by this cap instead of a separate index (deliberate).
11. Every mutation executes inside `StateStore.withLock`; no nested lock acquisition anywhere (deadlock-until-timeout otherwise). Delivery prompts fire strictly AFTER lock release.

## Edge Cases & Gotchas

- Channel key is normalized â€” `"My-Feature"` and `"my-feature"` are same; always call `normalizeChannelName` before direct `state.channels[]` access.
- `seen_content` entries are PER SENDER: identical text from different members in one window is legitimate.
- `drainQueue` first-msg cooldown quirk: second msg in same `drainQueue` call bypasses cooldown even if `now < cooldown_until`. This is intentional.
- Member removal (kick or disconnect) marks that session's queued msgs `rejected`, deletes their queue key, and folds+stops the clock segment they held; kick additionally queues a distinct `system` notice envelope per remaining member and returns `remaining_session_ids` so the plugin can drain them immediately.
- Stale marking: `session.deleted` â†’ `markStale` sets `member.stale=true`; `session.idle`/`statusâ†’idle` â†’ `clearStale` resets it. Sends targeting a stale sole-peer/stale explicit target are rejected; broadcast silently skips stale recipients.
- Multi-channel membership is supported: delivery provenance resolves each envelope's own channel (`drainForDelivery`) and `system.transform` injects ONE labeled prompt section PER membership (`memberInfosFor`) â€” first-match ambiguity was fixed in R1.
- Slash parsing consumes ONLY recognized keys (Channel/As/RolePrompt/Action/LimitMs/LimitRole/To/Broadcast/Target); unknown `x=y` survives in free-form prompt text. Subcommand matching strips `_`/`-` and lowercases, so `UpdateRole` â‰¡ `update_role`.
