# OpenComms Overhaul — Handoff Log

> Maintained by Lead per OrganisationalLeader's standing directive: update after every major milestone.
> Decisions, remaining work, next actions. The living handoff document.

## Current State (as of this handoff)

### Released
- **v1.3.1-gui-native** — the native Tauri Desktop GUI (bundled assets, IPC bridge, no loopback for the UI). Tag pushed; Reviewer-approved. The release object on GitHub carries the PRE-bridge NSIS (DB8C551E) — the bridge-enabled NSIS (741FDFDF, sidecar D96400A2) needs the owner to attach (edit release → delete stale asset → upload from `desktop/src-tauri/target/release/bundle/nsis/`).
- **v1.2.0-gui** — the loopback-shell build (rollback artifact, remains on the releases page).
- **v1.1.0** — the CLI-only Inno Setup installer (legacy, still functional as the CLI/headless installer).

### Milestones complete (M0 → M4.5)
- **M0**: architecture plan (OVERHAUL_PLAN.md), contract v0.3, ADRs 0001–0006, research, all spikes Reviewer-verified
- **M1**: orchestrator core, AgentRuntime, end-to-end spawn→join proof, SEA path independence, one-command Linux install, `opencomms update`
- **M2**: supervision (stop/restart with identity adoption), task assignment, permissionsDrain, full GUI surfaces, `opencomms agent` CLI, Linux CI green (9-stage smoke)
- **M3**: multi-node opt-in — pairing (one-time codes, owner-gated), ed25519 CA + certs, load-bearing revocation (CA + transport layers), outbound-only WSS, audit differentiation
- **M4**: Tauri Desktop GUI v1.2.0, `opencomms agent` CLI, `opencomms serve` alias, GUI/CLI parity checklist
- **M4.5**: NATIVE Tauri GUI (owner re-scope: no webgui, no loopback for the UI) — bundled assets, IPC data layer, handshake-validated stdio JSON-RPC bridge, thin Rust relay, strict CSP, 24-command allowlist. Released as v1.3.1-gui-native; ADR-0006 supersedes ADR-0004.
- **Workstream L**: Linux install/update overhaul — one-command install (curl|bash), `opencomms update`, pinned Node builds, installer v2.1, all verified on real Linux CI
- **M5 Backend items**: audit log (b6c73bb), budgets verification (2ce53a4), bridge hardening (f59cc8c), ARCHITECTURE.md (f1881c5) — all landed

### In Flight
- **M4.6 MCP integration**: Backend's 768bd9b wired the 12 orchestrator tools into the production MCP server registry (--admin gated, principal classes: human-present/operator/member/read). AWAITING Reviewer's code-gate verdict. The MCP-integration directive completes when this ships.
- **M5 exit gate**: Reviewer's final pass (audit + budgets + parity re-verification against the native build). Platform's CI signing + latest.json post-attach.

### Owner Actions Needed
1. **Release-attach**: edit the v1.3.1-gui-native release → delete the stale DB8C551E NSIS → upload the bridge-enabled 741FDFDF NSIS + .sha256 (from `desktop/src-tauri/target/release/bundle/nsis/`).
2. **Linux artifacts**: workflow_dispatch on linux-release.yml (Actions page) → attach the deb/AppImage artifacts.
3. **Never-stage strays**: iOS/, RECON_NOTES.md, build-ios-demo.yml, phone/ — recommend deleting (unrelated DigitalPass demo work, never committed).

### Key Decisions (full log in OVERHAUL_PLAN.md §7–§8)
- Local node implicit; remote opt-in with per-machine owner approval; multi-machine never assumed
- AgentRuntime host-adapter-based (opencode first; claude/codex ready)
- Native Tauri GUI (ADR-0006 supersedes ADR-0004) — bundled assets, IPC, no loopback for the UI
- Owner-rooted CA + short-lived certs; outbound-only WSS; token discipline transport-independent
- One-command Linux install; CLI exit-code taxonomy; MCP orchestrator tools behind operator opt-in

### Architecture Invariants (enforced, Reviewer-gated)
- Thin Rust relay (no policy in Rust); TS-core trust enforcement (single audited model)
- Token discipline transport-independent (human-typed, closure-local, cleared, never logged)
- Node-blind engine; loopback HTTP for CLI/headless only; multi-machine never assumed
- 24-command IPC allowlist, deny-by-default, no wildcards

### Remaining Work (prioritised)
1. Reviewer's M4.6 code gate on 768bd9b (unblocks the MCP integration)
2. Owner's release-attach (2 browser clicks)
3. Platform's CI signing + latest.json
4. M5 exit gate → FINAL owner report
5. M5 hardening completion (audit surface + budgets + docs — most already landed)