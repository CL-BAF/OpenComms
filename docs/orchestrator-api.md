# Orchestrator API — Contract v0 (M0 draft)

Consumers: Tauri GUI (Frontend), CLI/headless, Lead tooling. Provider: Orchestrator core (Backend).
Design rules: local-only by default; remote operations require explicit node approval; never creates provider sessions except through an AgentRuntime's documented spawn path; every mutating call is owner-approved or Lead-approved per trust policy.

## 0. Conventions

- Transport (M0): loopback HTTP on the existing GUI server (`src/gui/server.ts`) under `/api/orchestrator/*`; Tauri calls the same loopback. Later ADR may move to Tauri IPC — keep shapes identical.
- JSON only. Envelope: `{ ok: true, data }` / `{ ok: false, message }`.
- IDs: node `node_*`, agent `agt_*`, task `tsk_*`, run `run_*`. Timestamps epoch ms.
- All list endpoints support `?project=` implicit from workspace selection.
- **Security note (v0.1, binding):** loopback restricts by process location, not identity — any local process can hit these routes. Trust/approve endpoints (§1, §5) are unauthenticated-hostile by design: before M3, "owner action" must be backed by a concrete mechanism (e.g. explicit owner confirm token surfaced in the GUI, never readable by agent-facing tools). Agent-facing surfaces must not be able to call approve/revoke. Loopback-only is acceptable for M1/M2 single-machine use only.

## 1. Nodes

- `GET /api/orchestrator/nodes` → `{ nodes: [{ id, name, kind: "local"|"remote", platform, status: "online"|"offline"|"pending_approval", capabilities: { max_agents, runtimes: string[], headless: bool }, approved_at|null }] }`
- `POST /api/orchestrator/nodes/approve` `{ node_id }` → owner approves a pending remote node. 403 unless owner action.
- `POST /api/orchestrator/nodes/revoke` `{ node_id }` → revoke approval; remote agents on that node are stopped gracefully or marked lost.

## 2. Agents

- `GET /api/orchestrator/agents` → `{ agents: [{ id, name, host, role, runtime, status: "starting"|"running"|"idle"|"stale"|"stopped"|"failed", node_id, channel_ids, last_heartbeat, spawn_cmd_redacted }] }`
- `POST /api/orchestrator/agents/create` `{ name, host, role, role_prompt, channel, node_id?, model?, provider_config? }` → creates + spawns locally (node_id omitted ⇒ local node). Response includes agent id + spawn command (redacted).
- `POST /api/orchestrator/agents/stop` `{ agent_id, force?: bool }`
- `POST /api/orchestrator/agents/restart` `{ agent_id }`
- `GET /api/orchestrator/agents/{id}` → full record incl. task history refs

## 3. Tasks (M2; stubbed in M1)

- `POST /api/orchestrator/tasks/assign` `{ agent_id, task: { title, body, channel } }` → Lead assigns via channel message (`review_request` semantics preserved).
- `GET /api/orchestrator/tasks` → task list w/ status derived from agent acks/messages.

## 4. Events / Activity

- `GET /api/orchestrator/events?since=` → activity feed (spawn/stop/stale/message/error), capped, cursor-paginated.
- Existing `/api/events` SSE continues to fire `refresh` so the GUI can refetch.

## 5. Trust & Permissions (M3; read-only stubs in M1)

- `GET /api/orchestrator/trust` → `{ local_node_id, approved_nodes, pending_requests[] }`
- Approval actions are owner-only; Lead cannot self-approve remote nodes.

## 6. Error taxonomy

- `400 validation`, `403 trust_denied`, `404 unknown`, `409 conflict` (e.g. duplicate agent name on node), `500 internal`. Message strings are operator-facing, no secrets.

## 7. Versioning

- Contract bumps are additive until M4; breaking changes after M4 require a `/v2/` namespace.
- Contract owner: Lead. Changes proposed via `opencommupdate`, logged in OVERHAUL_PLAN.md Decision Log.

## 8. CLI mapping (v0.2 — Platform proposal, Lead-adopted)

- CLI consumes this API over loopback HTTP only; `src/cli/**` never imports orchestrator modules.
- `opencomms agent list|create|stop|restart|status` wrap §2 endpoints. Global flags: `--project <dir>` (default cwd), `--json` (emit raw API envelope, single line).
- Exit codes (additive to existing CLI 0/1): `0` ok · `1` generic failure (conn-refused hints "is `opencomms gui` running?") · `2` CLI validation · `3` conflict (409) · `4` trust_denied (403) · `5` unknown (404) · `6` internal (500).
- `agent create` pre-validates required flags (name/host/role) client-side → exit 2 without HTTP roundtrip; duplicate name (409) → exit 3; already-stopped on `agent stop` → idempotent success exit 0. No interactive prompts in M1 (headless-safe).

## 9. Contract addenda (v0.3 — GUI arbitration, Lead-decided)

- **Lead identity**: agents-list items may carry `designated: "lead"`. Exactly ONE agent per project may hold `designated: "lead"`, set at creation, immutable. No separate /lead endpoint (single source: agents list). Required for GUI Overview/Team (docs/gui-ia.md §8.1).
- **Runtime/model listing**: `GET /api/orchestrator/nodes/{id}/runtimes` → `[{ runtime, providers: [{ provider, models: string[] }] }]` — powers the create-agent dialog. M1.
- **Events composition**: orchestrator events carry `kind: "orchestration" | "channel_notice"`; channel_notice entries include message_id refs for member-scoped deep-dive via existing history APIs. Single feed, no second endpoint. M2.
- **Task events**: orchestrator events include `task_id` when applicable. M2.
- **SSE topics**: additive event names (`orchestrator`, `tasks`) on the existing `/api/events` stream; generic `refresh` unchanged. M2.