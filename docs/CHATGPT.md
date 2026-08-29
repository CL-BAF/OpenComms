# ChatGPT / ChatGPT Desktop

Status: **EXPERIMENTAL SCAFFOLD, deliberately not a working integration.**
Third-party ChatGPT integration requires a PUBLIC HTTPS MCP endpoint plus
OAuth 2.1 + PKCE — infrastructure an installer cannot honestly create for
you. Everything in this adapter is honest about that line. (Doc basis:
developers.openai.com/plugins, learn.chatgpt.com, platform.openai.com/docs/
mcp — fetched 2026-08-29.)

## What the current official surfaces support

| Surface | Third-party MCP | Notes |
|---|---|---|
| ChatGPT Web | Yes — developer mode (Pro/Plus/Business/Enterprise/Education) or reviewed directory submission | public HTTPS, streamable HTTP at `/mcp` |
| ChatGPT Desktop | Plugins work; LOCAL MCP only via the Codex host | use the separate `codex` adapter for local stdio |
| Push into conversations | **UNSUPPORTED** | no documented mechanism for third parties |
| Conversation identity | **UNSUPPORTED** | not exposed to servers |
| Role injection | **UNSUPPORTED** | — |
| Workspace Agents API | documented but scoped | published workspace agents only; not an OpenComms path in v2 |

## What OpenComms ships

`opencomms install chatgpt --project <dir>` writes
`opencomms-chatgpt/`:

- `mcp-streamable-server.mjs` — streamable-HTTP MCP scaffold around the
  shared host-neutral tools, with an unauth-refusal guard:
  `assertConfiguration()` throws "Refusing to run unauthenticated" when
  `OPENCOMMS_ALLOW_UNAUTHENTICATED=1` (that endpoint can never exist).
- `README.md` — deployment checklist (TLS, OAuth 2.1 + PKCE S256,
  per-session `OPENCOMMS_MEMBER_ID` mapping, developer-mode testing,
  submission requirements) and the explicit forbidden paths:
  **never port-forward a local OpenComms state dir; no bundled OAuth
  provider.**

## What we deliberately do NOT do

- No Electron/process/private-database access to ChatGPT Desktop; no
  undocumented IPC; detection of the Desktop app returns "not detected"
  by design (documented API does not exist — test-locked).
- No fake "works in ChatGPT Desktop" claims: local stdio servers in the
  Chat app are not a thing — that integration surface belongs to the
  Codex host adapter.
- No unauthenticated public endpoint, ever (guard is in the scaffold and
  in tests).

## If you productionize it

1. TLS + public hostname.
2. OAuth 2.1 + PKCE (S256 mandatory) in front of the tool endpoint.
3. Map authorized users to OpenComms member ids server-side (pins are
   per-deployment; member-pin.json is NOT network-sharable — plan state).
4. Test via developer mode at chatgpt.com/plugins; directory listing
   requires OpenAI review + verified identity + domain verification.

## Files & tests

- `src/adapters/chatgpt/install.ts` (`CHATGPT_CAPABILITIES` honesty
  constants incl. `localBrokerExposure: FORBIDDEN BY DESIGN`).
- Tests: `test/unit/core/chatgpt-install.test.ts` — capability honesty,
  refusal semantics EXECUTED, README content, no-Scan guarantee.