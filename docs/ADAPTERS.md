# OpenComms Adapters

Adapters translate between one host and the host-neutral Core
(`src/core/*`). Adapters contain ONLY host translation logic — channel
logic, routing, persistence, and safety live in Core.

## The adapter contract

`src/hosts/contract.ts` defines `OpenCommsHostAdapter`:

- `initialize(ctx)` — MUST fail closed when identity cannot be verified.
- `getCurrentSession?()` — identity of the current host session/thread
  (`SessionIdentity`), or null when the host exposes none.
- `verifySession?(id)` — `true` verified / `false` verified-invalid /
  **`null` = CANNOT VERIFY = FAIL CLOSED** (core refuses membership
  mutations on null).
- `deliverMessage?` — PUSH delivery; returns `DeliveryOutcome`
  (`delivered | failed | requeued | unsupported`). Adapters never fake
  success.
- `pullMessages?` — PULL retrieval.
- `subscribeLifecycle?` — host lifecycle events.
- `shutdown()` — idempotent.

`HostCapabilities.roleInjection` is an enum, not a boolean:
`system-prompt` (persistent per-session instructions — OpenCode) |
`hook-boundary` (injected at hook fire points) | `none`.

Host capability profiles live in `src/hosts/profiles.ts` (single source of
truth; see docs/CAPABILITIES.md for the full matrix with citations).

**Member `host` values**: adapters pass an explicit host label
(`opencode`, `claude-code`, `claude-desktop`, `codex`, `chatgpt`,
`chatgpt-codex`). The literal value `generic` is the non-adapter fallback
used by legacy/direct core callers — it is NEVER a valid adapter id, and
production adapters must always pass an explicit host.

## Member identity models

OpenComms routes by its own opaque member ids (`sess_*`). Host identities
live in `member.host_session_id` and are NEVER used for routing.

- **OpenCode**: identity = the real OpenCode `ctx.sessionID`; child-session
  checks are adapter-side (fail closed on SDK lookup errors).
- **MCP hosts (Claude Code / Desktop / Codex — the pinned model)**: each MCP
  server process serves EXACTLY ONE member. The installer pins the member
  id:
  - `<project>/.opencomms/member-pin.json` — hook-side identity source
    (Claude Code hook commands carry no env block; the file is the
    production path). Machine-local identity data, same trust boundary as
    state.json.
  - `OPENCOMMS_MEMBER_ID` env in .mcp.json / config.toml — MCP-tool
    identity; env wins when present (override/multi-instance path).
  - `authorizeMember` validates the pin against the LIVE roster on every
    call: unpinned => denied; kicked member => pin immediately dead.
  - Tool arguments NEVER choose an identity — `to=`/`target=` name only
    OTHER members.
- **Claude Code namespace bridge**: hooks observe Claude's own session ids
  while MCP routes by member id. The SessionStart hook binds an UNBOUND
  pinned member to the live Claude session id (`member.host_session_id`),
  and delivery hooks resolve member-by-host-session (fail-closed on
  ambiguity). Env pin > pin file, then host_session_id index.

## Per-host notes

Detailed pages: [CLAUDE_CODE.md](CLAUDE_CODE.md),
[CLAUDE_DESKTOP.md](CLAUDE_DESKTOP.md), [CODEX.md](CODEX.md),
[CHATGPT.md](CHATGPT.md), [OPENCODE.md](OPENCODE.md).

## Shared MCP tool surface (all MCP hosts)

Registered per pinned-member instance by `src/mcp/opencomms-tools.ts`:

| Tool | Mutates | Notes |
|---|---|---|
| opencomms_create / join | yes | bootstrap: allowed for a pinned-but-not-rostered member |
| opencomms_send | yes | `to`/`broadcast`; never sends as another member |
| opencomms_status | no | member-scoped |
| opencomms_inbox | no | PREVIEW ONLY (does not consume) |
| opencomms_pull | yes | drains + marks delivered + UNTRUSTED framing |
| opencomms_history | no | member-scoped |
| opencomms_pause / resume | yes | channel-wide |
| opencomms_update_role | yes | own role only |
| opencomms_disconnect | yes | leaves channel; state retained |
| opencomms_kick | yes | **admin instances only** (desktop-facing default OFF) |

All mutating calls run under the cross-process state lock; reads are
lock-free. `opencomms_kick` follows the engine's Builder-only policy.