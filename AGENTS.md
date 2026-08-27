# AGENTS.md — OpenComms AI Quick Reference

> **Purpose:** Token-efficient entry point for AI coders. Read this file first. Only dive into `docs/*` if you need detail — everything here is grounded in source so you don't have to re-read `src/*.ts`.

## 1. What OpenComms Is

Project-local TypeScript OpenCode plugin that **links existing root OpenCode sessions** (2..N) into a communication channel with an **open role vocabulary** (e.g. Builder <-> Reviewer, or Lead/Coder/Tester trios) **without creating or owning sessions**.

- Package: `opencomms` v1.0.0, ESM, `opencode >=1.18.0`
- 4 source files: `src/types.ts`, `src/store.ts`, `src/engine.ts`, `src/plugin.ts`
- State lives at `<project>/.opencode-comms/state.json`, written atomically (temp file + rename)
- No new sessions ever created. Only links sessions the user already opened.

## 2. File Map (read only what you need)

| File | Role | When to read it |
|------|------|-----------------|
| `src/types.ts:1` | All types, constants, `State` shape | Adding fields, changing schema, new message types |
| `src/store.ts:1` | `StateStore` persistence, atomic writes, corrupt recovery | Changing persistence, file location, atomicity |
| `src/engine.ts:1` | Pure deterministic business logic (channels, queues, timer, validation) | Changing channel/message/queue/timer logic, validation |
| `src/plugin.ts:1` | OpenCode glue: tools, hooks, slash command, delivery | Adding tools, hooks, changing prompt injection |
| `docs/ARCHITECTURE.md` | Data flow, lifecycle, invariants | Understanding system before big changes |
| `docs/API_REFERENCE.md` | Full function signatures with `file:line` | Looking up exact API without reading source |
| `docs/TOOLS_AND_COMMANDS.md` | 10 tools + `/OpenComms` slash command spec | Working on tool args, descriptions, slash parsing |

## 3. Core Mental Model (30s)

```
Two existing sessions (Builder, Reviewer)
        |
        v
Create channel (Builder) ---> Join channel (Reviewer)  [engine.ts:91,142]
        |
        v
Send message (queued) ---> Drain on peer idle (event hook)  [engine.ts:268,375]
        |                       |
   paused? rate-limit?      cooldown? stale? --> delivered via client.session.prompt()
   duplicate? hop-count?    [plugin.ts:271,316]
```

**Key invariants (never violate):**
1. Never create/delete OpenCode sessions — only link existing ones (`plugin.ts:14`).
2. Channel name is case-insensitive, normalized via `normalizeChannelName` (`engine.ts:39`), max 64 chars.
3. One session cannot hold two roles on same channel; one role cannot be held by two sessions (`engine.ts:163-181`).
4. Project + worktree must match across members (`engine.ts:151-161`).
5. Messages are queued and **only delivered when recipient is idle** (`plugin.ts:316-349`). Never auto-forward assistant text.

## 4. State Shape (persisted JSON)

```ts
// src/types.ts:87 — top-level State
State {
  schema_version: 1,
  channels: Record<normalizedName, Channel>,
  messages: Record<message_id, MessageEnvelope>,
  queues: Record<recipientSessionId, string[]>,  // FIFO of message_ids
  delivered_to: Record<message_id, string[]>,
  errors: Array<{at:number, message:string}>     // capped 200
}
// Channel: src/types.ts:60 — id, name, project_id, worktree, paused, members[≤2], rate, cooldown_until, seen_content, max_hops=4, rate_limit=20/min, stale_event_ms=5min, timer (chess-clock: per-role elapsed, active_role, optional limit_ms)
// MessageEnvelope: src/types.ts:32 — message_id (ocm_*), correlation_id (cor_*), hop_count, delivery_status (pending|delivered|rejected|stale|failed)
```

Persisted at `<project>/.opencode-comms/state.json` (`types.ts:9-10`), `StateStore` (`store.ts:28`).

## 5. Most Common Tasks

| Task | Where to edit | Key function |
|------|---------------|--------------|
| Add/modify tool | `src/plugin.ts:79` `tools` object, then `engine.ts` for logic | `tool()` definition + engine function |
| Change validation (limits, roles) | `src/engine.ts:91` `createChannel` / `src/types.ts:16` | `normalizeRole`, constants `DEFAULT_*` |
| Change delivery timing | `src/engine.ts:375` `drainQueue`, `src/plugin.ts:271` `deliverPending` | `delivery_cooldown_ms` |
| Change timer behavior | `src/engine.ts` `timerAction`, `timerElapsed`, `timerLimitReached` | `ChannelTimer`, `TimerInput` |
| Change persistence | `src/store.ts:64` `save()`, `src/types.ts:9` | `STATE_DIR`, `STATE_FILE` |
| Add message type | `src/types.ts:26` `MessageType` + `src/plugin.ts:135` schema | `MessageType` union |
| Modify role prompt injection | `src/plugin.ts:44` `buildRolePrompt`, `307` hook | `experimental.chat.system.transform` |

## 6. Build / Test (no guessing)

```bash
npm run build        # tsc -p tsconfig.build.json -> dist/
npm run typecheck    # tsc --noEmit
npm run test         # build:test + node --test dist-test/test/unit/*.test.js
npm run test:unit    # same as test
npm run test:all     # unit + live (needs OpenCode running, 5min timeout)
```

Tests in `test/unit/engine.test.ts` (timer + channel/queue tests), `store.test.ts`, and `test/live/live.test.ts` (guarded live flow).

## 7. Token-Saving Rules for AI Coders

1. **Don't re-read source** — use `docs/API_REFERENCE.md` for signatures; it has `file:line` for every export.
2. **Don't grep for types** — `docs/ARCHITECTURE.md` has the full type table and State diagram.
3. **Don't guess tool args** — `docs/TOOLS_AND_COMMANDS.md` has exact schemas for all 11 tools.
4. **For small changes, edit one file only** — engine is pure logic, plugin is glue, store is I/O. Don't cross concerns.
5. **After editing, run `npm run typecheck`** — strict mode, `noUncheckedIndexedAccess`.

## 8. Gotchas

- Channels hold **N members** (`Channel.max_members`, default 8, clamped to >= 2 at creation). On a two-member channel `sendMessage` targets the lone peer; with 3+ members a send **fails** unless you pass `to=<session_id|role>` or `broadcast=true` — targeting is never guessed.
- Roles are an **open vocabulary** (structural check: letter first, 1-32 chars of letters/digits/space/-/_), unique per channel, spelling preserved verbatim; all role lookups compare case-insensitively.
- Every load->mutate->save runs under `StateStore.withLock` (exclusive-create `.state.lock`, stale-broken after 15s). Bare reads stay lock-free because writes are atomic renames. Never call anything that takes the lock while already inside it — deadlocks until timeout.
- Message types are whitelisted: senders may send only `review_request|review_response|manual`; `"system"` is reserved for internal notices (e.g. kick notifications).
- Delivered peer content is wrapped in `<<<UNTRUSTED_PEER_MESSAGE>>>` markers with provenance (`formatUntrustedMessage`) before entering another session's prompt — keep that framing intact.
- `seen_content` dedup keys are `${sender_session_id}:${hash}` — identical content from *different* senders is legitimate.
- Reads are member-scoped: `history` requires membership (`HistoryInput.session_id`); transcripts never leak to outsiders. Root-session checks on Create/Join now **fail closed** on SDK lookup errors.
- Retention: `MAX_PERSISTED_MESSAGES = 2000`; `pruneMessages` keeps newest and cleans queues/`delivered_to`. History scans are bounded by the cap instead of a separate index (deliberate tradeoff).
- Kick: Builder-only removal of another member via `kickChannel` / `/OpenComms Kick Channel=.. Target=<id|role>`. Kicking severs only the channel link; the session lives on. Single-member channels survive kicks and accept rejoin.
- Channel names must match `^[a-z0-9][a-z0-9-_]*$` after lowercasing (blocks `__proto__` key games); lookups use `normalizeChannelName`.
- Timer keys members by **session id** (`timer.elapsed_ms[sessionId]`, `active_member_id`); it auto-switches on `sendMessage`, folds/stops on `markStale`/kick/disconnect if the departing member held the clock.
- Corrupt/tampered `state.json` never bricks the plugin: schema_version + shape validated (`validateState`), wrong version or forged member rows -> `emptyState()` + recorded error; legacy files get timer/max_members backfilled.
- Slash args use `extractSlashArgs`: only recognized keys (`Channel/As/Target/To/Broadcast/Action/LimitMs/LimitRole/RolePrompt`) are consumed; unknown `x=y` stays in free-form prompt text. Subcommand matching ignores `_`/`-` and case (`UpdateRole` == `updaterole`).

---
*For deeper detail, see `docs/README.md` navigation hub.*
