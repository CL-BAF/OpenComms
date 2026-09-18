# OpenComms Overhaul — Handoff Log (FINAL)

> Maintained by Lead. Updated after every major milestone per OrganisationalLeader's standing directive.
> This is the FINAL version as of the session close — all specialists kicked, session destroyed per owner directive.
> Repository: https://github.com/CL-BAF/OpenComms · Branch: main · HEAD: 51235d8 → (working tree has M4.6 + native-GUI M4.5 completions uncommitted — commit before the next session)

## Released Tags (origin)
| Tag | What |
|-----|------|
| v1.0.0 | CLI-only (Node SEA, installer wizard) |
| v1.1.0 | CLI + installer wizard (Inno Setup, shortcuts, PATH) |
| v1.1.0-gui | First Tauri shell (spike → verified) |
| v1.2.0-gui | Updater wired, parity checklist, Linux configs |
| v1.2.1-gui-interim | Real console UI bundled in dist-shell (fixes the broken install) |
| v1.3.0-gui-native | Handshake-validated IPC bridge (native, no loopback for the UI) |
| **v1.3.1-gui-native** | **Loopback URL fully removed — fully native UI. CURRENT RELEASE.** |

⚠️ **The release object for v1.3.1-gui-native carries the PRE-bridge NSIS (DB8C551E)** — it needs the bridge-enabled NSIS (741FDFDF, built from `desktop/src-tauri/target/release/bundle/nsis/`) uploaded to replace it. Owner action: edit the release → delete the stale asset → upload the new one.

## Completed Milestones
| Milestone | What shipped |
|-----------|-------------|
| **M0** | Architecture plan, contract v0.3, ADRs 0001–0006, research, all spikes verified |
| **M1** | Orchestrator core (AgentRuntime, multi-host), end-to-end spawn→join proof (Reviewer-reproduced), SEA path independence, one-command Linux install, `opencomms update` |
| **M2** | Supervision (stop/restart w/ identity adoption), task assignment, permissionsDrain, full GUI surfaces, `opencomms agent` CLI, Linux CI green (9-stage smoke) |
| **M3** | Multi-node opt-in: pairing (one-time codes, owner-gated), ed25519 CA + certs, load-bearing revocation (CA + transport), outbound-only WSS, session-authority boundary, audit |
| **M4** | Tauri Desktop GUI v1.2.0 (updater, parity, Linux configs), `opencomms agent` CLI, `serve` alias |
| **M4.5** | NATIVE Tauri GUI (owner re-scope: no webgui, no loopback for the UI) — bundled assets, IPC data layer, handshake-validated stdio JSON-RPC bridge, thin Rust relay, strict CSP, 24-command allowlist, load-bearing revocation. v1.3.1-gui-native; ADR-0006 supersedes ADR-0004 |
| **Workstream L** | Linux install/update overhaul: one-command install (curl|bash), `opencomms update`, SEA cwd-independence, pinned Node builds, installer v2.1, real Linux CI verified |
| **M5 (in flight)** | Audit log (b6c73bb), budgets verification (2ce53a4), bridge hardening (f59cc8c), ARCHITECTURE.md (f1881c5) — Backend complete. Frontend gui-ia.md final pass + native verification + parity DONE. Platform hardening checks DONE |

## Key Decisions (full log: OVERHAUL_PLAN.md §7–§8)
- Local node implicit; remote opt-in with per-machine owner approval; multi-machine never assumed
- AgentRuntime host-adapter-based (opencode first; claude/codex ready)
- Native Tauri GUI (ADR-0006 supersedes ADR-0004) — bundled assets, IPC, no loopback for the UI
- Owner-rooted CA + short-lived certs; outbound-only WSS; token discipline transport-independent
- One-command Linux install; CLI exit-code taxonomy; MCP orchestrator tools behind operator opt-in
- Version 1.2.0 (all resolvers single-sourced in version-constants.ts)

## Architecture Invariants (enforced, Reviewer-gated)
- Thin Rust relay (no policy in Rust); TS-core trust enforcement (single audited model)
- Token discipline transport-independent (human-typed, closure-local, cleared, never logged)
- Node-blind engine; loopback HTTP for CLI/headless only; multi-machine never assumed
- 24-command IPC allowlist, deny-by-default, no wildcards

## Remaining Work (prioritised)
1. **Commit the working tree** — the M4.5 native GUI + M5 completions + MCP tools are uncommitted (243/243 tests green on the working tree). Files: src/cli/main.ts (bridge dispatch), src/gui/server.ts (bridgeDeps), src/gui/ui.ts (M3 Nodes), desktop/** (Tauri config, capabilities, main.rs, README), docs/** (gui-cli-parity.md, tauri-native-gui.md, ADR-0006, research-m3.md), test/unit/core/gui.test.ts
2. **Owner: release-attach** — create the v1.3.1-gui-native release object (releases/new → select tag → title → publish), delete the stale DB8C551E NSIS, upload the bridge-enabled 741FDFDF NSIS + .sha256
3. **Owner: Linux artifacts** — workflow_dispatch on linux-release.yml (Actions page) → attach deb/AppImage
4. **Platform: CI signing** — TAURI_SIGNING_PRIVATE_KEY injection + latest.json generation (the tracked updater-live item; the updater is safely inert until then)
5. **M4.6 MCP**: Reviewer code-gate on 768bd9b (12 orchestrator tools wired into the production registry — 242/242 verified); then the MCP-integration directive ships
6. **Never-stage strays**: owner decision pending — recommend deleting iOS/, RECON_NOTES.md, build-ios-demo.yml, phone/ (unrelated DigitalPass demo work, never committed)

## Never-Stage Watchlist
`iOS/` · `RECON_NOTES.md` · `.github/workflows/build-ios-demo.yml` · `phone/` — unrelated DigitalPass demo work, NEVER staged/pushed. Recommend owner deletion.

## Key Files
- `AGENTS.md` — root AI entry point (token-efficient)
- `OVERHAUL_PLAN.md` — milestones, workstreams, decision log §7–§8
- `docs/handoff.md` — this file (maintained per OrganisationalLeader's directive)
- `docs/tauri-native-gui.md` — native GUI architecture (M4.5 design)
- `docs/mcp-orchestrator-tools.md` — MCP tool-surface design (M4.6)
- `docs/adr/ADR-0006-native-tauri-gui.md` — the native architecture ADR
- `docs/orchestrator-design.md` — orchestrator design (§9c M3, §9b M2, §9 M1)
- `docs/gui-cli-parity.md` — GUI↔CLI parity checklist (shared M4 artifact)
- `docs/gui-ia.md` — GUI information architecture (final, shipped)
- `docs/research/` — evidence reports (batch-1, M1/M2 re-scoped, M3 design-input)