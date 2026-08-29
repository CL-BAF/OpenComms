# docs â€” Navigation Hub

> Start at `../AGENTS.md` for the 30-second overview. This file routes you to the right detail doc without re-reading source.

## Doc Index

| Doc | Purpose | When to use |
|-----|---------|-------------|
| [`AGENTS.md`](../AGENTS.md) | Root AI entry point, invariants, file map | **Read first** for any task |
| `docs/README.md` | This file â€” navigation | Finding which doc to read |
| `docs/ARCHITECTURE.md` | System design, state diagram, lifecycles, invariants, delivery flow | Before architectural changes or debugging delivery |
| `docs/API_REFERENCE.md` | Every exported function/type/constant with `file:line` + signature | Looking up exact args/returns without opening `src/*` |
| `docs/TOOLS_AND_COMMANDS.md` | 12 tools + `/OpenComms` slash command, schemas, examples | Adding/modifying tools or commands |
| [docs/CAPABILITIES.md](CAPABILITIES.md) | Honest per-surface capability matrix with citations | Before claiming host support |
| [docs/ADAPTERS.md](ADAPTERS.md) | Adapter contract, identity models, shared MCP tools | Writing/changing any adapter |
| [docs/SECURITY.md](SECURITY.md) | Threat model, trust boundaries, residual risks | Security review |
| [docs/PROTOCOL.md](PROTOCOL.md) | Envelope, delivery semantics, MCP wire surface | Changing message/transport behavior |
| [docs/MIGRATION.md](MIGRATION.md) | v1->v2 migration + cutover discipline | Upgrading projects |
| [docs/OPENCODE.md](OPENCODE.md) / [CLAUDE_CODE.md](CLAUDE_CODE.md) / [CLAUDE_DESKTOP.md](CLAUDE_DESKTOP.md) / [CODEX.md](CODEX.md) / [CHATGPT.md](CHATGPT.md) | Per-host adapter guides | Working on a specific host |

## Quick Routing

| I need to... | Read | Then edit |
|--------------|------|-----------|
| Understand the whole system in 2 min | `ARCHITECTURE.md` Â§ Overview + Â§ Data Flow | â€” |
| Find a function's signature | `API_REFERENCE.md` table | `src/core/engine.ts` or `src/core/store.ts` |
| Add a new tool | `TOOLS_AND_COMMANDS.md` + `API_REFERENCE.md` plugin section | `src/plugin.ts` then `src/core/engine.ts` |
| Change persistence / file location | `ARCHITECTURE.md` Â§ State Persistence | `src/core/store.ts`, `src/core/types.ts` |
| Fix delivery / queue bug | `ARCHITECTURE.md` Â§ Delivery Pipeline + Gotchas | `src/core/engine.ts` `drainQueue`, `src/plugin.ts` `deliverPending` |
| Change channel validation | `ARCHITECTURE.md` Â§ Invariants | `src/core/engine.ts` `createChannel`, `src/core/types.ts` |
| Add a message type | `API_REFERENCE.md` Â§ Types â†’ `MessageType` | `src/core/types.ts` `MessageType` + `src/plugin.ts` |

## Source of Truth

All `file:line` refs point to `src/` at `HEAD`. Docs are generated from source â€” if a signature drifts, the source wins. Run `npm run typecheck` after edits.

## Build & Test Recap

```bash
npm run build       # tsc -p tsconfig.build.json
npm run typecheck   # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run test        # unit tests (30 tests, <2s)
npm run test:all    # unit + live (needs OpenCode server, 5min timeout)
```

Test files: `test/unit/engine.test.ts:1` (27 tests), `test/unit/store.test.ts:1` (3 tests), `test/live/live.test.ts:1` (guarded live flow).
