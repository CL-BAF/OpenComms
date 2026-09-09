# OpenComms

> A host-neutral, project-local communication layer for AI coding agents.
> Link sessions you already have open - OpenCode, Claude Code, Claude Desktop,
> Codex - into shared multi-agent channels, without creating, owning, or
> replacing any session.

```
npm install && npm run build
node install.mjs C:\path\to\your\project        # install the OpenCode plugin
```

**Version 1.0.0** | TypeScript | MIT | OpenCode >= 1.18.0 (verified against 1.18.25)

---

## Why OpenComms

Multi-agent coding workflows break down at coordination. OpenComms solves one
problem well: **reliable, safe communication between agent sessions that already
exist** - across tabs, terminals, and providers.

- **Link-only.** OpenComms never creates, replaces, or deletes host sessions.
  Linked sessions keep their own history, model, and permissions.
- **Autonomous, not runaway.** Messages deliver when a recipient is actually
  available (idle wake, session resume, or pull), so agents can hold multi-turn
  conversations without a human pressing Enter on each one. Loop protection
  (dedup, rate limits, hop caps, cooldowns) keeps autonomy bounded.
- **Provider-independent core.** A channel is a shared OpenComms space, not a
  provider session. Native provider sessions are delivery endpoints only.
  Any mix of hosts can share one channel.
- **Honest about limits.** Where a host cannot do something, OpenComms reports
  UNSUPPORTED instead of faking parity. See
  [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for the evidence-backed matrix.

## Supported hosts

| Host | Setup | Status | How members receive messages |
|------|-------|--------|------------------------------|
| **OpenCode** | plugin (auto-installer) | **FULL** (reference adapter) | **PUSH** - delivered automatically when the session is idle; full autonomous agent-to-agent loops |
| **Claude Code** | hooks + MCP: `opencomms install claude-code` | **PUSH** (spawn-resume) | `claude --resume <id> --print "<msg>"` (documented non-interactive resume); join with `spawn_push=true`. Also hook-boundary delivery + `opencomms_pull`. Never mid-turn |
| **Codex CLI** | `config.toml` MCP: `opencomms install codex` | **PUSH** (exec-compatible sessions) | `codex exec resume <id> "<msg>"` (documented continuation); join with `spawn_push=true`. TUI-created-session resume is UNVERIFIED. Otherwise `opencomms_pull` |
| **Claude Desktop** | `.mcpb` extension bundle | **PULL** (platform limit) | The agent calls `opencomms_pull`. Desktop exposes no session identity and no push path - a platform limitation, not an OpenComms one |
| **ChatGPT** (web/desktop) | remote MCP (operator-hosted) | **BLOCKED** by platform requirements | Would be PULL via a public HTTPS MCP endpoint; ChatGPT requires operator-hosted OAuth - [docs/CHATGPT.md](docs/CHATGPT.md) |

Any mix of these hosts can share one channel. Delivery mode is explicit per
member (`push | spawn_push | pull | poll | managed_thread`), with per-member
**endpoint capabilities** (`push/pull/resume/queue_while_busy/interrupt`)
derived from the mode and overridable. Autonomous multi-turn messaging is
verified on OpenCode (CLI-to-CLI and Desktop,
[docs/OPENCODE.md](docs/OPENCODE.md)); Claude Code / Codex spawn-push is
argv-contract-verified and unit-tested but NOT yet live-verified against
the vendor CLIs (guarded live test pending). Windows note: npm-distributed
CLIs are `.cmd` shims that Node refuses to spawn without a shell — set
`OPENCOMMS_CLAUDE_BIN` / `OPENCOMMS_CODEX_BIN` to a native executable or a
command template (e.g. `OPENCOMMS_CODEX_BIN="node C:\path\to\codex.js"`);
oversized batches are refused before spawning (30k-char Windows command
line; never truncated).

## Session lifecycle: save, resume as new, delete, description

An OpenComms **session** (= channel = conversation) has a lifecycle:
`active → saved (archived) → deleted`.

- **Save** (NOT delete): stops autonomous activity and archives everything
  OpenComms received — description, the agent-supplied structured summary,
  final roster with role prompts, and the full message history — into
  `.opencomms/archives/<id>.json`; live state is purged.
- **Resume as new**: `opencomms session resume <name> [--as <new-name>]`
  creates a NEW active session linked to the archive (`parent_channel_id`);
  joiners receive the COMPACT archived context (purpose/summary/roster) —
  **never the full transcript**; agents query it via `opencomms_archive`
  (mode=summary|messages) when they need depth. Session evolution example:
  design → implementation → security review → GUI dev.
- **Delete**: destructive (live state AND archive); active sessions require
  a member, saved sessions are operator-managed; `--confirm` required.
- **Description**: set ONCE by the first responding agent — pass
  `session_description` (≤140 chars) with any `opencomms_send`; later
  values are ignored; failures never break the session.

Operator CLI (provider-independent backend surface, GUI-ready):

```bash
opencomms session list|get|save|delete|resume
opencomms join-command <session> [--host opencode|claude-code|codex]
opencomms install-member --host claude-code --name architect   # human member ids
```

## Quick start (OpenCode, two tabs)

1. **Install the plugin** (from the repo root):

   ```bash
   node install.mjs C:\path\to\your\project
   ```

   The installer builds `dist/` if needed, copies the plugin into the
   project's `.opencode/plugins/`, and registers it in `opencode.json`
   (idempotent; existing config preserved).

2. **Create a channel** in the first OpenCode tab:

   ```text
   /OpenComms Create Channel=my-feature As=Builder [Implement requests, verify your work, and send completed work to Reviewer with a summary, changed files, verification results, and uncertainties.]
   ```

3. **Join from the second tab** (same project, another root session):

   ```text
   /OpenComms Join Channel=my-feature As=Reviewer [Independently inspect Builder's work. Send prioritized findings with locations, impact, expected fixes, and verification steps. Return PASS only when no material defects remain.]
   ```

Both tabs remain ordinary OpenCode sessions. When Builder sends a review
request, Reviewer's session receives and processes it automatically when idle -
no manual wake-up - and Reviewer's reply reaches Builder the same way.

OpenComms rejects: joining the same session twice, one session holding two
roles, replacing a member without confirmation, linking child sessions (root
sessions only), and linking sessions from incompatible projects or worktrees.

## Multi-agent channels

Channels are not limited to two members. Up to `max_members` (default 8) agents
with **any open-vocabulary role labels** share one channel and one history:
Coordinator / Backend / Frontend / Security / Test / Reviewer, or any shape you
need.

- **Targeting:** `opencomms_send` with `to=<session_id|role>` reaches exactly
  one member; `broadcast=true` fans out to every other member. On a 3+ member
  channel an omitted target is an **error**, never a guess.
- **Cross-host members:** Claude Code / Claude Desktop / Codex agents join the
  same channels through the OpenComms MCP tools with per-member pinned
  identities (`.opencomms/pins/<member_id>.json`) - see
  [docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md) and [docs/CODEX.md](docs/CODEX.md).
- **CLI-to-CLI autonomy:** every OpenCode TUI/`serve` process runs its own
  server, so delivery is **owner-side**: each instance prompts only the sessions
  it hosts, and a file-watch wake routes mail queued by another process to the
  recipient's own instance. Topology matrix and lab evidence:
  [docs/OPENCODE.md](docs/OPENCODE.md).

## Commands

Slash command (user-facing, deterministic parsing - the model never interprets
channel names or roles loosely):

```text
/OpenComms Create    Channel=<name> As=<role> [role instructions]
/OpenComms Join      Channel=<name> As=<role> [role instructions]
/OpenComms Status    [Channel=<name>]
/OpenComms Inbox     Channel=<name>
/OpenComms History   Channel=<name>
/OpenComms Pause | Resume | Disconnect    Channel=<name>
/OpenComms UpdateRole Channel=<name> [new role instructions]
/OpenComms Kick      Channel=<name> Target=<member_id|role>
/OpenComms Timer     Channel=<name> Action=<start|stop|switch|reset|status|set_limit|clear_limit> [LimitMs=<ms>] [LimitRole=<role>]
```

`LimitRole=<role>` is an alias of the member-targeting parameter
`to=<role|session-id>`; timers are keyed per member.

Agents call the same operations as deterministic tools:
`opencomms_create`, `opencomms_join`, `opencomms_send`, `opencomms_status`,
`opencomms_inbox`, `opencomms_history`, `opencomms_update_role`,
`opencomms_pause`, `opencomms_resume`, `opencomms_disconnect`,
`opencomms_timer` (+ `opencomms_kick` on privileged hosts). Full schemas:
[docs/TOOLS_AND_COMMANDS.md](docs/TOOLS_AND_COMMANDS.md).

Shared CLI for setup on any host:
`opencomms install | install-member | uninstall | doctor | status | channels | members | version`.

Role prompts (the bracketed text) are injected as persistent system instructions
before every model dispatch - they are not pasted into visible conversation
history. Role prompts guide behavior; they are **not a security boundary**.

## Delivery, safety, and loop protection

**Delivery model.** A message crosses sessions only when an agent explicitly
calls `opencomms_send` - OpenComms never auto-forwards assistant responses.
Delivery is two-phase: a message is marked delivered only after the host session
actually accepted it, a startup sweep recovers anything stranded by a crash, and
failed deliveries requeue in original FIFO order.

**Busy recipients.** OpenComms never overlaps prompts in one session. Messages
to a busy session queue as pending and deliver when it becomes idle - FIFO
order, at most once, visible in `opencomms_status`.

**Loop protection (defaults, all configurable per channel):**

| Protection | Default |
|------------|---------|
| Duplicate content rejection | 5-minute window, per sender |
| Rate limit | 20 messages/minute/channel |
| Delivery cooldown | 1s per recipient |
| Reply-chain hop cap | 4 hops |
| Stale-event rejection | 5 minutes |

**Untrusted peers.** Peer content is framed inside
`<<<UNTRUSTED_PEER_MESSAGE>>>` markers with provenance and treated as data, not
instructions. Peer messages cannot modify channel configuration, permissions,
role ownership, or safety rules. Threat model:
[docs/SECURITY.md](docs/SECURITY.md).

**Pause / Resume / Disconnect / Kick:**

```text
/OpenComms Pause Channel=my-feature       # nothing is delivered
/OpenComms Resume Channel=my-feature      # pending messages deliver on next idle
/OpenComms Disconnect Channel=my-feature  # remove this session; channel survives for others
/OpenComms Kick Channel=my-feature Target=Reviewer   # privileged removal, session itself is untouched
```

No OpenCode sessions are ever created or deleted by these operations.

## Persistence and privacy

State lives at `<project>/.opencomms/state.json` (schema v2), written
atomically (temp file + rename) so a crash mid-write never corrupts channels or
queues. Corrupt state recovers automatically: OpenComms starts fresh and records
the error in `opencomms_status` instead of bricking. The `.opencomms/` directory
is created on first use and should be gitignored.

After a restart, OpenComms restores channel metadata, validates linked sessions,
marks vanished sessions stale (visible in status), and lets you rejoin or repair
- it never silently creates a replacement session.

OpenComms does not expose provider credentials, API keys, environment secrets,
unrelated session content, other channels' messages, or private host
configuration.

**Upgrading from 1.x:** the first run of the new version migrates
`.opencode-comms/state.json` (v1) to `.opencomms/state.json` (v2) automatically
- backup + `MIGRATED_FROM_V1` marker, channels/queues/timers preserved. Do not
run the pre-1.x plugin afterwards. Details: [docs/MIGRATION.md](docs/MIGRATION.md).

**Permissions:** OpenComms does not pretend that role prompts enforce read-only
behavior. If a member must be permission-restricted, configure that on the
session before linking it.

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| `Channel "X" already exists` | `/OpenComms Join` it, or disconnect then recreate. |
| `This session is already registered` | One session cannot hold two roles on one channel. Use a different root session. |
| `Session ... is a child session` | Only root sessions can be linked. Open a root session. |
| `belongs to a different project/worktree` | Both sessions must share the project and worktree. |
| `peer session is marked stale` | The peer session no longer exists after a restart. Rejoin or repair. |
| `Rate limit exceeded` | Default 20/min/channel. Wait, or pause to reset. |
| `Duplicate message content detected` | Same content twice within 5 minutes. Vary the content or wait. |
| `maximum hop count` | A reply chain exceeded 4 hops. Start a new message. |
| Spawn-push fails with spawn errors | The CLI must be resolvable and spawnable. Set `OPENCOMMS_CLAUDE_BIN` / `OPENCOMMS_CODEX_BIN` when the binary is not on PATH; note that Windows npm `.cmd` shims cannot be spawned directly (Node refuses without a shell) - point the override at a native executable OR a command template (e.g. `OPENCOMMS_CODEX_BIN="node C:\path\to\codex.js"`). Batches over the argv budget are refused before spawning. Adapter limits: [docs/CODEX.md](docs/CODEX.md). |
| Plugin not loading | Ensure `dist/plugin.js` is in `.opencode/plugins/` or referenced in `opencode.json`; run `npm run build`. |
| `state.json` corrupt | Recovers automatically (fresh state + recorded error). Delete the file to reset. |

## Requirements

- Node.js >= 20 (dependencies target Node 22 types)
- OpenCode >= 1.18.0 for the OpenCode adapter (tested against
  `@opencode-ai/plugin`/`sdk` 1.18.23; runtime behavior verified against
  OpenCode 1.18.25, including the two-server CLI-to-CLI topology lab)
- Claude Code CLI / Codex CLI for those adapters (capability detection reports
  honestly when absent)

## Development

```bash
npm install
npm run build          # tsc -> dist/ + esbuild bundle
npm run typecheck      # strict TS, noUncheckedIndexedAccess
npm run test           # unit tests
npm run test:contract  # adapter-contract / host-neutrality tests
npm run audit          # dependency audit (0 known vulns at release)
npm run format:check   # prettier gate
```

The live integration test (`test/live/live.test.ts`) is **guarded**: it skips
when no OpenCode server is reachable, so CI never fails on it. To run it for
real against a running OpenCode server:

```powershell
$env:OPENCODE_SERVER_URL = "http://127.0.0.1:4096"
$env:OPENCODE_SERVER_PASSWORD = "<your password>"
$env:OPENCOMMS_LIVE_PROJECT = "C:\path\to\your\project"
# optional: enables the autonomous no-manual-wake scenario (needs a tool-capable model)
$env:OPENCODE_LIVE_MODEL = "openai/qwen3:0.6b"
npm run test:live
```

Skipped live tests are never counted as evidence of host support.

OpenComms is developed and tested on **Windows first** (Windows-safe atomic
writes, PowerShell examples); macOS and Linux are supported by the same code
paths.

## Project layout

| Path | Role |
|------|------|
| `src/core/` | Host-neutral core: types, atomic store, deterministic engine (routing, queues, two-phase delivery) |
| `src/plugin.ts` | OpenCode adapter: tools, hooks, slash command |
| `src/hosts/` | Delivery controllers + capability profiles (per-host, never in core) |
| `src/mcp/` | Shared MCP stdio server + identity-pinned OpenComms tools |
| `src/adapters/` | Claude Code / Claude Desktop / Codex / ChatGPT installers + hooks |
| `src/cli/main.ts` | `opencomms` CLI |
| `test/unit/` | Unit tests (engine, store, adapters, CLI, MCP, spawn delivery) |
| `test/contract/` | Host-neutrality + capability-consistency contracts |
| `test/live/` | Guarded live integration test |
| `docs/` | Architecture, API reference, per-host guides, security model |

## Documentation

| Document | Contents |
|----------|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Data flow, lifecycle, invariants, daemon/SQLite decision |
| [docs/API_REFERENCE.md](docs/API_REFERENCE.md) | Full function signatures (`file:line`) |
| [docs/TOOLS_AND_COMMANDS.md](docs/TOOLS_AND_COMMANDS.md) | Tool schemas + slash command spec |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | Evidence-backed per-host capability matrix |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Adapter contract + pinned-identity model |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | Delivery state machine + identity rules |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model + injection defenses |
| [docs/MIGRATION.md](docs/MIGRATION.md) | v1 -> v2 state migration |
| [docs/OPENCODE.md](docs/OPENCODE.md) | OpenCode topology + autonomy evidence |
| [docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md) | Claude Code adapter guide (hooks, MCP, multi-member pins) |
| [docs/CLAUDE_DESKTOP.md](docs/CLAUDE_DESKTOP.md) | Claude Desktop (.mcpb) guide |
| [docs/CODEX.md](docs/CODEX.md) | Codex CLI adapter guide |
| [docs/CHATGPT.md](docs/CHATGPT.md) | ChatGPT requirements + blocked status |

`AGENTS.md` is a token-efficient entry point for AI coding assistants working in
this repository.

## License

MIT
