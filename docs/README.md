# docs — Navigation Hub

> Start at `../AGENTS.md` for the 30-second overview. This file routes you to the right detail doc without re-reading source.

## Doc Index

| Doc | Purpose | When to use |
|-----|---------|-------------|
| [`AGENTS.md`](../AGENTS.md) | Root AI entry point, invariants, file map | **Read first** for any task |
| `docs/README.md` | This file — navigation | Finding which doc to read |
| `docs/ARCHITECTURE.md` | System design, state diagram, lifecycles, invariants, delivery flow | Before architectural changes or debugging delivery |
| `docs/API_REFERENCE.md` | Every exported function/type/constant with `file:line` + signature | Looking up exact args/returns without opening `src/*` |
| `docs/TOOLS_AND_COMMANDS.md` | 11 tools + `/OpenComms` slash command, schemas, examples | Adding/modifying tools or commands |

## Quick Routing

| I need to... | Read | Then edit |
|--------------|------|-----------|
| Understand the whole system in 2 min | `ARCHITECTURE.md` § Overview + § Data Flow | — |
| Find a function's signature | `API_REFERENCE.md` table | `src/engine.ts` or `src/store.ts` |
| Add a new tool | `TOOLS_AND_COMMANDS.md` + `API_REFERENCE.md` plugin section | `src/plugin.ts:79` then `src/engine.ts` |
| Change persistence / file location | `ARCHITECTURE.md` § State Persistence | `src/store.ts:28`, `src/types.ts:9` |
| Fix delivery / queue bug | `ARCHITECTURE.md` § Delivery Pipeline + Gotchas | `src/engine.ts:375`, `src/plugin.ts:271` |
| Change channel validation | `ARCHITECTURE.md` § Invariants | `src/engine.ts:91`, `src/types.ts:16` |
| Add a message type | `API_REFERENCE.md` § Types → `MessageType` | `src/types.ts:26` + `src/plugin.ts:135` |

## Source of Truth

All `file:line` refs point to `src/` at `HEAD`. Docs are generated from source — if a signature drifts, the source wins. Run `npm run typecheck` after edits.

## Build & Test Recap

```bash
npm run build       # tsc -p tsconfig.build.json
npm run typecheck   # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run test        # unit tests (30 tests, <2s)
npm run test:all    # unit + live (needs OpenCode server, 5min timeout)
```

Test files: `test/unit/engine.test.ts:1` (27 tests), `test/unit/store.test.ts:1` (3 tests), `test/live/live.test.ts:1` (guarded live flow).
