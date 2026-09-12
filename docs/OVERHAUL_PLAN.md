# OpenComms Distributed Orchestration Overhaul — Master Plan

Owner: Lead (ses_f712b9a4cffebyiTDO0O8F0rWi). Channel: `opencommupdate`.
Status: living document. Changes require Lead approval; material changes logged in the Decision Log.

## 1. Mission

Evolve OpenComms from a session-linking messaging layer into a **distributed AI-orchestration platform**:

- The owner manually starts **only** a built-in Lead.
- That Lead creates, supervises, and manages other AI agents **locally** and — only after explicit per-machine approval — on remote machines (nodes).
- Multi-machine operation is **optional and never assumed**; all features must work single-machine.
- Delivery: a **shared Tauri desktop GUI** (Windows + Linux) and a **complete CLI/headless mode** (server Linux, no display).
- Existing manual workflows (manual session create/join, push/pull delivery, slash commands) **remain supported**.

Out of scope: anything WebSalesAI.

## 2. Current-State Grounding (2026-09-11, verified)

- Package `opencomms` v1.1.0; core = `src/core/{types,store,engine}.ts` (schema v2, atomic writes, lock discipline), OpenCode glue = `src/plugin.ts`, MCP server = `src/mcp/`, CLI = `src/cli/main.ts`.
- GUI today = **loopback HTTP server** (`src/gui/server.ts`, routes under `/api/*`) + **embedded static HTML/JS** (`src/gui/ui.ts`). No Tauri app, no `src-tauri/`, no desktop shell — Frontend must scaffold it.
- Multi-host support: OpenCode (push/pull), Claude Code + Codex (spawn-push via documented CLI resume, `src/hosts/spawn-delivery.ts`), Claude Desktop/ChatGPT (pull-only).
- Spawn machinery exists for **delivery to already-running sessions**; it is NOT agent lifecycle management (no create/start/stop/status/supervision).
- Hosts available on this dev machine: `opencode` only (claude/codex not installed). First spawn spike therefore targets OpenCode (`opencode run` / serve-based spawn), with Claude Code/Codex following the same `AgentRuntime` interface.

## 3. Target Architecture (baseline; ADRs refine)

```
Owner → GUI (Tauri desktop | loopback console | CLI/headless)
          │ (single Orchestrator API, see docs/orchestrator-api.md)
          ▼
      Orchestrator core (new, src/orchestrator/)
          │  Lead agent (built-in, runs as an agent runtime instance)
          ├── AgentRuntime abstraction (per-host adapters: opencode, claude-code, codex, …)
          ├── NodeRegistry (local node always present; remote nodes explicit opt-in)
          ├── Trust/permission gate (owner-approved machine list, per-node grants)
          └── State: .opencomms/ (orchestrator state beside channel state)
```

- **Local node** is implicit and always available; remote nodes are additive and require explicit owner approval per machine (trust gate).
- Lead is a special AgentRuntime instance with the built-in Lead role; it coordinates other agents, assigns tasks, verifies via Reviewer.
- The existing channel/messaging engine remains the transport; orchestration builds on top, not beside.

## 4. Milestones

- **M0 — Ground truth & spikes** (now): repo surveys, API contract v0, Tauri scaffold spike, same-machine spawn spike (OpenCode), Linux headless gap analysis, research batch-1, ADR stubs.
- **M1 — Same-machine agent spawn (vertical slice)**: `AgentRuntime` (opencode first) + orchestrator state + Lead "create agent" tool + spawn/stop/status + GUI "Team" view showing real spawned agents. Exit: owner creates a worker agent from the GUI/CLI and it joins a channel as a member. Needs Reviewer verification.
- **M2 — Supervision & tasking**: lifecycle (stop/restart/status), task assignment via channels, structured progress, stale/crash detection + restart policy.
- **M3 — Multi-node opt-in**: NodeRegistry, remote agent spawn behind explicit approval + pairing flow; every remote action gated; multi-machine never assumed.
- **M4 — Tauri GUI parity + headless CLI**: full parity across GUI surfaces (Sessions/Team/Nodes/Activity/Settings), CLI command parity, headless daemon mode for server Linux.
- **M5 — Hardening**: budgets, audit log, permissions UI, docs, release installers for Win+Linux.

### Workstream L — Linux install/update overhaul (INSERTED, high priority; owner: Platform + Backend)

Owner directive (2026-09-12): fix and overhaul the Linux installation and update experience. Triggers from Debian 13 field testing:
- SEA binary resolves its own resources via `process.cwd()` because the CLI bundle is CJS and `import.meta` is unavailable (`repoRootForCli()` fallback) — `opencomms version` from `/tmp` resolves `<cwd>/opencomms` and ENOENTs. Broken standalone behavior.
- `opencomms install opencode` reaches for source-tree `install.mjs` — standalone exe must not depend on the repo.
- Installer can install incomplete/failed build artifacts (only smoke-checks after copying).
- No prebuilt Linux release artifact, no pinned build Node, no `opencomms update`, no one-command install.

Requirements (binding, full text in owner directive): one-command install (`curl … install.sh | bash`), `opencomms update` (+ `--check`), atomic replace w/ rollback, verify-then-install, prebuilt x86_64 (+arm64 if clean) artifacts, supported-Node enforcement with clear early failure, five-location separation (executable / packaged resources / source repo / target project / cwd), host-installer audit for source-tree dependence, CJS-vs-ESM SEA decision with documented rationale, cwd-independence regression tests exercising the real binary from /tmp, /, $HOME, project dirs, README NORMAL-vs-DEVELOPMENT split, installer/update security review. Windows + all provider functionality must not regress; full suite must pass.

Work split: **Platform** owns install.sh redesign, release pipeline (pinned Node, artifacts, checksums), `opencomms update`, README, Linux regression tests. **Backend** owns the SEA/runtime path-architecture fix (executable-vs-cwd vs packaged resources, import.meta/CJS resolution, host installer de-repo-ing) as it touches src/cli/**, src/adapters/**, scripts/bundle.mjs — Backend owns src/** logic; Platform owns scripts/install.sh + release + packaging. Cross-cutting coordination through Lead. Reviewer gates: full security review of installer/update code + cwd-independence test verification + Windows regression proof. M1 orchestrator work continues in parallel (Backend: orchestrator first, then SEA fix; Platform: this overhaul is now their primary).

## 5. Workstream Ownership (non-overlapping)

| Area | Owner | Files (initial) |
|------|-------|-----------------|
| Orchestrator core, AgentRuntime, node model, spawn/lifecycle, trust gate | **Backend** | `src/orchestrator/**`, `src/hosts/**`, `src/core/engine.ts` (coordinated changes only) |
| Tauri desktop GUI (Win/Linux), console UI, settings/surfaces | **Frontend** | `desktop/**` (Tauri app), `src/gui/**` |
| Headless CLI/daemon, Linux packaging, systemd, cross-platform verification | **Platform** | `src/cli/**`, `scripts/**` (Linux), `installer/**` (Linux), `docs/WINDOWS_RELEASE.md` untouched except coordinated |
| Research: evidence reports w/ URLs on high-risk architecture topics | **Researcher** | `docs/research/**` only |
| Architecture, plan, ADRs, API contract, cross-cutting integration | **Lead** | `docs/**`, `src/plugin.ts` (glue), merges/reviews |
| Independent QA/security gate | **Reviewer** | no write ownership; reviews diffs, runs tests, reports findings |

Lead assigns, Reviewer verifies milestone exits. Cross-cutting changes are integrated by Lead to avoid merge conflicts.

Roster (channel `opencommupdate`): Lead ses_f712b9a4cffebyiTDO0O8F0rWi · Backend ses_f712a522affeHeW1uGteRbQEws · Frontend ses_f712a30b2ffebN2PqNx4nvzRvY · Platform ses_f712a151cffewzD4P4V4aryHlb · Reviewer ses_f7129af6affedXE83x4HrLvqoM · Researcher ses_f7129973bffeWivFk3Zs9Qe1oj.

## 6. Working Rules

1. Non-overlapping file ownership; cross-cutting edits go through Lead.
2. Milestone exits require **Reviewer verification** before being reported done.
3. All agents report progress to Lead on `opencommupdate`; Lead reports to owner.
4. Spikes are disposable code — no polish, must be clearly marked spike branches/paths.
5. Multi-machine: never assume; remote = explicit approval flow only.
6. Manual workflows stay working: after each milestone, verify manual create/join/send still works.

## 7. Decision Log

- 2026-09-11 (Lead): Orchestration state lives in `.opencomms/` beside channel state (single project-local data dir).
- 2026-09-11 (Lead): AgentRuntime is host-adapter-based; OpenCode is the first runtime target (only host installed on dev machine).
- 2026-09-11 (Lead): Tauri app owns no business logic; it consumes the Orchestrator API (contract v0 in docs/orchestrator-api.md). The loopback HTTP server remains for CLI/headless + console, and Tauri wraps it in M0 spike.
- 2026-09-11 (Lead): Remote nodes = explicit pairing + per-machine owner approval; never auto-discovered, never assumed.

## 8. Research-anchored Decisions (from Researcher batch-1, evidence-with-URLs in docs/research/)

- 2026-09-11 (Lead, ADR-0002): For OpenCode orchestration, spawn = `opencode serve` (headless HTTP, OpenAPI spec, basic-auth via env, SSE) + HTTP API — NOT TUI prompt injection. Existing spawn-push resume remains for already-running TUI sessions. (Evidence: opencode.ai/docs/server)
- 2026-09-11 (Lead, ADR-0002): AgentRuntime interface ops: create(quiet, role prompt) / resume(sessionRef, prompt) / abort / status / permissions-drain / output-stream — validated against opencode serve, claude -p/-r/--bg, codex exec/resume evidence. (Researcher §7)
- 2026-09-11 (Lead, ADR-0001): Node transport v1 = outbound-only WSS node→coordinator (Buildkite model); no mesh VPN dependency; bearer token over wss only (Codex --remote token rule as security floor); framing identical local vs remote. M3.
- 2026-09-11 (Lead, ADR-0003): Node pairing = short-lived credentials + auto-rotation (SPIFFE pattern) over either Noise-XX-pinned-keys or owner-rooted mTLS — exact mechanism decided at M3 planning; pairing-code UX (Tailscale/codex style) is the model. Private keys never leave the node.
- 2026-09-11 (Lead, ADR-0003): Secrets tiering: OS keyring first (DPAPI user-scope Win / libsecret Linux), encrypted-file fallback for headless (keyring absent), never plaintext; DPAPI non-interactive path only (prompt flow removed Feb 2027). (Researcher §6)
- 2026-09-11 (Lead, ADR-0005): Node daemon = outbound registration + heartbeat + job pull + output streaming (Buildkite-shaped); systemd Type=notify + watchdog on Linux; supervisor/worker split (daemon owns registration, agent workers resumable/killable); ephemeral/JIT node mode is a designed trust-tier option from M3. (Researcher §4)
- 2026-09-11 (Lead, ADR-0002): One git worktree per spawned agent (never share a checkout); stop preserves worktree, cleanup only after unpushed-commit check; `git worktree list --porcelain -z` for parsing. (Researcher §8)
- 2026-09-11 (Lead, ADR-0004): Tauri ships the Node coordinator as sidecar (per-triple externalBin, capability-scoped spawn); updater = static JSON + Ed25519-signed artifacts in CI, passive install on Windows; signing key custody = CI secret, never a dev-machine file. (Researcher §5)
- 2026-09-11 (Lead, contract v0.1): Trust/approve endpoints are unauthenticated-hostile on loopback (Reviewer flag accepted); owner-action mechanism required before M3; agent-facing tools must not reach approve/revoke.
- 2026-09-11 (Lead, ADR-0005): Linux packaging split approved — tarball (exe + systemd user unit + README + sha256) at M0/M1, `.deb` at M5 via dpkg-deb (no auto-enable of services, postinst prints instructions only). Per docs/headless-linux-plan.md §4.
- 2026-09-11 (Lead, ADR-0005): Headless daemon = `opencomms gui --server --no-open` is canonical; `opencomms serve` added in M4 as a thin alias (stable name for systemd units), NOT a separate binary/code path.
- 2026-09-11 (Lead, contract v0.1): CLI consumes the Orchestrator API over loopback HTTP only — `src/cli/**` never imports `src/orchestrator/**` directly (single protocol surface; keeps file ownership clean).
- 2026-09-11 (Lead, contract v0.2): CLI exit-code taxonomy adopted: 0 ok · 1 generic (conn-refused hints "is opencomms gui running?") · 2 CLI validation · 3 conflict 409 · 4 trust_denied 403 · 5 unknown 404 · 6 internal 500. Additive to existing 0/1. Authoritative mapping lives in the contract addendum.
- 2026-09-11 (Lead, ADR-0002, answers to Researcher open questions): (a) M1 spike uses ONE `opencode serve` instance with MULTIPLE sessions (shared server, per-agent session ids) — cheapest and matches the SDK model; per-agent isolation is revisited only if supervision/kill evidence demands it. (b) Orchestrator-chosen deterministic agent keys are adopted where the host supports them (Claude `--session-id`); opencode/codex session ids captured at create and persisted in the agent record — canonical key = OpenComms `agt_*` id, host session id is a tracked attribute, never the primary key. (c) Tauri sidecar spike = Frontend (already tasked).
- 2026-09-11 (Lead, M0 close-out, Backend sign-off): Backend M0 deliverables ACCEPTED — docs/orchestrator-design.md + spike PASS (3x reproduced). Managed-vs-user session question DECIDED: `agt_*` primary key + `managed` marker lives in orchestrator state ONLY; engine untouched (join keys on `ctx.sessionID` = captured host_session_id, spike-proven). Model pinning is now policy: orchestrator always pins a pre-verified model at spawn, never server defaults (spike: default model hard-failed, another hung silently); turn-waits are timeout-based. Status is event-driven (SSE), never GET /session/status (returns {} mid-turn). Engine §8 items routed to Lead integration: (1) operator-created channels keep sentinel project ids — VERIFIED engine already handles this correctly (joinChannel sentinel-join logic at src/core/engine.ts:595-618 means spawned agents join operator-created channels with zero engine change; worktree stays strict); (2) stale_policy window for serve-restart gaps = generous M1 window per member at join (decision at M1 implementation); (3) timer keying works unchanged.
- 2026-09-11 (Lead, M0 close-out): Windows shim caveat generalized — orchestrator resolves the NATIVE opencode.exe (not npm .cmd/.ps1 shim) before spawn, with override env (same pattern as OPENCOMMS_CLAUDE_BIN/OPENCOMMS_CODEX_BIN). Recorded as M1 implementation requirement.
- 2026-09-11 (Lead, M1, FINAL — resolves my earlier contradictory routing, per Reviewer): Agent worktree default = `<project>/.opencomms/agents/<agt_id>/worktree` (Option A). Project-local scratch inside the existing state dir; `.opencomms/` is already gitignored wholesale so no new ignore entry; Platform smoke tests assert state.json content byte-identical (agents/ scratch allowed to appear) — already true in both tests; design §2 text + Platform note already match this choice. No root-level `.opencomms-agents/` dir.
- 2026-09-12 (Lead, M1/L, commit process): Hunk-level coordination on shared files requires an EXPLICIT handoff snapshot (working-tree state declared + acknowledged before the next owner touches the file). The gate-2 tree-collision ate Platform's update-wiring hunks + install.sh v2.1 + build-exe preflight + tarball builder + test scripts mid-landing; recovered from git dangling objects with disclosure-first incident handling (Platform). Recovery verified; Reviewer re-verifies 2591921. Rule adopted for all future shared-file sequencing.
- 2026-09-12 (Lead, M1/L): Stray files iOS/ + RECON_NOTES.md (unrelated DigitalPass demo work) are NEVER staged/pushed; owner decision on removal pending.
- 2026-09-12 (Lead, M5 ledger): rename(2)-atomic rollback restore in update.ts (P4, Platform); O_EXCL mkTempIn (P4); script-integrity pinning for release-pinned installer checksums (P3-C); Linux-CI live execution of installer/self-update/test paths (honest-verification ledger).
- 2026-09-12 (Lead, OWNER DIRECTIVE, Tauri GUI release): when the Tauri desktop GUI is complete, commit it to the repo AS A RELEASE and clearly specify it is the TAURI GUI (no longer a web GUI). Requirements: (1) the desktop/ Tauri app ships as a tagged release artifact (Windows first; Linux when toolchain verifies); (2) README + release notes must state the desktop GUI is Tauri-native — "webgui" naming is retired for the desktop app (the loopback HTML console remains the CLI/headless fallback, documented as such); (3) release notes name it explicitly: OpenComms Tauri Desktop GUI; (4) the real Node coordinator sidecar (pinned 22.14.0 build) replaces the stand-in binary in the release artifact; (5) Reviewer verifies the release artifact + naming before the tag pushes. Sequencing: Frontend owns the app + slot-5+ commits; Platform owns release packaging; Lead owns docs/README wording + tag; all gated.