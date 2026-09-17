# M4 GUI ↔ Headless-CLI Parity Checklist

Owner: Frontend. Status: SHARED M4 ARTIFACT (Lead-placed; Platform's input
for CLI-parity implementation + Linux verification).
Anchor: `docs/orchestrator-api.md` §8 (CLI mapping, v0.2) + `docs/gui-ia.md`
(surface contract) + `docs/adr/ADR-0005-headless-cli.md`.

Rule: every GUI surface maps to CLI verb(s); where the GUI shows something
headless cannot, or headless does something the GUI delegates, that asymmetry
is listed HONESTLY — nothing is "planned later" without a named lane.

## 1. Surface-by-surface mapping

### Overview (Lead home)
| GUI capability | CLI equivalent | Parity |
|---|---|---|
| Lead card (designated:"lead" from agents list) | `opencomms agent list --json \| filter designated` | FULL |
| Team strip + statuses | `opencomms agent list` | FULL |
| Owner inbox (pending node requests) | `opencomms trust view` (pending_requests) | FULL |
| Quick actions (New session / Create agent) | `opencomms session` (existing), `opencomms agent create` | FULL |

### Sessions
| GUI capability | CLI equivalent | Parity |
|---|---|---|
| Live + saved lists | `opencomms status` / `opencomms session list|get` | FULL |
| Session detail (members, budgets, lifecycle) | `opencomms members <channel>` / `opencomms session get` | FULL |
| Create session | `opencomms session create`-equivalent operator flow (engine fns exist) | PARTIAL — no CLI create verb yet; GUI + API cover it (Platform M4/M5 to confirm) |
| Save / Resume / Delete | `opencomms session save|resume|delete` | FULL |
| Join-command per host | `opencomms join-command --host` | FULL |
| Remove agent | `opencomms members remove` (API route; CLI verb if Platform adds) | PARTIAL — API exists, verb pending |

### Team
| GUI capability | CLI equivalent | Parity |
|---|---|---|
| Roster + status pills | `opencomms agent list` | FULL |
| Create agent (required model picker) | `opencomms agent create` (pre-validates; 409→exit 3) | FULL |
| Stop (Lead-protected) / Restart (identity adopt) | `opencomms agent stop|restart` | FULL |
| Agent detail (redacted spawn cmd) | `opencomms agent status` (redacted by value) | FULL |

### Tasks
| GUI capability | CLI equivalent | Parity |
|---|---|---|
| Task list (queued/delivered/acked) | `opencomms agent status` / `GET /tasks` via `--json` | PARTIAL — dedicated `opencomms task list` verb not yet in Platform's set; API exists |
| Assign dialog (agent picker/title/body/channel) | `opencomms agent` assign verb pending | PARTIAL — same |

### Nodes
| GUI capability | CLI equivalent | Parity |
|---|---|---|
| Local/remote/pending cards + capabilities | `opencomms nodes` (M3 set; Platform) | FULL (per ADR-0005) |
| Approve/revoke with token | `opencomms trust approve|revoke --confirm-token` (§8 exit 4=trust_denied) | FULL |
| Pairing context display | CLI shows same fields in --json | FULL |

### Activity
| GUI capability | CLI equivalent | Parity |
|---|---|---|
| Unified feed (kind orchestration/channel_notice) | `GET /events?since=` via API/`--json` | PARTIAL — no dedicated verb; API cursor pagination exists |

### Settings
| GUI capability | CLI equivalent | Parity |
|---|---|---|
| Workspace/project switch | `--project <dir>` global flag (documented default cwd = TARGET) | FULL |
| Security boundary + token DISPLAY location | Token surfaced by CLI/settings surface only (contract §6) | FULL — GUI never displays the token; CLI/settings is where the human reads it |
| Integrations/Diagnostics tabs | `opencomms doctor` | FULL |
| Updater | `opencomms update` (verify-then-extract, rollback) | FULL |

## 2. Honest asymmetries (by design, not gaps)

1. **Trust token display** is a human-in-the-loop surface (Settings/CLI only);
   the GUI never renders it (contract §6). Headless is actually STRONGER here
   (the CLI is where the human gets the token).
2. **Status pills are event-driven in the GUI** (SSE). Headless has no
   persistent stream; `agent status` snapshots + `--json` re-poll is the
   headless equivalent. Same data, different refresh model.
3. **Windows GUI-only niceties** (native folder browse via the shell) degrade
   to typed paths headlessly — ADR-0005 graceful degradation holds.
4. **Daemon/enroll** (`node daemon enroll|run|status`) is CLI-only (server
   Linux concern); the GUI consumes its state but never runs it.

## 3. Verbs the checklist proposes Platform add (M4/M5, each tiny)

- `opencomms task list` (wraps GET /tasks; the only surface without a verb)
- `opencomms members remove` (wraps the existing API route)
- Optional: `opencomms session create` as an explicit verb (currently
  GUI/API-only operator flow)

## 4. Verification protocol (per Platform's gates)

Each mapping row above gets: run the verb against a live `opencomms gui
--server` instance, compare fields to the GUI's render source (same endpoint),
and record PASS/FAIL + any drift in the M4 exit report. --json parity is
byte-shape equality with the API envelope.