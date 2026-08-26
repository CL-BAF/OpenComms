# docs/CONTINUATION_PROMPT.md — Short Variant

Use this when you want a minimal paste (saves tokens). For full rules see `../PROMPT.md`.

```
You are continuing TS work on OpenComms (opencomms v1.0.0, ESM, opencode >=1.18.0, 4 files: types.ts/store.ts/engine.ts/plugin.ts).

TASK: {{TASK}}

READ FIRST: AGENTS.md:1 then docs/API_REFERENCE.md for signatures (file:line). Don't re-read src/*.ts blindly. Routing: docs/README.md:15.

CONSTRAINTS: strict+noUncheckedIndexedAccess (tsconfig.json:1), state at .opencode-comms/state.json atomic (store.ts:64), channel normalized lower (engine.ts:39) max64, roles Builder|Reviewer only (types.ts:13, engine.ts:43), one session→one role, one role→one session, project+worktree must match (engine.ts:151), messages only via sendMessage (engine.ts:268) queued→drainQueue on idle (engine.ts:375+plugin.ts:271 via session.idle/status, plugin.ts:316), never auto-forward.

EDIT: smallest file — types.ts for shapes, store.ts for I/O, engine.ts for logic (pure, returns ToolResult types.ts:183), plugin.ts:79 for tools + plugin.ts:363 for /OpenComms slash (parseArgs plugin.ts:48). Session id from ctx.sessionID.

VERIFY: npm run typecheck && npm run test (29 tests). Summarize file:line edits.
```
