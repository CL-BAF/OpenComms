# OpenComms Capability Matrix

Every claim below is backed by an implementing file/test or a recorded
official-doc citation. Vocabulary: **SUPPORTED** / **PARTIAL** /
**EXPERIMENTAL** / **UNSUPPORTED** only. Statuses are per *surface*, never
per vendor. Date of last full verification: **2026-08-29**.

Legend for "evidence": implementation path + test file where applicable.

## Surfaces

1. OpenCode (plugin, CLI)
2. Claude Code (CLI — hooks + MCP)
3. Claude Desktop (extension — local MCP)
4. Codex CLI (config.toml MCP + trust-gated hooks)
5. Codex App Server (managed JSON-RPC)
6. ChatGPT Desktop (plugins / remote MCP)
7. ChatGPT Web (developer mode / remote MCP)

## Matrix

| Capability | OpenCode | Claude Code | Claude Desktop | Codex CLI | Codex App Server | ChatGPT Desktop | ChatGPT Web |
|---|---|---|---|---|---|---|---|
| Installation | SUPPORTED (installer, idempotent)¹ | PARTIAL (installer: hooks merged, MCP registered)² | PARTIAL (.mcpb bundle; end-user install UX UNVERIFIED-BY-HARNESS)³ | PARTIAL (config.toml section; trusted-project caveat)⁴ | UNSUPPORTED (no adapter shipped) | PARTIAL (scaffold only; OAuth/TLS operator-provided)⁵ | PARTIAL (developer mode; scaffold)⁵ |
| Membership / channels | SUPPORTED | SUPPORTED (via MCP tools) | SUPPORTED (via MCP tools) | SUPPORTED (via MCP tools) | UNSUPPORTED | SUPPORTED (via MCP tools, remote) | SUPPORTED (remote) |
| Existing-session identity | SUPPORTED (ctx.sessionID)⁶ | PARTIAL (hooks see session_id; MCP tools do NOT)⁶ | UNSUPPORTED (no conversation id documented)³ | PARTIAL (hooks see session_id; MCP tools do NOT) | SUPPORTED (thread ids) | UNSUPPORTED | UNSUPPORTED |
| Existing-session linking | SUPPORTED (invariant: link-only)⁶ | PARTIAL (hook-boundary correlation via pin + host_session_id) | UNSUPPORTED | PARTIAL (hook-boundary correlation if user opts in) | EXCEPTION (opencomms never attaches to TUI threads) | UNSUPPORTED | UNSUPPORTED |
| Push delivery | SUPPORTED (deliver on idle event)⁶ | SUPPORTED with limits (spawn_push: `claude --resume <id> --print <msg>` documented non-interactive resume; never mid-turn; serialized per member)¹ ,⁶ ,⁷ | UNSUPPORTED (documented: no server-initiated push, no session identity)³ | SUPPORTED with limits (spawn_push: `codex exec resume <id> <msg>`; verified for exec-compatible sessions; TUI-session resume UNVERIFIED)⁴ ,⁷ | UNSUPPORTED (no app-server client shipped) | UNSUPPORTED (documented)⁵ | UNSUPPORTED (documented)⁵ |
| Pull inbox | SUPPORTED (tools) | SUPPORTED (opencomms_pull MCP) | SUPPORTED (opencomms_pull; stale_policy=none so nothing ages out while unread) | SUPPORTED | UNSUPPORTED | SUPPORTED (remote) | SUPPORTED (remote) |
| Polling | UNSUPPORTED (event-driven instead) | UNSUPPORTED (hook boundaries only) | UNSUPPORTED (user-invoked tools) | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED |
| Managed threads | UNSUPPORTED (never owns sessions) | UNSUPPORTED | UNSUPPORTED | UNSUPPORTED | EXPERIMENTAL (docs only — no code shipped) | UNSUPPORTED | UNSUPPORTED |
| Role injection | SUPPORTED (persistent system prompt)⁶ | PARTIAL (hook-boundary additionalContext)¹ | UNSUPPORTED | PARTIAL (AGENTS.md; hooks trust-gated) | PARTIAL (per-thread instructions, via app-server only) | UNSUPPORTED | UNSUPPORTED |
| Lifecycle events | SUPPORTED (session.idle/deleted/status)⁶ | SUPPORTED (SessionStart/SessionEnd hooks; Stop per turn)¹ | UNSUPPORTED | PARTIAL (SessionStart/End hooks, trust-gated) | SUPPORTED (thread notifications) | UNSUPPORTED | UNSUPPORTED |
| Session discovery | SUPPORTED (client.session.list) | UNSUPPORTED (no documented API) | UNSUPPORTED | UNSUPPORTED | SUPPORTED (thread/list, via app-server) | UNSUPPORTED | UNSUPPORTED |
| Session resume | SUPPORTED (sessions persist server-side) | SUPPORTED (claude --resume <id>) | UNSUPPORTED | SUPPORTED (codex exec resume <id>) | SUPPORTED (thread/resume) | UNSUPPORTED | UNSUPPORTED |
| History (member-scoped) | SUPPORTED | SUPPORTED | SUPPORTED | SUPPORTED | UNSUPPORTED | SUPPORTED | SUPPORTED |
| Targeted send / broadcast | SUPPORTED (to= / broadcast) | SUPPORTED | SUPPORTED | SUPPORTED | UNSUPPORTED | SUPPORTED | SUPPORTED |
| Cross-host channels | SUPPORTED (any combination of members above; delivery modes never conflated) | SUPPORTED | SUPPORTED | SUPPORTED | (requires app-server adapter) | PARTIAL (PULL side only) | PARTIAL |
| Local operation (no network) | SUPPORTED | SUPPORTED (stdio MCP + hooks) | SUPPORTED (stdio) | SUPPORTED (stdio) | n/a | UNSUPPORTED (public HTTPS endpoint required)⁵ | UNSUPPORTED |
| Remote broker required | No | No | No | No | No | Yes (only for ChatGPT; must be authenticated) | Yes |

## Evidence index

1. **Claude Code hooks** — official hooks reference, fetched 2026-08-29
   (code.claude.com/docs/en/hooks): hook event names, stdin JSON
   (`session_id`, `cwd`), `hookSpecificOutput.additionalContext` on
   SessionStart/UserPromptSubmit/Stop; `${CLAUDE_PROJECT_DIR}` expansion in
   hook commands. Implementation: `src/adapters/claude-code/hooks.ts`,
   `src/adapters/claude-code/install.ts`; tests:
   `test/unit/core/claude-hooks.test.ts` (child-process, production pin-file
   wiring), `test/unit/core/mcp-server.test.ts` (transport).
2. **OpenCode plugin API** — official plugin docs fetched 2026-08-29
   (opencode.ai/docs/plugins): tool registration, event hook,
   experimental.chat.system.transform, command.execute.before,
   client.session.prompt/get. Implementation: `src/plugin.ts`,
   `src/core/*`; wiring tests: `test/unit/plugin.test.ts`; live guard:
   `test/live/live.test.ts` (SKIPped without a server — never counted as
   evidence).
3. **Claude Desktop / MCPB** — MANIFEST.md v0.3 + support article 10949351,
   fetched 2026-08-29: no push into conversations, no conversation identity;
   .mcpb layout, `${__dirname}`, `${user_config.*}`, `mcpb pack`.
   Implementation: `src/adapters/claude-desktop/package.ts`,
   `adapters/claude-desktop/manifest.json`; smoke:
   `test/unit/core/desktop-package.test.ts`.
4. **Codex** — developers.openai.com/codex (mcp/config/hooks pages), fetched
   2026-08-29: `[mcp_servers.*]` tables (project scope trusted-projects
   only), stdio command/args/env + `cwd`, hooks trust-gated (non-managed
   hooks are skipped until the user approves them in /hooks), no documented
   external injection into TUI sessions. Implementation:
   `src/adapters/codex/install.ts`; tests:
   `test/unit/core/codex-install.test.ts`.
5. **ChatGPT** — developers.openai.com/plugins + learn.chatgpt.com +
   platform.openai.com/docs/mcp, fetched 2026-08-29: third-party MCP =
   public HTTPS streamable-HTTP endpoint; developer mode plan gates; OAuth
   2.1 + PKCE (S256) for private data; strictly PULL; no conversation
   identity. Implementation: `src/adapters/chatgpt/install.ts` (scaffold
   with unauth-refusal guard); tests: `test/unit/core/chatgpt-install.test.ts`.
6. **OpenCode behaviors** — engine + plugin (PUSH delivery on idle,
   persistent role injection, session events): `src/core/engine.ts`,
   `src/plugin.ts`; tests: `test/unit/engine.test.ts`,
   `test/unit/plugin.test.ts`. **Topology verification 2026-09-08**
   (OpenCode 1.18.25, headless `opencode serve` labs with real local model
   turns): Desktop↔Desktop and headless same-server autonomous loops
   verified both directions with no manual wake (5/5 A→B receipts, B→A
   receipt +10.9s); two-server CLI↔CLI verified AFTER the owner-side
   delivery fix (recipient's turn fires on the recipient's own bus; the
   sender's bus shows zero foreign events). Full evidence:
   docs/OPENCODE.md § "Topology & autonomy".
7. **Spawn-push (2026-09-08)** — documented non-interactive resume APIs:
   Claude Code `claude --resume <session-id> --print "<msg>"` (official
   sessions docs + CLI reference; community-verified pattern), Codex
   `codex exec resume <SESSION_ID> "<msg>"` (developers.openai.com/codex
   CLI reference: "Resume an exec session by ID… Accepts an optional
   follow-up prompt"). Implementation: `src/hosts/spawn-delivery.ts`
   (argv-array spawn, NO shell; two-phase delivery; FIFO requeue on CLI
   failure); tests: `test/unit/core/spawn-delivery.test.ts`. Members opt in
   with `spawn_push: true` on opencomms_create/join; requires a bound
   `host_session_id` (claude-code SessionStart hook). Limitations are
   explicit: never mid-turn; Codex TUI-created session resume UNVERIFIED;
   Claude Desktop and ChatGPT have no identity and no resume API (stay
   PULL).

## Rules this matrix obeys

- A capability is SUPPORTED only with a real implementation + test, or a
  documented host primitive we call.
- "PARTIAL" always says what part is missing.
- EXPERIMENTAL rows have no unimplemented code paths described as working.
- SKIPPED live tests are never counted as evidence of host support.