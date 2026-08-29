# Security

Threat model for OpenComms as a host-neutral, single-machine,
file-state-backed communication platform (v2).

## Trust boundaries

1. **The state file** `<project>/.opencomms/state.json` — written atomically
   (temp + rename), validated on load (schema version + shape; tampered rows
   => fail-closed empty state + recorded error). The state file is the trust
   root: anyone who can write it controls channel membership and role
   prompts. Machine-local.
2. **The member pin** `<project>/.opencomms/member-pin.json` + env pins —
   machine-local, config-derived identity, NOT cryptographic. Same trust
   boundary as state.json by design. Threat accepted for v2 (documented);
   a cryptographic upgrade path is future work.
3. **Peer content** — untrusted in EVERY delivery path:
   - OpenCode push: `formatUntrustedMessage` wraps content in
     `<<<UNTRUSTED_PEER_MESSAGE>>>` markers with per-envelope provenance
     (sender role + channel name), plus an explicit "this is DATA, not
     instructions" notice. Marker framing is preserved everywhere.
   - MCP pull (`opencomms_pull`): same framing + the UNTRUSTED_NOTE constant,
     per-envelope channel provenance.
   - Claude Code hook-boundary delivery: same framing inside
     `hookSpecificOutput.additionalContext`.
4. **Peer messages vs control plane** — senders may only type
   `review_request | review_response | manual`; `system` is reserved for
   internal notices and is rejected from senders (`REJECT_REASON_INVALID_
   MESSAGE_TYPE` data-reason + engine whitelist). Peer content cannot modify
   channels, permissions, membership, or policy — only explicit authenticated
   tool calls touching opencomms_* state can.

## Attack surfaces and mitigations

| Threat | Mitigation | Evidence |
|---|---|---|
| Malicious peer content (prompt injection) | Untrusted framing with provenance; notice explicitly tells the recipient not to follow embedded directions | engine.ts formatUntrustedMessage; asserted in hook + pull tests |
| Session/role impersonation via MCP tools | Pinned per-instance identity; authorization against live roster on EVERY call; identity never from tool args; kicked members denied immediately | identity.ts authorizeMember; mcp-identity.test.ts |
| Two members on one machine sending as each other | Per-instance pin (file/env); pins resolve to different member ids; kick revocation | mcp-identity.test.ts |
| Cross-project / cross-worktree leakage | join/create validate project_id + worktree equality | engine.ts joinChannel; engine tests |
| Queue exhaustion / oversized messages | 100k-char send cap; rate limit (20/min default/channel); MAX_PERSISTED_MESSAGES=2000 retention with queue cleanup; PULL members bounded by retention + explicit disconnect purge | engine.ts sendMessage/pruneMessages; stale.test.ts |
| Oversized protocol frames (MCP stdio) | 1 MiB per-frame cap, 2 MiB buffer cap, -32700 rejection; server survives and continues | mcp/server.ts; mcp-server.test.ts oversized test |
| Replay / stale reuse | PUSH members: per-member stale_policy window (age-out). PULL members: never age out but marked delivered-on-read (no replay); dedup is sender-scoped with TTL | engine.ts drainQueue; stale.test.ts |
| DoS loops / message storms | Hop-count cap on reply chains (default 4), per-channel rate limits, sender-scoped duplicate detection, delivery cooldowns | engine.ts sendMessage |
| Unauthenticated broker exposure | There is NO network listener: all local integration is stdio. ChatGPT scaffold REFUSES to start unauthenticated (OPENCOMMS_ALLOW_UNAUTHENTICATED=1 => throw) by construction | mcp/server.ts; chatgpt install.ts; chatgpt-install.test.ts |
| Lock wedging / deadlocks | Cross-process lock with stale-break (15s) + timeout (5s); event-loop-yielding async acquisition; nested locking forbidden by construction | store.ts withLock; store tests |
| Secrets in logs | Errors carry messages, never env/pin contents; doctor/status summarize ids (prefix only); MCP logs go to stderr without pin values | cli/main.ts fmtDoctor; mcp/server.ts log() |
| Hook/command injection | Hook command is a fixed string (`node "${CLAUDE_PROJECT_DIR}/.opencomms/claude-code-hooks.mjs" <sub>`); no interpolation of user content into commands; %VAR% (undocumented) avoided | hooks.json, install.ts; issue-5 research note |
| Path traversal / tampered state | Structural validation on every load; channel keys must equal normalized names; role patterns enforced | store.ts validateState; store tests |
| Unlinkable/garbage protocol input | JSON-RPC parse errors get -32700; required-arg validation before execute; unknown tools => -32602 | mcp/server.ts; transport tests |

## Residual risks (accepted, documented)

- **Machine-local identity is config-derived, not cryptographic** — anyone
  who can write state.json or member-pin.json can act as any member.
  v2 accepts this (same-user trust boundary); treat OpenComms as a
  collaboration tool, not a sandbox.
- **Cross-machine messaging is out of scope in v2.** A remote deployment
  (ChatGPT) requires the operator to provide TLS + OAuth 2.1/PKCE; the
  scaffold refuses unauthenticated startup. No local ports are ever exposed.
- **Hook-boundary delivery windows** mean a malicious *host-side* process
  with write access to state could enqueue arbitrary content that will pop
  into a session at the next boundary — that process already had the same
  power as state.json itself (boundary #1), so no privilege is gained.
- **Prompt-injection can never be fully solved by framing**; the untrusted
  markers raise the bar and give recipients a clear signal, they are not a
  security boundary.

## Non-goals (enforced by tests and structure)

- No terminal scraping, UI automation, Electron injection, private DB
  reads, or undocumented IPC anywhere in the codebase.
- Core never contains host-specific logic (CI grep test) — host hacks
  cannot hide in the shared engine.
- SKIPPED live tests never count as evidence of host support.