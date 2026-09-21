# INTEGRATIONS_PLAN.md — Automatic Project Bootstrap & Host Integration Installers

Owner: Lead (channel `integration-bootstrap`). Last updated: M4 COMPLETE —
**Reviewer charter-level PASS issued 2026-09-21.** All milestones (M1–M4)
closed: 329/329 unit, 2/2 contract, typecheck/format/build clean.

## Purpose

When the GUI opens a repository, OpenComms must detect whether the project/plugin
integration exists, offer install when missing, offer safe update when outdated,
and offer repair when broken/partial — via a common HostInstaller lifecycle
(detect / install / update / repair / verify) shared by all hosts, with
machine-level host integrations separated from project-level repository
integrations. GUI calls backend integration APIs only; the UI never edits
provider config files directly.

## Current-state survey (done 2026-09-21, verified in source)

- Installers exist per host but with NO common abstraction and NO versioning:
  - `src/cli/install-opencode.ts` — `opencodeInstallReport()` writes
    `.opencode/plugins/plugin.js` + patches `opencode.json(.jsonc)` "plugin" array.
  - `src/adapters/claude-code/install.ts` — `installClaudeCode()` copies hooks +
    MCP bundles, merges `.claude/settings.json` hooks and `.mcp.json` server.
  - `src/adapters/codex/install.ts` — `installCodex()` copies MCP bundle +
    appends `[mcp_servers.opencomms]` to `.codex/config.toml`.
  - `src/adapters/claude-desktop/package.ts` — `.mcpb` bundle packaging (PULL only).
  - `src/adapters/chatgpt/install.ts` — remote MCP scaffold (EXPERIMENTAL, PULL only).
- GUI already has a stub Integrations surface: `GET /api/integrations` in
  `src/gui/server.ts` (status strings only, no lifecycle ops) and
  `integrationsList` bridge stub returning `[]`. UI nav (`src/gui/ui.ts`) has no
  Integrations nav item yet.
- Project state marker: `.opencomms/state.json` (schema v2) — exists iff
  OpenComms state was initialized. Installer artifacts (plugin.js, hooks,
  config patches) exist independently of state.
- Capability honesty is already enforced by existing tests (`codex-install.test.ts`,
  `claude-hooks.test.ts`): never claim FULL for PULL-only hosts.
- Uninstall logic is ad-hoc in `src/cli/main.ts` `runUninstall()` — to be
  superseded by the lifecycle (kept as CLI thin wrapper).

## Architecture decisions

1. **Common abstraction** `HostIntegration` interface (`src/integrations/types.ts`):
   `id`, `name`, `scope: "project" | "machine"`, plus async
   `detect(ctx) -> Detection`, `install(ctx) -> Report`, `update(ctx) -> Report`,
   `repair(ctx) -> Report`, `verify(ctx) -> Report`.
   - `Detection = { status: "absent" | "installed" | "outdated" | "broken", installedVersion?, currentVersion?, details[], issues[] }`
   - `Report = { ok, actions[], warnings[], capabilities, changedFiles[] }` (superset of existing per-host report shapes; adapters map their native reports).
2. **IntegrationManager** (`src/integrations/manager.ts`): registry keyed by host
   id; one entry point for GUI/bridge/CLI; operations run under existing
   `StateStore.withLock` when they touch project state; file writes atomic
   (temp + rename) and idempotent (re-run = no-op or safe patch).
3. **Version marker**: project integration version stamped in
   `.opencomms/integration.json` `{ schema_version: 1, integrations: { <id>:
   { version, installed_at, updated_at, host_meta } } }`. Current version =
   package VERSION. Compatibility = semver-major compare; migrations live in
   each adapter.
4. **Scope split**: machine-level (OpenCode host plugin availability, Claude Code
   CLI presence, Codex CLI presence, GUI app install) is DETECTION-ONLY from the
   GUI; project-level integrations are the install/update/repair surface.
5. **Non-destructive**: install/update/repair never overwrite user config keys
   beyond the documented OpenComms entries; uninstall removes only OpenComms
   entries (existing `runUninstall` semantics, re-expressed via adapters).
6. **GUI**: backend routes `/api/integrations` (list, refresh), `/api/integrations/:id/detect|install|update|repair|verify` (POST). UI adds an
   "Integrations" nav view listing the five hosts with per-host status +
   action buttons + capability warnings surfaced verbatim from reports.
   Bridge `integrationsList` wired to the manager instead of `[]`.
7. **Adapters wrap existing installers**: OpenCode wraps `opencodeInstallReport`,
   Claude Code wraps `installClaudeCode`, Codex wraps `installCodex`,
   Claude Desktop wraps `buildDesktopBundle` (project bundle present check),
   ChatGPT wraps `scaffoldChatGptIntegration` (status "scaffold only", never FULL).

## Milestones

- **M1 (COMPLETE 2026-09-21, suite green 277/277 + contract 2/2 + typecheck/format clean)** — Core abstraction + manager + OpenCode/Claude/Codex
  adapters wrapping existing installers + integration.json version marker +
  unit tests. Landed: manager runGuarded (StateStore.withLock + marker
  rollback on ok:false), adoption flow (P2-4), placeholder detection (P1-1),
  codex orphan-env detection (P2-2 adapter side), parse-before-copy (P2-1),
  foreign plugin.js guard (P3-3), parallel-install test, real-adapter
  corrupt-settings test, string-aware .jsonc stripping (P1-2), structured
  opencodeInstallReport fields (P3-3), single compareVersions (P3-1), CLI
  uninstall fixes (P2-2 codex all-sections, P2-5 claude completeness),
  install.sh node-unit uninstall (P3-5). Reviewer re-review pending.
- **M2 (COMPLETE 2026-09-21, suite green 305/305 + contract 2/2 + typecheck/format/build clean + live doctor smoke pass)** —
  Landed: claude-desktop adapter (wraps buildDesktopBundle; PULL-only honest
  labels; manifest validation via validateDesktopManifest), chatgpt adapter
  (wraps scaffoldChatGptIntegration; EXPERIMENTAL "Platform setup required",
  never installable-to-FULL), registry.ts (createDefaultManager, all five
  hosts), src/cli/doctor.ts (doctorReport + doctorReportWithManager: state,
  per-host detect via manager, machine-level CLI presence, pins, perms probe;
  --fix repairs broken + updates outdated under manager locking; absent never
  implicitly installed; placeholder member env → unfixable with install-member
  guidance, never auto-run; idempotent), CLI dispatch `opencomms doctor
  [--fix]` (async for --fix, sync read-only otherwise), doctorCommand text
  renderer over the shared backend, help text updated. One real bug fixed by
  Builder's own tests (placeholder branch unreachable behind the fixable
  gate). Reviewer review requested.
- **M3 (COMPLETE 2026-09-21 pending final Reviewer PASS; suite 329/329 + contract 2/2 + typecheck/format/build clean + live GUI smoke pass)** —
  Landed: per-host uninstall across all five adapters (files-first/marker-last
  ordering, foreign-plugin guard, idempotent no-op, changedFiles fidelity,
  state/pins survival — IntegrationBuilder, Reviewer PASS), uninstall +
  PLACEHOLDER_ISSUE in types/manager (Lead after Builder reassignment),
  P2-6 stripJsoncComments reuse + P3-7 structured-fields consumption
  (IntegrationBuilder), src/gui/integrations.ts (overview/action-whitelist/
  sync-bridge/bootstrap offer-only), server routes GET /api/integrations +
  GET bootstrap + POST :id/:action (old heuristic stub + sync detectCodex
  removed; bridge integrationsList wired), UI Integrations view + overview
  bootstrap banner (no provider FS logic in ui.ts). Live smoke verified.
- **M4 (COMPLETE 2026-09-21 — Reviewer charter-level PASS)** — Docs accuracy
  (ADAPTERS.md lifecycle + heuristics section; TOOLS_AND_COMMANDS.md CLI
  command table; README product positioning rewrite with claim verification —
  3 mechanical defects found and fixed: duplicate host table, CL-Baf URL
  case-sensitivity 404, install.sh --exe form), integrationsListSync dead
  loop removed (P4-1), final regression sweep independently verified by
  Reviewer (329/329 + contract + typecheck + format + build + CLI-side
  P2-2/P2-5/P3-5). Charter coverage closed: destructive-config risks,
  idempotency, rollback, version detection, migrations, GUI provider-FS
  separation, no duplicated parsers/installers, locking/atomicity, Windows
  paths, capability honesty, scope split, stale-state closure, trust guard,
  injection, privilege, test matrix, regressions.

## Final verification record (2026-09-21)

- Unit: 329/329 pass (was 243 at baseline; +86 tests across integrations
  suites: manager, adapters, uninstall, doctor, gui-integrations).
- Contract: 2/2 pass. Typecheck (strict, noUncheckedIndexedAccess): clean.
- Prettier format:check: clean. Build (tsc + esbuild bundle): green.
- Live smoke: `opencomms doctor` on this repo (per-host statuses correct);
  GUI server GET /api/integrations + bootstrap + POST verify round-trip.
- Reviewer charter-level PASS: R1 (12 findings, all adopted+closed), R2
  (M1/M2 PASS), M3 final gate PASS, M4 sweep PASS, README claims verified.
- **M4** — Full suite (typecheck/format/unit/contract), Reviewer PASS, docs update
  (ADAPTERS.md, TOOLS_AND_COMMANDS.md if any tool surface changes).

## File ownership (avoid collisions)

- Lead: `docs/INTEGRATIONS_PLAN.md`, reviews, integration of final wiring,
  `src/cli/install-opencode.ts`, `src/cli/update.ts`, `src/cli/main.ts`,
  `scripts/install.sh`, `src/gui/server.ts`, `src/gui/ui.ts` (M3).
- Builder: `src/integrations/types.ts`, `src/integrations/manager.ts`,
  `src/integrations/versioning.ts` (integration.json read/write atomic),
  `test/unit/core/integrations-manager.test.ts`.
- IntegrationBuilder: `src/integrations/adapters/opencode.ts`,
  `claude-code.ts`, `codex.ts` (+ `claude-desktop.ts`, `chatgpt.ts` in M2),
  `src/adapters/claude-code/install.ts` (P2-1 parse-before-copy),
  `test/unit/core/integrations-adapters.test.ts`.
- Reviewer: independent review per milestone.

## Verification checklist

- `npm run typecheck`, `npm run format:check`, `npm run test`, `npm run test:contract`.
- New tests must cover: detection (absent/installed/outdated/broken), fresh
  install, update from older marker, repair of partial installs (e.g. plugin.js
  missing but registered, config registered but bundle missing), repeated
  install idempotency, malformed integration.json (falls back to repair path,
  never bricks), preservation of unrelated user config (opencode.json extra keys,
  .claude/settings.json unrelated hooks, .codex/config.toml other sections).
- Capability claims: assert no FULL claims for Claude/Codex PULL-only paths.

## Decisions log

- 2026-09-21: reuse existing installer functions rather than rewrite (decided).
- 2026-09-21: integration.json in `.opencomms/` next to state.json (not
  preferences.json) so it travels with the project and is project-scoped (decided).
- 2026-09-21: GUI project-open detection = detect all five, show non-intrusive
  banner in Integrations view (no modal prompts on open) (decided, M3).
- 2026-09-21 (R1 triage): P1-1 placeholder member env => detect "broken" (option b).
- 2026-09-21 (R1 triage): P1-2 string-aware .jsonc stripping + URL preservation test.
- 2026-09-21 (R1 triage): P2-1 parse-before-copy in claude-code installer; real
  adapter-throw test added to manager suite.
- 2026-09-21 (R1 triage): P2-2 split — adapter detect/repair for env-orphan
  brokenness; CLI uninstall (main.ts) removes all `mcp_servers.opencomms.*`
  sections (M2, Lead-owned).
- 2026-09-21 (R1 triage): P2-3 manager ops under StateStore.withLock; atomic
  user-config writes; parallel manager.install test.
- 2026-09-21 (R1 triage): P2-4 pre-marker adoption: artifacts+no marker =>
  "outdated"; update stamps marker without duplicating config.
- 2026-09-21 (R1 triage): P3-1 single compareVersions in integrations/versioning.ts;
  src/cli/update.ts imports it (Lead wires, M2).
- 2026-09-21 (R1 triage): P3-3 opencodeInstallReport gains structured fields
  (wrotePlugin, configPath, configRegistered, pluginRegistered,
  preExistingForeignPlugin); foreign plugin.js clobber guard in adapter.
- 2026-09-21 (R1 triage): P3-4 M3 replaces GUI stub statuses with adapter
  detect(); detectCodex off the sync HTTP path.
- 2026-09-21 (R1 triage): P3-5 install.sh --uninstall also removes
  opencomms-node.service + disable hint (Lead, M2).
- 2026-09-21 (R1 triage): P3-2 DEFERRED (wizard VBS duplication — pre-existing,
  orthogonal); P3-6 NO ACTION (accepted).
- 2026-09-21 (R1 triage): Manager never writes the integration.json marker when
  adapter Report.ok=false — marker must imply a good install.
- 2026-09-21 (R1 triage): CLI ownership consolidated to Lead: install-opencode.ts,
  update.ts, main.ts, install.sh; IntegrationBuilder owns adapters only.
- 2026-09-21 (verification): writeIntegrationMarkers rename-fallback (direct
  write when rename fails) ACCEPTED and recorded — atomicity loss only on the
  Windows handle-hold path; temp+rename remains the primary path.
- 2026-09-21 (M2, Lead): P2-2 CLI side — runUninstall codex removes ALL
  `[mcp_servers.opencomms*]` sections (parent + env sub-table) via regex scan
  with sub-table skipping; P2-5 — claude-code uninstall now also removes the
  .mcp.json opencomms entry + copied bundles, drops empty hook events, and
  preserves unrelated config byte-for-byte; state.json/pins untouched.
- 2026-09-21 (R2 verdict, M1+M2 PASS): P2-6 ADOPTED for M3 — opencode adapter
  readConfig() must reuse stripJsoncComments (last duplicated parser).
- 2026-09-21 (R2): P3-7 — opencode toReport consumes structured fields; P3-8 —
  foreign-plugin heuristic accepted, documented in M4 ADAPTERS.md; P3-9 —
  cross-process contention delegated to StateStore.withLock per store.test.ts
  convention (recorded here per Reviewer request).
- 2026-09-21 (R2): uninstall lifecycle decision — adapter-uninstall removes the
  id's integration.json marker so detect() reports absent; therefore uninstall
  is a MUTATING op and runs under the manager's runGuarded locking. opencode
  uninstall deletes plugin.js only when content matches /opencomms/i (inverse
  of the P3-3 foreign guard; foreign plugin.js left in place with warning).
  changedFiles[] = exactly what was removed; warnings carry the state.json/pins
  survive caveat with the same wording as CLI runUninstall.
- 2026-09-21 (R2): PLACEHOLDER_ISSUE exported constant from types.ts replaces
  /placeholder/i text matching between adapters and doctor (structural contract).
- 2026-09-21 (R2): projectBootstrap migration_required keys on state.json
  schema_version per store.ts migration logic (v2 present → never
  migration_required even if legacy dir exists); incompatible marker schema →
  action "repair" (no third path); bootstrap is OFFER-ONLY, never auto-runs.
- 2026-09-21 (R2 clarification): PLACEHOLDER_ISSUE is the ENTIRE issue string;
  doctor checks structural equality (issues.includes(PLACEHOLDER_ISSUE)) as the
  primary contract — /placeholder/i survives only as a legacy fallback.
- 2026-09-21 (R2 clarification): verify() remains in the runGuarded set
  (read-only but snapshot-consistent under the lock; no behavioral change).
- 2026-09-21 (M3, Lead): Builder unresponsive ~45 min on the critical path →
  Lead took types.ts (optional uninstall member + PLACEHOLDER_ISSUE) and
  manager.ts (uninstall under runGuarded, unsupported-refusal) per the
  announced reassignment; Builder's gui/integrations.ts slice unchanged.
  Adapters now emit PLACEHOLDER_ISSUE verbatim; doctor's primary check is
  structural equality (issues.includes), /placeholder/i = legacy fallback.
- 2026-09-21 (M3, Reviewer note adopted as binding): per-host uninstall
  ordering — "files first, marker last". removeIntegrationMarker runs ONLY
  after full removal success; on failure the marker is left untouched +
  ok:false (runGuarded rollback composes correctly). Idempotent no-op path
  short-circuits before touching the marker.
- 2026-09-21 (M3 PASS, Reviewer): M1+M2+M3 all PASS. P4 notes recorded:
  (1) integrationsListSync dead first loop — REMOVED in the same pass
  (marker-only payload, comment documents the sync/HTTP split);
  (2) UI statusMeta lacks 'unknown' — accepted known limit (sync bridge
  never feeds that view);
  (3) uninstall offered for outdated hosts — deliberate lifecycle freedom.
  Reviewer's earlier P4 on toReport foreign-plugin warning wording
  ("overstates overwrite on the failure path") — deferred to the M4 docs
  pass wording check; detect-side guard covers behavior.
- 2026-09-21 (M4): README product-positioning rewrite IN SCOPE (Reviewer
  confirmed) — draft committed to working tree pending Reviewer claim
  verification: charter positioning header, install.mjs-era flows removed,
  new Project-integration section, /trust caveat on Codex row, machine-vs-
  project scope sentence, CLI reference table, OpenCode stays the only FULL.
- 2026-09-21 (M4): Reviewer final regression sweep = 329/329 + contract +
  typecheck + format + build + CLI-side P2-2/P2-5/P3-5 re-verified; charter-
  level PASS issued for M1-M4 code+docs, final sign-off gated only on README
  review.

## Unresolved risks

- Codex project-scope config requires /trust — surfaced in warnings, not fixed.
- ChatGPT remains scaffold/EXPERIMENTAL; GUI must label it "Platform setup
  required", never installable to FULL.
- Claude Desktop bundle presence check is heuristic (dir exists) until real
  .mcpb install detection lands.