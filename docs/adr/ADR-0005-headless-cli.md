# ADR-0005 — Headless/CLI mode

Status: Proposed (M0) · Owner: Lead · Input: Platform

## Decision (proposed)
The CLI (`src/cli/**`) is the complete headless surface for server Linux: same Orchestrator API verbs as the GUI (`opencomms agent list|create|stop|restart|status`, node/trust commands in M3), a daemon/service mode (systemd unit shape proposed by Platform), and no display requirement. Windows GUI-only features degrade gracefully; nothing desktop-only is required for core operation.

## Consequences
- One contract (docs/orchestrator-api.md), two consumers: Tauri GUI and CLI; both verified per release.
- Platform owns CLI/daemon/Linux packaging; coordinates with Frontend only on shared API shapes.
- Paths follow platform convention (XDG on Linux, current layout on Windows) — details in docs/headless-linux-plan.md.

## Open questions
- Daemon transport to the same loopback server vs a dedicated headless server mode.
- Whether the daemon runs the orchestrator core in-process (proposed: yes, one process).