# ADR-0004 — Tauri desktop shell

Status: Proposed (M0) · Owner: Lead · Input: Frontend

## Decision (proposed)
A Tauri v2 app in `desktop/` (repo root) is the shared desktop GUI for Windows + Linux. **Tauri owns no business logic**; it consumes the Orchestrator API. In M0 it wraps the existing loopback HTTP console (Node server started as a Tauri sidecar). The loopback server + embedded HTML console remain the fallback and the CLI/headless UI surface — one API, two shells.

## Consequences
- Contract stability (docs/orchestrator-api.md) matters more than transport; a later ADR may move Tauri to IPC while keeping shapes.
- Frontend owns `desktop/**` + `src/gui/**`; Backend must keep `/api/*` backward-compatible or coordinate through Lead.
- Linux Tauri verification depends on toolchain/CI availability (Platform coordinates).

## Open questions
- Sidecar bundling strategy for the Node coordinator (SEA exe on Windows; binary/script on Linux) — Researcher topic (5) evidence pending.
- Auto-update story — M5.