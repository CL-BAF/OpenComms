# OpenComms upgrade handoff — 2026-10-05

The local implementation and regression gates pass, and usable **1.4.0 Windows portable coordinator** and **npm package** artifacts were produced. **The whole upgrade is not accepted as complete:** authenticated core-host/cross-host roundtrips, real Tauri compilation/WebView execution and Windows installer smoke remain unverified. At the end of local validation, no release had been published, branch pushed, public endpoint exposed or paid service provisioned. A subsequent user instruction authorized committing and pushing the source changes; it did not authorize a release. The mistaken subject/course assignment change was removed.

The upgrade started from a source archive without `.git`. Git history was subsequently restored from `CL-BAF/OpenComms` main for the user's authorized commit/push; the validation records below describe the prior local build. The tested source snapshot is:

```text
111856faebd9aacb10930d6f16712b5563829b248f320710553fba5cb258dc36
```

[Source inventory](verification/2026-10-05/source-manifest.json) hashes 170 source/config/build-input files; [commands and versions](verification/2026-10-05/commands.json) records exact final commands and exit codes. Generated artifacts have separate hashes in [SHA256SUMS](verification/2026-10-05/SHA256SUMS.txt). This is a content snapshot, not an invented Git commit.

## Baseline and defect provenance

Locked dependencies were initially missing. After installing them, baseline typecheck, formatting and two contract tests passed. The first unit run recorded **297 passed, 1 failed, 54 skipped** (352 total). The failure was Rust/TypeScript bridge count drift, 36 versus 26, during concurrent bridge edits. This is not a clean pre-edit unit baseline, and skipped adapter tests without `dist` were not proof of installation success. See [baseline unit output](verification/2026-10-05/baseline-unit.txt), [contract output](verification/2026-10-05/baseline-contract.txt) and [format output](verification/2026-10-05/baseline-format.txt).

The integration defects below were confirmed by source inspection; no preserved pre-fix authenticated vendor execution traces exist. Current real child-process, HTTP and persistence regressions demonstrate the resulting behavior.

| Finding / investigation target | What changed and current evidence |
| --- | --- |
| Missing native operation coverage and browser/native route drift | Shared exact named routes and bounded native allowlists cover create/stop/restart/assign/join/remove and the new workflow operations. Query arguments survive translation. Rust/TS parity and the actual packaged coordinator handshake pass. |
| Member-removal parsing | The existing HTTP removal handler was present; no original HTTP removal failure was established. Exact native route resolution separates member listing from removal. Real HTTP/native-seam workflows persist removal of the intended existing identity. |
| Create Agent without a model catalogue | Missing catalogue/runtime now disables submission with recovery; the form does not invoke an empty callback. ACP explicitly preserves its configured model. Current browser tests exercise the missing-catalogue state; no retained original browser failure recording is claimed. |
| Activity pagination / live refresh | Cursor advances to the last returned event; pages are deduplicated and bounded. Filters, saved tabs, task details, join host, context search and editing/focus survive refresh. Current pagination and Chrome workflows pass; no clean original browser trace is claimed. |
| Misleading milestone failure strings and support guessing | Known capability failures retain their state across HTTP/native envelopes. Actual errors retain request IDs and redaction. Capability negotiation comes from the selected project/runtime/session, rather than success of an unrelated read. Unsupported updates and remote controls are explained visibly. |
| Installed MCP/hook entries had relative dependencies | Normal builds now bundle each installed entry and ship the Desktop manifest. SEA embeds them; installers do not rebuild source. Copied executable and installed npm package both run their adapters outside the checkout. |
| Claude hook command omitted the dispatcher's subcommand | Hook dispatch reads the actual `hook_event_name` when the registered command has no subcommand. Installed-command subprocess tests bind identity and pull framed context. |
| Fabricated managed OpenCode status; incomplete resume/stop/restart | Actual exact-session lookup and status are used. Failed resume/abort does not claim stopped. Restart preserves identity; replacement requires explicit authorization. Real loopback fixtures exercise these paths. |
| Acceptance mixed with completion and ambiguous retry | HTTP 204 prompt acceptance is handled independently from model completion. Persisted in-flight uncertainty prevents blind replay, including linked-plugin recovery. No original 204 JSON-parse reproduction is claimed. |
| Guessed permission routes and swallowed errors | Current global OpenCode permission list is filtered to the exact session; replies grant once or reject. Authentication/network failures remain failures. ACP permissions await operator decisions. |
| Empty managed worktree scaffolds / wrong runtime directory | Source workspace is the default. Optional isolation creates a verified detached Git checkout of source HEAD. Every runtime HTTP call selects the recorded directory; project/worktree membership stays exact. |
| Approved remote creation could reach a local runtime | Missing authenticated remote dispatch now produces an explicit unsupported result before local creation/control. This was a source-confirmed boundary defect, not an experiment against a remote vendor. |
| Later malformed orchestration file lost its recovery copy | Exact malformed bytes are now preserved even after the one-time migration backup exists. Real store regression passes. |
| Remote/inactive permission records could reach local runtime | Local placement, live identity and lifecycle are checked before runtime access. Advertised per-agent permission capability uses the same validator. Colliding remote session identity regression and both transport checks pass. |
| Revocation implied graceful remote stopping | Backend audit, GUI and MCP descriptions now say certificate revoked/records failed; actual remote host interruption is unavailable here. |

Claude Stop `additionalContext` was suspected unsupported; current official documentation supports it, so no defect is claimed. Existing owner-side OpenCode delivery, per-member pins, atomic channel storage, project/worktree matching and untrusted message framing were preserved.

Failures reproduced **during the upgrade**, rather than assigned to the original baseline: failed intermediate compilation clobbered standalone bundles; a valid renamed MCP bundle did not start; the new ACP runtime mishandled fragmented UTF-8. These have regressions and fixes. Fresh builds plus `noEmitOnError` prevent compiler failure from overwriting bundles, and native asset generation restores bundles after successful TypeScript emission. The newly enabled real packaged-sidecar probe also exposed an outdated assertion requiring an available catalogue; it now validates an honest unavailable result, routing, correlation and recovery. Its prior failure is retained in [the intermediate log](verification/2026-10-05/validation-unit-before-probe-fix.txt).

## Implemented work

The existing engine/store/API architecture remains in use. Channel mutations share locking across HTTP/native; project switching cannot race active mutations. Managed runtime instances and local serve startup are scoped and cached; owned resources shut down, while linked host processes remain user-owned. Queues persist two-phase handover and bounded retry/uncertainty, and stale/rejected cleanup is saved even when no batch is delivered. Runtime/message budgets are checked on each queued handover/retry, leaving capped work visible for an operator decision.

Tasks extend `.opencomms/orchestrator.json` rather than creating a competing database. Delivery and execution are independent. Durable owner/revision, dependencies, criteria, related messages, artifacts, evidence, review rounds, blockers and operation IDs support explicit delegation and recovery. Completion is operator-only after independent accepted review and passing evidence covering each criterion. Human review must judge relevance and truth: the application does not execute evidence references or infer behavioral correctness from compilation.

Explicit handoff retains prior work/context and refuses running, terminal or uncertain in-flight work. Received assignments require confirmation the former owner stopped. Advisory file ownership detects overlap; Git isolation is separately opt-in. Saved team templates are revisioned plans with roles/prompts/host/runtime/model requirements and budgets; saving/deleting never launches a team. Context search and compact handoffs keep proposals, decisions, verified findings, questions and rejected approaches project-local.

The GUI now includes task details/transitions/evidence/review, explicit reassignment, team plans, project context, host approvals and durable emergency coordination stop. Queued mail is not labeled working; unavailable model/usage/connection facts remain unknown. Dialogs protect against duplicate submission and uncertain retry, retain disabled capability states after errors, and manage keyboard focus. Browser SSE/native polling preserve navigation and editing state. See [every visible control's action/authority/evidence](GUI_ACTION_AUDIT.md) and [actual CLI asymmetries](gui-cli-parity.md).

Gemini project hooks/MCP, a reusable configured ACP runtime, and read-only MCP profiles for Goose, Cursor, Cline, Roo, Continue, VS Code/Copilot and legacy Windsurf/Cascade were added. Installed configurations preserve unrelated entries and do not auto-grant host trust/permissions.

## Integration verification level

| Surface | Local evidence | Outstanding real-host gate |
| --- | --- | --- |
| OpenCode linked | Owner-side idle/queue/recovery engine/controller tests and identity contracts | Authenticated existing-session/model exchange and cross-server continuity |
| OpenCode managed | Real loopback API fixtures for exact identity, busy/idle, 204 acceptance, directory, resume/abort, permissions | Actual installed host/provider/model completion |
| Claude Code / Codex linked | Installed MCP/hook child processes, pinned membership, framed pull, argv resume/limit tests | Authenticated host tool/hook/resume roundtrip; Codex interactive TUI resume specifically unverified |
| Gemini linked | Actual copied hook/MCP processes and safe settings merge | Host trust, authentication and model roundtrip |
| ACP managed | Actual deterministic stdio subprocess, fragmented streams, conditional load, permissions/cancel | A real compatible authenticated vendor/model; model catalogue/selection unsupported |
| Editor MCP profiles | Every exported server command executes outside checkout, joins pinned member and pulls framed mail | Actual authenticated editor/tool use; native conversation identity/lifecycle unknown |
| Claude Desktop | Standalone extension server and manifest execute from copied installation | Official MCPB packing/Desktop installation and real tool use |
| ChatGPT | Connector scaffold with authenticated HTTPS requirements | Operator deployment, OAuth/TLS and actual connector use; no public bridge deployed |
| Codex App Server | Explicitly unsupported | No client/runtime implementation shipped |

The integration screen separates **Application detected → Configuration checked → Recent runtime contact → Round trip verified**; no live roundtrip is marked verified here. Managed contact is bounded recorded status, not authentication/model proof. See [CAPABILITIES.md](CAPABILITIES.md), [official references/live prerequisites](INTEGRATION_VERIFICATION.md) and [profile scope](MCP_PROFILES.md).

Observed environment: Windows 10.0.26200; Node **24.19.0** for source tests, verified pinned Node **22.14.0** for SEA/artifact smoke; npm **11.17.0**; Chrome **154.0.8037.98**. Codex CLI **0.159.0-alpha.12.1** was detected, with no login/model/tool-roundtrip claim. OpenCode, Claude and Gemini executables were absent from PATH. Rust/cargo and Inno Setup were unavailable. [Detection record](verification/2026-10-05/environment-gates.json).

## Exact final verification

All commands ran from the repository root unless stated otherwise. The source/test build is refreshed by `npm run test:unit`; the following compiled contract/live commands reuse that exact build.

| Command | Exit / result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | 0 | [log](verification/2026-10-05/validation-typecheck-final.txt) |
| `npm run format:check` | 0 | [log](verification/2026-10-05/validation-format-final.txt) |
| `.build-tools/node-v22.14.0.exe scripts/build-exe.mjs --out dist-release` with `OPENCOMMS_NPM_CLI` set to the installed npm CLI | 0; version smoke 1.4.0 | [log](verification/2026-10-05/validation-build-exe-final.txt) |
| `npm run test:unit` | **438 passed, 0 failed, 0 skipped**, exit 0 | [log](verification/2026-10-05/validation-unit-final.txt) |
| `node --test --test-reporter=tap --test-concurrency=1 dist-test/test/contract/*.test.js` | **2 passed**, 0 failed/skipped, exit 0 | [log](verification/2026-10-05/validation-contract-final.txt) |
| `node --test --test-reporter=tap --test-concurrency=1 --test-timeout=300000 dist-test/test/live/live.test.js` | **0 passed, 3 skipped**, exit 0 | [log](verification/2026-10-05/validation-live-final.txt) |
| `node --test --test-reporter=tap --test-concurrency=1 dist-test/test/live/managed-vendor.test.js` | **0 passed, 2 skipped**, exit 0 | [log](verification/2026-10-05/validation-vendor-final.txt) |
| `node scripts/build-shell-asset.mjs` | 0 | [log](verification/2026-10-05/validation-native-build.txt) |
| `node scripts/test-native-assets.mjs` | 0; hashes/version/CSP/JS syntax/named IPC | [log](verification/2026-10-05/validation-native-assets.txt) |
| `node scripts/test-browser-workflows.mjs` with bundled Playwright path | **23 HTTP + 23 native-seam checks**, no uncaught UI errors, exit 0 | [log](verification/2026-10-05/validation-browser.txt), [JSON](verification/2026-10-05/browser-workflows.json) |
| `.build-tools/node-v22.14.0.exe scripts/test-standalone-artifacts.mjs dist-release/opencomms.exe` | 0; copied executable, five installers, hook/MCP children, real GUI/persisted session | [log](verification/2026-10-05/validation-standalone-final.txt), [JSON](verification/2026-10-05/standalone-artifacts.json) |
| `npm pack --pack-destination dist-release --cache .npm-cache --json` | 0 | [log](verification/2026-10-05/validation-npm-pack.txt) |
| `.build-tools/node-v22.14.0.exe scripts/test-standalone-artifacts.mjs dist-release/opencomms-1.4.0.tgz --npm` with npm CLI path | 0; actual offline temp package installation, copied adapters and real GUI | [log](verification/2026-10-05/validation-npm-smoke-final.txt), [JSON](verification/2026-10-05/npm-artifacts.json) |
| `npm run build:installer` | **1**; ISCC.exe missing | [log](verification/2026-10-05/validation-installer.txt) |
| `npm run test:windows-release` | **1**; no produced installer | [log](verification/2026-10-05/validation-windows-release.txt) |
| `cargo check --locked` | Not launched; cargo unavailable; no exit code invented | [record](verification/2026-10-05/validation-rust.txt) |
| `graphify update .` | Not launched; graphify/tool/output absent | [record](verification/2026-10-05/validation-graphify.txt) |

The live skips are **not passes**. The native Chrome surface emulates Tauri invoke against the real backend, with persisted managed-worker fixtures; it does not launch a vendor or prove the Rust/WebView/installer. The real packaged coordinator probe is now executed, rather than skipped, and verifies handshake, exact advertised command set, acknowledgment, request correlation and unavailable-runtime handling.

Original workflow screenshots are retained locally in `.verification/` and excluded from publication. The published JSON summaries and logs record fixture task state/evidence coverage, not the semantic truth of an external game/entity behavior.

## Artifacts and launch

| Produced artifact | Size | SHA256 |
| --- | ---: | --- |
| `dist-release/opencomms.exe` | 85,030,912 bytes | `e915c9faa61d50a99762bb739ec737bf6c75d9b2fb6f323975012feaed96f4a0` |
| `dist-release/opencomms-1.4.0.tgz` | 504,646 bytes | `2770f06706e199d2d0307575fdb0ed617f2f278b150c36f00b02164592423f15` |
| Tauri target sidecar, `desktop/src-tauri/binaries/opencomms-coordinator-x86_64-pc-windows-msvc.exe` | 85,030,912 bytes | Same executable hash |
| `desktop/dist-shell/index.html`, `app.js`, `manifest.json` | Offline frontend | Exact individual hashes in source manifest |

Build binaries and generated shell assets are local artifacts and are not committed to Git. Published evidence/checksums are retained here; regenerate artifacts with the documented build commands. No current Inno or Tauri installer/native application was produced. SEA injection invalidates the upstream Node PE signature; the generated portable coordinator is an **unsigned local build**.

```powershell
.\dist-release\opencomms.exe version
.\dist-release\opencomms.exe gui --project "C:\path\to\coding-project" --port 4919 --server
```

Open `http://127.0.0.1:4919`; omit `--server` to open the browser automatically. Keep coding projects outside the installation folder. The SEA coordinator itself does not need a separate Node installation, but installed MCP/hooks require the host's configured Node runtime. The tarball can be installed with `npm install <absolute-path-to-opencomms-1.4.0.tgz>`; Node and declared dependencies are required. No global installation was performed on the user's machine.

## Migration and update

1. Stop coordinator writers and host plugin instances deliberately; preserve linked conversation identities. Back up the complete project `.opencomms` directory, integration configuration and app workspace settings before updating. Keep backups private; the orchestration file contains the owner confirmation token.
2. Replace the local application/integration artifacts with this build, updating every writer before resuming. Review the existing release target before using CLI update; this local upgrade has not been published. Windows uses its supported installer when one is built/tested.
3. Channel state stays schema 2. The existing orchestration schema stays 1, with additive task/template version-1 extensions. Before the first extension write, exact prior orchestration bytes are retained as `orchestrator.pre-tasks-v1.json`. Legacy delivery acknowledgments never become successful execution.
4. Invalid/forward-version documents are preserved as `orchestrator.rejected.*.json`; malformed JSON as `orchestrator.unreadable.*.json`, including corruption after migration. Review recovery files; stop writers before restoring, preserve current data first, and never combine project stores.
5. Check configuration, explicit member pins/trust, exact identity/worktree and an actual host roundtrip before supervising new work. Existing archives and unrelated host configuration are retained. Uninstall never silently removes project state.

See [TASK_EXECUTION.md](TASK_EXECUTION.md) for legacy criteria, idempotent operation recovery and handoffs; [MIGRATION.md](MIGRATION.md) for the older channel v1→v2 cutover.

## Manual acceptance and remaining limits

1. Launch the portable GUI in a disposable existing project. Inspect diagnostics, create a channel and check the join command's host/role. Save, select the saved tab, refresh, and resume as a new channel; verify archive contents remain.
2. Install chosen integrations in that disposable project. Check all four onboarding stages separately and review host trust/member pins. On a machine with authenticated hosts, link existing sessions, record original IDs, exchange framed targeted messages and confirm IDs/models/workspaces are unchanged.
3. Exercise a busy recipient, queue mail, disconnect/restart its host and inspect delivery. For an uncertain accepted prompt, inspect the actual host and persisted envelope before any retry. Confirm no automatic replacement conversation.
4. Explicitly create a supported managed worker, link its exact existing identity to a matching channel, then assign a task with behavioral criteria. Run work, record blockers/checks/artifacts, enter review and have an independent reviewer assess evidence. Reject premature completion, then accept only after relevant passing evidence covers every criterion. Bare linked members can exchange messages; this task-assignment UI currently selects managed agent records linked to channels.
5. Trigger an actual host permission request; verify the inbox matches the correct local active session and allow once or reject. Check a disconnected/unsupported/remote entry displays its real limit and cannot operate a local host.
6. Save/edit/apply one team entry explicitly; confirm saving does not launch agents. Search project context, page Activity, and refresh while filters/detail/forms are selected.
7. Emergency-stop coordination with a lead present; verify linked hosts keep running. Choose managed interruption only where supported. Restart the coordinator and verify the durable stop remains; explicit resume must preserve independently paused channels.
8. With Rust/C++/WebView2 installed, run the [desktop build/tests](../desktop/README.md), then test actual native create/stop/restart/assign/remove, picker, shutdown and reconnect. With Inno Setup available, build and smoke-test installation/shortcuts/uninstall/state preservation. The existing Windows release harness requires a real installer.
9. Deliberately opt in to [linked and managed live tests](INTEGRATION_VERIFICATION.md) with authenticated disposable hosts. Run representative real cohorts before invoking `scripts/evaluate-coordination.mjs`; no solo/mixed/eight-agent performance result was fabricated.

Automatic dependency scheduling, automatic model fallback, worktree merging and remote managed execution are not implemented. Verified dependencies gate admission, explicit handoff supplies fallback, and ownership in shared trees is advisory. Budgets bound coordinator handovers/review/retries/runtime; they do not guarantee a hard spend cap on already running host work. Token/cost telemetry remains unknown without actual host data. ACP load depends on advertised support; editor MCP profiles provide tools, not native session discovery/control. ChatGPT authenticated deployment, Claude Desktop application installation, vendor roundtrips, Linux packages and native installer/WebView acceptance are still outstanding gates.
