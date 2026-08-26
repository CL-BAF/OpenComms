# Prompt — Continue Working on OpenComms (TypeScript)

Copy-paste this into your AI coder. Replace `{{TASK}}` with what you want built.

---

You are working on **OpenComms** — a project-local TypeScript OpenCode plugin (ESM, `opencode >=1.18.0`) that links two existing root OpenCode sessions (Builder <-> Reviewer) without creating sessions. 4 source files, ~1059 LOC.

**TASK:** {{DESCRIBE YOUR TASK HERE — e.g. "Add message expiry param to opencomms_send" / "Fix drainQueue cooldown starvation" / "Add ChannelSummary field"}}

### 1. Read first (do not re-read src blindly)

1. `AGENTS.md:1` — 30s mental model, invariants, file map, gotchas (108 lines)
2. `docs/README.md:1` — routing table to the right doc
3. Only then `docs/ARCHITECTURE.md` (data flow/lifecycle) OR `docs/API_REFERENCE.md` (exact signatures with `file:line`) OR `docs/TOOLS_AND_COMMANDS.md` (10 tools + `/OpenComms` slash) — whichever `AGENTS.md` routes you to.

**Token rule:** Use `docs/API_REFERENCE.md` for signatures — don't grep `src/*.ts` or re-read files you already have via docs.

### 2. Project constraints

- ESM only (`"type":"module"`), `target ES2022`, `module NodeNext`, `strict: true`, `noUncheckedIndexedAccess: true` (`tsconfig.json:1`)
- State persisted at `<project>/.opencode-comms/state.json` (`src/types.ts:9`, `src/store.ts:28`) — atomic tmp+rename, corrupt recovery returns `emptyState()` (`store.ts:52`)
- Never create/delete OpenCode sessions (`src/plugin.ts:14`). Only link existing ones via `ctx.sessionID`.
- Channel name normalized `trim().toLowerCase()` (`src/engine.ts:39`), max 64 chars. Roles only `Builder|Reviewer` (`src/types.ts:13`), case-insensitive via `normalizeRole` (`engine.ts:43`).
- One session = one role per channel; one role = one session per channel (`engine.ts:163-181`). Project + worktree must match (`engine.ts:151-161`).
- Messages queued via `sendMessage` (`engine.ts:268`), delivered **only when recipient idle** via `drainQueue` (`engine.ts:375`) + `deliverPending` (`plugin.ts:271`) on `session.idle` / `session.status→idle` (`plugin.ts:316`). Never auto-forward assistant text.
- `drainQueue` cooldown only blocks **first** msg in batch (`engine.ts:410`). `seen_content` dedup is sha256/32hex within `stale_event_ms=5min` (`engine.ts:50`). `max_hops=4`, `rate_limit=20/min`, `delivery_cooldown_ms=1000` (`engine.ts:34-37`).

### 3. File ownership (edit smallest surface)

| Need | Edit | Keep pure |
|------|------|-----------|
| Types/constants | `src/types.ts:1` | — |
| Persistence | `src/store.ts:1` | I/O only, no logic |
| Channel/message/queue logic | `src/engine.ts:1` | Deterministic, synchronous, mutates `State` in place, returns `ToolResult` (`types.ts:183`) |
| Tools/hooks/slash/delivery | `src/plugin.ts:1` | Glue only: `load()→engine→save() if ok→JSON.stringify(result)` (`plugin.ts:79-268`), `parseArgs`/`stripArgs` (`plugin.ts:48,60`), `experimental.chat.system.transform` (`plugin.ts:307`), `event` (`plugin.ts:316`), `command.execute.before` (`plugin.ts:351`) |

Don't cross concerns.

### 4. Workflow

1. Plan the State/type change first (`src/types.ts:87` `State`, `src/types.ts:60` `Channel`, `src/types.ts:32` `MessageEnvelope`) if needed — bump `SCHEMA_VERSION` (`types.ts:11`) only on breaking shape change.
2. Implement logic in `src/engine.ts` using helpers `ok`/`fail` (`engine.ts:66`), `findChannel`, `memberOf`, `peerOf` (`engine.ts:74-84`), `pushError` (caps 200, `engine.ts:88`).
3. Wire tool in `src/plugin.ts:79` `tools` object + slash subcommand in `plugin.ts:363` switch if needed. Derive `session_id` from `ctx.sessionID`, not args.
4. Verify: `npm run typecheck` (must pass, `strict` + `noUncheckedIndexedAccess`) then `npm run test` (29 tests, <2s). Use `npm run test:all` only if you need live OpenCode (5min timeout).

### 5. Tests

- Unit: `test/unit/engine.test.ts:1` (25 tests) + `test/unit/store.test.ts:1` (3 tests) — use `emptyState()` (`store.ts:17`) + `createPair` helper pattern.
- Add a test for new validation/delivery path before closing.

### 6. Output rules

- Keep edits minimal, preserve existing formatting/comments.
- Don't add new dependencies without asking.
- After finish, summarize: files changed, `file:line` of key edits, `typecheck`/`test` status.

Now execute `{{TASK}}`. Start by stating which docs you read and which file you will edit first.
