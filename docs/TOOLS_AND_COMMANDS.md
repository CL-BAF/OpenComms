# TOOLS_AND_COMMANDS.md — Tools & Slash Command Spec

> 10 deterministic tools registered via `@opencode-ai/plugin` `tool()` (`plugin.ts:79`). All mutating tools pattern: `load() → engine fn → save() if ok → JSON.stringify(result)`. All `channel` args are case-insensitive (normalized via `engine.ts:39`).

## Tool Inventory

| # | Tool name | Line | Mutates state? | Requires membership? | Args |
|---|-----------|------|----------------|----------------------|------|
| 1 | `opencomms_create` | `plugin.ts:80` | Yes | No | `channel`, `role`, `role_prompt` |
| 2 | `opencomms_join` | `plugin.ts:105` | Yes | No | `channel`, `role`, `role_prompt` |
| 3 | `opencomms_send` | `plugin.ts:130` | Yes | Yes | `channel`, `type?`, `content`, `reply_to?` |
| 4 | `opencomms_status` | `plugin.ts:161` | No | No | `channel?` |
| 5 | `opencomms_inbox` | `plugin.ts:173` | No | Yes | `channel`, `limit?` |
| 6 | `opencomms_history` | `plugin.ts:188` | No | No | `channel`, `limit?` |
| 7 | `opencomms_update_role` | `plugin.ts:201` | Yes | Yes | `channel`, `role_prompt` |
| 8 | `opencomms_pause` | `plugin.ts:222` | Yes | Yes | `channel` |
| 9 | `opencomms_resume` | `plugin.ts:238` | Yes | Yes | `channel` |
| 10| `opencomms_disconnect` | `plugin.ts:254` | Yes | Yes | `channel` |

### Schemas (exact)

```ts
// plugin.ts:82-86 opencomms_create
{ channel: string, role: string /* Builder|Reviewer, normalized via normalizeRole */, role_prompt: string }

// plugin.ts:108-112 opencomms_join — same as create

// plugin.ts:133-141 opencomms_send
{ channel: string, type?: string /* review_request|review_response|manual|system, default "manual" */,
  content: string, reply_to?: string|null }

// plugin.ts:164 opencomms_status
{ channel?: string }

// plugin.ts:177 opencomms_inbox
{ channel: string, limit?: number /* 1..100, default 20 */ }

// plugin.ts:192 opencomms_history
{ channel: string, limit?: number /* 1..100, default 20 */ }

// plugin.ts:205 opencomms_update_role
{ channel: string, role_prompt: string }

// plugin.ts:226 opencomms_pause / 242 resume / 258 disconnect
{ channel: string }
```

### Returns

Every tool returns `JSON.stringify(ToolResult)` where `ToolResult = {ok:boolean, message:string, data?:unknown}` (`types.ts:183`). On `ok:true`, `data` may contain:

- `create`/`join`: `{channel_id, role, session_id}` (`engine.ts:138,196`)
- `send`: `{message_id, delivery_status}` (`engine.ts:364`)
- `inbox`: `{pending:number, messages:{message_id,sender_role,message_type,content,timestamp,reply_to,hop_count,delivery_status}[]}` (`engine.ts:448`)
- `history`: `{messages:{message_id,sender_role,recipient_role,message_type,content,timestamp,reply_to,hop_count,delivery_status}[]}` (`engine.ts:471`)
- `status`: `StatusReport {channels:ChannelSummary[], total_messages, pending_messages, errors}` (`engine.ts:516`)

`requireMember` guard (`plugin.ts:72`) — tools 3,5,7-10 reject with `"This session is not linked to any OpenComms channel..."` if `isMember(state, ctx.sessionID) === false`.

`opencomms_create`/`join` derive `session_id` from `ctx.sessionID` (`plugin.ts:96,121`) — never passed by caller. `opencomms_send` derives sender from `ctx.sessionID` as well (`plugin.ts:154`).

## Slash Command: `/OpenComms`

Registered via `command.execute.before` (`plugin.ts:351`). Only triggers when `input.command === "OpenComms"`.

### Parsing

```ts
// plugin.ts:48,60
parseArgs(raw): Record<string,string>   // /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"..."|'...'|(\S+))/g
stripArgs(raw): string                  // remove all key=value, trim
sub = stripArgs(args).split(/\s+/)[0].toLowerCase()  // plugin.ts:355
channel = args.Channel ?? args.channel
role    = args.As ?? args.role
rolePrompt = args.RolePrompt ?? args.role_prompt ?? rest.replace(/^\S+\s*/, "") // remainder
```

`rolePrompt` for Create/Join/UpdateRole is the free-form remainder after the subcommand keyword — allows `RolePrompt="multi word"` or bare text.

### Subcommands

| Subcommand | Line | Args used | Engine fn | Example |
|------------|------|-----------|-----------|---------|
| `Create` | `plugin.ts:364` | `Channel`, `As`/`role`, rest=rolePrompt | `createChannel` | `/OpenComms Create Channel=feat As=Builder You are the builder...` |
| `Join` | `plugin.ts:380` | same | `joinChannel` | `/OpenComms Join Channel=feat As=Reviewer You are the reviewer...` |
| `Status` | `plugin.ts:396` | `Channel?` | `status` | `/OpenComms Status Channel=feat` or `/OpenComms Status` |
| `Pause` | `plugin.ts:399` | `Channel` | `pauseChannel` | `/OpenComms Pause Channel=feat` |
| `Resume` | `plugin.ts:402` | `Channel` | `resumeChannel` | `/OpenComms Resume Channel=feat` |
| `Disconnect` | `plugin.ts:405` | `Channel` | `disconnectChannel` | `/OpenComms Disconnect Channel=feat` |
| `UpdateRole` (alias `update_role`) | `plugin.ts:408` | `Channel`, rest=rolePrompt | `updateRole` | `/OpenComms UpdateRole Channel=feat New instructions...` |
| `Inbox` | `plugin.ts:415` | `Channel` | `inbox` | `/OpenComms Inbox Channel=feat` |
| `History` | `plugin.ts:418` | `Channel` | `history` | `/OpenComms History Channel=feat` |

Aliases: subcommand matched lowercased, so `Create`/`create`/`CREATE` all work. `Channel`/`channel` both work; `As`/`role` both work (`plugin.ts:356-358`).

On unknown subcommand: returns `"Unknown /OpenComms subcommand. Supported: Create, Join, Status, Pause, Resume, Disconnect, UpdateRole, Inbox, History."` (`plugin.ts:422`). Result always appended as `output.parts.push({type:"text", text:`OpenComms: ${result.message}`, ...})` (`plugin.ts:430`) and `save(state)` only if `result.ok` (`plugin.ts:429`).

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
