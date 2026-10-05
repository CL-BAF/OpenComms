# OpenComms capabilities

Updated 2026-10-05. These statuses describe this build. A working protocol fixture does not establish vendor authentication or live model interoperability. See [verification evidence and live gates](INTEGRATION_VERIFICATION.md).

Linked mode communicates with user-owned sessions. Managed mode explicitly creates and controls separate runtime sessions. Installation, session discovery, authentication, prompt acceptance and task completion are distinct facts.

| Surface | Installation and onboarding | Delivery and identity | Managed creation | Remaining live gate |
| --- | --- | --- | --- | --- |
| OpenCode linked plugin | SUPPORTED project plugin installation | SUPPORTED owner-side idle delivery, explicit tools, existing root identity | UNSUPPORTED in linked mode | Current authenticated OpenCode/model roundtrip; historical evidence remains in [OPENCODE.md](OPENCODE.md) |
| OpenCode managed runtime | SUPPORTED configured native executable, authenticated local serve and explicit model pin | SUPPORTED exact lookup, actual busy/idle status, prompt acceptance and operator permission replies | SUPPORTED separate sessions; source folder by default, optional detached Git worktree | Installed server, provider authentication and model completion |
| Claude Code linked | PARTIAL project hooks and MCP installer; explicit pin/trust required | SUPPORTED hook context and MCP pull; PARTIAL opt-in argv resume delivery, no mid-turn injection | UNSUPPORTED | Installed CLI authentication and vendor hook/resume roundtrip |
| Codex CLI linked | PARTIAL project TOML MCP registration; project trust and explicit pin required | SUPPORTED MCP pull; PARTIAL opt-in exec-compatible resume; interactive TUI resume unverified | UNSUPPORTED | Authenticated CLI/tool and resume roundtrip |
| Gemini CLI linked | PARTIAL settings, MCP and lifecycle hooks; explicit pin/trust required | SUPPORTED hook context and MCP pull; documented hook identity correlation | UNSUPPORTED | Gemini authentication, hook trust and actual roundtrip |
| Configured ACP managed runtime | PARTIAL operator-supplied executable/argv and existing authentication | SUPPORTED initialize/new/prompt/cancel and pending operator permissions; load conditional on advertised capability | SUPPORTED separate managed sessions, source folder or optional detached Git worktree | Vendor interoperability/authentication; model catalogue/selection and discovery unsupported |
| Codex App Server | UNSUPPORTED: no client/runtime shipped | UNSUPPORTED in this build | UNSUPPORTED | Official host primitives are documented but are not implemented OpenComms capabilities |
| Claude Desktop | PARTIAL standalone extension layout; user packs/installs with official MCPB tooling | SUPPORTED explicit MCP pull; conversation identity, push and role injection unsupported | UNSUPPORTED | Real extension installation and Desktop tool execution |
| ChatGPT web/desktop connector | PARTIAL scaffold; operator supplies authenticated HTTPS deployment | PARTIAL remote MCP pull after deployment; conversation identity and server-initiated push unsupported | UNSUPPORTED | Remote deployment, OAuth/TLS and actual connector execution |
| Manual Goose / Cursor / Cline / Roo / Continue / VS Code-Copilot MCP profiles | PARTIAL read-only configuration export; user merges and enables it | SUPPORTED shared MCP pin/join/pull wire behavior; native conversation identity and lifecycle UNKNOWN | UNSUPPORTED by profiles | Actual authenticated host configuration and tool execution; [setup contracts](MCP_PROFILES.md) |
| Windsurf legacy Cascade MCP profile | PARTIAL read-only export for the documented legacy Cascade configuration; current default Devin Local excluded | SUPPORTED shared MCP pull wire behavior; native identity/lifecycle UNKNOWN | UNSUPPORTED by profile | Installed legacy agent acceptance and actual tool execution; [current documentation boundary](MCP_PROFILES.md) |

## Runtime constraints

- Explicit managed actions alone create managed sessions. Linked installations do not create, replace or delete existing sessions.
- Unsupported runtimes and required capabilities fail before creation. ACP resume remains unknown until its peer advertises loadSession; automatic replacement is disabled.
- Managed delivery distinguishes accepted, rejected and uncertain. Uncertain mail remains in flight for inspection and is excluded from linked-plugin startup recovery. Acceptance does not complete a task.
- Isolation is a verified detached checkout of source HEAD. The source must be a Git repository root. Uncommitted edits are not copied, linked sessions are not relocated, and retained worktrees are never automatically deleted. Membership still requires exact project/worktree equality.
- Operator permission responses grant one request once or reject it. No adapter silently grants permanent permissions. Unsupported listing and a failed request remain distinct.
- Installed MCP/hook files are standalone bundles. SEA builds embed them and the Desktop manifest; npm builds include the manifest in dist. Installations do not rebuild source.
- Integration detection inspects configuration and artifacts. Placeholders, missing artifacts and malformed settings are actionable. Configuration verification never proves authenticated vendor execution.

## Implementation and regression evidence

| Concern | Implementation | Regression |
| --- | --- | --- |
| Installed wiring | scripts/build-bundles.mjs, src/cli/adapter-resources.ts, installers | installed-adapters.test.ts, gemini-integration.test.ts, desktop-package.test.ts run copied artifacts outside the checkout |
| OpenCode managed API | src/orchestrator/runtimes/opencode.ts | opencode-runtime.test.ts uses real loopback HTTP |
| ACP protocol | src/orchestrator/runtimes/acp.ts | acp-runtime.test.ts launches an actual deterministic subprocess; no vendor/model claim |
| Durable create/isolation | src/orchestrator/api.ts, worktrees.ts, managed-capabilities.ts | managed-create-safety.test.ts checks concurrent retries and real temporary Git worktrees |
| Endpoint ownership | src/hosts/opencode/delivery.ts, managed-delivery.ts | opencode-owner-delivery.test.ts and managed-delivery.test.ts preserve uncertain managed mail |
| Spawn argv/limits | src/hosts/spawn-delivery.ts | spawn-delivery.test.ts checks argv-only launch, pre-drain refusal and serialization |
| Manual editor profiles | src/integrations/mcp-profiles.ts, CLI mcp-profile | mcp-profiles.test.ts launches every exported profile, checks its exact host label, unknown native identity and real framed pull |

Official sources and opt-in live commands are in [INTEGRATION_VERIFICATION.md](INTEGRATION_VERIFICATION.md). Skipped live tests are never successful interoperability evidence.
