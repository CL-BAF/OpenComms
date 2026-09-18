# M4.6 Design Addendum — MCP Orchestrator Tool Surface (design BEFORE code)

Owner: Backend (ses_f712a522affeHeW1uGteRbQEws). Status: draft for Lead's
design gate (per M4.6 directive + Reviewer's 6 binding priorities). The
existing MCP server (`src/mcp/**`, stdio JSON-RPC, 16 channel tools) gains
the ORCHESTRATOR verbs as MCP tools. Design rule: **the MCP tools ride the
same OrchestratorApi — no new enforcement surface**; every trust gate that
protects the HTTP/bridge surfaces applies identically over MCP.

## 1. Principal classification (Reviewer priority 1 — the sharpest gate)

Every mutating MCP tool carries an EXPLICIT principal class, enforced
server-side before dispatch:

| Class | Meaning | Tools |
|---|---|---|
| `human-present` | Requires the owner's confirm token IN THE CALL | `node_approve`, `node_revoke`, `pairing_create` |
| `operator` | Allowed for an authenticated ADMIN MCP instance (the operator's own MCP server, `--admin` flag) | `agent_create`, `agent_stop`, `agent_restart`, `task_assign` |
| `member` | Any pinned member (existing channel-tool semantics) | all existing opencomms_* channel tools |
| `read` | No mutation, no token | all `*_list`/`status`/`view` tools |

- **`human-present` tools REQUIRE the confirm token as a tool argument**
  (transport-independent — condition 2). No token in the call = 403-shape
  denial + audit event, identical to HTTP. ChatGPT/Claude CANNOT approve a
  node without the human typing the token into that call; the LLM cannot
  self-supply it because the token is never readable by any tool (M1
  design: not GET-readable, never in trust_view).
- `operator`-class tools require the MCP server instance to be launched
  with `--admin` (existing flag, desktop-facing default OFF) AND the
  acting member to be the designated Lead or an owner-pinned operator
  identity. Without `--admin`, these tools return a typed "operator MCP
  required" denial. This keeps the owner-only boundary: an app-side MCP
  client (ChatGPT/Claude) connects to a NON-admin instance by default and
  gets read + member tools only.

## 2. Identity-scoped tool sets (Reviewer condition 3 — M1 boundary holds)

- **Agent pins** (channel members): get the existing channel tools ONLY.
  No orchestrator tools. An agent can never spawn/stop/restart another
  agent or approve a node — same boundary as the HTTP surface.
- **App/operator identities**: a NEW pin class (`operator` pin, set by the
  installer with `--admin`) gets the orchestrator tools. The pin file
  records the class; `authorizeMember` rejects orchestrator-tool calls
  from member-class pins and channel-mutation calls from operator pins
  when they are not channel members.
- **Never crossed**: the pin's class is fixed at install time; no tool can
  re-classify it (no self-escalation — condition 4).

## 3. Tool list (new, all mapping to existing OrchestratorApi fns)

| MCP tool | Principal | Maps to | Notes |
|---|---|---|---|
| `opencomms_agent_list` | read | GET /agents | `designated` honored |
| `opencomms_agent_status` | read | GET /agents/{id} | |
| `opencomms_agent_create` | operator | POST /agents/create | model REQUIRED (server-enforced); remote node_id passes condition C |
| `opencomms_agent_stop` | operator | POST /agents/stop | Lead-protected server-side |
| `opencomms_agent_restart` | operator | POST /agents/restart | identity adoption server-side |
| `opencomms_task_assign` | operator | POST /tasks/assign | eligibility + budget server-enforced |
| `opencomms_task_list` | read | GET /tasks | |
| `opencomms_node_list` | read | GET /nodes | |
| `opencomms_node_approve` | human-present | POST /nodes/approve | confirm_token arg REQUIRED |
| `opencomms_node_revoke` | human-present | POST /nodes/revoke | confirm_token arg REQUIRED |
| `opencomms_node_pair` | human-present | POST /nodes/pairing-code | confirm_token arg REQUIRED |
| `opencomms_audit` | human-present | POST /audit | confirm_token arg REQUIRED |

Deny-by-default tool registry: the MCP server's tool list is the union of
the existing channel tools + these, FILTERED by the pin class at tool-
listing time (an agent pin never even SEES the orchestrator tools).

## 4. Condition C inherited (condition 5)

`agent_create` with a remote `node_id` and `task_assign` to a remote
agent pass through `assertRemoteActionAllowed` inside OrchestratorApi —
the MCP layer adds NOTHING; the same ordered checks (approved →
credential-valid → grant-present) apply with 403 + audit.

## 5. MCP-caller distinction in the audit trail (condition 6)

Every orchestrator event gains an additive `via` field
(`"http" | "mcp" | "bridge" | "cli"`) stamped at the OrchestratorApi
call sites — additive to the event shape (backfill: absent = legacy).
The audit log and the GUI Activity surface can then show WHOSE transport
issued each action, without changing any enforcement.

## 6. Non-goals

- No new Rust/Rust-adjacent enforcement. The MCP server is the existing
  stdio JSON-RPC server with a bigger tool table.
- No bearer/CA material over MCP: node pairing stays in the GUI/CLI
  (owner surfaces); MCP can only LIST nodes and (with the token) approve.
- ChatGPT remote access remains gated on the operator-hosted OAuth
  deployment (docs/CHATGPT.md) — unchanged by this extension.

## 7. Implementation order

1. `mcp/principal.ts`: pin-class model + `authorizePrincipal(class, …)`.
2. `mcp/orchestrator-tools.ts`: the 10 new tools (thin OrchestratorApi
   wrappers; same ToolResult envelope).
3. Server registry: tool list filtered by pin class; `--admin` gate.
4. Tests: per-tool principal classification, four deny cases over MCP
   (condition C), token-over-MCP for approve/revoke, identity-scoping
   (member pin cannot see orchestrator tools).