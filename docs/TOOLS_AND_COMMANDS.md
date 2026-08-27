# TOOLS_AND_COMMANDS.md — Tools & Slash Command Spec

> 12 deterministic tools registered via `@opencode-ai/plugin` `tool()` (`plugin.ts`). All mutating tools run inside `store.withLock`: `withLock(load() → engine fn → save() if ok) → JSON.stringify(result)` (P1 concurrency fix). All `channel` args are case-insensitive (normalized via `normalizeChannelName`).

## Tool Inventory

| # | Tool name | Mutates state? | Requires membership? | Args |
|---|-----------|----------------|----------------------|------|
| 1 | `opencomms_create` | Yes | No | `channel`, `role`, `role_prompt`, `max_members?` |
| 2 | `opencomms_join` | Yes | No | `channel`, `role`, `role_prompt` |
| 3 | `opencomms_send` | Yes | Yes | `channel`, `type?`, `content`, `reply_to?`, `to?`, `broadcast?` |
| 4 | `opencomms_status` | No | No | `channel?` |
| 5 | `opencomms_inbox` | No | Yes | `channel`, `limit?` |
| 6 | `opencomms_history` | No | Yes | `channel`, `limit?` |
| 7 | `opencomms_update_role` | Yes | Yes | `channel`, `role_prompt` |
| 8 | `opencomms_pause` | Yes | Yes | `channel` |
| 9 | `opencomms_resume` | Yes | Yes | `channel` |
| 10| `opencomms_disconnect` | Yes | Yes | `channel` |
| 11| `opencomms_timer` | Yes | Yes | `channel`, `action`, `limit_ms?`, `to?` |
| 12| `opencomms_kick` | Yes | Yes (Builder only) | `channel`, `target_session_id?` / `target_role?` |

### Schemas (exact)

```ts
// opencomms_create
{ channel: string, role: string /* open vocabulary: /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/, unique per channel */,
  role_prompt: string, max_members?: number /* clamped to [2, DEFAULT_MAX_MEMBERS=8] */ }

// opencomms_join — same as create minus max_members

// opencomms_send
{ channel: string, type?: string /* review_request|review_response|manual ONLY ("system" is reserved), default "manual" */,
  content: string, reply_to?: string|null,
  to?: string|null   /* other member's session_id or role label; required on 3+-member channels unless broadcast */,
  broadcast?: boolean }
/* NOTE rate limiting: a broadcast counts as ONE logical send against the 20/min window
   regardless of fan-out size (max 7 copies/send under max_members=8). */

// opencomms_status
{ channel?: string }

// opencomms_inbox
{ channel: string, limit?: number /* 1..100, default 20 */ }

// opencomms_history — member-scoped (session from ctx.sessionID)
{ channel: string, limit?: number /* 1..100, default 20 */ }

// opencomms_update_role
{ channel: string, role_prompt: string }

// opencomms_pause / resume / disconnect
{ channel: string }

// opencomms_timer
{ channel: string, action: string /* start|stop|switch|reset|status|set_limit|clear_limit */,
  limit_ms?: number|null, to?: string|null /* target member by session_id or role */ }
/* NOTE set_limit scope: WITHOUT to= the cap applies to the whole-channel TOTAL (deliberate);
   WITH to=<id|role> it scopes to that one member (self-targeting allowed).
   switch on 3+-member channels REQUIRES to= (never guesses); single-peer channels imply the peer. */

// opencomms_kick — removes another member's CHANNEL LINK only; their OpenCode session lives on
{ channel: string, target_session_id?: string|null, target_role?: string|null }
```

### Returns

Every tool returns `JSON.stringify(ToolResult)` where `ToolResult = {ok:boolean, message:string, data?:unknown}` (`types.ts`). On `ok:true`, `data` may contain:

- `create`/`join`: `{channel_id, role, session_id}`
- `send`: `{message_ids: string[], recipients: string[], delivery_status}` (one envelope per recipient under broadcast)
- `inbox`: `{pending:number, messages:{message_id,sender_role,message_type,content,timestamp,reply_to,hop_count,delivery_status}[]}`
- `history`: `{messages:{message_id,sender_role,recipient_role,message_type,content,timestamp,reply_to,hop_count,delivery_status}[]}`
- `status`: `StatusReport {channels:ChannelSummary[], total_messages, pending_messages, errors}`
- `timer` (status): `{active_member_id, elapsed_ms_by_member, elapsed_ms_by_role, total_ms, limit_ms, limit_member_id, limit_reached}`
- `kick`: `{kicked_session_id, kicked_role, remaining_session_ids}` — the plugin drains the queued system notices for those ids immediately (mirroring the send path).

Membership guard (`requireMember`) rejects tools 3,5-12 with `"This session is not linked to any OpenComms channel..."`.

Create/Join derive `session_id` from `ctx.sessionID` — never passed by caller. Both **fail closed** when the root-session SDK lookup errors.

## Slash Command: `/OpenComms`

Registered via `command.execute.before`. Only triggers when `input.command === "OpenComms"`.

### Parsing

```ts
extractSlashArgs(raw): { params: Record<string,string>, rest: string }  // ONLY recognized keys consumed
sub = firstWord(raw).replace(/[_-]/g,"").toLowerCase()                  // UpdateRole == update_role == UPDATE-ROLE
// Recognized keys: Channel, As, RolePrompt, Action, LimitMs, LimitRole, To, Broadcast, Target
// Unknown x=y tokens stay in the free-form prompt text (no longer swallowed).
rolePrompt = params.RolePrompt ?? rest-minus-subcommand
```

### Subcommands

| Subcommand | Args used | Engine fn | Example |
|------------|-----------|-----------|---------|
| `Create` | `Channel`, `As`=role, rest=rolePrompt | `createChannel` | `/OpenComms Create Channel=feat As=Builder You are the builder...` |
| `Join` | same | `joinChannel` | `/OpenComms Join Channel=feat As=Reviewer You are the reviewer...` |
| `Status` | `Channel?` | `status` | `/OpenComms Status Channel=feat` or `/OpenComms Status` |
| `Pause` | `Channel` | `pauseChannel` | `/OpenComms Pause Channel=feat` |
| `Resume` | `Channel` | `resumeChannel` | `/OpenComms Resume Channel=feat` |
| `Disconnect` | `Channel` | `disconnectChannel` | `/OpenComms Disconnect Channel=feat` |
| `Kick` | `Channel`, `Target`=`<session_id\|role>` | `kickChannel` | `/OpenComms Kick Channel=feat Target=Reviewer` |
| `UpdateRole` (alias `update_role`) | `Channel`, rest=rolePrompt | `updateRole` | `/OpenComms UpdateRole Channel=feat New instructions...` |
| `Inbox` | `Channel` | `inbox` | `/OpenComms Inbox Channel=feat` |
| `History` | `Channel` | `history` (member-only) | `/OpenComms History Channel=feat` |
| `Timer` | `Channel`, `Action`, `LimitMs`?, `To`/`LimitRole`? | `timerAction` | `/OpenComms Timer Channel=feat Action=status` |

Aliases: subcommand matched lowercased, so `Create`/`create`/`CREATE` all work. `Channel`/`channel` both work; `As`/`role` both work (`plugin.ts:356-358`).

On unknown subcommand: returns `"Unknown /OpenComms subcommand. Supported: Create, Join, Status, Pause, Resume, Disconnect, UpdateRole, Inbox, History, Timer."` (`plugin.ts:422`). Result always appended as `output.parts.push({type:"text", text:`OpenComms: ${result.message}`, ...})` (`plugin.ts:430`) and `save(state)` only if `result.ok` (`plugin.ts:429`).

## End-to-End Flow Example

```
Session A (/OpenComms Create):  plugin.ts:364 → engine.ts:91 createChannel → save
Session B (/OpenComms Join):    plugin.ts:380 → engine.ts:142 joinChannel → save
Session A send:                 plugin.ts:130 tool → engine.ts:268 sendMessage → queues[B].push(id)
Session B idle event:            plugin.ts:318 → clearStale → deliverPending → engine.ts:375 drainQueue → client.session.prompt(text)
Session B reply:                same send path, reply_to=parentId → hop_count++
Session A idle:                 same drain → delivers reply
```

Delivery text format (`plugin.ts:282`):
```
[OpenComms message from Builder (review_request) — message_id ocm_..., reply_to none, hop 0]

<content>

---

[OpenComms message from ...]
```

## Adding a New Tool — Checklist

1. Add `tool({ description, args:{...}, async execute(args, ctx){...} })` in `plugin.ts:79` `tools` object.
2. Implement pure logic in `src/engine.ts` (take `State` + input, mutate, return `ToolResult` via `ok`/`fail` helpers at `engine.ts:66`).
3. Add types in `src/types.ts` if new input shape needed.
4. Wire slash subcommand in `plugin.ts:363` switch if CLI access wanted.
5. `npm run typecheck && npm run test` — engine tests at `test/unit/engine.test.ts:1`.
