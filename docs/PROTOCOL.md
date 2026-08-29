# OpenComms Protocol (internal)

All state is file-based (`<project>/.opencomms/state.json`); there is no
network protocol in v2. This page documents the in-process/envelope
"protocol" that adapters and tools share, plus the wire formats of the
MCP surface.

## Versioning

- `state.schema_version = 2`. Load rejects other versions (fail-closed) —
  except during the one-time v1 migration (see MIGRATION.md).
- Message envelope fields are stable names; add fields additively.
- MCP server implementation targets protocol version `2024-11-05` (see
  `McpStdioServer`); capabilities: `tools`.

## Message envelope (state v2)

```
message_id        ocm_<hex>        unique per envelope
channel_id        chn_<hex>        immutable channel reference
sender_session_id sess_*           OpenComms routing id (sender)
sender_role       role label
recipient_*                        resolved recipient (one envelope each)
timestamp         epoch ms
message_type      review_request | review_response | manual | system(reserved)
content           <= 100,000 chars
reply_to          message_id|null  (inherits correlation_id, +1 hop)
hop_count         capped by channel.max_hops (default 4)
correlation_id    cor_<hex>        reply chains share it
delivery_status   pending|delivered|failed|rejected|stale
delivered_at      epoch ms|null
attempts          drain count
```

Sender-facing rules (engine-enforced):
- type whitelist; `system` reserved (returns `data.reason =
  "invalid_message_type"` for plugin branch);
- sender-scoped duplicate detection within the stale window;
- per-channel rate limit; hop cap; paused channels reject sends;
- recipients: explicit `to` (session id or role), `broadcast`, or the peer
  on a 2-member channel — never guessed on 3+.

## Delivery semantics

- **PUSH members**: `drainQueue` runs at host-idle/lifecycle hooks; age-out
  per member `stale_policy { mode: "window", window_ms }` (v1 default
  5 min). Failed delivery requeues in FIFO order with the batch's
  delivered-by entries rolled back.
- **PULL members** (`stale_policy { mode: "none" }`): no age-out; messages
  live until read (bounded by retention + disconnect purge); reading marks
  delivered (no retry loops).
- Delivery cooldowns apply per recipient; only the first message in a
  batch waits.

## Identity

- Routing: OpenComms `sess_*` ids only.
- Host identity: `member.host_session_id` (correlation only).
- MCP hosts: pinned identity (`member-pin.json` / `OPENCOMMS_MEMBER_ID`),
  validated against the live roster per call; tool arguments never choose
  an identity. See ADAPTERS.md.

## MCP wire surface (stdio, JSON-RPC 2.0, newline-delimited)

- `initialize` -> `{protocolVersion, capabilities:{tools:{}}, serverInfo}`
- `notifications/initialized`, `ping`
- `tools/list`, `tools/call` (required-args validated; unknown tool -32602)
- Oversized frames (>1 MiB) rejected with -32700; server keeps serving.
- Tool results: `{content:[{type:"text",text}], isError}`; text is a JSON
  `ToolResult` (`{ok, message, data?}`).
- Peer content inside tool results is framed untrusted
  (`<<<UNTRUSTED_PEER_MESSAGE>>>` + notice), identical to push framing.

## Extension rules for future transports (e.g. remote/broker)

- Keep envelope + framing identical; only the transport changes.
- Any networked transport MUST require authentication (see SECURITY.md —
  unauthenticated public endpoints are rejected by construction).
- Host-specific session ids must never become routing keys.