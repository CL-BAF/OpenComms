# OpenCode Adapter

OpenCode is the REFERENCE implementation — the adapter the host-neutral
core was extracted from, and the only host with full PUSH delivery.

## What you get (unchanged from 1.x behavior + v2 model)

| Capability | Status | How |
|---|---|---|
| Existing-session linking | SUPPORTED | root sessions only; never creates/owns sessions |
| Push delivery on idle | SUPPORTED | `client.session.prompt` when the peer goes idle |
| Persistent role injection | SUPPORTED | `experimental.chat.system.transform` per membership |
| Lifecycle events | SUPPORTED | session.idle / deleted / status hooks |
| Cross-host channels | SUPPORTED | members from other hosts join the same state |
| Tools + slash command | SUPPORTED | 12 tools + `/OpenComms` (see docs/TOOLS_AND_COMMANDS.md) |

## Install / upgrade

```bash
npm run install:plugin   # or: opencomms install opencode --project <dir>
```

- Copies the bundled plugin to `.opencode/plugins/plugin.js` and registers
  it in `opencode.json` (idempotent; unrelated config preserved).
- Upgrading from 1.x: the first run migrates the legacy
  `.opencode-comms/` state automatically — see MIGRATION.md. Do not run
  the old plugin afterwards.

## v2 member model defaults

OpenCode members register with explicit host metadata:
`host: "opencode"`, `surface: "cli"`, `delivery_mode: "push"`,
`stale_policy: { mode: "window", window_ms: 5min }` — PUSH behavior is
byte-identical to v1. `status` now reports host/surface/delivery per
member so cross-host channels are legible.

## Honest notes

- Role injection relies on the OpenCode plugin API
  (`experimental.chat.system.transform`) — verified current 2026-08-29.
- `opencomms_status` TOOL is member-scoped (a session sees only its own
  channels' rosters); the user-facing `/OpenComms Status` slash command
  keeps the full project view.
- Live end-to-end behavior is covered by a GUARDED live test
  (`test/live/live.test.ts`): it SKIPs without a running OpenCode server —
  skips are never counted as evidence.

## Files & tests

- `src/plugin.ts` (adapter), `src/core/*` (host-neutral core).
- Tests: `test/unit/engine.test.ts`, `store.test.ts`, `plugin.test.ts`
  (wiring), plus core/ suites (migration, staleness, MCP identity).