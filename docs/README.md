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
| [UPGRADE_HANDOFF.md](UPGRADE_HANDOFF.md) | Current build, exact evidence, artifacts and outstanding acceptance gates | Reviewing this upgrade |
| [GUI_ACTION_AUDIT.md](GUI_ACTION_AUDIT.md) | Every visible control, named backend action and verification level | Browser/native parity |
| [TASK_EXECUTION.md](TASK_EXECUTION.md) | Task execution, criteria/evidence/review, migration and evaluation | Assigning and verifying work |
| [INTEGRATION_VERIFICATION.md](INTEGRATION_VERIFICATION.md) / [MCP_PROFILES.md](MCP_PROFILES.md) | Current official host contracts, live prerequisites and manual profiles | Installing/testing integrations |
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

The upgrade started from an archive without Git metadata; repository history was restored for publication. Older generated `file:line` references and historical milestone reports can drift; current source wins. The upgrade handoff identifies the tested local source by a SHA256 inventory. Run `npm run typecheck` after edits.

## Build & Test Recap

```bash
npm run build       # tsc -p tsconfig.build.json
npm run typecheck   # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run test        # fresh source/bundles + complete unit suite
npm run test:all    # unit + guarded linked live + opt-in managed vendor tests
```

Tests span `test/unit/`, `test/contract/` and `test/live/`. Browser and artifact harnesses live in `scripts/`. Exact final counts, skips and blocked checks are in the current handoff; a skipped live test is never interoperability evidence.
