# API_REFERENCE.md â€” Complete Symbol Catalog

> Every exported symbol with signature and notes. Line anchors are approximate after the multi-agent refactor â€” signatures here are the source of truth; use `rg "export function <name>" src/` for exact positions.

## src/core/types.ts . Constants & Types

### Constants

| Symbol | Value / Type | Notes |
|--------|--------------|-------|
| `STATE_DIR` | `".opencomms"` | Subdir under project root (v2) |
| `STATE_FILE` | `"state.json"` | Inside `STATE_DIR` |
| `SCHEMA_VERSION` | `1` | Bump on breaking State shape change |
| `ROLE_BUILDER` | `"Builder"` | Legacy default label (kick policy v1 checks this) |
| `ROLE_REVIEWER` | `"Reviewer"` | Legacy default label |
| `DEFAULT_MAX_MEMBERS` | `8` | Per-channel membership cap; clamped â‰¥2 at creation |
| `VALID_SENDER_MESSAGE_TYPES` | `["review_request","review_response","manual"]` | Whitelist; `"system"` is internal-only |

### Type Aliases

| Type | Definition |
|------|------------|
| `Role` | `string` â€” OPEN vocabulary, validated structurally by `normalizeRole` (`/^[A-Za-z][A-Za-z0-9 _-]{0,31}$/`, spelling preserved) |
| `SenderMessageType` | `"review_request"\|"review_response"\|"manual"` â€” what senders may set |
| `MessageType` | `SenderMessageType \| "system"` â€” `"system"` appears only in internally-generated envelopes |
| `DeliveryStatus` | `"pending"\|"delivered"\|"failed"\|"rejected"\|"stale"` |

### Interfaces

```ts
interface MessageEnvelope {
  message_id: string              // ocm_<hex>
  channel_id: string              // chn_<hex>
  sender_session_id: string
  sender_role: string             // open-vocab role label
  recipient_session_id: string
  recipient_role: string
  timestamp: number
  message_type: MessageType
  content: string
  reply_to: string | null
  hop_count: number
  delivery_status: DeliveryStatus
  correlation_id: string          // cor_<hex>
  delivered_at: number | null
  attempts: number
}

interface Member {
  session_id: string
  role: string                    // open vocab, unique per channel
  role_prompt: string
  joined_at: number
  stale: boolean
  stale_at: number | null
}

interface Channel {
  id: string; name: string; project_id: string; worktree: string
  created_at: number; paused: boolean; paused_at: number | null
  members: Member[]               // â‰¤ max_members
  max_members: number             // default 8, clamped â‰¥2 at creation
  rate: { window_start:number, count:number }
  cooldown_until: Record<string,number>
  seen_content: Record<string,number>   // keys `${sender_session_id}:${hash}`; TTL = stale_event_ms
  processed_correlations: string[]      // capped 500
  max_hops: number                      // default 4
  rate_limit: number                    // default 20/min; broadcast counts as ONE send
  delivery_cooldown_ms: number          // default 1000
  stale_event_ms: number                // default 300000 (5min)
  timer: ChannelTimer
}

interface ChannelTimer {
  active_member_id: string | null       // member ON the clock (session id)
  segment_started_at: number | null
  elapsed_ms: Record<string, number>    // keyed BY SESSION ID
  limit_ms: number | null
  limit_member_id: string | null        // null â†’ limit applies to channel TOTAL
}

interface State {
  schema_version: number
  channels: Record<string,Channel>        // key = normalizedName
  messages: Record<string,MessageEnvelope>
  queues: Record<string,string[]>         // recipientSessionId â†’ FIFO ids
  delivered_to: Record<string,string[]>   // message_id â†’ recipientIds
  errors: Array<{at:number,message:string}> // capped 200
}

interface ChannelSummary { id, name, project_id, worktree, created_at, paused, max_members,
  members:{session_id,role,stale,joined_at}[], queue_lengths:Record<string,number>, last_message_at:number|null }
interface StatusReport { channels: ChannelSummary[], total_messages:number, pending_messages:number, errors:{at,message}[] }

// Inputs
SendInput      { channel:string, type?:MessageType, content:string, reply_to?:string|null,
                 to?:string|null /* other member's session_id or role */, broadcast?:boolean }
CreateInput    { channel:string, role:string, role_prompt:string, session_id, project_id, worktree,
                 max_members?:number }
JoinInput      { channel:string, role:string, role_prompt:string, session_id, project_id, worktree }
UpdateRoleInput{ channel:string, session_id:string, role_prompt:string }
PauseInput     { channel:string, session_id:string }
ResumeInput    { channel:string, session_id:string }
DisconnectInput{ channel:string, session_id:string }
KickInput      { channel:string, session_id:string /* caller */,
                 target_session_id?:string|null, target_role?:string|null }  // exactly one required
InboxInput     { channel:string, session_id:string, limit?:number }
HistoryInput   { channel:string, session_id:string /* MEMBER-SCOPED reads */, limit?:number }
StatusInput    { channel?:string }
TimerInput     { channel:string, session_id:string,
                 action:"start"|"stop"|"switch"|"reset"|"status"|"set_limit"|"clear_limit",
                 limit_ms?:number|null, to?:string|null /* member by id-or-role */ }
ToolResult     { ok:boolean, message:string, data?:unknown }
```

---

## src/core/engine.ts . Pure Logic

Constants:

| Symbol | Value |
|--------|-------|
| `DEFAULT_MAX_HOPS` | `4` |
| `DEFAULT_RATE_LIMIT` | `20` (per minute) |
| `DEFAULT_DELIVERY_COOLDOWN_MS` | `1000` |
| `DEFAULT_STALE_EVENT_MS` | `300000` (5 min) |
| `MAX_PERSISTED_MESSAGES` | `2000` retention cap enforced by `pruneMessages` |

Utilities:

| Function | Signature | Notes |
|----------|-----------|-------|
| `normalizeChannelName` | `(name:string)=>string` | `trim().toLowerCase()`; creation additionally enforces `^[a-z0-9][a-z0-9-_]*$` + â‰¤64 |
| `normalizeRole` | `(role:string)=>string\|null` | Open vocabulary; trims, collapses inner whitespace, structural check; spelling preserved |
| `assertRootSession` | `(parentID, sessionId)=>string\|null` | Rejection message if child session, else null |
| `contentHash` | `(content:string)=>string` | sha256, first 32 hex chars |
| `newMessageId` / `newChannelId` / `newCorrelationId` | `()=>string` | `ocm_` / `chn_` / `cor_` prefixed hex |
| `defaultTimer` | `()=>ChannelTimer` | All-null, empty `elapsed_ms` record |
| `timerElapsed(timer, memberId, now?)` | `=>number` | Cumulative ms for one MEMBER incl. running segment |
| `timerElapsedAll(timer, now?)` | `=>Record<string,number>` | Per-member snapshot incl. running segment |
| `timerTotal(timer, now?)` | `=>number` | Sum across all members incl. running segment |
| `timerLimitReached(timer, now?)` | `=>boolean` | Member-scoped when `limit_member_id` set, else TOTAL |
| `resolveSwitchTarget(channel, requesterId, to?)` | `{result?, target?}` | Never-guess switch resolution: explicit `to` (others only) > implied single peer > ERROR on N>1 |
| `memberInfosFor(state, sessionId)` | `=>MemberInfo[]` | ALL memberships `{role, prompt, channel_name}` â€” one labeled prompt section per channel |
| `drainForDelivery(state, recipientSessionId)` | `=>DeliveryPair[]` | Drains queue marking `in_flight` (persisted pre-prompt); annotates each envelope with ITS OWN channel name for provenance |
| `commitDelivery(state, sessionId, ids)` | `=>void` | `in_flight`â†’`delivered` after the host ACCEPTED the prompt (two-phase delivery) |
| `sweepInFlight(state)` | `=>string[]` | Startup crash recovery: `in_flight`â†’pending + FIFO re-queue; returns swept ids (idempotent) |
| `pendingRecipients(state)` | `=>string[]` | Distinct recipients holding PENDING queue entries (fs-watch wake input; in_flight excluded) |
| `requeueFailedDelivery(state, sessionId, ids)` | `=>void` | Restores pending status + ORIGINAL FIFO order on prompt failure (accepts `delivered` or `in_flight`) |
| `pruneMessages(state)` | `=>void` | Keeps newest `MAX_PERSISTED_MESSAGES`, cleans queues/delivered_to of pruned ids |
| `formatUntrustedMessage(msg, channelName)` | `=>string` | `<<<UNTRUSTED_PEER_MESSAGE>>>` framing + provenance + do-not-follow notice |
| `formatDeliveryBatch(delivered, channelName)` | `=>string` | Batch joiner for the above |

Channel ops (all `state` mutated in place, return `ToolResult`):

| Function | Signature | Failure cases |
|----------|-----------|---------------|
| `createChannel(state, input)` | Slug/role validation, dupes, clamps `max_membersâˆˆ[2,8]` | bad slug (`__proto__` etc.), len>64, malformed role, missing fields, already exists |
| `joinChannel(state, input)` | Project/worktree match, dupe-session, MAX_MEMBERS FIRST, then case-insensitive role-taken | full channel â†’ `is full`; taken role â†’ holder listed |
| `updateRole(state, input)` | membership + non-empty prompt | not member |
| `pauseChannel` / `resumeChannel` | Idempotent no-op messages | not member |
| `disconnectChannel(state, input)` | Shared `removeMember`: purge own queue as rejected, fold+stop held timer segment | deletes channel if empty |
| `kickChannel(state, input)` | Builder-only caller; self-kick denied (id OR role spellings); target must exist | queues distinct `system` notice per remaining member; returns `{kicked_session_id, kicked_role, remaining_session_ids}`; single-member channel survives |

Messaging:

| Function | Signature | Key validations |
|----------|-----------|-----------------|
| `sendMessage(state, input, senderSessionId)` | Type whitelist ("system" reserved + unknown rejected); recipients resolved via never-guess policy; paused; size â‰¤100k; rate window (broadcast = ONE count); per-sender dedup (`${sender}:${hash}`, TTL sweep); hops â‰¤ max_hops | Returns `{message_ids[], recipients[], delivery_status}` |
| `drainQueue(state, recipientSessionId, opts?)` | See ARCHITECTURE.md delivery pipeline; per-envelope pause/cooldown/stale/canDeliver guards; calls pruneMessages | Returns delivered `MessageEnvelope[]` |
| `inbox(state, input)` | MEMBER-ONLY | Does NOT drain |
| `history(state, input)` | MEMBER-ONLY (`HistoryInput.session_id`) | Newest-first, limit 1..100 default 20 |
| `status(state, input)` | Metadata only (no content) | Optional single-channel filter |
| `timerAction(state, input)` | start/stop/switch/reset/status/set_limit/clear_limit; switch REQUIRES `to=` on 3+-member channels; set_limit w/o `to=` scopes TOTAL deliberately; `Number.isFinite` gate rejects NaN limits | Not member / invalid action / bad limit |

Session helpers (read-only): `markStale(state, sessionId)`, `clearStale(state, sessionId)`, `isMember(state, sessionId)`, `channelForSession(state, sessionId)` (first match â€” only used for presence now), `deliveryStatusOf(state, messageId)`.

---

## src/core/store.ts . Persistence

| Symbol | Signature / Value | Notes |
|--------|-------------------|-------|
| `emptyState()` | `()=>State` | schema_version=SCHEMA_VERSION, all maps empty |
| `class StateStore` | `constructor(projectDir:string)` | `dir`, `file`, private `lockPath` |
| `.withLock(fn)` | `<T>(fn:()=>T)=>T` | Exclusive-create `.state.lock` (`<pid>@<ts>`); LOCK_TIMEOUT_MS=5s; locks older than LOCK_STALE_MS=15s broken. R5 tradeoff documented in ARCHITECTURE.md |
| `.load()` | `()=>State` | validateState gate (schema_version, shapes, key/name agreement) â†’ reject to fresh + error; backfillState for legacy files |
| `.save(state)` | `(state:State)=>void` | Atomic tmp+rename; blocking-sleep retry; direct-write fallback |
| `.update(fn)` | `(mutate:(state:State)=>void)=>State` | `withLock(load â†’ mutate â†’ save)` |
| `LOCK_TIMEOUT_MS` / `LOCK_STALE_MS` | `5000` / `15000` | Exported for tests |
| `stateDirFor` / `isInsideStateDir` | path helpers | |

---

## src/plugin.ts . OpenCode Adapter

| Symbol | Kind | Notes |
|--------|------|-------|
| `OpenCommsPlugin` (default export) | `Plugin` factory | Receives `{client, project, directory, worktree}` |
| `buildRolePrompt(role, prompt, channelName?)` | helper | Labeled per-channel when channelName given |
| `extractSlashArgs(raw)` | helper | Consumes ONLY recognized keys (Channel/As/RolePrompt/Action/LimitMs/LimitRole/To/Broadcast/Target); quotes supported; unknown `x=y` stays in text |
| `slashSub(raw)` | helper | First word, strips `_`/`-`, lowercased |
| `deliverPending(sessionId)` | async (controller) | Now lives in `src/hosts/opencode/delivery.ts` `createDeliveryController` â€” owner-side gate, two-phase in_flight/commit, requeue+retry on failure |
| `delivery.markLocal / notifyRecipient / startupSweep` | controller API | `markLocal`: ownership evidence (session.* events + system transform); `notifyRecipient`: immediate for local, 5s cross-server fallback for ownerless PUSH members; `startupSweep`: crash recovery |
| `requireRootSession(sessionId)` | async guard | FAILS CLOSED on SDK error (create/join refuse + record) |
| `withLockedState(mutate, shouldSave)` | helper | Every tool mutation runs through it |
| `tools` | 12 entries | create, join, send, status, inbox, history, update_role, pause, resume, disconnect, kick, timer â€” see TOOLS_AND_COMMANDS.md |
| hooks | 3 | system.transform (per-membership prompts), event (idle/deleted/status), command.execute.before (/OpenComms) |

---

## Build Outputs

| Output | Source | Config |
|--------|--------|--------|
| `dist/*.js` | `src/*.ts` | `tsconfig.build.json` (`outDir: dist`) + esbuild bundle `dist/plugin.bundled.js` |
| `dist-test/**/*.js` | `src/*.ts` + `test/**/*.ts` | `tsconfig.test.json` (`outDir: dist-test`) |

Strict flags (`tsconfig.json`): `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`.
