# OpenComms

Project-local communication and coordination for AI coding sessions. Package version **1.5.0**; TypeScript, ESM, MIT. See [v1.5.0 release notes](docs/releases/v1.5.0.md).

**Linked mode** connects sessions you already run and preserves their identity, model, workspace and host permissions. **Managed mode** explicitly creates separate OpenCode sessions or sessions through an operator-configured ACP runtime. Managed capabilities depend on the selected host; MCP tool access alone does not provide session control.

The browser console and Tauri shell share named, validated backend operations. The console shows delivery, execution, approvals and uncertainty separately. Peer messages remain framed as untrusted data.

The browser and native consoles expose the same task, team, context and integration operations. **Authenticated vendor roundtrips remain unverified by local protocol fixtures.** Packaged desktop and installer validation is separate from source tests. The [earlier upgrade handoff](docs/UPGRADE_HANDOFF.md) records the historical v1.4.0 local build; its results are not acceptance evidence for v1.5.0.

## Start locally

The portable Windows coordinator runs without a Node installation:

```powershell
.\dist-release\opencomms.exe version
.\dist-release\opencomms.exe gui --project "C:\path\to\project" --port 4919 --server
```

Open `http://127.0.0.1:4919`. Omit `--server` to open the default browser. Integration hook/MCP processes still require the host's configured Node runtime. Keep project data outside the executable installation directory.

From source:

```powershell
npm ci
npm run build
node dist/cli/main.js gui --project "C:\path\to\project" --port 4919 --server
```

Project selection validates the directory before switching. Paste a path or use Browse where the OS picker is available. A busy mutation or owned runtime can prevent switching; finish or stop that work first. The browser API binds to loopback and validates Host/Origin. Owner-only trust actions still require the explicit owner token.

## Integration support

Installation/configuration checks, runtime contact and authenticated model roundtrips are separate onboarding stages. Unknown information stays unknown. This build's matrix is in [CAPABILITIES.md](docs/CAPABILITIES.md), with official references and opt-in live commands in [INTEGRATION_VERIFICATION.md](docs/INTEGRATION_VERIFICATION.md).

| Surface | Implemented path | Verification in this environment |
| --- | --- | --- |
| OpenCode linked | Existing root-session identity; owner-side queued idle delivery | Engine/controller regression tests; authenticated linked live tests skipped |
| OpenCode managed | Explicit model-pinned creation, exact status/resume, asynchronous prompt acceptance, operator permissions | Real loopback HTTP fixtures; live model gate skipped |
| Claude Code | Standalone hooks + pinned MCP pull; opt-in argv resume delivery | Copied hooks/MCP execute; CLI authentication/resume unverified |
| Codex CLI | Project MCP registration and pull; opt-in exec-compatible resume | Copied MCP executes; actual CLI/model roundtrip and interactive TUI resume unverified |
| Gemini CLI | Project MCP and lifecycle hooks with explicit pin/trust | Copied hooks/MCP execute; vendor trust/authentication/roundtrip unverified |
| Configured ACP | Stdio initialize/new/prompt/cancel; pending operator permissions; load only if advertised | Real deterministic subprocess fixtures; actual vendor/model interoperability unverified |
| Claude Desktop | Standalone MCP extension layout and explicit pull | Copied extension server executes; Desktop packing/installation/tool use unverified |
| Goose, Cursor, Cline, Roo, Continue, VS Code/Copilot | Manual read-only MCP configuration profiles | Every exported server command tested outside checkout; editor authentication/tool use unverified |
| Windsurf legacy Cascade | Manual profile for the documented legacy configuration | Shared MCP command tested; current default Devin Local excluded |
| Codex App Server | No runtime client shipped | Unsupported |
| ChatGPT connector | Configuration scaffold requiring an operator-hosted authenticated HTTPS MCP service | Deployment/OAuth/actual connector use unverified |

```powershell
.\dist-release\opencomms.exe install opencode --project "C:\path\to\project"
.\dist-release\opencomms.exe doctor
.\dist-release\opencomms.exe install gemini-cli --project "C:\path\to\project"
.\dist-release\opencomms.exe mcp-profile cursor --id reviewer --project "C:\path\to\project"
```

Install/update/repair preserve unrelated host configuration; uninstall removes OpenComms-owned entries and retains project state/pins. Review host trust and approvals explicitly. Profiles print configuration for you to merge; they do not write editor settings. See [MCP_PROFILES.md](docs/MCP_PROFILES.md).

On Windows, spawned resume/ACP commands use argv arrays. Supply a native executable or a documented `node <entrypoint>` template; `.cmd`/`.bat` shims are refused for shell-free spawning. Oversized batches fail before drain. No host identity is silently replaced to demonstrate success.

## Linked quick start

Install the OpenCode integration in a disposable project. In two existing root OpenCode sessions from that exact project/worktree:

```text
/OpenComms Create Channel=my-feature As=Builder [Implement the request and send evidence to Reviewer.]
/OpenComms Join Channel=my-feature As=Reviewer [Inspect behavior and evidence; return specific findings.]
```

Other hosts join through their pinned MCP tools. A channel supports up to its configured member limit (default eight) with unique, case-insensitive roles. With three or more members, send to an explicit role/session or choose broadcast; omitted targeting fails. Delivery acceptance or a reply saying “done” never completes a task.

Session Save archives coordinator history and summary, then removes live channel state. Resume as new creates a new OpenComms channel referencing the archive and supplies compact context to joiners. Delete is confirm-gated. These operations do not delete linked host conversations or terminate their processes.

## Supervising work

The overview shows host, mode, model where available, current task, actual status and bounded recovery details. Queued mail is shown as queued; unknown usage is not estimated. Tasks have criteria, owner, dependencies, advisory file ownership, messages/artifacts, blockers, evidence and independent review.

Execution follows `ready → assigned → running → blocked/review → verified_complete`, with failed/cancelled outcomes. Backend revision/owner/dependency gates apply to GUI, CLI and MCP. Only the local operator can accept evidence-backed completion after independent review; the reviewer must assess the evidence's truth and relevance. OpenComms does not execute arbitrary evidence references.

Saved team templates retain roles, prompts, host/runtime, model requirements and budgets. Applying one requires an explicit entry and choice to link or launch. Project context records proposals, accepted decisions, verified findings, open questions and rejected approaches; compact handoffs reference deeper records.

Emergency stop durably pauses coordination, including after restart. Managed interruption is an explicit supported operation, including the lead. Linked host processes keep running. Resume unpauses only channels paused by that stop and never automatically restarts agents.

See [TASK_EXECUTION.md](docs/TASK_EXECUTION.md) for migration, assignment, transitions, manual reassignment and the bounded opt-in coordination evaluation. Automatic dependency scheduling, model fallback and worktree merging are not implemented. Optional managed Git worktrees require a real repository root and retain source HEAD separately; uncommitted edits are not copied. Remote trust/enrollment records do not imply a working remote agent execution transport.

## Build and verify

```powershell
npm run typecheck
npm run format:check
npm run test:unit
npm run test:contract
npm run test:live       # guarded linked-host test; skips are not passes
npm run test:vendor     # explicit opt-in managed vendor/model tests
```

Unit builds regenerate source bundles before testing installed adapters. A failed TypeScript compile does not emit over a working bundle.

SEA builds require **Node 22.14.0** exactly. In this workspace the verified pinned executable is available at `.build-tools/node-v22.14.0.exe`:

```powershell
$env:OPENCOMMS_NPM_CLI='C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
& '.\.build-tools\node-v22.14.0.exe' scripts/build-exe.mjs --out dist-release
node scripts/test-standalone-artifacts.mjs dist-release/opencomms.exe
npm pack --pack-destination dist-release
```

The SEA embeds standalone MCP, Claude/Gemini hooks, OpenCode plugin and Desktop manifest assets. The npm package ships these assets in `dist`. Neither installation needs to rebuild source. Builds are unsigned unless the release explicitly states otherwise; compare the downloaded artifact with its published checksum.

`npm run build:installer` needs Inno Setup 6.4.x. `npm run test:windows-release` needs its produced installer. Tauri needs Rust, Visual Studio C++ build tools and WebView2 on Windows; see [desktop/README.md](desktop/README.md). The Inno installer launches the browser console; the Tauri installer packages the native shell and coordinator sidecar. Static assets and bridge tests alone do not prove either packaged GUI works; each release needs its own installer smoke test.

Linux install/update scripts remain available for server releases. `opencomms update --check` previews the configured release target; Windows update directs you to its installer. Review the target/version before updating. The GUI updater is disabled, and native signing/updater configuration remains unconfigured.

## Source map and documentation

| Path | Role |
| --- | --- |
| `src/core/` | Atomic channel store, deterministic engine, queues, archives |
| `src/plugin.ts`, `src/hosts/` | Linked host tools and delivery controllers |
| `src/orchestrator/` | Managed runtimes, task/context/template store, API, bounded native bridge |
| `src/mcp/`, `src/adapters/`, `src/integrations/` | Pinned tools, hooks, installers, profiles and detection |
| `src/gui/` | Shared action contracts, loopback backend and offline UI |
| `src/cli/` | CLI and standalone resource resolution |
| `desktop/` | Tauri shell, strict CSP, allowlisted coordinator IPC |
| `test/`, `scripts/` | Unit/contract/live tests, browser and artifact verification |

Start with [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [SECURITY.md](docs/SECURITY.md), [PROTOCOL.md](docs/PROTOCOL.md) and [TOOLS_AND_COMMANDS.md](docs/TOOLS_AND_COMMANDS.md). Host guides: [OpenCode](docs/OPENCODE.md), [Claude Code](docs/CLAUDE_CODE.md), [Codex](docs/CODEX.md), [Claude Desktop](docs/CLAUDE_DESKTOP.md), [ChatGPT](docs/CHATGPT.md). `opencomms help` lists current CLI commands.
