# Claude Code Adapter

Status: **PARTIAL, honest** — OpenComms links a running Claude Code session
to shared channels via hooks (identity + delivery boundaries) and the MCP
server (tools). Delivery is boundary-based, never mid-turn. (Doc basis:
hooks & MCP references fetched 2026-08-29.)

## What you get

| Capability | Status | How |
|---|---|---|
| Channel membership | SUPPORTED | MCP tools (create/join) with pinned identity |
| **Spawn-push delivery** | SUPPORTED | join with `spawn_push=true`: senders resume your session via `claude --resume <session-id> --print "<framed message>"` (documented non-interactive resume). Requires the SessionStart hook to have bound `host_session_id`. Serialized per member; failures requeue in FIFO |
| Hook-boundary delivery | SUPPORTED | queued messages injected via `additionalContext` at SessionStart / UserPromptSubmit / Stop |
| Pull inbox | SUPPORTED | `opencomms_pull` / `opencomms_inbox` (MCP) |
| Push into a MID-TURN session | UNSUPPORTED | no host API — a live turn cannot be interrupted or appended to mid-flight |
| Role injection | PARTIAL | SessionStart boundary only (not persistent system prompt) |
| Cross-host channels | SUPPORTED | same state file as every other adapter; OpenCode/Codex peers push to you when `spawn_push=true` |

## Install

```bash
opencomms install claude-code --project <project-dir>
# registers (idempotently):
#   .opencomms/{claude-code-hooks.mjs, opencomms-mcp.mjs}
#   .claude/settings.json hooks (merged; unrelated keys preserved)
#   .mcp.json  opencomms MCP server (project scope)
```

Then, inside a Claude Code session in that project:

```bash
opencomms install-member --host claude-code
# writes .opencomms/pins/<member_id>.json (machine-local identity data)
```

**Multi-member identity (per-member pins):** each member gets its OWN pin
file; a second `install-member` run WITHOUT `--id` REFUSES (it would
otherwise orphan the first member). Add another member with
`install-member --id <member_id>`. The SessionStart hook binds a pinned
member to the live Claude session (host_session_id) only when EXACTLY ONE
pinned claude-code member is unbound — with several unbound pins the bind
is ambiguous, so nothing auto-binds and the hook emits guidance instead
(bind members one at a time: install -> start session -> install next, or
set OPENCOMMS_MEMBER_ID for the session). This is the identity bridge
between the MCP member namespace and Claude's session ids, fail-closed by
design: one member's pin can never authorize another member's drains — and
it is also the targeting key for spawn-push delivery. When joining a
channel, pass `spawn_push=true` to `opencomms_create`/`opencomms_join` so
peers can resume your session and push messages immediately.

## Hook events used (verified names, 2026-08-29)

- `SessionStart` — binds pin->session, clears staleness, drains queued
  messages (`hookSpecificOutput.additionalContext`).
- `UserPromptSubmit` — drains queued messages at the next prompt boundary.
- `Stop` — drains at turn end (last boundary before idle).
- `SessionEnd` — marks the member stale (cleared again at next
  SessionStart).

All hooks FAIL OPEN: any OpenComms error exits 0 with empty output and
never blocks the host session. Hook command strings use the documented
`${CLAUDE_PROJECT_DIR}` placeholder; `%VAR%` is undocumented and never
used.

## Honest limits

- Messages arrive at the NEXT hook boundary — never mid-turn. An
  unattended session sees nothing until the user interacts or restarts.
- MCP tools receive NO session identity from the host; identity is the
  pinned member (file/env), and hooks corroborate the live session.
- Role instructions are injected at SessionStart boundary, not as a
  persistent system prompt.
- Cross-session messaging sockets and MCP "channels" (Claude's other
  push-adjacent mechanisms) were NOT re-verified for production use; the
  adapter does not depend on them (see CAPABILITIES.md rules).

## Files & tests

- `src/adapters/claude-code/hooks.ts` (async handlers, fail-open),
  `hook-cli.ts` (installed runner), `install.ts` (idempotent, merge-only).
- `adapters/claude-code/` plugin manifest, hooks.json, mcp-config.json,
  slash command.
- Tests: `test/unit/core/claude-hooks.test.ts` (child-process, REAL
  production wiring: pin file, no env injection), `mcp-server.test.ts`
  (JSON-RPC transport), `mcp-identity.test.ts` (pin authorization).