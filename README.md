# OpenComms

> A host-neutral, project-local **TypeScript communication platform for coding agents** — link existing sessions from OpenCode, Claude Code, Claude Desktop, and Codex into named channels with open role vocabulary (the classic pair being Builder + Reviewer) — **without creating, owning, or replacing any sessions**.

OpenComms v2 is a shared Core + thin host adapters:

- **OpenCode** (plugin; PUSH delivery on idle) — the reference adapter
- **Claude Code** (hooks + MCP; hook-boundary delivery, PULL tools)
- **Claude Desktop** (.mcpb extension; strictly PULL)
- **Codex** (config.toml MCP + optional trust-gated hooks; strictly PULL)
- **ChatGPT** (remote-MCP scaffold — deliberately not a working integration without operator-hosted auth)

Delivery modes are explicit per member (`push | pull | poll |
managed_thread`); capabilities are honest (see
[docs/CAPABILITIES.md](docs/CAPABILITIES.md)) — where a host cannot do
something, OpenComms says UNSUPPORTED instead of faking parity. Shared
CLI: `opencomms install|install-member|uninstall|doctor|status|channels|
members|version`. Threat model: [docs/SECURITY.md](docs/SECURITY.md).

## Table of Contents

- [What it does](#what-it-does)
- [Installation](#installation)
- [Windows / OpenCode Desktop setup](#windows--opencode-desktop-setup)
- [The two-tab pairing workflow](#the-two-tab-pairing-workflow)
- [Multi-agent channels (3-8 members) and CLI-to-CLI autonomy](#multi-agent-channels-3-8-members-and-cli-to-cli-autonomy)
- [Command examples](#command-examples)
- [Personalized role-prompt examples](#personalized-role-prompt-examples)
- [How messages are delivered](#how-messages-are-delivered)
- [How independent prompting works](#how-independent-prompting-works)
- [Queue, status, pause, resume, and disconnect](#queue-status-pause-resume-and-disconnect)
- [Persistence and privacy](#persistence-and-privacy)
- [Permission limitations](#permission-limitations)
- [Troubleshooting](#troubleshooting)
- [Supported OpenCode versions](#supported-opencode-versions)
- [Development and live-test instructions](#development-and-live-test-instructions)

## What it does

OpenComms connects **root host sessions that you have already opened** for the same project — OpenCode sessions in separate tabs (or CLI terminals), plus members from Claude Code, Claude Desktop, and Codex via the shared MCP tools. Channels hold **2-8 members** under any open role labels (the classic pair being Builder + Reviewer). It never silently creates replacement sessions. All linked sessions remain:

- Visible in OpenCode Desktop
- Independently accessible in their original tabs
- Independently promptable by you
- Backed by their existing conversation histories
- In control of their own model and agent selections

OpenComms only coordinates communication between them.

## Installation

### From Git

```bash
git clone https://github.com/CL-BAF/OpenComms.git OpenComms
cd OpenComms
npm install
npm run build
```

This produces `dist/` with the compiled plugin. The entry point is `dist/plugin.js` (`export default OpenCommsPlugin`).

### Project-local installation

The bundled installer builds the plugin, copies it into your project's `.opencode/plugins/` directory, and patches your `opencode.json` to register it â€” all in one command:

```bash
# from the OpenComms repo root
node install.mjs C:\path\to\your\project
```

Or via npm script:

```bash
npm run install:plugin -- C:\path\to\your\project
```

The installer:
- Runs `npm run build` automatically if `dist/` is missing
- Copies `dist/*` into `<target>/.opencode/plugins/`
- Adds `".opencode/plugins/plugin.js"` to the `plugin` array in `<target>/opencode.json` (or `opencode.jsonc`)
- Preserves all existing config and never duplicates the entry on re-runs (idempotent)

If no target directory is given, it installs into the current working directory.

If you prefer to wire it manually instead, copy the built plugin into your project and reference it in `opencode.json`:

```text
<your-project>/
â””â”€â”€ .opencode/
    â””â”€â”€ plugins/
        â””â”€â”€ opencomms.js   # copy of dist/plugin.js (+ dist/*.js)
```

```jsonc
{
  "plugin": ["../path/to/OpenComms/dist/plugin.js"]
}
```

## Windows / OpenCode Desktop setup

OpenComms is developed and tested on Windows. It uses Windows-safe atomic file writes (temp file + rename with a retry fallback for antivirus/OneDrive handle races). No extra configuration is required beyond installing the plugin and ensuring OpenCode Desktop can resolve your project directory.

State is stored at:

```text
<project>\.opencomms\state.json
```

This directory is created on first use and should be added to `.gitignore`.

## The two-tab pairing workflow

### First tab â€” create the channel

Open a normal OpenCode session in your project and run:

```text
/OpenComms Create Channel=my-feature As=Builder [Implement the user's requests, verify your work, and send completed work to Reviewer with a summary, changed files, verification results, and uncertainties.]
```

The plugin obtains the current tab's real session ID from the tool execution context and registers **that exact existing session** as `Builder` on channel `my-feature`. No new session is created.

### Second tab â€” join the channel

Open another normal root session in the **same project** and run:

```text
/OpenComms Join Channel=my-feature As=Reviewer [Independently inspect Builder's work. Send prioritized findings with locations, impact, expected fixes, and verification steps. Return PASS only when no material defects remain.]
```

The plugin registers the second tab's exact session as `Reviewer`. After joining, both original tabs remain ordinary, usable OpenCode sessions.

OpenComms rejects:

- Joining the same session twice
- Using one session for both roles
- Replacing an existing channel member without confirmation
- Linking a child session (only root sessions may be linked)
- Linking sessions from incompatible projects or worktrees
- Joining a nonexistent, paused, or closed channel incorrectly

## Multi-agent channels (3-8 members) and CLI-to-CLI autonomy

Channels are **not** limited to Builder + Reviewer. Up to `max_members` (default 8) agents with any open-vocabulary roles — Coordinator / Backend / Frontend / Security / Test / Reviewer, or Architect / Implementation A / Implementation B / Test / Reviewer — share one channel and one message history:

- **Targeting:** `opencomms_send` with `to=<session_id|role>` reaches exactly one member; `broadcast=true` fans out to every other member. On a 3+ member channel an omitted target is an **error**, never a guess. On a two-member channel the single peer is implied (classic workflow unchanged).
- **Cross-host members:** Claude Code / Claude Desktop / Codex agents join the same channels through the OpenComms MCP tools with per-member pinned identities (`.opencomms/pins/<member_id>.json` — see [docs/CLAUDE_CODE.md](docs/CLAUDE_CODE.md)); delivery mode (`push`/`pull`) is explicit per member.
- **CLI↔CLI autonomy:** every `opencode` TUI/`serve` runs its own server + plugin instance, so delivery is **owner-side** — each instance prompts only its own sessions, and an fs-watch wake makes the recipient's own instance pick up mail the moment another process queues it. Verified against OpenCode 1.18.25 (Desktop↔Desktop, headless↔headless, and two-server CLI↔CLI: recipient's turn always executes on the recipient's own server). Topology matrix + evidence: [docs/OPENCODE.md](docs/OPENCODE.md).

## Command examples

```text
/OpenComms Create Channel=<name> As=<Builder|Reviewer> [role instructions]
/OpenComms Join    Channel=<name> As=<Builder|Reviewer> [role instructions]
/OpenComms Status  [Channel=<name>]
/OpenComms Pause   Channel=<name>
/OpenComms Resume  Channel=<name>
/OpenComms Disconnect Channel=<name>
/OpenComms UpdateRole Channel=<name> [new role instructions]
/OpenComms Inbox   Channel=<name>
/OpenComms History Channel=<name>
/OpenComms Timer   Channel=<name> Action=<start|stop|switch|reset|status|set_limit|clear_limit> [LimitMs=<ms>] [LimitRole=<Builder|Reviewer>]

> `LimitRole=<role>` is an alias of the member-targeting parameter `to=<role|session-id>` — timers are keyed **per member** (by session id), and `LimitRole` maps to the same lookup by role label.
```

The equivalent deterministic tools are also available to the agents directly:

```text
opencomms_create
opencomms_join
opencomms_send
opencomms_status
opencomms_inbox
opencomms_history
opencomms_update_role
opencomms_pause
opencomms_resume
opencomms_disconnect
opencomms_timer
```

Arguments are parsed deterministically in plugin code. The slash command only forwards raw arguments to the matching tool â€” it does not rely on the model to interpret channel names, roles, or instructions loosely.

## Personalized role-prompt examples

The text inside the square brackets during `Create` and `Join` is the **persistent role prompt** for that session. It is injected via OpenCode's `experimental.chat.system.transform` hook before every model dispatch, so it applies to ordinary user prompts, peer messages, and subsequent turns â€” without being pasted into visible conversation history.

```text
/OpenComms Create Channel=auth-feature As=Builder [You are the Builder. Implement the user's requests exactly. After each change, run the test suite and send a review request to Reviewer containing: a one-paragraph summary, the list of changed files with line ranges, verification results, and any uncertainties. Do not modify files outside src/. When you disagree with Reviewer, explain why and wait for the user.]

/OpenComms Join Channel=auth-feature As=Reviewer [You are the Reviewer. Independently inspect Builder's work without trusting their summary. Send prioritized findings with: file:line locations, severity, impact, the expected fix, and a verification step. Return PASS only when no material defects remain. Never edit files yourself. If Builder is stuck, report to the user.]
```

Role prompts guide model behavior but are **not a security boundary**.

## How messages are delivered

The Builder calls:

```text
opencomms_send({
  channel: "my-feature",
  type: "review_request",
  content: "Implementation is ready. Changed files: ... Verification: ..."
})
```

OpenComms uses the injected OpenCode client and the session prompt API to deliver a labelled message to the **already-linked Reviewer session**. The message appears in the Reviewer session's normal history and triggers a Reviewer turn when the session is available. Delivery is **two-phase**: a message is only marked delivered when the host session actually accepted the prompt (crash-safe, startup sweep recovers stranded messages), and it is always wrapped in `<<<UNTRUSTED_PEER_MESSAGE>>>` framing as untrusted data.

The Reviewer responds with:

```text
opencomms_send({
  channel: "my-feature",
  type: "review_response",
  content: "CHANGES_REQUIRED: ..."
})
```

OpenComms delivers that to the existing Builder session.

**OpenComms never automatically forwards every assistant response.** A message crosses to the other session only when an agent explicitly calls `opencomms_send` (or you enable a specific, documented communication rule). This prevents uncontrolled agent-to-agent loops.

## How independent prompting works

You can prompt either linked session manually at any time:

- Ask Builder to implement something
- Ask Reviewer an unrelated question
- Ask Reviewer to inspect work manually
- Correct either agent
- Change either role prompt (`/OpenComms UpdateRole`)
- Pause communication (`/OpenComms Pause`)
- Send a manual message to the peer (via `opencomms_send`)
- Disconnect the channel (`/OpenComms Disconnect`)

OpenComms does **not** start a permanent autonomous coder/reviewer loop. It is a communication layer between user-controlled sessions.

## Queue, status, pause, resume, and disconnect

**Busy sessions:** OpenComms never overlaps prompts in one session. If the recipient is busy, messages are:

- Queued and marked pending
- Delivered after the session becomes idle
- Preserved in FIFO order
- Delivered at most once (deduplicated)
- Reported via `opencomms_status`

OpenComms never interrupts a user-authored turn, discards a message silently, delivers the same message twice, lets a late event reactivate a paused channel, or lets a disconnected channel continue sending.

**Loop prevention:** unique message IDs, deduplication, correlation IDs, configurable maximum hop count (default 4), repeated-content detection, per-channel rate limits (default 20/min), pause/resume controls, delivery cooldowns (1s), and stale-event rejection (5min).

**Pause / Resume:**

```text
/OpenComms Pause Channel=my-feature      # no messages delivered
/OpenComms Resume Channel=my-feature     # pending messages deliver on next idle
```

**Disconnect:** removes the current session from the channel. The channel remains for the other member, or is removed if empty. **No OpenCode sessions are ever deleted.**

## Chess-clock timer

Each channel has a **chess-clock timer** that tracks cumulative active time **per member** (keyed by session id). When Builder sends a message, Builder's clock stops and the primary recipient's starts automatically. This lets you give the agents a hard time budget and let them self-limit.

```text
/OpenComms Timer Channel=feat Action=start                                    # start your clock
/OpenComms Timer Channel=feat Action=status                                    # read elapsed + limit
/OpenComms Timer Channel=feat Action=set_limit LimitMs=600000                  # 10 min total cap
/OpenComms Timer Channel=feat Action=set_limit LimitMs=300000 LimitRole=Builder # 5 min Builder-only cap (LimitRole is an alias of to=<role>)
/OpenComms Timer Channel=feat Action=clear_limit                                # remove the cap
/OpenComms Timer Channel=feat Action=stop                                      # stop the clock
/OpenComms Timer Channel=feat Action=reset                                     # zero everything
```

The timer auto-switches on every `opencomms_send` (sender stops, primary recipient starts). The `status` action returns a member-keyed report so agents can check it and decide whether to continue:

```json
{
  "active_member_id": "sess_b",
  "elapsed_ms_by_member": { "sess_a": 45123, "sess_b": 10250 },
  "elapsed_ms_by_role": { "Builder": 45100, "Reviewer": 10250 },
  "total_ms": 55350,
  "limit_ms": 600000,
  "limit_member_id": null,
  "limit_reached": false
}
```

`elapsed_ms_by_member` and `total_ms` always include the **running** segment for the member currently on the clock â€” no need to stop the timer first to read accurate numbers.

## Persistence and privacy

State is stored at `<project>/.opencomms/state.json` (schema v2) and is written atomically (temp file + rename) so a crash mid-write never corrupts a channel or queue. After restarting OpenCode Desktop, OpenComms:

- Restores channel metadata
- Validates whether linked sessions still exist
- Marks missing sessions as stale (reported via `opencomms_status`)
- Allows you to rejoin or repair the channel
- **Never creates a replacement session automatically**
- **Never deletes existing OpenCode sessions**

OpenComms does not expose provider credentials, API keys, environment secrets, unrelated session content, messages from other channels, or private OpenCode configuration. Peer message content is treated as untrusted input subordinate to your current instruction, OpenCode permissions, channel policy, and the recipient's role prompt. Peer content cannot modify channel configuration, permissions, role ownership, or safety rules unless you explicitly authorize it.

## Upgrading from 1.x

If you used OpenComms 1.x (OpenCode-only plugin), your existing state migrates automatically:

- The first run of the new version reads the legacy `<project>/.opencode-comms/state.json` (schema v1), backs it up as `.opencomms/state.v1.bak.json`, and writes the new `<project>/.opencomms/state.json` (schema v2). Channels, members, queues, and timers are preserved; the legacy file is left untouched.
- A `MIGRATED_FROM_V1` marker prevents re-migration.
- **Do not run the pre-1.x plugin after migrating**: it reads only the legacy dir and would see stale (pre-migration) state. The new installer replaces the old plugin file in the same step; if you kept a manual copy, remove it.

## Permission limitations

If a role is meant to be read-only, investigate whether your OpenCode version can safely apply or update permissions on an **existing** session. If existing-session permissions cannot be changed safely, OpenComms does **not** pretend that prompt instructions enforce read-only behavior. Create/configure the session with the appropriate permissions separately before linking it.

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| `Channel "X" already exists` | Use `/OpenComms Join` to join it, or `/OpenComms Disconnect` then recreate. |
| `This session is already registered` | One session cannot hold two roles on the same channel. Use a different root session. |
| `Session ... is a child session` | OpenComms only links root sessions. Open a root session (no parent). |
| `belongs to a different project/worktree` | Both sessions must be in the same project and worktree. |
| `peer session is marked stale` | The peer's session no longer exists after a restart. Rejoin or repair the channel. |
| `Rate limit exceeded` | Default is 20 messages/minute/channel. Wait, or pause to reset. |
| `Duplicate message content detected` | Same content sent twice within 5 minutes. Vary the content or wait. |
| `maximum hop count` | A reply chain exceeded 4 hops. Start a new message instead of replying. |
| Plugin not loading | Ensure `dist/plugin.js` is in `.opencode/plugins/` or referenced in `opencode.json`. Run `npm run build`. |
| `state.json` corrupt | OpenComms recovers automatically (starts fresh, records the error in `opencomms_status`). Delete the file to reset. |

## Supported OpenCode versions

- **OpenCode:** `>=1.18.0`
- **Tested against:** `@opencode-ai/plugin` and `@opencode-ai/sdk` `1.18.23`; runtime behavior verified against OpenCode `1.18.25` (including the two-server CLI↔CLI topology lab)
- Verified OpenCode behaviors: `sessionID` in tool context, `session.get`/`list`/`prompt`, root-vs-child detection via `parentID`, `session.idle` / `session.status` / `session.deleted` events, `command.execute.before` with `$ARGUMENTS`, `experimental.chat.system.transform`, project/worktree identity, Desktop's embedded plugin transport, Windows path resolution.

## Development and live-test instructions

```bash
npm install
npm run build        # tsc -p tsconfig.build.json -> dist/
npm run typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run test         # unit tests (<2s)
npm run test:live    # live integration test (needs OpenCode Desktop running)
npm run test:all     # unit + live
npm run audit        # dependency audit
```

Unit tests live in `test/unit/`. The live test (`test/live/live.test.ts`) is **guarded**: it skips automatically when no OpenCode server is reachable, so `npm run test:all` never fails in CI. To run it for real, start OpenCode Desktop with a deterministic local model and export:

```powershell
$env:OPENCODE_SERVER_URL = "http://127.0.0.1:4096"
$env:OPENCODE_SERVER_PASSWORD = "<your password>"
$env:OPENCOMMS_LIVE_PROJECT = "C:\path\to\your\project"
# optional: enables the autonomous no-manual-wake scenario (needs a tool-capable model)
$env:OPENCODE_LIVE_MODEL = "openai/qwen3:0.6b"
npm run test:live
```

The live test proves the full acceptance flow from the project specification: two pre-existing root sessions are linked, exchange messages via explicit `opencomms_send`, queue when busy, deduplicate, pause/resume, and disconnect without deleting sessions.

## Architecture

| File | Role |
|------|------|
| `src/core/types.ts` | All types, constants, persisted `State` shape |
| `src/core/store.ts` | Atomic JSON persistence under `.opencomms/state.json`, v1 migration |
| `src/core/engine.ts` | Pure deterministic business logic (channels, queues, validation, two-phase delivery state machine) |
| `src/plugin.ts` | OpenCode adapter: tools, hooks, slash command |
| `src/hosts/opencode/delivery.ts` | Owner-side delivery controller (multi-server wake, fs-watch, fallback) |
| `src/mcp/` | Shared MCP stdio server + OpenComms tools (identity-pinned) |
| `src/adapters/` | Claude Code / Claude Desktop / Codex / ChatGPT installers + hooks |
| `src/cli/main.ts` | `opencomms` CLI (install, install-member, doctor, status, ...) |

See `docs/ARCHITECTURE.md` for the data flow, lifecycle, and invariants, and `docs/API_REFERENCE.md` for full function signatures.

## License

MIT