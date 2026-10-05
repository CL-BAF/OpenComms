/** Host capability declarations; implementation and live limits are in docs/CAPABILITIES.md. */

import type { HostCapabilities } from "../core/types.js"

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
 * Hook context and explicit argv resume are distinct delivery paths. The host
 * has no busy-check API; resuming a live turn may interleave. MCP has no native
 * session identity, so lifecycle hooks bind the separate OpenComms member pin.
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

/** Desktop MCP is pull-only and exposes no conversation identity or lifecycle. */
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

/** Exec resume is documented; continuation of TUI-created sessions remains unverified. */
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

/** Platform primitives only: this build ships no Codex App Server client/runtime. */
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

/** Remote MCP pull requires public HTTPS and authentication; conversation identity is unavailable. */
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

/** Local scripts use explicit member pins and pull tools; native session ids never route mail. */
export const OLLAMA_CAPABILITIES: HostCapabilities = {
  sessionIdentity: false, // local agents have no vendor session ids (by design)
  sessionDiscovery: false,
  existingSessionLinking: false,
  sessionResume: false,
  promptDelivery: false, // PULL: the agent reads its queue with opencomms_pull
  idleDetection: false,
  lifecycleEvents: false,
  roleInjection: "none",
  toolRegistration: true, // shared MCP server (stdio, pinned identity)
  commandRegistration: false,
  mcpSupport: true,
}

/** Gemini CLI linked hooks/MCP; no managed runner or autonomous push claimed. */
export const GEMINI_CLI_CAPABILITIES: HostCapabilities = {
  sessionIdentity: true,
  sessionDiscovery: false,
  existingSessionLinking: true,
  sessionResume: false,
  promptDelivery: false,
  idleDetection: false,
  lifecycleEvents: true,
  roleInjection: "hook-boundary",
  toolRegistration: true,
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
  ollama: OLLAMA_CAPABILITIES,
  "gemini-cli": GEMINI_CLI_CAPABILITIES,
}
