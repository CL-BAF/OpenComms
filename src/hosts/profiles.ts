/**
 * Host capability profiles — honest, evidence-backed declarations.
 *
 * Sources verified 2026-08-29 against official docs (see docs/CAPABILITIES.md
 * for the full matrix with citations). Values here are the single source of
 * truth for capability claims; Core reads these, never hardcodes host facts.
 */

import type { HostCapabilities } from "../core/types.js"

/**
 * OpenCode — the reference implementation. Plugin registers tools, hooks the
 * event bus (session.idle / session.deleted / session.status), injects
 * persistent role prompts via experimental.chat.system.transform, and pushes
 * into idle sessions via client.session.prompt.
 */
export const OPENCODE_CAPABILITIES: HostCapabilities = {
  sessionIdentity: true, // ctx.sessionID on every tool call
  sessionDiscovery: true, // client.session.list
  existingSessionLinking: true, // core invariant: link-only
  sessionResume: true, // sessions persist server-side
  promptDelivery: true, // client.session.prompt on idle
  idleDetection: true, // session.idle / session.status events
  lifecycleEvents: true, // event hook
  roleInjection: "system-prompt",
  toolRegistration: true,
  commandRegistration: true, // /OpenComms slash command
  mcpSupport: false, // not needed for the OpenCode path
}

/**
 * Claude Code (CLI) — hooks + MCP + SPAWN-PUSH. Verified 2026-09-08:
 * - Hooks (SessionStart/UserPromptSubmit/Stop/SessionEnd...) receive
 *   session_id and can inject additionalContext at hook boundaries.
 * - The documented non-interactive resume (`claude --resume <session-id>
 *   --print "<msg>"`) continues an existing session from a child process —
 *   a REAL push channel without terminal automation (spawn_push mode).
 * - MCP servers (project .mcp.json, stdio) get NO session identity.
 * - Mid-turn push is impossible (no API); a live TUI turn cannot be
 *   interrupted, and resuming mid-turn may interleave (serialized per
 *   member, failures requeue).
 */
export const CLAUDE_CODE_CAPABILITIES: HostCapabilities = {
  sessionIdentity: true, // hooks receive session_id; MCP tools do NOT
  sessionDiscovery: false, // no documented session enumeration API
  existingSessionLinking: true, // hooks bind a running session to OpenComms
  sessionResume: true, // claude --resume <id> (documented)
  promptDelivery: true, // spawn_push: claude --resume <id> --print <msg>
  idleDetection: false, // Stop hook fires per-turn, not idle transitions
  lifecycleEvents: true, // SessionStart/SessionEnd hooks
  roleInjection: "hook-boundary", // SessionStart additionalContext
  toolRegistration: true, // MCP server (project scope)
  commandRegistration: true, // plugin commands/skills
  mcpSupport: true,
}

/**
 * Claude Desktop — Desktop Extensions (.mcpb), local stdio MCP. Verified
 * 2026-08-29: strictly PULL (model/user invokes tools); no conversation
 * identity, no push, no lifecycle, no role injection.
 */
export const CLAUDE_DESKTOP_CAPABILITIES: HostCapabilities = {
  sessionIdentity: false, // no conversation id exposed to MCP servers
  sessionDiscovery: false,
  existingSessionLinking: false,
  sessionResume: false,
  promptDelivery: false, // documented: no server-initiated push
  idleDetection: false,
  lifecycleEvents: false,
  roleInjection: "none",
  toolRegistration: true, // MCP tools via .mcpb
  commandRegistration: false,
  mcpSupport: true,
}

/**
 * Codex CLI — MCP client via config.toml, hooks (trust-gated), SPAWN-PUSH
 * for exec-compatible sessions. Verified 2026-08-29 (hooks/MCP) and
 * 2026-09-08 (exec resume): `codex exec resume <SESSION_ID> "<prompt>"` is
 * the documented non-interactive continuation — a REAL push channel for
 * exec-compatible sessions (spawn_push mode). Resuming TUI-created
 * sessions is NOT verified (the resume docs target exec sessions).
 */
export const CODEX_CLI_CAPABILITIES: HostCapabilities = {
  sessionIdentity: true, // hooks receive session_id; MCP tools do NOT
  sessionDiscovery: false,
  existingSessionLinking: true, // hooks bind a session
  sessionResume: true, // codex exec resume <id> (documented)
  promptDelivery: true, // spawn_push: codex exec resume <id> <msg> (exec-compatible sessions)
  idleDetection: false,
  lifecycleEvents: true, // SessionStart/SessionEnd hooks
  roleInjection: "hook-boundary",
  toolRegistration: true, // [mcp_servers.*] in config.toml
  commandRegistration: false,
  mcpSupport: true,
}

/**
 * Codex App Server — MANAGED_THREAD model (EXPERIMENTAL in v2). Verified
 * 2026-08-29: JSON-RPC over stdio; thread/start|resume, turn/start|steer,
 * turn/completed notifications. OpenComms owns/starts the threads it
 * delivers to — linking unrelated interactive TUI sessions is NOT claimed.
 */
export const CODEX_APP_SERVER_CAPABILITIES: HostCapabilities = {
  sessionIdentity: true, // thread ids from app-server
  sessionDiscovery: true, // thread/list
  existingSessionLinking: false, // TUI-owned sessions: not verified
  sessionResume: true, // thread/resume (documented)
  promptDelivery: true, // turn/start / turn/steer on OWN threads
  idleDetection: true, // turn/completed notifications
  lifecycleEvents: true, // thread/status/changed
  roleInjection: "none", // instructions per-thread at thread/start
  toolRegistration: false,
  commandRegistration: false,
  mcpSupport: true,
}

/**
 * ChatGPT (web/desktop) — Plugins/remote MCP. Verified 2026-08-29: strictly
 * PULL for third parties; requires public HTTPS endpoint + OAuth for
 * private servers; no conversation identity; no push into conversations.
 * Local MCP only through the Codex host (separate adapter).
 */
export const CHATGPT_CAPABILITIES: HostCapabilities = {
  sessionIdentity: false,
  sessionDiscovery: false,
  existingSessionLinking: false,
  sessionResume: false,
  promptDelivery: false,
  idleDetection: false,
  lifecycleEvents: false,
  roleInjection: "none",
  toolRegistration: true, // remote MCP tools (developer mode / directory)
  commandRegistration: false,
  mcpSupport: true,
}

export const HOST_CAPABILITY_PROFILES: Record<string, HostCapabilities> = {
  opencode: OPENCODE_CAPABILITIES,
  "claude-code": CLAUDE_CODE_CAPABILITIES,
  "claude-desktop": CLAUDE_DESKTOP_CAPABILITIES,
  codex: CODEX_CLI_CAPABILITIES,
  "codex-app-server": CODEX_APP_SERVER_CAPABILITIES,
  chatgpt: CHATGPT_CAPABILITIES,
}
