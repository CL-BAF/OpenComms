# OpenComms Desktop GUI — Information Architecture (M0 proposal)

Owner: Frontend. Status: PROPOSAL for Lead approval; contract gaps in §8 are
requests, not decisions. Consumes only `docs/orchestrator-api.md` contract v0 —
no invented endpoints, no fake data; surfaces whose endpoints are missing stay
visibly disabled until Backend lands them.

## 1. Design principles

1. **Lead is visually distinct and primary.** The owner's home surface is the
   Lead view: Lead's state, current focus, its team at a glance, and the
   owner-approval inbox (node trust requests). Lead is the only agent rendered
   with the accent identity; every other agent is neutral until inspected.
2. **Server is source of truth.** The shell owns no business logic; every view
   is a projection of the Orchestrator API + existing `/api/*` surface.
3. **Honesty over polish.** No optimistic fake states. If an endpoint is
   missing, the surface renders disabled with a "waits on contract" note.
4. **Multi-machine never assumed.** Nodes/remote anything is opt-in UI; the
   local node is shown implicitly, remote nodes appear only after approval.
5. **Manual workflows stay first-class.** Manual create/join/send flows remain
   reachable in the redesign (they are the M0-era paths, kept working).

## 2. Navigation model

Persistent left rail (carried over from the existing console shell, restyled):

```
Overview   (Lead-distinct owner home; default route)
Sessions   (OpenComms channels: live + saved)
Team       (managed agents: lifecycle + status)
Tasks      (M2: assignment + progress)
Nodes      (M3: machines, trust gate)
Activity   (unified event feed)
Settings   (workspace, security boundary, diagnostics entry)
```

Sessions absorbs today's Saved Sessions as a segment (active / saved tabs).
Integrations + Diagnostics move under Settings (Integrations keeps its honest
per-host status; Diagnostics stays copyable + secret-free).

## 3. Surface: Overview (Lead home)

Owner opens the app → sees Lead first.

- **Lead card (accent-styled, largest element):** identity (name, runtime,
  host), status (`starting|running|idle|stale|stopped|failed`), node, channels,
  last heartbeat, redacted spawn command.
- **Team strip:** one-line-per-agent roster summary (role, status) with link
  into Team.
- **Owner inbox:** pending node-approval requests + budget/trust notices.
  Owner-only actions; Lead cannot approve remote nodes (contract §5).
- **Quick actions:** New session, Create agent, Assign task (disabled pre-M2).

Endpoints needed (contract v0):
- `GET /api/orchestrator/agents` (filter to the Lead-designated agent)
- `GET /api/orchestrator/trust` (pending requests; M1 = read-only stub)
- `GET /api/orchestrator/events?since=` (owner-inbox notices)
- existing `POST /api/sessions` (quick new session)

## 4. Surface: Sessions

Carry forward today's proven detail surface (lifecycle, budgets, join
commands, member removal, save/resume/delete), restyled into the new IA:

- **List:** live + saved segments; card = name, badge, description, roles,
  member count, last activity (today's shape is good — keep it).
- **Detail:** overview KVs; agents panel (per-member state Working/Idle/
  Offline); join-agent panel with per-host command + capability warning;
  archive panel (summary + compact context + resume) for saved sessions.

Endpoints: existing `/api/sessions*` family only. No contract-v0 dependency.
This surface ships FIRST (it is the "manual workflows keep working" proof).

## 5. Surface: Team (M1)

Managed-agent roster — the M1 GUI deliverable.

- **Roster table:** name, role, host/runtime, node (local implicit), status
  pill, channel membership, last heartbeat.
- **Create agent** dialog (owner action): name, host/runtime, role, role
  prompt, target channel, optional node (local default; remote only from
  approved list), optional model/provider config.
- **Agent detail:** full record incl. task-history refs, spawn command
  (redacted), stop/restart controls with confirm modals.

Endpoints (contract v0):
- `GET /api/orchestrator/agents`
- `POST /api/orchestrator/agents/create`
- `POST /api/orchestrator/agents/stop` (+`force`)
- `POST /api/orchestrator/agents/restart`
- `GET /api/orchestrator/agents/{id}`

## 6. Surface: Tasks (M2 — disabled until endpoints land)

- Task list: title, assigned agent, channel, derived status, timestamps.
- Assign-task dialog (Lead/owner action): agent picker, title, body, channel.
- Task detail: status derived from agent acks/messages; link into session.

Endpoints (contract v0 §3): `POST /api/orchestrator/tasks/assign`,
`GET /api/orchestrator/tasks`. Both are M2-stubbed in M1 → route renders
disabled with "waits on M2 contract" note.

## 7. Surface: Nodes (M3; read-only local in M1)

- **Local node** card always present: platform, `max_agents`, runtimes,
  headless capability, online status.
- **Remote nodes:** appear ONLY as `pending_approval` requests (owner inbox
  drives approval) or approved entries with revoke control.
- Node detail: capabilities view (what it can host), agents currently placed
  on it, approval timestamp + approver.

Endpoints (contract v0 §1, §5): `GET /api/orchestrator/nodes`,
`POST /api/orchestrator/nodes/approve` (owner-only),
`POST /api/orchestrator/nodes/revoke`, `GET /api/orchestrator/trust`.
Remote-node UI renders disabled until M3; local node renders from M1 stubs.

## 8. Contract gaps — PROPOSALS to Lead (do not implement yet)

1. **Lead identity (blocks Overview).** Contract v0 has no way to tell which
   agent is the built-in Lead. Proposal: add
   `GET /api/orchestrator/lead` → `{ agent_id, status, node_id, channel_ids }`
   OR a `designated: "lead"` flag on the agents list items. Needed before M1
   Team/Overview work renders Lead-distinct.
2. **Provider/model options (blocks Create-agent dialog).** `agents/create`
   accepts `model?/provider_config?` but nothing lists valid choices per node.
   Proposal: `GET /api/orchestrator/nodes/{id}/runtimes` →
   `[{ runtime, providers: [{ provider, models: string[] }] }]`. M1 need.
3. **Activity feed composition.** `GET /api/orchestrator/events` covers
   orchestration events only; channel message traffic (the interesting
   activity) is member-scoped in the channel engine. Proposal: extend the
   orchestrator events feed with `kind: "orchestration" | "channel_notice"`
   OR expose an owner-scoped `GET /api/orchestrator/sessions/{name}/activity`
   wrapping channel history for console members. Needed by M2/M4 (Activity).
4. **Task lifecycle events.** For Tasks UX, tasks need to appear on the
   events feed (assigned/acked/progress/done) — proposal: orchestrator events
   include `task_id` when applicable. M2 need.
5. **SSE topic split.** Existing `/api/events` fires generic `refresh`. Fine
   for M0/M1 refetch, but by M2 the GUI needs cheap targeted refresh.
   Proposal: additive SSE event names (`orchestrator`, `tasks`) on the same
   stream; shapes stay additive per contract §7.

## 9. What is intentionally NOT in this proposal

- No visual spec/colors beyond "Lead = accent identity, others neutral".
- No IPC migration — loopback HTTP stays the transport (contract §0); shapes
  identical when/if an ADR moves transport to Tauri IPC.
- No fake data anywhere; disabled states carry explanatory copy instead.

## 10. Sequencing

1. **Now (M0):** spike shell wraps existing console (done — see
   `desktop/README.md`); this doc is the contract-coordination artifact.
2. **M1:** rebuild IA shell (new nav, Overview skeleton, Sessions restyled
   from existing endpoints, Team live against real agents endpoints).
3. **M2:** Tasks + Activity (with events composition per §8.3/8.4 outcomes).
4. **M3:** Nodes + trust-gate UI against real Registry endpoints.
5. **M4:** parity pass Win/Linux + headless CLI parity check with Platform.