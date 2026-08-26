# API_REFERENCE.md — Complete Symbol Catalog

> Every exported symbol with `file:line`, signature, and notes. Use this instead of opening `src/*.ts`.

## src/types.ts:1 — Constants & Types

### Constants

| Symbol | Line | Value / Type | Notes |
|--------|------|--------------|-------|
| `STATE_DIR` | `types.ts:9` | `".opencode-comms"` | Subdir under project root |
| `STATE_FILE` | `types.ts:10` | `"state.json"` | Inside `STATE_DIR` |
| `SCHEMA_VERSION` | `types.ts:11` | `1` | Bump on breaking State shape change |
| `ROLE_BUILDER` | `types.ts:13` | `"Builder"` | |
| `ROLE_REVIEWER` | `types.ts:14` | `"Reviewer"` | |
| `VALID_ROLES` | `types.ts:16` | `readonly ["Builder","Reviewer"]` | |

### Type Aliases

| Type | Line | Definition |
|------|------|------------|
| `Role` | `types.ts:17` | `(typeof VALID_ROLES)[number]` → `"Builder"\|"Reviewer"` |
| `DeliveryStatus` | `types.ts:19` | `"pending"\|"delivered"\|"failed"\|"rejected"\|"stale"` |
| `MessageType` | `types.ts:26` | `"review_request"\|"review_response"\|"manual"\|"system"` |

### Interfaces

```ts
// types.ts:32
interface MessageEnvelope {
  message_id: string              // ocm_<hex>
  channel_id: string              // chn_<hex>
  sender_session_id: string
  sender_role: Role
  recipient_session_id: string
  recipient_role: Role
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

// types.ts:50
interface Member {
  session_id: string
  role: Role
  role_prompt: string
  joined_at: number
  stale: boolean
  stale_at: number | null
}

// types.ts:60
interface Channel {
  id: string; name: string; project_id: string; worktree: string
  created_at: number; paused: boolean; paused_at: number | null
  members: Member[]               // ≤2
  rate: { window_start:number, count:number }
  cooldown_until: Record<string,number>
  seen_content: Record<string,number>
  processed_correlations: string[] // capped 500
  max_hops: number                 // default 4
  rate_limit: number               // default 20
  delivery_cooldown_ms: number     // default 1000
  stale_event_ms: number           // default 300000 (5min)
}

// types.ts:87
interface State {
  schema_version: number
  channels: Record<string,Channel>        // key = normalizedName
  messages: Record<string,MessageEnvelope>
  queues: Record<string,string[]>         // recipientSessionId → FIFO ids
  delivered_to: Record<string,string[]>   // message_id → recipientIds
  errors: Array<{at:number,message:string}> // capped 200
}

// types.ts:98 / 115
interface ChannelSummary { id, name, project_id, worktree, created_at, paused, members:{session_id,role,stale,joined_at}[], queue_lengths:Record<string,number>, last_message_at:number|null }
interface StatusReport { channels: ChannelSummary[], total_messages:number, pending_messages:number, errors:{at,message}[] }

// Input types — all in types.ts:122-181
SendInput      { channel:string, type?:MessageType, content:string, reply_to?:string|null } // :122
CreateInput    { channel:string, role:Role, role_prompt:string, session_id:string, project_id:string, worktree:string } // :129
JoinInput      { channel:string, role:Role, role_prompt:string, session_id:string, project_id:string, worktree:string } // :138
UpdateRoleInput{ channel:string, session_id:string, role_prompt:string } // :147
PauseInput     { channel:string, session_id:string } // :153
ResumeInput    { channel:string, session_id:string } // :158
DisconnectInput{ channel:string, session_id:string } // :163
InboxInput     { channel:string, session_id:string, limit?:number } // :168
HistoryInput   { channel:string, limit?:number } // :174
StatusInput    { channel?:string } // :179
ToolResult     { ok:boolean, message:string, data?:unknown } // :183
```

---

## src/engine.ts:1 — Pure Logic

Constants:

| Symbol | Line | Value |
|--------|------|-------|
| `DEFAULT_MAX_HOPS` | `engine.ts:34` | `4` |
| `DEFAULT_RATE_LIMIT` | `engine.ts:35` | `20` (per minute) |
| `DEFAULT_DELIVERY_COOLDOWN_MS` | `engine.ts:36` | `1000` |
| `DEFAULT_STALE_EVENT_MS` | `engine.ts:37` | `300000` (5 min) |

Utilities:

| Function | Line | Signature | Notes |
|----------|------|-----------|-------|
| `normalizeChannelName` | `engine.ts:39` | `(name:string)=>string` | `trim().toLowerCase()` |
| `normalizeRole` | `engine.ts:43` | `(role:string)=>Role\|null` | Case-insensitive, only Builder/Reviewer |
| `assertRootSession` | `engine.ts:51` | `(parentID:string\|undefined\|null, sessionId:string)=>string\|null` | Returns rejection message if session is a child (has parentID), else null |
| `contentHash` | `engine.ts:50` | `(content:string)=>string` | sha256, first 32 hex chars |
| `newMessageId` | `engine.ts:54` | `()=>string` | `ocm_<32hex>` |
| `newChannelId` | `engine.ts:58` | `()=>string` | `chn_<32hex>` |
| `newCorrelationId` | `engine.ts:62` | `()=>string` | `cor_<32hex>` |

Channel ops (all `state` mutated in place, return `ToolResult`):

| Function | Line | Signature | Failure cases |
|----------|------|-----------|---------------|
| `createChannel` | `engine.ts:91` | `(state:State, input:CreateInput)=>ToolResult` | empty name, len>64, missing session/project/worktree/role_prompt, already exists |
| `joinChannel` | `engine.ts:142` | `(state:State, input:JoinInput)=>ToolResult` | no channel, project/worktree mismatch, already member (same or diff role), role already taken, missing role_prompt |
| `updateRole` | `engine.ts:200` | `(state:State, input:UpdateRoleInput)=>ToolResult` | no channel, not member, empty role_prompt |
| `pauseChannel` | `engine.ts:212` | `(state:State, input:PauseInput)=>ToolResult` | no channel, not member (idempotent if already paused) |
| `resumeChannel` | `engine.ts:225` | `(state:State, input:ResumeInput)=>ToolResult` | no channel, not member (ok if not paused) |
| `disconnectChannel` | `engine.ts:238` | `(state:State, input:DisconnectInput)=>ToolResult` | no channel, not member; marks its queue msgs `rejected`, deletes `queues[sessionId]`, deletes channel if empty |

Messaging:

| Function | Line | Signature | Key validations |
|----------|------|-----------|-----------------|
| `sendMessage` | `engine.ts:268` | `(state:State, input:SendInput, senderSessionId:string)=>ToolResult` | no channel, not member, no peer, peer stale, paused, empty content, len>100k, rate limit, duplicate content (hash within stale window), hop_count>max_hops |
| `drainQueue` | `engine.ts:375` | `(state:State, recipientSessionId:string, opts?:{now?:number, canDeliver?:(msg:MessageEnvelope)=>boolean})=>MessageEnvelope[]` | See delivery pipeline in ARCHITECTURE.md; returns delivered batch |
| `inbox` | `engine.ts:435` | `(state:State, input:InboxInput)=>ToolResult` | no channel, not member; limit clamped 1..100 default 20; does NOT drain |
| `history` | `engine.ts:463` | `(state:State, input:HistoryInput)=>ToolResult` | no channel; returns newest-first, limit 1..100 |
| `status` | `engine.ts:486` | `(state:State, input:StatusInput)=>ToolResult` | If `input.channel` set, only that channel; else all |

Session helpers (read-only):

| Function | Line | Signature |
|----------|------|-----------|
| `markStale` | `engine.ts:525` | `(state:State, sessionId:string)=>void` |
| `clearStale` | `engine.ts:535` | `(state:State, sessionId:string)=>void` |
| `isMember` | `engine.ts:545` | `(state:State, sessionId:string)=>boolean` |
| `rolePromptFor` | `engine.ts:549` | `(state:State, sessionId:string)=>string\|null` | 
| `channelForSession` | `engine.ts:557` | `(state:State, sessionId:string)=>Channel\|undefined` |
| `deliveryStatusOf` | `engine.ts:561` | `(state:State, messageId:string)=>DeliveryStatus\|null` |

---

## src/store.ts:1 — Persistence

| Symbol | Line | Signature / Value | Notes |
|--------|------|-------------------|-------|
| `emptyState()` | `store.ts:17` | `()=>State` | schema_version=1, all maps `{}`, errors `[]` |
| `class StateStore` | `store.ts:28` | `constructor(projectDir:string)` | `dir = join(projectDir, STATE_DIR)`, `file = join(dir, STATE_FILE)` |
| `.dir` | `store.ts:29` | `string` | Absolute dir path |
| `.file` | `store.ts:30` | `string` | Absolute file path |
| `.load()` | `store.ts:37` | `()=>State` | Returns `emptyState` if missing; on corrupt, returns `emptyState` + pushes error |
| `.save(state)` | `store.ts:64` | `(state:State)=>void` | Atomic tmp+rename; Windows retry 50ms + fallback direct write |
| `.update(fn)` | `store.ts:95` | `(mutate:(state:State)=>void)=>State` | load→mutate→save |
| `stateDirFor` | `store.ts:103` | `(projectDir:string)=>string` | `join(projectDir, STATE_DIR)` |
| `isInsideStateDir` | `store.ts:107` | `(projectDir:string, candidate:string)=>boolean` | Checks dirname |

---

## src/plugin.ts:1 — OpenCode Glue

| Symbol | Line | Kind | Notes |
|--------|------|------|-------|
| `OpenCommsPlugin` | `plugin.ts:64` | `Plugin` | Async factory `( {client, project, directory, worktree} ) => PluginInstance` |
| `ROLE_PROMPT_HEADER` | `plugin.ts:42` | `const string` | `"## OpenComms role instructions"` |
| `buildRolePrompt` | `plugin.ts:44` | `(role:Role, prompt:string)=>string` | `${HEADER}\n\nYou are the ${role}...\n\n${prompt.trim()}` |
| `parseArgs` | `plugin.ts:48` | `(raw:string)=>Record<string,string>` | Regex `/([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\.)*)"|'((?:[^'\\]|\.)*)'|(\S+))/g` |
| `stripArgs` | `plugin.ts:60` | `(raw:string)=>string` | Removes key=value tokens, trims |
| `promptRole` | `plugin.ts:441` | `(state:State, sessionId:string)=>Role\|null` | Private helper, scans channels for member |
| `deliverPending` | `plugin.ts:271` | `(sessionId:string)=>Promise<void>` | Loads state, checks `channelForSession`, paused, calls `drainQueue`, saves, prompts via `client.session.prompt`; on error records to `errors` |
| `tools` | `plugin.ts:79` | 10 entries | See TOOLS_AND_COMMANDS.md |
| `experimental.chat.system.transform` | `plugin.ts:307` | hook | Injects role prompt |
| `event` | `plugin.ts:316` | hook | Handles idle/deleted/status |
| `command.execute.before` | `plugin.ts:351` | hook | Handles `/OpenComms` slash |

Re-export:

| Symbol | Line |
|--------|------|
| `default` | `plugin.ts:449` | `export default OpenCommsPlugin` |

---

## Build Outputs

| Output | Source | Config |
|--------|--------|--------|
| `dist/*.js` | `src/*.ts` | `tsconfig.build.json:1` (`outDir: dist`, include `src/**/*.ts`) |
| `dist-test/**/*.js` | `src/*.ts` + `test/**/*.ts` | `tsconfig.test.json:1` (`outDir: dist-test`) |

Strict flags (`tsconfig.json:7`): `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`.
