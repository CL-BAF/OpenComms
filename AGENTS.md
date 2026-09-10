# AGENTS.md â€” OpenComms AI Quick Reference

> **Purpose:** Token-efficient entry point for AI coders. Read this file first. Only dive into `docs/*` if you need detail â€” everything here is grounded in source so you don't have to re-read `src/*.ts`.

## 1. What OpenComms Is

Project-local TypeScript OpenCode plugin that **links existing root OpenCode sessions** (2..N) into a communication channel with an **open role vocabulary** (e.g. Builder <-> Reviewer, or Lead/Coder/Tester trios) **without creating or owning sessions**.

- Package: `opencomms` v1.1.0, ESM, `opencode >=1.18.0`
- Core sources: `src/core/types.ts`, `src/core/store.ts`, `src/core/engine.ts` + OpenCode adapter `src/plugin.ts`
- State lives at `<project>/.opencomms/state.json` (schema v2), written atomically (temp file + rename). Legacy `.opencode-comms/state.json` exists only until the one-time v1->v2 migration
- No new sessions ever created. Only links sessions the user already opened.

## 2. File Map (read only what you need)

| File | Role | When to read it |
|------|------|-----------------|
| `src/core/types.ts` | All types, constants, `State` shape | Adding fields, changing schema, new message types |
| `src/core/store.ts` | `StateStore` persistence, atomic writes, corrupt recovery, v1 migration | Changing persistence, file location, atomicity |
| `src/core/engine.ts` | Pure deterministic business logic (channels, queues, timer, validation) | Changing channel/message/queue/timer logic, validation |
| `src/plugin.ts` | OpenCode glue: tools, hooks, slash command, delivery | Adding tools, hooks, changing prompt injection |
| `src/gui/server.ts` + `src/gui/ui.ts` | Loopback API and embedded offline HTML console | Changing workspace selection, operator flows, GUI surfaces |
| `src/gui/workspace.ts` | Per-user project registry/preferences | Changing recent-project behavior or app-level settings |
| `docs/ARCHITECTURE.md` | Data flow, lifecycle, invariants | Understanding system before big changes |
| `docs/API_REFERENCE.md` | Full function signatures with `file:line` | Looking up exact API without reading source |
| `docs/TOOLS_AND_COMMANDS.md` | 12 tools + `/OpenComms` slash command spec | Working on tool args, descriptions, slash parsing |

## 3. Core Mental Model (30s)

```
Two existing sessions (Builder, Reviewer)
        |
        v
Create channel (Builder) ---> Join channel (Reviewer)  [engine.ts createChannel/joinChannel]
        |
        v
Send message (queued) ---> Drain on peer idle (event hook)  [engine.ts sendMessage/drainQueue]
        |                       |
   paused? rate-limit?      cooldown? stale? --> delivered via client.session.prompt()
   duplicate? hop-count?    [plugin.ts deliverPending]
```

**Key invariants (never violate):**
1. Never create/delete OpenCode sessions â€” only link existing ones (invariant; see ARCHITECTURE.md).
2. Channel name is case-insensitive, normalized via `normalizeChannelName` (`src/core/engine.ts`), max 64 chars.
3. One session cannot hold two roles on same channel; one role cannot be held by two sessions (`src/core/engine.ts` joinChannel).
4. Project + worktree must match across members (`src/core/engine.ts` joinChannel).
5. Messages are queued and **only delivered when recipient is idle** (`deliverPending` in `src/plugin.ts`). Never auto-forward assistant text.

## 4. State Shape (persisted JSON)

```ts
// src/core/types.ts . State
State {
  schema_version: 2,
  channels: Record<normalizedName, Channel>,
  messages: Record<message_id, MessageEnvelope>,
  queues: Record<recipientSessionId, string[]>,  // FIFO of message_ids
  delivered_to: Record<message_id, string[]>,
  errors: Array<{at:number, message:string}>     // capped 200
}
// Channel: members carry host/surface/delivery_mode/host_session_id/stale_policy (schema v2); timer keyed by session id
// MessageEnvelope â€” message_id (ocm_*), correlation_id (cor_*), hop_count, delivery_status (pending|in_flight|delivered|rejected|stale|failed)
```

Persisted at `<project>/.opencomms/state.json` (`src/core/types.ts`), `StateStore` (`src/core/store.ts`). Legacy `.opencode-comms/state.json` is migrated once (backup + MIGRATED_FROM_V1 marker); never run the pre-1.x plugin after migration.

## Delivery invariants (CLIâ†”CLI autonomy, verified 2026-09-08)

- **Owner-side delivery**: each OpenCode TUI/`serve` = own server + plugin instance + bus. An instance prompts ONLY sessions it has seen events for (`delivery.markLocal`); the fs-watch wake (`fs.watchFile` on state.json) makes the recipient's OWN instance pick up mail queued by another process. Cross-server prompting degrades rendering and is used only as a 5s fallback for ownerless PUSH members. Evidence + topology matrix: `docs/OPENCODE.md`.
- **Two-phase delivery**: drain marks `in_flight` (persisted pre-prompt) â†’ `commitDelivery` after the host accepts â† `delivered`. Crash between = `sweepInFlight` re-queues at next plugin start (at-least-once on that window). Retries dead-letter as `failed` after `MAX_DELIVERY_ATTEMPTS` (5).
- **Spawn-push (Claude Code / Codex)**: documented CLI resume (`claude --resume <id> --print`, `codex exec resume <id>`) invoked as an argv-array child process (NO shell). Gate: `spawn_push` mode + bound `host_session_id` + host builder; Windows npm `.cmd` shims need `OPENCOMMS_CLAUDE_BIN`/`OPENCOMMS_CODEX_BIN` (native binary or quote-aware command template); batches over the argv budget (~30k win32) are refused pre-drain, never truncated.
- **Endpoint capabilities** per member (`effectiveEndpointCapabilities`): mode-derived `push/pull/resume/queue_while_busy/interrupt`, explicit overrides win.
- **Session lifecycle** (`active | saved | deleted`): Save archives (summary/roster/prompts/messages) to `.opencomms/archives/<id>.json` and purges live state; Resume creates a NEW linked session (empty members = validator-allowed only for resumed channels; joiners get COMPACT context, never the transcript); Delete is destructive (confirm-gated). Description: set-once ≤140 chars via `send.session_description`.
- **Budgets** per channel (`budgets.max_runtime_ms`, `budgets.max_delivered_messages`): enforced at send; `delivered_total` counts handovers incl. retries. `rate_limit`/`max_hops` configurable at create.
- New engine surface: `commitDelivery`, `sweepInFlight`, `pendingRecipients`, `effectiveEndpointCapabilities`, `buildSessionArchive`, `commitSessionSave`, `resumeSession`, `deleteSession` (`src/core/engine.ts`); controllers: `src/hosts/opencode/delivery.ts`, `src/hosts/spawn-delivery.ts`; archives: `src/core/archive.ts`.

## 5. Most Common Tasks

| Task | Where to edit | Key function |
|------|---------------|--------------|
| Add/modify tool | `src/plugin.ts` `tools` object, then `src/core/engine.ts` for logic | `tool()` definition + engine function |
| Change validation (limits, roles) | `src/core/engine.ts` `createChannel` / `src/core/types.ts` | `normalizeRole`, constants `DEFAULT_*` |
| Change delivery timing | `src/core/engine.ts` `drainQueue`, `src/plugin.ts` `deliverPending` | `delivery_cooldown_ms` |
| Change timer behavior | `src/core/engine.ts` `timerAction`, `timerElapsed`, `timerLimitReached` | `ChannelTimer`, `TimerInput` |
| Change persistence | `src/core/store.ts` `save()`, `src/core/types.ts` | `STATE_DIR`, `STATE_FILE` |
| Add message type | `src/core/types.ts` `MessageType` + `src/plugin.ts` schema | `MessageType` union |
| Modify role prompt injection | `src/plugin.ts` `buildRolePrompt` + system.transform hook | `experimental.chat.system.transform` |

## 6. Build / Test (no guessing)

```bash
npm run build        # tsc -p tsconfig.build.json -> dist/ (+ esbuild plugin bundle)
npm run typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run format:check # prettier --check (the chosen format gate; see note)
npm run test         # build:test + node --test dist-test/test/unit/**/*.test.js
npm run test:unit    # same as test
npm run test:contract # adapter-contract/host-neutrality tests
npm run test:all     # unit + live (needs OpenCode running, 5min timeout)
```

Formatter decision: **typecheck-strict + prettier check is the format gate** (prettier pinned as devDependency; `npm run format` rewrites, `npm run format:check` validates). No eslint — typecheck strictness + prettier are the deliberate choice.

Tests in `test/unit/engine.test.ts` (timer + channel/queue tests), `store.test.ts`, and `test/live/live.test.ts` (guarded live flow).

## 7. Token-Saving Rules for AI Coders

1. **Don't re-read source** â€” use `docs/API_REFERENCE.md` for signatures; it has `file:line` for every export.
2. **Don't grep for types** â€” `docs/ARCHITECTURE.md` has the full type table and State diagram.
3. **Don't guess tool args** â€” `docs/TOOLS_AND_COMMANDS.md` has exact schemas for all 12 tools.
4. **For small changes, edit one file only** â€” engine is pure logic, plugin is glue, store is I/O. Don't cross concerns.
5. **After editing, run `npm run typecheck`** â€” strict mode, `noUncheckedIndexedAccess`.

## 8. Gotchas

- Channels hold **N members** (`Channel.max_members`, default 8, clamped to >= 2 at creation). On a two-member channel `sendMessage` targets the lone peer; with 3+ members a send **fails** unless you pass `to=<session_id|role>` or `broadcast=true` â€” targeting is never guessed.
- Claude Code member identity uses **per-member pin files** (`.opencomms/pins/<member_id>.json`, id pattern `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`); the legacy single `member-pin.json` is read-only fallback. A blind second `install-member` run REFUSES (pass `--id`); SessionStart binds only when exactly one pinned claude-code member is unbound (ambiguity = no bind + guidance).
- Roles are an **open vocabulary** (structural check: letter first, 1-32 chars of letters/digits/space/-/_), unique per channel, spelling preserved verbatim; all role lookups compare case-insensitively.
- Every load->mutate->save runs under `StateStore.withLock` (exclusive-create `.state.lock`, stale-broken after 15s). Bare reads stay lock-free because writes are atomic renames. Never call anything that takes the lock while already inside it â€” deadlocks until timeout.
- Message types are whitelisted: senders may send only `review_request|review_response|manual`; `"system"` is reserved for internal notices (e.g. kick notifications).
- Delivered peer content is wrapped in `<<<UNTRUSTED_PEER_MESSAGE>>>` markers with provenance (`formatUntrustedMessage`) before entering another session's prompt â€” keep that framing intact.
- `seen_content` dedup keys are `${sender_session_id}:${hash}` â€” identical content from *different* senders is legitimate.
- Reads are member-scoped: `history` requires membership (`HistoryInput.session_id`); transcripts never leak to outsiders. Root-session checks on Create/Join now **fail closed** on SDK lookup errors.
- Retention: `MAX_PERSISTED_MESSAGES = 2000`; `pruneMessages` keeps newest and cleans queues/`delivered_to`. History scans are bounded by the cap instead of a separate index (deliberate tradeoff).
- Kick: Builder-only removal of another member via `kickChannel` / `/OpenComms Kick Channel=.. Target=<id|role>`. Kicking severs only the channel link; the session lives on. Single-member channels survive kicks and accept rejoin.
- Channel names must match `^[a-z0-9][a-z0-9-_]*$` after lowercasing (blocks `__proto__` key games); lookups use `normalizeChannelName`.
- Timer keys members by **session id** (`timer.elapsed_ms[sessionId]`, `active_member_id`); it auto-switches on `sendMessage`, folds/stops on `markStale`/kick/disconnect if the departing member held the clock.
- Corrupt/tampered `state.json` never bricks the plugin: schema_version + shape validated (`validateState`), wrong version or forged member rows -> `emptyState()` + recorded error; legacy files get timer/max_members backfilled.
- Slash args use `extractSlashArgs`: only recognized keys (`Channel/As/Target/To/Broadcast/Action/LimitMs/LimitRole/RolePrompt`) are consumed; unknown `x=y` stays in free-form prompt text. Subcommand matching ignores `_`/`-` and case (`UpdateRole` == `updaterole`).

---
*For deeper detail, see `docs/README.md` navigation hub.*
