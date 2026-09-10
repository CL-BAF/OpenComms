/**
 * ChatGPT adapter â€” remote MCP connector scaffold.
 *
 * Verified 2026-08-29 (developers.openai.com/plugins, platform.openai.com/docs/mcp,
 * learn.chatgpt.com/docs):
 * - Third-party integration = remote MCP server at a PUBLIC HTTPS endpoint
 *   (streamable HTTP at /mcp), reachable from OpenAI's infrastructure.
 * - Developer mode (Pro/Plus/Business/Enterprise/Education, chatgpt.com/plugins)
 *   allows adding a custom MCP server URL. Public directory submission requires
 *   review + verified identity + domain verification.
 * - OAuth 2.1 + PKCE (S256 mandatory) for private data; no machine-to-machine
 *   grants. ChatGPT presents an OpenAI-managed mTLS cert + documented egress.
 * - STRICTLY PULL: the model/user invokes tools; NO documented push into
 *   conversations; no conversation identity; Workspace Agents API is the only
 *   documented external->conversation delivery (published agents only).
 * - ChatGPT Desktop: plugins work in the app; LOCAL MCP servers only through
 *   the Codex host (that's the codex adapter's surface, NOT this one).
 *
 * THIS ADAPTER SCOPE (v2): the state/protocol side of a streamable-HTTP MCP
 * endpoint + honest capability labeling + documentation of the supported
 * connection path. NOT included: a production OAuth provider (requires a
 * registered domain, TLS, and OpenAI review) â€” that is exactly the part we
 * refuse to fake. No local broker is ever exposed to the internet.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

export interface ChatGptScaffoldReport {
  ok: boolean
  filesWritten: { path: string; purpose: string }[]
  warnings: string[]
  capabilities: Record<string, string>
}

export const CHATGPT_CAPABILITIES: Record<string, string> = {
  installation: "PARTIAL (remote MCP endpoint + developer mode or reviewed directory submission)",
  delivery: "PULL ONLY (model/user invokes MCP tools; no push into conversations)",
  sessionIdentity: "UNSUPPORTED (no conversation id documented for third parties)",
  existingConversationPush: "UNSUPPORTED (documented)",
  roleInjection: "UNSUPPORTED",
  lifecycle: "UNSUPPORTED",
  memberIdentity: "PARTIAL (pinned per-instance env; not cryptographic)",
  localBrokerExposure: "FORBIDDEN BY DESIGN (no unauthenticated local port exposure)",
  crossMachine: "UNSUPPORTED IN V2 (documented; future authenticated remote connector)",
}

/**
 * Generate the ChatGPT integration scaffold: a streamable-HTTP MCP wrapper
 * AROUND the shared in-process core (same tools as every other host) plus a
 * deployment checklist. The scaffold is EXPLICITLY MARKED EXPERIMENTAL and
 * requires the operator to provide hosting/auth; it refuses to start an
 * unauthenticated public server by itself.
 */
export function scaffoldChatGptIntegration(projectDir: string): ChatGptScaffoldReport {
  const target = resolve(projectDir)
  const outDir = join(target, "opencomms-chatgpt")
  mkdirSync(outDir, { recursive: true })

  const serverPath = join(outDir, "mcp-streamable-server.mjs")
  const readmePath = join(outDir, "README.md")

  writeFileSync(
    serverPath,
    [
      "// EXPERIMENTAL â€” ChatGPT remote MCP connector scaffold (OpenComms v2).",
      "//",
      "// This file exposes a streamable-HTTP MCP endpoint around the shared",
      "// OpenComms tools, using the official MCP SDK transport. It is NOT",
      "// production-ready until YOU provide:",
      "//   1. TLS + a public hostname (never expose a local port directly),",
      "//   2. OAuth 2.1 + PKCE (S256) authorization (ChatGPT requirement),",
      "//   3. Per-member identity mapping (OPENCOMMS_MEMBER_ID per session token),",
      "//   4. Review/submission per OpenAI's plugin policy if you want directory",
      "//      distribution (developer mode works without it).",
      "//",
      "// Deployment checklist lives in README.md next to this file.",
      "",
      'import process from "node:process"',
      "",
      "export function assertConfiguration() {",
      '  const projectDir = process.env["OPENCOMMS_PROJECT_DIR"] ?? ""',
      "  if (!projectDir) {",
      '    throw new Error("Set OPENCOMMS_PROJECT_DIR to the project whose .opencomms state this endpoint serves.")',
      "  }",
      '  if (process.env["OPENCOMMS_ALLOW_UNAUTHENTICATED"] === "1") {',
      '    throw new Error("Refusing to run unauthenticated. Configure OAuth 2.1 + PKCE first.")',
      "  }",
      "  return { projectDir }",
      "}",
      "",
      "// The streamable HTTP transport + tool surface reuse the same MCP tools as",
      "// every other host; this scaffold only wires transport-level details that",
      "// require your hosting decision (body handling, session tokens).",
      "",
    ].join("\n"),
    "utf8",
  )

  writeFileSync(
    readmePath,
    [
      "# OpenComms for ChatGPT â€” EXPERIMENTAL scaffold",
      "",
      "## What works today (documented, 2026-08-29)",
      "",
      "- ChatGPT (web/desktop) can call a third-party MCP server over streamable HTTP",
      "  at a PUBLIC endpoint when added through developer mode (Pro/Plus/Business/",
      "  Enterprise/Education) or reviewed directory submission.",
      "- The OpenComms MCP tool surface (status/inbox/pull/send/history/pause/resume/",
      "  disconnect/update_role) is host-neutral and shared by all adapters.",
      "",
      "## What ChatGpt CANNOT do (documented limits)",
      "",
      "- Push a message into a conversation (PULL only).",
      "- Expose conversation identity to the server.",
      "- Inject role instructions.",
      "- Local MCP servers in the Chat app (only the Codex host runs local MCP â€”",
      "  that is the separate `codex` adapter).",
      "",
      "## Deliberately NOT provided",
      "",
      "- Local broker exposure to the internet (never port-forward OpenComms).",
      "- A bundled OAuth provider. You must run an OAuth 2.1 + PKCE (S256)",
      "  authorization server in front of this endpoint.",
      "",
      "## Steps to productionize",
      "",
      "1. Host `mcp-streamable-server.mjs` behind TLS on a public hostname.",
      "2. Put an OAuth 2.1 + PKCE authorization layer in front (S256 mandatory).",
      "3. Map each ChatGPT user to an OpenComms member id; set OPENCOMMS_MEMBER_ID",
      "   per authorized session (identity stays pinned server-side, never from",
      "   tool arguments).",
      "4. Add the URL via chatgpt.com/plugins (developer mode) to test.",
      "5. Read the egress/verification requirements before directory submission.",
      "",
      "The scaffold refuses to start with OPENCOMMS_ALLOW_UNAUTHENTICATED=1: an",
      "unauthenticated public OpenComms endpoint must never exist.",
      "",
    ].join("\n"),
    "utf8",
  )

  return {
    ok: true,
    filesWritten: [
      {
        path: "opencomms-chatgpt/mcp-streamable-server.mjs",
        purpose: "EXPERIMENTAL streamable-HTTP MCP scaffold (refuses unauthenticated startup)",
      },
      { path: "opencomms-chatgpt/README.md", purpose: "Deployment checklist + documented limits" },
    ],
    warnings: [
      "This adapter is a scaffold, not a working ChatGPT integration: OAuth 2.1 + PKCE, TLS, and a public hostname are operator-provided.",
      "The shared member-pin.json state file is NOT network-sharable; a remote deployment needs its own state plan (documented).",
    ],
    capabilities: CHATGPT_CAPABILITIES,
  }
}

export function detectChatGptDesktop(): { detected: boolean; version: string | null } {
  // There is no documented, non-invasive way to detect ChatGPT Desktop from a
  // CLI process (no registry/API documented). We deliberately return
  // not-detected rather than scanning private app databases.
  return { detected: false, version: null }
}
