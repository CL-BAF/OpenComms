# Claude Desktop Adapter

Status honest summary (full matrix in CAPABILITIES.md):
**PULL-only**. OpenComms CANNOT push into a Claude Desktop conversation,
cannot see conversation identity, and cannot inject role instructions.
Everything the Desktop member does goes through MCP tools the user/model
invokes.

## How it works

One `.mcpb` extension = one pinned channel member. The extension runs the
same shared MCP stdio server as every other MCP host
(`src/mcp/server.ts`, tools in `src/mcp/opencomms-tools.ts`), with
`stale_policy: { mode: "none" }` so queued messages survive until you read
them (bounded by retention + disconnect).

Verified manifest fields (recorded fetch **2026-08-29**, sources:
`github.com/modelcontextprotocol/mcpb` MANIFEST.md v0.3 "Current version:
0.3, last updated 2025-12-02"; support.claude.com article 10949351 "local
MCP servers on Claude Desktop"):

- `manifest_version: "0.3"`; required fields
  manifest_version/name/version/description/author/server.
- `server.entry_point` REQUIRED for node-type servers.
- `server.mcp_config` {command, args, env}; `${__dirname}` substitution;
  `platform_overrides` (win32/darwin).
- `user_config` types incl. `directory`, `required`, `sensitive`
  ("mask input and store securely"; this is NOT documented as "OS
  keychain" — earlier wording corrected).
- `${user_config.KEY}` expansion in env AND args.
- `compatibility.runtimes.node` / `platforms`.
- CLI: `npx @anthropic-ai/mcpb pack <dir>` produces the installable zip.

## Install path

1. Build the bundle: `opencomms install claude-desktop --project <dir>`
   (or call `buildDesktopBundle`) -> `opencomms-claude-desktop/` with
   manifest.json + a self-contained `server/main.mjs`.
2. Package: `npm i -g @anthropic-ai/mcpb && mcpb pack opencomms-claude-desktop`.
3. Install in Claude Desktop: Settings > Extensions > "Advanced settings" >
   Extension Developer > "Install Extension…" (article-documented path).
   Opening the .mcpb file directly shows an install dialog (README phrasing
   — treat as ASSUMED for double-click; UI-verified install is
   UNVERIFIED-BY-HARNESS).
4. During install, provide:
   - **project directory** (directory picker) — the project whose
     `.opencomms/state.json` you join;
   - **member id** — from `opencomms install-member --host claude-desktop`
     run in that project (pinned identity; sensitive).
5. In the conversation, ask Claude to run `opencomms_create` /
   `opencomms_join` (bootstrap is allowed for the pinned member), then
   `opencomms_pull` to read queued messages and `opencomms_send` to reply.

## Limitations (documented, not accidental)

- No push: the host gives servers no channel into a running conversation;
  the member must pull.
- No conversation identity: identity is the pinned per-instance member id
  (machine-local config, not cryptographic).
- No role injection: paste role instructions when creating/joining; role
  prompts persist in channel state, not in the conversation.
- Desktop instances ship WITHOUT admin tools (opencomms_kick) by default.
- `project_id` for Desktop members is effectively constant (derives from
  `OPENCOMMS_PROJECT_ID` env, default `local-project`); the project
  scoping that matters is the state directory itself.
- End-user install UX (double-click/dialog flows) is UNVERIFIED-BY-HARNESS;
  the bundle layout and packaged-server behavior ARE verified by
  `test/unit/core/desktop-package.test.ts`.

## Files

- `adapters/claude-desktop/manifest.json` — MCPB manifest (v0.3).
- `src/adapters/claude-desktop/package.ts` — manifest validation + bundle
  layout (self-contained esbuild server).
- `src/mcp/*` — shared MCP server + tools + pinned identity.