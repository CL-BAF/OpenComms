# Integration verification, 2026-10-05

This upgrade was verified through real local processes, persisted state, temporary Git repositories and loopback HTTP fixtures. Vendor login and model execution remain separate gates. This checkout contains no OpenCode, Claude or Gemini executable; Codex version detection is available but does not prove login or a tool roundtrip. No real user host configuration was changed during these checks.

## Current official references

- [OpenCode server API](https://opencode.ai/docs/server/) documents session lookup, session status, asynchronous prompt acceptance (`204`), abort and the server OpenAPI specification. The [official generated SDK](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/v2/gen/sdk.gen.ts) supplies the current permission list/reply and `directory` selector contracts. Permission listing uses `/permission`, filtered to exact `sessionID`; a reply uses `/permission/:requestID/reply` with `once` or `reject`.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) define hook-event input, session identity and context responses. Installed hook dispatch reads `hook_event_name` directly when the registered command has no subcommand. Hook output remains framed peer data.
- [Gemini hook reference](https://geminicli.com/docs/hooks/reference/) and [configuration reference](https://geminicli.com/docs/reference/configuration/) define project hooks and MCP configuration. Its [official hook runner](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/hooks/hookRunner.ts) expands `$GEMINI_PROJECT_DIR` and shell-escapes that value. Gemini onboarding preserves unrelated settings and does not auto-enable hook or MCP trust.
- [Codex App Server](https://developers.openai.com/codex/app-server/) documents managed thread primitives. This build has no App Server client; those primitives are explicitly unsupported here. Existing Codex integration remains MCP pull plus opt-in documented CLI resume delivery.
- ACP [initialization](https://agentclientprotocol.com/protocol/v1/initialization), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) and [tool permissions](https://agentclientprotocol.com/protocol/v1/tool-calls) define the implemented stdio protocol. Session load is conditional on advertised `loadSession`. Requests for client filesystem or terminal operations are refused because those capabilities are not advertised.

## Linked onboarding

Install the selected integration from the GUI or `opencomms install <host> --project <directory>`. Claude Code, Codex and Gemini require an explicit member pin and corresponding `OPENCOMMS_MEMBER_ID` configuration. Review the host's project trust and tool approval prompts. The installer and doctor inspect project artifacts; they do not log in to a vendor or claim live execution.

Claude Desktop creates an extension directory containing its manifest and standalone server. Pack and install it through the official MCPB/Desktop flow. ChatGPT installation is a connector scaffold and still requires an authenticated public HTTPS MCP service.

For Goose, Cursor, Cline, Roo, Continue, VS Code/Copilot and legacy Windsurf/Cascade, [manual MCP profiles](MCP_PROFILES.md) provide read-only configuration exports, current official setup references and explicit native identity/lifecycle limits. Each exported server command is regression-tested with an actual standalone MCP subprocess, pinned membership and framed pull. This verifies our server configuration without claiming authenticated editor/model interoperability.

## Configured ACP managed mode

Set `OPENCOMMS_ACP_COMMAND` to the exact executable and ACP arguments documented by the selected host before starting OpenComms. The value is parsed into an argv array and never executed through a shell. On Windows, use a native executable or `node` plus the real JS entrypoint; `.cmd` and `.bat` launchers are refused. Authentication must already be configured in that host's environment. Detection performs an ACP initialization handshake without creating a model turn.

ACP session creation is quiet. A role prompt accompanies the first framed assignment. The host's own configured model is preserved: this adapter does not invent a model catalogue, switch models, proxy client filesystem/terminal access, or discover existing interactive conversations. Permission requests remain pending for an operator; once-only approval or rejection is explicit and cancellation resolves outstanding requests as cancelled.

## Opt-in live verification

`npm run test:vendor` contains actual managed OpenCode and ACP text-token roundtrip tests. By default both are skipped. To execute one, set:

```text
OPENCOMMS_VENDOR_LIVE=1
OPENCOMMS_VENDOR_LIVE_HOST=opencode or acp
OPENCOMMS_VENDOR_LIVE_PROJECT=<explicit disposable project directory>
```

For OpenCode also set `OPENCODE_SERVER_URL` to an authenticated loopback server, `OPENCODE_SERVER_PASSWORD`, optionally `OPENCODE_SERVER_USERNAME`, and `OPENCODE_LIVE_MODEL=provider/model`. For ACP set the real `OPENCOMMS_ACP_COMMAND` and preconfigure host authentication. The harness creates separate managed sessions, sends a unique framed verification token, observes an actual agent text response and checks preserved resume identity. It refuses the deterministic ACP unit fixture as live evidence. A peer without session-load support fails that resume gate honestly. These tests can use a paid model and require deliberate opt-in.

`npm run test:live` retains the existing guarded linked OpenCode end-to-end flow. Missing runtime/authentication prerequisites or skipped tests are recorded as unverified, never successful interoperability. Unit protocol fixtures establish our wire behavior and persistence; they do not substitute for either live test.
