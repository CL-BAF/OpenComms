# Task execution and verification

Tasks extend the existing `.opencomms/orchestrator.json`. Assignment still uses the channel engine, recipient queue, framing and budget limits. There is no second task database or substitute agent runtime.

Delivery (`unknown`, `queued`, `in_flight`, `delivered`, `acknowledged`, `failed`, `stale`) describes receipt. Execution (`ready`, `assigned`, `running`, `blocked`, `review`, `verified_complete`, `failed`, `cancelled`) describes work. A reply saying “done”, delivery acknowledgement or successful compilation never automatically completes a task. The compatibility `status` field remains a delivery alias.

Assign an existing managed agent after explicitly linking its existing host session to the selected channel. Assignments target that endpoint even on channels with three or more members. The backend rejects missing/disconnected recipients, unmet dependencies, channel budgets and overlapping ownership unless an operator explicitly acknowledges the overlap. Ownership is advisory; it does not enforce filesystem isolation.

```powershell
node dist/cli/main.js gui --server --port 4919
node dist/cli/main.js task assign --agent agt_REPLACE --channel team --title "Fix attack behavior" --body "Target the nearest hostile entity" --criterion "Attack targets the nearest hostile entity" --owns "src/combat" --request-id "attack-fix-1"
node dist/cli/main.js task list
node dist/cli/main.js task show tsk_REPLACE
```

Reuse the same `--request-id` when retrying an assignment or handoff. The backend journals the operation before dispatch. An interrupted operation without a persisted envelope remains uncertain and refuses blind retries. If its exact envelope was durably queued, recovery finds it and returns the existing task. A reused key with different content or another operation type is rejected.

Transitions require the current `revision` and either the durable owner or local operator. A blocked/failed outcome requires an actionable blocker. Work moves from assigned to running, then review. Returning from review to running requires `changes_requested` feedback. Review rounds are bounded (default three, configurable 1–20). Terminal outcomes cannot be reopened silently.

Only the local operator can accept `review → verified_complete`. Acceptance requires nonempty criteria, an independent accepted review and passing evidence for every criterion. A patch/artifact reference alone is insufficient. Evidence must describe the requested behavior; the application records evidence and enforces coverage, while the human reviewer judges whether that evidence is valid. It does not execute referenced checks or prove the truth of arbitrary submitted text.

Create `evidence.json` containing:

```json
[
  {
    "criterion": "Attack targets the nearest hostile entity",
    "kind": "behavior",
    "reference": "checks/nearest-hostile-scenario.log",
    "summary": "Scenario records the attack target switching to the nearest hostile entity.",
    "passed": true
  }
]
```

Create `review.json` containing:

```json
{
  "outcome": "accepted",
  "reviewer": "operator",
  "summary": "Observed the requested behavior and reviewed the scenario evidence."
}
```

After inspecting the current revision:

```powershell
node dist/cli/main.js task transition tsk_REPLACE --state running --revision 1
node dist/cli/main.js task transition tsk_REPLACE --state review --revision 2
node dist/cli/main.js task transition tsk_REPLACE --state verified_complete --revision 3 --evidence-file evidence.json --review-file review.json
```

The browser/native task view uses these same operations. MCP workers use `opencomms_task_report` to report running, blocked, review or failed work. Their identity comes from the process pin and current project roster; they cannot supply an operator actor or accept verified completion. Owner reports acknowledge receipt while preserving independent execution state. Member task reads include only assignments to that endpoint; operator views can inspect all tasks in the selected project.

| Operation               | Shared HTTP route                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| List / assign           | `GET /api/orchestrator/tasks`, `POST /api/orchestrator/tasks/assign`                       |
| Detail / transition     | `GET /api/orchestrator/tasks/:id`, `POST /api/orchestrator/tasks/:id/transition`           |
| Explicit reassignment   | `POST /api/orchestrator/tasks/:id/reassign`                                                |
| Saved team templates    | `GET/POST /api/orchestrator/team-templates`, `DELETE /api/orchestrator/team-templates/:id` |
| Context search / append | `GET /api/orchestrator/context?query=`, `POST /api/orchestrator/context`                   |
| Compact handoff         | `GET /api/orchestrator/context/handoff`                                                    |

## Explicit handoffs and saved team plans

The local operator can reassign assigned, blocked or review work to another active, linked worker. Revision, a distinct request ID and an actionable reason are required. Running work must be stopped and reported blocked first. Already received work requires an explicit confirmation that the prior owner stopped this task. Uncertain in-flight prompts and terminal outcomes cannot be reassigned. Queue cancellation and new handoff delivery commit together; prior messages, ownership, evidence, artifacts and context remain inspectable. Independent review must be recorded again for the new attempt. Each task retains at most 16 handoffs and refuses further transfers instead of evicting history.

```powershell
node dist/cli/main.js task reassign tsk_REPLACE --agent agt_REPLACEMENT --reason "Previous owner stopped; transfer remaining combat change" --revision 4 --handoff-confirmed --request-id "combat-handoff-1"
```

Saved templates record a name, description, one to eight unique roles, bounded role prompts, host/runtime, optional model pins, capability requirements and conversation/review budgets. In this build host and runtime must match. Requirements use `push`, `interrupt`, `permissions`, `status`, `identity`, `isolated_worktree` or `model_selection`; saving a requirement does not prove a host supports it. Templates are project-local and capped at 32. Edits and deletion require the current template revision. Saving/deleting plans never launches, stops or replaces agents.

Applying a plan requires an explicit entry and mode selection. Linking prepares instructions for an existing host session and preserves its identity/model/workspace; managed launch uses the existing checked creation path. Requirements are validated before managed launch. Conversation budgets apply only when explicitly creating a channel with those values, and review limits are chosen during assignment. Templates do not silently modify existing channel budgets or host permissions.

## Project context

Context records distinguish proposed approaches, accepted decisions/constraints, verified findings with evidence references, open questions and rejected approaches. Records stay inside the selected project's orchestration store. Search covers title, body, kind and status. Compact handoffs return at most 12 recent context records and 12 active tasks, with references to deeper records rather than an injected full history.

```powershell
node dist/cli/main.js task context add --record-file decision.json
node dist/cli/main.js task context list --search targeting
node dist/cli/main.js task context handoff
```

An example context record is `{ "kind": "decision", "status": "accepted", "title": "Targeting interface", "body": "Select the nearest hostile entity.", "references": ["src/combat/target.ts"] }`. A `finding/verified` record requires at least one evidence reference. Known coordinator credentials are refused before entering task content, reports or context.

## Safe migration and recovery

Emergency coordination stop is persisted in the same project store with the names of channels it paused. Restart and project switching retain that stop. Explicit resume unpauses only those channels, preserving separate operator pauses; it never restarts managed agents automatically. Managed status details retain bounded, redacted recovery guidance. Stale/rejected queue cleanup is saved even when no host batch is dispatched, and unknown in-flight acceptance remains visible for reconciliation.

The orchestration schema remains version 1 with additive task and team-template version 1 extensions. Old task message markers are read as legacy assignments with no execution evidence. Old replies may acknowledge delivery but never imply verified completion. Records become durable when assigned or explicitly transitioned. Operators can supply `--criteria-file` on a transition to add acceptance criteria to legacy work.

Before the first write of this extension, the exact old orchestration document is copied to `.opencomms/orchestrator.pre-tasks-v1.json`. Channel queues/messages, archives and host configuration are retained. Invalid/forward-version orchestration documents are preserved as `orchestrator.rejected.*.json`; malformed JSON is preserved as `orchestrator.unreadable.*.json` before fail-closed recovery. Stop coordinator instances before restoring a backup, preserve the current files, and upgrade all instances before resuming writes. Never combine stores from different projects.

Task storage is bounded at 2,000 records, context at 500; reaching these limits refuses additional work instead of silently deleting verification evidence. Automatic pruning, dependency queue scheduling, model fallback, arbitrary model changes to linked sessions and worktree merging are not implemented. Verified dependencies are enforced at assignment/run/acceptance admission. Manual reassignment supplies an explicit fallback choice; it does not automatically schedule replacement work. Delivery budgets are checked at send and every queued handover/retry; capped work remains queued for an operator budget decision.

## Opt-in coordination evaluation

`scripts/evaluate-coordination.mjs` compares recorded, real runs without launching or modifying agents. Use the same prompt and acceptance criteria for each case in a one-agent cohort, a small team using at least two integration hosts, and a 5–8-agent cohort. Run those tasks through the application and independently review their evidence. Record human interventions and actual host versions yourself; unknown telemetry stays absent.

The input is a JSON manifest with `version: 1`, `build_version`, `tested_revision`, `cases: [{id,prompt,acceptance_criteria}]`, and exactly three `cohorts`. Each cohort has `name` (`solo`, `mixed`, `eight`), explicit `agent_ids`, matching `hosts` and `host_versions`, and `runs: [{case_id,task_id,human_interventions}]`. Each case needs a distinct task in every cohort. Optional run `usage` is accepted only with `source: "host_telemetry"`, an evidence `reference`, and actual `tokens`/`cost`/`currency`; estimates are excluded.

```powershell
node scripts/evaluate-coordination.mjs --allow-evaluation --manifest evaluation-runs.json --output evaluation-report.json
```

Requests are sequential, loopback-only, limited to 16 cases × 3 cohorts and 10 seconds per request. The report counts evidence-backed outcomes, failures, unfinished work, recorded human interventions, duration from assignment to the last execution transition and available usage. It verifies equal prompts/criteria and declared task ownership. Declared team membership is not proof that every participant contributed; the report states this visibility limit. Exit 0 requires all cases verified, 1 means valid comparison with unfinished/unsuccessful outcomes, 2 means invalid input or unavailable backend. No live performance result is supplied until real cohorts have run.

## Verification

`test/unit/core/tasks.test.ts` covers real persisted assignment/queue targeting, concurrent retry deduplication, acknowledgement vs execution, revision/ownership/dependency/review gates, crash-window recovery, legacy migration, project isolation, credential rejection, saved templates, explicit handoffs, the production MCP queue persistence path, host-bound task reports and CLI transport. Delivery/controller budget tests cover queued batches, retries and expiry; coordination-state tests cover emergency recovery across project changes and restart. These checks prove local task coordination contracts; they do not prove interoperability with an authenticated live coding host or the semantic correctness of external evidence.
