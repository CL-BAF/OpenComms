# OpenCode Adapter

OpenCode is the REFERENCE implementation — the adapter the host-neutral
core was extracted from, and the only host with full PUSH delivery.

## Topology & autonomy (verified 2026-09-08, OpenCode 1.18.25)

These are not assumptions — every claim below was reproduced against real
OpenCode servers in a lab (headless `opencode serve` instances, real local
model turns through the documented HTTP APIs), and matches the official
server documentation ("When you run `opencode` it starts a TUI and a server…
If you have the opencode TUI running, `opencode serve` will start a NEW
server"):

| Fact | Evidence |
|---|---|
| Each TUI / `serve` runs its OWN server with its own event bus | official docs + lab: two `serve` processes on one project, two independent `/event` streams |
| Session DATA is shared across servers (global storage/DB) | lab: server A `GET /session/B` → RESOLVED for a session created on server B |
| Runtime status is per-server (`/session/status` = 0 cross-server) | lab: `session.status` returned an empty map on the foreign server |
| `session.idle` / `session.status` fire ONLY on the server executing the turn | lab: SSE recordings of both buses during a delivery |
| `client.session.prompt(B)` from server A executes B's turn ON SERVER A | lab (pre-fix): B's turn events appeared on A's bus, nothing on B's; B's transcript updated only via shared storage |

### Supported topology matrix

| Topology | Autonomous loop | Mechanism |
|---|---|---|
| Desktop ↔ Desktop (one server, N sessions) | WORKS | idle event → owner-side prompt (single instance owns everything) |
| Headless `opencode serve` ↔ same server | WORKS | same as Desktop; verified end-to-end with real model turns |
| CLI TUI ↔ CLI TUI (two servers) | WORKS (since the owner-side fix) | fs-watch wake → the recipient's OWN instance prompts via its OWN server; verified: recipient's turn events fired on the recipient's bus, zero on the sender's |
| CLI TUI ↔ CLI TUI (both attach to one shared `opencode serve`) | WORKS | identical to Desktop topology; recommended for 3+ agent channels |
| 3+ agents, mixed CLI/Desktop/headless | WORKS | same channel, per-member owner-side delivery; targeting never guessed (`to=`/`broadcast`) |
| Recipient TUI closed everywhere | DEGRADED (honest) | 5s fallback cross-prompts PUSH members → message lands in shared storage, visible when a TUI reopens; never silently dropped before the stale window |

**Why CLI↔CLI failed before the fix:** the sender's plugin prompted the
recipient cross-server; the turn ran on the WRONG server; the recipient's
terminal rendered nothing and no idle event fired on its own bus — so the
conversation stopped after one hop unless the user manually woke the peer.
That matches the reported "works on Desktop, breaks between CLI sessions".

### The autonomous loop (what "no manual wake" means)

1. A calls `opencomms_send` (a tool call inside A's own turn).
2. A's plugin queues one envelope per recipient (locked, atomic).
3. If the recipient is local → prompt immediately; else the recipient's own
   instance is woken by the state fs-watch (≤ ~1s) and prompts locally.
4. The recipient's model receives the message framed as
   `<<<UNTRUSTED_PEER_MESSAGE>>>` DATA with provenance, processes it, and
   may call `opencomms_send` itself — which wakes the original sender the
   same way. Loop protection (dedup, rate limit, hop cap, pause) applies at
   every hop.

Measured in the lab (local qwen3:0.6b, single server): A→B auto-receipt
5/5 attempts (+0.08s–2s), B→A auto-receipt (+10.9s), full turn execution
with no manual prompting. Cross-server (two `serve` processes): recipient
turn executed on the recipient's own server, `delivered, attempts=1`.

Honest limitation: the DELIVERY mechanism is model-independent (verified
with a 0.6B local model), but whether the peer REPLIES with
`opencomms_send` depends on the model following its role prompt — a 0.6B
model often does not. Use a tool-capable model for autonomous loops.

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
`host: "opencode"`, `host_session_id: <session id>`, `surface: "cli"`
(default), `delivery_mode: "push"`,
`stale_policy: { mode: "window", window_ms: 5min }` — PUSH behavior is
byte-identical to v1. Rows created before the host stamp carry
`host: "generic"`; they are treated as opencode PUSH members by the
delivery logic. `status` reports host/surface/delivery per member so
cross-host channels are legible.

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