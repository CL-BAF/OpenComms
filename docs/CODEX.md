# Codex Adapter

Status: **PUSH for exec-compatible sessions; PULL otherwise.** OpenComms
integrates with Codex through the documented project MCP config (PULL
tools), optional trust-gated hooks, and — since 2026-09-08 — the
documented non-interactive resume (`codex exec resume <SESSION_ID>
"<prompt>"`, per developers.openai.com/codex/cli/reference) as a REAL push
channel when a member joins with `spawn_push=true`. OpenComms does NOT
inject into running TUI turns, does not automate the terminal UI, and
ships NO App Server client in v2. (Doc basis: developers.openai.com/codex
pages — mcp, config, hooks, cli reference — fetched 2026-08-29 /
2026-09-08.)

## What you get

| Capability | Status | How |
|---|---|---|
| Channel membership / PULL inbox / history / status | SUPPORTED | MCP tools via `[mcp_servers.opencomms]` |
| **Spawn-push delivery (exec sessions)** | SUPPORTED | join with `spawn_push=true`: senders run `codex exec resume <session-id> "<framed msg>"` (argv array, no shell). TUI-created-session resume is UNVERIFIED — the resume API documents exec sessions |
| Hook-boundary delivery | PARTIAL, OPT-IN | hooks exist but Codex skips untrusted hooks until you approve them in `/hooks` |
| Push into running TUI turn | UNSUPPORTED | no documented injection path; never attempted |
| Managed threads (App Server) | EXPERIMENTAL, DOCS-ONLY | no client shipped in v2 — nothing here claims it works |
| Role injection | PARTIAL | AGENTS.md is the supported per-project instruction surface |

## Install

```bash
opencomms install codex --project <project-dir>
# idempotently:
#   copies .opencomms/opencomms-mcp.mjs
#   appends [mcp_servers.opencomms] (+ .env pin placeholders) to
#   <project>/.codex/config.toml — never touching unrelated sections
```

Registration shape (matches the documented tables):

```toml
[mcp_servers.opencomms]
command = "node"
args = ["<abs path>/.opencomms/opencomms-mcp.mjs", "<abs project>", "--host", "codex"]
cwd = "."

[mcp_servers.opencomms.env]
OPENCOMMS_MEMBER_ID = "<set by: opencomms install-member>"
OPENCOMMS_MEMBER_ROLE = "<role label>"
```

- Absolute paths + explicit `cwd` are used because the launch cwd for
  project-scope stdio servers is not documented (the documented `cwd`
  option is used instead of assuming the project root).
- **Trusted projects only**: Codex reads project-scope config only for
  trusted projects. If tools don't appear, run `/trust` or move the server
  to user scope (`~/.codex/config.toml`).
- Then run `opencomms install-member --host codex` in the project, and
  create/join a channel via the tools (bootstrap allows the pinned member).

## Hooks (optional, user-controlled)

Codex supports hook events (SessionStart, UserPromptSubmit, Stop, ...)
with trust-gating: non-managed hooks are SKIPPED until reviewed via
`/hooks`. OpenComms deliberately registers NO hooks silently — if you want
boundary delivery on Codex, add hooks yourself mirroring the Claude Code
pattern and approve them in `/hooks`.

## Honest limits

- MCP tools are PULL: Codex calls `opencomms_*` when the model decides.
- Threads/sessions: OpenComms does not resume, fork, or manage Codex
  threads. If/when an App Server adapter lands, it will be a SEPARATE,
  clearly-labeled EXPERIMENTAL adapter and never presented as equivalent
  to linking your interactive TUI session.
- `AGENTS.md` remains the right place for standing Codex instructions;
  OpenComms role prompts live in channel state.

## Files & tests

- `src/adapters/codex/install.ts` (+ `CODEX_CAPABILITIES` honesty
  constants).
- Tests: `test/unit/core/codex-install.test.ts` — registration,
  idempotency, unrelated-config preservation, no-silent-hooks, absolute
  paths + explicit `cwd`, trusted-project warning.