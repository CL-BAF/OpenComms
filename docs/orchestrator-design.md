# Orchestrator Design Note — AgentRuntime, Orchestrator State, Nodes & Trust (M0 → M1)

> Owner: Backend (ses_f712a522affeHeW1uGteRbQEws). Status: M0 design note, input to
> ADRs. Aligned to `docs/orchestrator-api.md` contract v0.3 and OVERHAUL_PLAN.md §8.
> No `src/**` changes are proposed in M0; §8 lists the engine changes M1 will need,
> to be integrated by Lead.

## 1. Survey — what exists today that orchestration builds on

| Surface                       | Location                                                                                               | What it already provides                                                                                                                                                                       | What it lacks for orchestration                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn-push delivery           | `src/hosts/spawn-delivery.ts`                                                                          | argv-array, no-shell child spawn; env-based binary overrides (`OPENCOMMS_CLAUDE_BIN`/`OPENCOMMS_CODEX_BIN`); Windows argv budget (~30k win32); two-phase drain→commit; FIFO requeue on failure | It RESUMES an existing session to hand it mail; it cannot create sessions, and has no stop/status/restart, no process handle retention, no supervision    |
| Member/timer model            | `src/core/engine.ts` (`makeMember`, `ChannelTimer`, `drainQueue`, `commitDelivery`, `sweepInFlight`)   | session-id-keyed routing, chess-clock per member, staleness, two-phase delivery, budget caps                                                                                                   | No concept of "who started this session", no process handle, no lifecycle beyond stale/live                                                               |
| MCP shared tools              | `src/mcp/opencomms-tools.ts` + `src/mcp/identity.ts`                                                   | pinned per-member identity (`pins/<member_id>.json`, `OPENCOMMS_MEMBER_ID`), `authorizeMember` against live roster, kick revocation                                                            | Identity is per-MCP-server-process; a spawned agent is a different process shape (its identity should derive from the agent record, not an installer pin) |
| Plugin glue                   | `src/plugin.ts` (tools, hooks, `system.transform`, slash dispatch)                                     | `session.idle`/`session.deleted` hooks, owner-side delivery controller (`src/hosts/opencode/delivery.ts`), fs-watch wake                                                                       | Tied to OpenCode plugin host; orchestrator needs the same semantics for hosts that have no plugin surface (serve-managed sessions)                        |
| Operator/GUI surface          | `src/gui/server.ts` (loopback `/api/*`), `createSessionAsOperator`/`removeMemberAsOperator` engine fns | operator-scoped mutations already exist as a pattern; SSE `refresh` broadcast; `memberState()` honest-status mapping (Working/Idle/Offline)                                                    | No agent/node entities, no spawn endpoints, no event feed beyond channel refresh                                                                          |
| Host capability profiles      | `src/hosts/profiles.ts`                                                                                | honest per-host capability declarations incl. `sessionResume`, `promptDelivery`, `idleDetection`                                                                                               | No spawn/lifecycle entries (profiles describe delivery, not agent creation)                                                                               |
| Host-neutral adapter contract | `src/hosts/contract.ts` (`OpenCommsHostAdapter`)                                                       | fail-closed identity verification model, `verifySession` null = fail closed                                                                                                                    | Same: delivery-shaped, not lifecycle-shaped                                                                                                               |

Ground truth proven by the spike (`docs/spike-spawn-opencode.md`): the OpenCode serve

- HTTP/SDK path supports create → prompt → promptAsync → abort → kill with
  OpenComms-compatible `ses_*` ids, SSE event stream, env-only auth, argv-discipline
  launch. The `AgentRuntime` below is a direct generalization of that proven sequence.

## 2. Node model (contract v0.1 §1)

```ts
// persisted in orchestrator state (§4)
interface NodeRecord {
  id: string // node_<hex>; local node has a FIXED well-known id
  name: string // operator-facing label
  kind: "local" | "remote"
  platform: string // process.platform of the node ("win32", "linux", ...)
  status: "online" | "offline" | "pending_approval"
  capabilities: { max_agents: number; runtimes: string[]; headless: boolean }
  approved_at: number | null // null while pending_approval; owner-only set
  approved_by: "owner" | null
  worktree_root: string | null // optional per-node scratch root for agent worktrees (remote, M3)
}
```

- **Local node is implicit**: on orchestrator start, ensure exactly one
  `kind:"local"` row with `status:"online"`, `approved_at` set, `runtimes` filled from
  runtime detection (§3). It is never "approved" via the API; it is not part of the
  approval flow at all.
- **Remote nodes (M3) enter as `pending_approval`** via an explicit pairing request.
  Nothing auto-approves. `POST /nodes/approve` and `/nodes/revoke` are owner-only
  (§6 trust model). Revoke = stop agents on that node gracefully, else mark `lost`
  (they become `status:"failed"` with a reason, never silently deleted).
- **Node status** (M1, local only): `online` while the orchestrator process runs.
  Honest rule: local node is online iff the orchestrator itself is alive — no fake
  heartbeats needed. Remote liveness (M3) uses the pairing-channel heartbeat.

### Worktree rule (policy, per Lead decision 2026-09-11)

One git worktree per spawned agent. At agent create the orchestrator:

1. Computes/creates the agent worktree (local node: `git worktree add <path> <base>`
   inside the project repo; M1 default path: `<project>/.opencomms/agents/<agt_id>/worktree`
   or an operator-configured scratch root — never inside another agent's worktree).
2. Records the path in the agent record (`worktree` field, §5) — the record is the
   source of truth, the directory is derived.
3. Uses `git worktree list --porcelain -z` (parsed NUL-separated records) to enumerate
   and to verify existence at spawn and at status-refresh. Orphaned agent worktrees
   (record gone, dir present) are reported, never auto-deleted in M1/M2.

## 3. AgentRuntime abstraction (contract v0.1 §2)

```ts
// src/orchestrator/runtime.ts (M1) — host-neutral; per-host builders in src/hosts/
type AgentRuntimeStatus = "starting" | "running" | "idle" | "stale" | "stopped" | "failed"

interface SpawnRequest {
  agent_id: string // agt_* (OpenComms-generated, primary key — Decision 2026-09-11(3))
  name: string
  role: string // open-vocab role label (same validation as channels)
  role_prompt: string
  worktree: string // resolved by worktree rule (§2)
  model?: string // "provider/model"; runtime-verified before spawn (spike finding)
  provider_config?: Record<string, unknown> // runtime-specific; secrets handled via env only
}

interface AgentRuntime {
  readonly runtime: string // "opencode" | "claude-code" | "codex" | ...
  /** Discover what this machine can run. Also backs the runtimes listing endpoint. */
  detect(): { available: boolean; version?: string; detail?: string }
  /** Create + start the agent. Idempotent per agent_id. Returns the runtime-native handle. */
  create(req: SpawnRequest): Promise<AgentHandle>
  /** Resume/attach to a KNOWN existing runtime session (reconnect path, §7). */
  resume(ref: { host_session_id: string; worktree: string }): Promise<AgentHandle>
}

interface AgentHandle {
  /** Delivery: hand one framed batch to the agent (OpenComms framing, envelope preserved). */
  deliver(framed: string): Promise<"delivered" | "failed">
  /** Best-effort interrupt of the current turn (M2: supervision). */
  abort(): Promise<void>
  /** Machine-readable status snapshot; never guessed. */
  status(): Promise<{ status: AgentRuntimeStatus; detail?: string }>
  /** Structured drain of pending permission prompts, if the host exposes one (M2). */
  permissionsDrain(): Promise<Array<{ permission_id: string; request: unknown }>> | null
  /** Process-level termination (stop). force=true escalates after grace. */
  stop(force?: boolean): Promise<void>
}

interface AgentRecord {
  // persisted (§4); NOT the same object as the handle
  id: string // agt_* (primary key)
  name: string
  host: string // host family label (matches Member.host vocabulary)
  role: string
  role_prompt: string
  runtime: string // AgentRuntime id
  node_id: string // node_* (local node id for M1)
  worktree: string // per-agent worktree (§2 rule)
  status: AgentRuntimeStatus
  host_session_id: string | null // ses_* captured at create (attribute, never a key)
  spawn_cmd_redacted: string // argv with password/secret tokens removed
  designated: "lead" | null // contract v0.3 §9; exactly ONE per project, immutable
  channel_ids: string[]
  last_heartbeat: number | null
  created_at: number
  restart_count: number
}
```

**Design principles (anchored in spike evidence):**

1. **`agt_*` is the primary key; `host_session_id` is an attribute.** Matches Lead
   decision (2026-09-11(3)) and mirrors the existing `Member` model
   (`session_id` routing key + `host_session_id` correlation). OpenCode's `ses_*`
   namespace is global; both user and spawned sessions share it — the agent record's
   `managed: true` semantics live in the orchestrator state, not in the session store
   (see §7 on identity).
2. **Delivery is push-shaped via the SAME two-phase protocol** as existing members:
   `drainForDelivery` marks `in_flight` → runtime `deliver(framed)` → `commitDelivery`.
   For OpenCode runtimes this is `session.prompt`/`promptAsync` over the shared serve
   (spike-proven); for claude-code/codex it degrades to the existing spawn-push resume
   path. Envelope/framing stays identical local vs remote (Researcher ground rule).
3. **Status is event-driven, not polled.** Spike: `GET /session/status` returned `{ }`
   mid-turn; SSE `session.status`/`session.idle` were reliable. The orchestrator keeps
   ONE SSE tap per serve instance (Lead addendum (2)) and routes by session id;
   `AgentHandle.status()` is allowed to be a best-effort snapshot for UI, but the
   state machine is driven by events + `last_heartbeat`.
4. **Model is always pinned and pre-verified.** Spike: server default picked an
   unreachable model (hard error) and another model hung silently. `detect()` lists
   models; `create()` requires a verified `model` unless the operator explicitly opts
   into the server default (recorded in the agent record either way).
5. **Least privilege, deny-by-default.** OpenCode M1: role prompt inline via first
   prompt / `OPENCODE_CONFIG_CONTENT`; permissions inline via `OPENCODE_PERMISSION`
   (conservative allowlist, e.g. read+glob+grep, bash gated); NEVER `--auto`/
   bypassPermissions. Env-only secret handoff; nothing agent-visible on disk (Lead
   constraint). Password never in argv, logs, role prompts, or tool surfaces.

### OpenCode runtime (first, spike-proven)

- **Launch (shared serve, per Lead decision 2026-09-11(1)):** one `opencode serve`
  process per project (NOT per agent), `--port <chosen> --hostname 127.0.0.1`, env
  `OPENCODE_SERVER_PASSWORD` (+ `OPENCODE_SERVER_USERNAME=orchestrator`), spawned
  argv-only with the resolved native exe (Windows shim caveat → same override-env
  pattern as spawn-delivery). Port: orchestrator-selected, bound with failure-verified
  readiness (stdout `listening` line), recorded on the node record (local node).
- **Create:** `session.create({ title: name })` → persist `host_session_id`, then
  `session.prompt` with the composed role-prompt + first task text.
- **Push:** `session.promptAsync` for fire-and-forget; `prompt` when a turn result is
  needed (structured `json_schema` output is available when needed).
- **Abort:** `session.abort`; **status:** SSE-driven; **stop:** node-level (§kill).
- **Kill semantics (recorded):** serve kill stops ALL sessions on the instance
  (accepted shared-instance tradeoff, single trust tier per Lead); abort-on-idle is a
  harmless no-op. Serve crash → SSE tap notices disconnect → agents flip `stale` →
  M2 restart policy applies. Rotation of server password = serve restart (M1: accept).

### Runtime registry (per-node)

`AgentRuntimeFactory[]`, resolved per `host` label. M1 ships `opencode` only (the only
host on this machine — verified `opencode --version` 1.18.25; claude/codex absent).
claude-code/codex implementations follow the same interface with their documented
argv (`claude -p/--resume`, `codex exec/exec resume`) — the interface above was shaped
by both (research report §1B/1C) and holds unchanged.

## 4. Orchestrator state (beside channel state; Lead Decision Log 2026-09-11)

New file: `<project>/.opencomms/orchestrator.json` — **separate** from
`state.json` (channels/messaging) so channel-schema evolution never touches
orchestration. Same discipline as the existing store: atomic temp+rename writes,
cross-process lock (`.orchestrator.lock`), fail-closed shape validation, corrupt ⇒
rebuild with recorded error. Schema versioning from day one (`orchestrator_schema_version: 1`).

```jsonc
{
  "orchestrator_schema_version": 1,
  "local_node_id": "node_local_<project-hash>",
  "nodes": [ NodeRecord ],
  "agents": [ AgentRecord ],
  "events_cursor": 0,
  "trust": {
    "owner_confirm_token": "<see §6>",   // never returned by any read API
    "approved_node_ids": [],
    "pending_pairing_requests": []
  }
}
```

- Agent ids: `agt_<uuid>` (id generator mirrors `newMessageId`/`newChannelId`).
- Event log: append-only ring in the same file (`events[]`, capped like
  `state.errors`, cursor-paginated for `GET /events?since=`). M1 kinds:
  `orchestration` (agent/node lifecycle) only; `channel_notice` kind + `task_id`
  added in M2 without shape breaks (contract §9 additive rule).
- Enrichment only, no duplication: channel_ids are derived from channel state at
  read time (agents are found via `Member.session_id === agent.host_session_id`);
  the persisted `channel_ids` cache is a convenience, refreshed on agent events.
- **Lead designation (contract v0.3 §9, M1-BINDING):** `designated:"lead"` is set at
  agent creation and immutable. Enforcement lives in the orchestrator mutate
  (inside the lock): second create-with-designated-lead (or any update attempt to
  change it) ⇒ validation error `409 conflict` ("a designated Lead already exists:
  <agt_id>"). The agents-list serializer emits `designated` on EVERY item (null when
  absent) so Frontend's lead-or-ERROR rule can rely on field presence.

## 5. API wiring (contract v0.3; transport = existing loopback GUI server)

- All `/api/orchestrator/*` routes are implemented **in-process in the `opencomms gui`
  server** (ADR-0005 leaning: orchestrator core runs inside the same server process —
  the Tauri sidecar argv stays exactly `gui --port N --server --project dir`, which
  Frontend's spike proved works). The orchestrator state store is instantiated lazily
  per selected project (mirrors `StateStore`/`ArchiveStore` handling) — no second
  daemon, no extra sidecar arg surface.
- SSE: the single `/api/events` stream gains additive event names (`orchestrator`,
  M2: `tasks`); generic `refresh` semantics unchanged (contract §9). The orchestrator
  broadcasts `orchestrator` events on spawn/stop/status transitions; SSE clients
  filter by topic.
- Runtimes listing (`GET /nodes/{id}/runtimes`, M1 local-only):
  `[ { runtime: "opencode", providers: [ { provider, models[] } ] } ]` — backed by
  `AgentRuntime.detect()` + `opencode models` cache (the orchestrator shells out once
  and caches; never exposes credentials).

## 6. Trust & permission model (M0 design; Reviewer-flagged, binding)

- **Single trust tier in M1/M2** (Lead gate): all spawned agents on the shared serve
  are EQUAL trust. No per-agent privilege fields are read by the orchestrator in M1
  (the schema leaves room for M3 `trust_tier` without a migration break).
- **Unauthenticated-hostile by construction** (contract v0.1 security note): loopback
  binds are a process-location boundary, not identity. Therefore:
  - Trust/approve/revoke endpoints accept `{ confirm_token }` — a random,
    per-project secret generated when the trust store is created, **surfaced to the
    human** in the GUI/CLI settings surface only (agent-facing tools never receive
    it; it is not readable via any orchestrator GET).
  - Owner-only persistence: approval state changes require the token in the request
    body; absent/wrong token ⇒ `403 trust_denied` and a recorded audit event.
    Lead (or any agent session) has no path to self-approve — approval lives in the
    same trust store that agents cannot read.
  - M1/M2 keep this mechanism already (cheap now, no retrofit later); M3 remote-node
    pairing reuses it as the human-in-the-loop gate.
- **Password hygiene** (Reviewer gate): `OPENCODE_SERVER_PASSWORD` is generated by the
  orchestrator, held in memory + env of the child process only, never logged or
  returned. `spawn_cmd_redacted` in agent records replaces any secret-bearing token.
  Auth handoff is env-var-only (spike: verified not visible in process listings).
- **SSE scoping limitation (ledger item, M3 sensitivity tiers):** `/event` is
  directory-scoped — any authenticated subscriber sees ALL project sessions' events
  (Researcher A3). M1 consequence: the single orchestrator tap is fine, but every
  agent on the shared serve could also open its own tap and see siblings' events.
  Known M1 limitation; per-sensitivity isolation = dedicated serve instance per tier
  (same tradeoff as kill semantics), decided at M3.
- **Agent-facing tools cannot mutate trust.** The orchestrator API is served from the
  GUI/operator process; agent sessions interact only through the channel engine
  (`opencomms_send` etc.), which cannot reach orchestrator routes (different process
  - tool surface). This is the same boundary shape the current MCP pin model uses.

## 7. Identity, reconnect & resume

- **Routing stays engine-native.** A spawned agent joins channels exactly like a
  manual session: the runtime composes the `/OpenComms Join Channel=... As=...`
  call INSIDE the agent's first prompt (or via the same system-transform path when
  the plugin is present in the serve's project). The engine keys on `ctx.sessionID`
  (=`host_session_id` we captured), so join works with ZERO engine changes —
  spike-proven: `session.create` ids live in the same `ses_*` namespace.
- **Identity pinning for managed agents:** the orchestrator writes the per-agent pin
  file (`pins/<agt_id>.json`-shaped, existing `saveMemberPin`) or sets
  `OPENCOMMS_MEMBER_ID` in the child env AFTER the agent joined (id is known at
  join). Identity is still never accepted from tool args; the orchestrator just
  provisions it. (M1: only needed if the runtime's MCP surface is enabled; the
  opencode runtime path needs none.)
- **Reconnect/resume:** orchestrator restart must recover agent records:
  1. Serve process gone ⇒ agent `stale`. Restart policy (M2) decides
     respawn-vs-mark-lost; M1 default: mark `stale`, surface in GUI, manual restart.
  2. `AgentRuntime.resume({ host_session_id })` re-attaches to a persisted session
     (opencode: session ids are global + persist across serve restarts — verified:
     spike sessions survived many serve processes; delivery uses the existing
     fs-watch/owner-side machinery once the session is re-linked).
  3. `last_heartbeat` = last SSE event seen for that session; stale threshold reuses
     the channel `stale_event_ms` policy (no new timing knob).
- **Orchestrator crash recovery:** state is atomic; on restart the orchestrator
  re-detects: serve alive? (port probe), sessions alive? (session list / SSE),
  reconcile agent rows with reality; unexplained rows → `stale`, never deleted.

## 8. Engine blockers/changes needed (recorded; integrated by Lead — NOT changed in M0)

1. **`createSessionAsOperator` sentinel project id.** GUI-created channels use
   `project_id:"gui-local-project"` (`src/gui/server.ts`). Orchestrator-created
   channels should stamp the REAL project id (or an explicit `orchestrator` sentinel
   consistently) so a spawned agent's join (which validates `project_id` equality)
   cannot be rejected. Verify join-channel project matching for the operator-created
   channel when the agent joins with its own session context.
2. **`stale` gating on sends.** Spawned agents that have never gone through a host
   idle event are `stale:false` by default (fresh rows) — OK. But a serve restart
   gap > `stale_event_ms` marks pushed mail rejected for PUSH members. M1 must either
   (a) set spawned members' `stale_policy` window generously, or (b) rely on the
   orchestrator's own restart policy (M2) — record decision at M1 implementation.
3. **No engine change required for membership.** Join keys on `ctx.sessionID` which
   equals the captured `host_session_id`; role/`max_members`/project checks all
   apply unchanged. The spike's open question (managed-vs-user session distinction)
   is solved in ORCHESTRATOR state (`agt_*` key + `managed` marker), not the engine.
4. **Timer keying** (`elapsed_ms[sessionId]`) works unchanged for spawned agents once
   joined (session-id keyed).

## 9. Milestone mapping (what M1 implements from this note)

- `src/orchestrator/` skeleton: `state.ts` (orchestrator.json store + lock),
  `runtime.ts` (AgentRuntime/AgentHandle/registry), `runtimes/opencode.ts` (spike
  code, promoted and hardened), `api.ts` (route handlers for §5), `events.ts` (SSE
  topics).
- M1 scope cut: local node only; single serve instance per project; create/spawn,
  status, stop, restart-stub; Lead designated enforcement; runtimes listing;
  events (orchestration kind); trust store + confirm-token gate wired for approve
  endpoints (no remote nodes to approve yet).
- **M1 addition (Lead tasking 2026-09-11):** `opencode models` catalog cache —
  `listModelsCatalog` (runtimes/opencode.ts) shells the CLI once per runtime
  instance (30s timeout, cwd = project), parses `provider/model` lines into
  `{provider, models[]}` groups, and GET /nodes/{id}/runtimes serves the full
  catalog with the configured serve pin surfaced FIRST. Unblocks the Team
  create-dialog model picker.
- **M1 closure:** ensureServe (managed shared-serve bootstrap: one child per
  project, argv-only launch, env-only crypto password, stdout-listening
  readiness with timeout-kill, idempotent reuse, SIGTERM on server close,
  serve.port recorded on the local node + ledger assertion on GUI-path
  create); resolveOpencodeBinary checked==returned fix. Live spawn→join
  proof PASSED (Reviewer-reproduced); M1 exit approved.

## 9b. M2 — Supervision & tasking (Backend lane; design addendum BEFORE code)

Lead tasking 2026-09-12. Deliverable order: (1)+(2) supervision core, (3) tasks,
(4) permissionsDrain. Review priorities pre-queued: orphan prevention on stop,
restart vs duplicate identities, task trust boundaries, permissionsDrain surface.

### 1. Real stop/restart (replaces the M1 restart stub)

- **stop(agent_id, force?)** — REAL termination path per runtime:
  1. Resolve the runtime handle (resume from the persisted record).
  2. `handle.abort()` first (graceful turn interruption), then the runtime's
     process-level stop: for the shared serve this is a SESSION stop (abort +
     session row marked stopped) — the serve process itself is NEVER killed
     per-agent (it hosts ALL agents; kill = node-level operation only, see
     shutdownNode). `force=true` escalates: abort + immediate stopped marking
     without waiting for turn completion.
  3. Orphan prevention (Review priority): stop MUST verify no lingering child
     references — the orchestrator holds only the SHARED serve child; agent
     stop never touches it. Assertion: after stop, `agent.status === "stopped"`
     AND the serve child is still alive AND `session.abort` was called exactly
     once (per-member serialization guard, same pattern as spawn-delivery).
  4. Designated lead stays un-stoppable (M1 rule preserved).
- **restart(agent_id)** — adopts or re-creates the host session:
  1. Session ids persist across serve restarts (spike §7 finding: global
     namespace, rows survive). Restart therefore FIRST attempts
     `resume({ host_session_id })`; the resumed handle is the SAME identity —
     `restart_count += 1`, status `starting → running`, host_session_id
     UNCHANGED (restart vs duplicate identities (Review priority): a restart
     NEVER allocates a second session unless resume fails).
  2. If resume fails (session row gone / host purged it): re-create via
     `create()` with the ORIGINAL spawn request fields (name/role/role_prompt/
     model persisted in the record) and PERSIST THE NEW host_session_id, with
     a `agent_restarted` event noting the identity change. The agent record's
     channel memberships are re-joinable by the runtime composing the join
     prompt again (the old session's membership dies with the old session id;
     engine state marks the old session stale via the existing machinery).
  3. restart_count is already persisted (M1); it goes live here.

### 2. Stale/crash detection + restart policy

- **Serve-disconnect detection:** the SSE tap (`event.subscribe`) is the
  liveness oracle (spike rule). On stream end / `server.instance.disposed` /
  repeated reconnect failure, the orchestrator marks ALL agents on that node
  `stale` (event-driven, never GET /session/status polling). M1's
  `last_heartbeat` (last SSE event seen per session) feeds the same threshold
  as the channel `stale_event_ms` policy — no new timing knob.
- **Restart policy = OPERATOR-CONTROLLED in M2 (binding):** no auto-respawn.
  Agents that crash/serve-die are marked stale/failed and surfaced; the
  operator (GUI restart button / CLI verb) decides. The restart policy hook
  exists (`restart_policy: "manual" | "auto"` on the node record, default
  "manual") so M3 can flip it per-node without a migration.
- **Crash recovery on orchestrator start** (from M1 design §7, now
  implemented): reconcile agent rows against reality — serve alive? (port
  probe), session alive? (SSE/session list) — unexplained rows → stale,
  never deleted.

### 3. Task assignment via channels

- **POST /tasks/assign** `{ agent_id, task: { title, body, channel } }` —
  rides the EXISTING message engine: the orchestrator composes a
  `review_request`-semantics envelope (trust boundary (Review priority):
  the task body is UNTRUSTED content — framed identically to peer mail; the
  orchestrator is just another sender on the channel, never a privileged
  injection path. It sends AS the operator session via engine sendMessage —
  no new message type, no new delivery path).
- **Task identity:** `tsk_*` id generated at assign; the envelope's
  `correlation_id` records the task link (additive `task_id` on the event,
  contract §9). **GET /tasks** derives status from channel state (acked =
  agent replied in the same correlation chain; completed = terminal event)
  — honest derivation, no separate task store in M2.
- **Events:** lifecycle events (`task_assigned`, `task_acked`,
  `task_completed`) carry `task_id` in the orchestration feed.

### 4. permissionsDrain (opencode first)

- The host exposes `POST /session/:id/permissions/:permissionID` (research
  report §1A). The opencode AgentHandle implements `permissionsDrain()`:
  list pending permission prompts (GET) + respond (POST response/remember).
- Surface: orchestrator API `GET /agents/{id}/permissions` +
  `POST /agents/{id}/permissions/{permissionID}` with `{ response }`. Trust
  boundary (Review priority): permission RESPONSES are operator actions —
  the orchestrator API is operator-only (loopback + browser-surface guard);
  agent-facing tools never reach it. Least-privilege default from M1 stands:
  deny-by-default allowlists at spawn; the drain surface only answers prompts
  for capabilities the spawn config gated.
- `AgentHandle.permissionsDrain` returns null for runtimes without the host
  API (interface already optional).
