import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OrchestratorApi, type OrchestratorApiDeps } from "../../../src/orchestrator/api.js"
import { OrchestratorStore, newAgentId, validateOrchestratorState } from "../../../src/orchestrator/state.js"
import { StateStore } from "../../../src/core/store.js"
import { createChannel, joinChannel, sendMessage } from "../../../src/core/engine.js"
import type { State } from "../../../src/core/types.js"
import type { TaskRecord } from "../../../src/orchestrator/tasks.js"
import { orchestratorTools } from "../../../src/mcp/orchestrator-tools.js"
import { buildOrchestratorApi } from "../../../src/mcp/main.js"
import { startGuiServer } from "../../../src/gui/server.js"
import { dispatchBridgeCommand, type BridgeDeps } from "../../../src/orchestrator/bridge.js"
import {
  taskList,
  taskAssign,
  taskTransition,
  taskReassign,
  taskShow,
  taskContext,
  setTaskDeps,
} from "../../../src/cli/tasks.js"

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ocm-task-evidence-"))
  const channelStore = new StateStore(dir)
  const store = new OrchestratorStore(dir, channelStore)
  const orch = store.load()
  const agentId = newAgentId()
  const sender = `operator-${orch.local_node_id}`
  orch.agents.push({
    id: agentId,
    name: "Worker",
    host: "opencode",
    role: "Worker",
    role_prompt: "Implement the acceptance criteria.",
    runtime: "opencode",
    node_id: orch.local_node_id,
    worktree: dir,
    status: "idle",
    host_session_id: "worker-session",
    spawn_cmd_redacted: "opencode",
    designated: null,
    channel_ids: ["team"],
    last_heartbeat: null,
    created_at: Date.now(),
    restart_count: 0,
    model: null,
  })
  store.save(orch)
  const channelState = channelStore.load()
  assert.ok(
    createChannel(channelState, {
      channel: "team",
      role: "Operator",
      role_prompt: "Coordinate tasks",
      session_id: sender,
      project_id: dir,
      worktree: dir,
    }).ok,
  )
  for (const [session_id, role] of [
    ["worker-session", "Worker"],
    ["other-session", "Reviewer"],
  ]) {
    assert.ok(
      joinChannel(channelState, {
        channel: "team",
        role: role!,
        role_prompt: role!,
        session_id: session_id!,
        project_id: dir,
        worktree: dir,
      }).ok,
    )
  }
  channelStore.save(channelState)
  let sends = 0
  const deps: OrchestratorApiDeps = {
    projectDir: dir,
    servePassword: () => "",
    serveModel: () => undefined,
    servePort: () => 0,
    projectId: () => dir,
    withLock: (fn) => channelStore.withLock(fn),
    loadOrchestrator: () => store.load(),
    saveOrchestrator: (s) => store.save(s),
    loadChannelEngineState: () => channelStore.load(),
    saveChannelEngineState: (s) => channelStore.save(s as State),
    engineSend: (state, input, senderId) => {
      sends += 1
      return sendMessage(
        state as State,
        {
          channel: input.channel,
          content: input.content,
          type: input.message_type,
          to: input.to,
        },
        senderId,
      )
    },
    feed: { emit() {} },
  }
  const api = new OrchestratorApi(deps)
  const assignment = (extra: Record<string, unknown> = {}) => ({
    agent_id: agentId,
    request_id: "assignment-1",
    task: {
      title: "Fix attack behavior",
      body: "Target the nearest hostile entity",
      channel: "team",
      acceptance_criteria: ["Attack targets the nearest hostile entity"],
      ownership: ["src/combat"],
      ...extra,
    },
  })
  return {
    dir,
    store,
    channelStore,
    agentId,
    api,
    deps,
    assignment,
    sends: () => sends,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
function view(api: OrchestratorApi, taskId: string): TaskRecord {
  const result = api.getTask(taskId)
  assert.ok(result.ok, result.message)
  return (result.data as { task: TaskRecord }).task
}
async function destination(f: ReturnType<typeof fixture>, endpoint = "other-session") {
  const id = newAgentId()
  await f.store.update((state) =>
    state.agents.push({ ...state.agents[0]!, id, name: "Reviewer", role: "Reviewer", host_session_id: endpoint }),
  )
  return id
}
async function change(api: OrchestratorApi, taskId: string, state: string, fields: Record<string, unknown> = {}) {
  return api.transitionTask(taskId, {
    state,
    actor_id: "operator",
    expected_revision: view(api, taskId).revision,
    ...fields,
  })
}

test("task assignment targets only its owner on a three-member channel; concurrent retries dispatch once", async () => {
  const f = fixture()
  try {
    const [a, b] = await Promise.all([f.api.assignTask(f.assignment()), f.api.assignTask(f.assignment())])
    assert.ok(a.ok, a.message)
    assert.ok(b.ok, b.message)
    assert.equal((a.data as { task_id: string }).task_id, (b.data as { task_id: string }).task_id)
    assert.equal(f.sends(), 1)
    const messages = Object.values(f.channelStore.load().messages)
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.recipient_session_id, "worker-session")
    assert.match(messages[0]?.content ?? "", /Acceptance criteria/)
    const conflict = await f.api.assignTask({
      ...f.assignment(),
      task: { ...f.assignment().task, title: "Another assignment" },
    })
    assert.equal(conflict.ok, false)
    assert.match(conflict.message, /different assignment/)
    assert.equal(f.sends(), 1)
    await f.store.update((s) => {
      s.agents[0]!.status = "stopped"
    })
    const replayAfterDisconnect = await f.api.assignTask(f.assignment())
    assert.ok(replayAfterDisconnect.ok, replayAfterDisconnect.message)
    assert.equal(f.sends(), 1)
  } finally {
    f.cleanup()
  }
})

test("operator reassignment cancels queued prior delivery atomically, preserves task evidence/context, and deduplicates concurrent retries", async () => {
  const f = fixture()
  try {
    const target = await destination(f)
    const assigned = await f.api.assignTask(f.assignment())
    const id = (assigned.data as { task_id: string }).task_id
    const original = view(f.api, id)
    assert.ok(
      (
        await change(f.api, id, "blocked", {
          blocker: "Needs another implementation owner",
          artifacts: ["src/combat.ts"],
          evidence: [
            {
              criterion: original.acceptance_criteria[0],
              kind: "check",
              passed: false,
              reference: "test-output",
              summary: "Nearest target still wrong",
            },
          ],
        })
      ).ok,
    )
    assert.ok(
      (
        await f.api.addContext({
          kind: "constraint",
          status: "accepted",
          title: "Target behavior",
          body: "Ignore friendly entities",
        })
      ).ok,
    )
    const request = {
      actor_id: "operator",
      agent_id: target,
      request_id: "handoff-1",
      expected_revision: view(f.api, id).revision,
      reason: "Transfer the isolated combat change",
      handoff_confirmed: true,
    }
    const results = await Promise.all([f.api.reassignTask(id, request), f.api.reassignTask(id, request)])
    assert.ok(
      results.every((r) => r.ok),
      JSON.stringify(results),
    )
    assert.equal(f.sends(), 2, "one original assignment and one handoff")
    const task = view(f.api, id)
    assert.equal(task.owner, target)
    assert.equal(task.recipient_session_id, "other-session")
    assert.equal(task.execution_state, "assigned")
    assert.deepEqual(task.ownership, original.ownership)
    assert.deepEqual(task.acceptance_criteria, original.acceptance_criteria)
    assert.equal(task.evidence[0]!.passed, false)
    assert.deepEqual(task.artifacts, ["src/combat.ts"])
    assert.equal(task.reassignments?.[0]?.from_owner, f.agentId)
    assert.match(task.reassignments![0]!.from_blocker!, /another implementation owner/)
    assert.ok(task.related_message_ids.includes(original.message_id!))
    const channels = f.channelStore.load()
    assert.deepEqual(channels.queues["worker-session"], [])
    assert.equal(channels.messages[original.message_id!]!.delivery_status, "rejected")
    assert.deepEqual(channels.queues["other-session"], [task.message_id])
    assert.equal((f.api.listContext().data as { records: unknown[] }).records.length, 1)
    assert.equal((await f.api.reassignTask(id, { ...request, reason: "Different handoff" })).ok, false)
    assert.equal(
      (await change(f.api, id, "running", { actor_id: f.agentId })).ok,
      false,
      "old worker cannot report for transferred work",
    )
  } finally {
    f.cleanup()
  }
})

test("reassignment refuses active or uncertain execution and requires confirmation for already received work", async () => {
  const f = fixture()
  try {
    const target = await destination(f)
    const assigned = await f.api.assignTask(f.assignment())
    const id = (assigned.data as { task_id: string }).task_id
    const req = () => ({
      actor_id: "operator",
      agent_id: target,
      request_id: "safe-handoff",
      reason: "Move bounded work",
      expected_revision: view(f.api, id).revision,
    })
    assert.equal((await f.api.reassignTask(id, { ...req(), actor_id: f.agentId })).ok, false)
    const engine = f.channelStore.load()
    engine.messages[view(f.api, id).message_id!]!.delivery_status = "in_flight"
    f.channelStore.save(engine)
    const uncertain = await f.api.reassignTask(id, { ...req(), handoff_confirmed: true })
    assert.equal(uncertain.ok, false)
    assert.match(uncertain.message, /in-flight/)
    engine.messages[view(f.api, id).message_id!]!.delivery_status = "delivered"
    f.channelStore.save(engine)
    const unconfirmed = await f.api.reassignTask(id, req())
    assert.equal(unconfirmed.ok, false)
    assert.match(unconfirmed.message, /Confirm the previous owner/)
    assert.ok((await change(f.api, id, "running")).ok)
    const active = await f.api.reassignTask(id, { ...req(), handoff_confirmed: true })
    assert.equal(active.ok, false)
    assert.match(active.message, /running/)
    assert.equal(f.sends(), 1)
    assert.equal(view(f.api, id).reassignments, undefined)
  } finally {
    f.cleanup()
  }
})

test("deterministic refused handoff retains prior owner and queue; retrying that operation never repeats dispatch", async () => {
  const f = fixture()
  try {
    const target = await destination(f, "not-linked-session")
    const assigned = await f.api.assignTask(f.assignment())
    const id = (assigned.data as { task_id: string }).task_id
    const original = view(f.api, id)
    const request = {
      actor_id: "operator",
      agent_id: target,
      request_id: "refused-handoff",
      expected_revision: original.revision,
      reason: "Transfer work",
    }
    const refused = await f.api.reassignTask(id, request)
    assert.equal(refused.ok, false)
    assert.equal(view(f.api, id).owner, f.agentId)
    assert.deepEqual(f.channelStore.load().queues["worker-session"], [original.message_id])
    assert.equal(view(f.api, id).reassignments![0]!.dispatch_state, "failed")
    assert.equal((await f.api.reassignTask(id, request)).ok, false)
    assert.equal(f.sends(), 2)
  } finally {
    f.cleanup()
  }
})

test("interrupted handoff before queue persistence is visibly uncertain and cannot be blindly retried", async () => {
  const f = fixture()
  try {
    const target = await destination(f)
    const assigned = await f.api.assignTask(f.assignment())
    const id = (assigned.data as { task_id: string }).task_id
    const request = {
      actor_id: "operator",
      agent_id: target,
      request_id: "uncertain-handoff",
      expected_revision: view(f.api, id).revision,
      reason: "Transfer work",
    }
    const interrupted = new OrchestratorApi({
      ...f.deps,
      saveChannelEngineState: () => {
        throw new Error("simulated disk failure")
      },
    })
    assert.equal((await interrupted.reassignTask(id, request)).ok, false)
    assert.equal(view(f.api, id).reassignments![0]!.dispatch_state, "dispatching")
    assert.equal((await f.api.reassignTask(id, request)).ok, false)
    assert.equal((await change(f.api, id, "assigned")).ok, false)
    assert.equal(f.sends(), 2)
  } finally {
    f.cleanup()
  }
})

test("handoff recovery after persisted queue but interrupted final save uses its exact envelope and never resends", async () => {
  const f = fixture()
  try {
    const target = await destination(f)
    const assigned = await f.api.assignTask(f.assignment())
    const id = (assigned.data as { task_id: string }).task_id
    const request = {
      actor_id: "operator",
      agent_id: target,
      request_id: "recover-handoff",
      expected_revision: view(f.api, id).revision,
      reason: "Transfer work",
    }
    const interrupted = new OrchestratorApi({
      ...f.deps,
      saveOrchestrator: (state) => {
        if (state.tasks.find((t) => t.task_id === id)?.reassignments?.at(-1)?.dispatch_state === "sent")
          throw new Error("final save failed")
        f.store.save(state)
      },
    })
    assert.equal((await interrupted.reassignTask(id, request)).ok, false)
    const recovered = view(f.api, id)
    assert.equal(recovered.owner, target)
    assert.equal(recovered.execution_state, "assigned")
    assert.equal(recovered.reassignments![0]!.dispatch_state, "sent")
    assert.equal(recovered.blocker, null)
    assert.ok((await f.api.reassignTask(id, request)).ok)
    assert.equal(f.sends(), 2)
  } finally {
    f.cleanup()
  }
})

test("saved team templates are project-local editable intent; save/delete never launches or alters live agents", async () => {
  const f = fixture(),
    other = fixture()
  try {
    const body = {
      name: "Combat fix team",
      description: "Builder and independent reviewer",
      entries: [
        {
          entry_id: "builder",
          role: "Builder",
          role_prompt: "Implement evidence-backed changes",
          host: "opencode",
          runtime: "opencode",
          model: "provider/model",
          required_capabilities: ["push", "identity"],
        },
        {
          entry_id: "reviewer",
          role: "Reviewer",
          role_prompt: "Check acceptance behavior",
          host: "claude-code",
          runtime: "claude-code",
          model: null,
          required_capabilities: ["status"],
        },
      ],
      budgets: { max_runtime_ms: 60_000, max_delivered_messages: 20, max_review_rounds: 3 },
    }
    const beforeAgents = f.store.load().agents
    const saved = await f.api.saveTeamTemplate(body)
    assert.ok(saved.ok, saved.message)
    const template = (saved.data as { template: { id: string; revision: number } }).template
    assert.equal(template.revision, 1)
    assert.equal((other.api.listTeamTemplates().data as { templates: unknown[] }).templates.length, 0)
    assert.deepEqual(f.store.load().agents, beforeAgents)
    assert.equal(f.sends(), 0)
    const edited = await f.api.saveTeamTemplate({
      ...body,
      id: template.id,
      expected_revision: 1,
      name: "Revised team",
    })
    assert.ok(edited.ok, edited.message)
    assert.equal((await f.api.saveTeamTemplate({ ...body, id: template.id, expected_revision: 1 })).ok, false)
    assert.equal((await f.api.deleteTeamTemplate(template.id, { expected_revision: 1 })).ok, false)
    assert.ok((await f.api.deleteTeamTemplate(template.id, { expected_revision: 2 })).ok)
    assert.deepEqual(f.store.load().agents, beforeAgents)
    assert.equal((f.api.listTeamTemplates().data as { templates: unknown[] }).templates.length, 0)
    assert.equal(f.sends(), 0)
  } finally {
    f.cleanup()
    other.cleanup()
  }
})

test("team template validation bounds prompts/teams/budgets and rejects unavailable capability names or secret values", async () => {
  const f = fixture()
  try {
    const entry = {
      entry_id: "builder",
      role: "Builder",
      role_prompt: "Implement",
      host: "opencode",
      runtime: "opencode",
      model: null,
      required_capabilities: ["push"],
    }
    const body = {
      name: "Bounded team",
      entries: [entry],
      budgets: { max_runtime_ms: null, max_delivered_messages: null, max_review_rounds: 3 },
    }
    for (const invalid of [
      { ...body, entries: [entry, entry] },
      { ...body, entries: [{ ...entry, required_capabilities: ["invented-feature"] }] },
      { ...body, entries: [{ ...entry, host: "opencode", runtime: "acp" }] },
      { ...body, budgets: { ...body.budgets, max_review_rounds: 0 } },
      {
        ...body,
        entries: Array.from({ length: 9 }, (_, i) => ({ ...entry, entry_id: `worker-${i}`, role: `Worker ${i}` })),
      },
    ])
      assert.equal((await f.api.saveTeamTemplate(invalid)).ok, false)
    const secretApi = new OrchestratorApi({ ...f.deps, servePassword: () => "known-secret" })
    assert.equal((await secretApi.saveTeamTemplate({ ...body, name: "known-secret" })).ok, false)
    assert.equal((f.api.listTeamTemplates().data as { templates: unknown[] }).templates.length, 0)
  } finally {
    f.cleanup()
  }
})

test("template and emergency fields backfill old orchestration stores without altering existing agent/task rows", () => {
  const f = fixture()
  try {
    const original = f.store.load()
    const legacy = { ...original } as Record<string, unknown>
    delete legacy["team_templates"]
    delete legacy["team_template_schema_version"]
    delete legacy["coordination"]
    writeFileSync(f.store.file, JSON.stringify(legacy))
    const loaded = f.store.load()
    assert.deepEqual(loaded.agents, original.agents)
    assert.deepEqual(loaded.tasks, original.tasks)
    assert.deepEqual(loaded.team_templates, [])
    assert.equal(loaded.team_template_schema_version, 1)
    loaded.coordination = { stopped: true, emergency_paused_channels: ["team"] }
    assert.equal(validateOrchestratorState(loaded).ok, true)
    assert.equal(
      validateOrchestratorState({
        ...loaded,
        coordination: { stopped: true, emergency_paused_channels: ["__proto__"] },
      }).ok,
      false,
    )
  } finally {
    f.cleanup()
  }
})

test("acknowledgement is delivery evidence only; completion requires matching behavior evidence and accepted independent review", async () => {
  const f = fixture()
  try {
    const assigned = await f.api.assignTask(f.assignment())
    assert.ok(assigned.ok, assigned.message)
    const id = (assigned.data as { task_id: string }).task_id
    const engine = f.channelStore.load()
    const initial = Object.values(engine.messages)[0]!
    const reply = sendMessage(
      engine,
      {
        channel: "team",
        content: "done",
        type: "review_response",
        to: initial.sender_session_id,
        reply_to: initial.message_id,
      },
      "worker-session",
    )
    assert.ok(reply.ok, reply.message)
    f.channelStore.save(engine)
    assert.equal(view(f.api, id).delivery_state, "acknowledged")
    assert.equal(view(f.api, id).execution_state, "assigned")
    assert.equal((await change(f.api, id, "verified_complete")).ok, false)
    assert.ok((await change(f.api, id, "running", { actor_id: f.agentId })).ok)
    assert.equal((await change(f.api, id, "blocked")).ok, false)
    assert.ok(
      (await change(f.api, id, "blocked", { blocker: "Host is waiting for permission to execute the scenario." })).ok,
    )
    assert.ok((await change(f.api, id, "running")).ok)
    assert.ok((await change(f.api, id, "review")).ok)
    const accepted = {
      outcome: "accepted",
      reviewer: "operator",
      summary: "Observed nearest-hostile targeting in the scenario.",
    }
    assert.equal(
      (
        await change(f.api, id, "verified_complete", {
          review: accepted,
          evidence: [
            {
              criterion: "Project compiles",
              kind: "check",
              reference: "checks/build.log",
              summary: "Build succeeds",
              passed: true,
            },
          ],
        })
      ).ok,
      false,
    )
    assert.equal(
      (
        await change(f.api, id, "verified_complete", {
          review: accepted,
          evidence: [
            {
              criterion: "Attack targets the nearest hostile entity",
              kind: "artifact",
              reference: "combat.patch",
              summary: "Patch exists",
              passed: true,
            },
          ],
        })
      ).ok,
      false,
    )
    assert.equal((await change(f.api, id, "verified_complete", { actor_id: f.agentId, review: accepted })).ok, false)
    const complete = await change(f.api, id, "verified_complete", {
      review: accepted,
      artifacts: ["combat.patch"],
      evidence: [
        {
          criterion: "Attack targets the nearest hostile entity",
          kind: "behavior",
          reference: "checks/nearest-hostile-scenario.log",
          summary: "Scenario records the attack target switching to the nearest hostile entity.",
          passed: true,
        },
      ],
    })
    assert.ok(complete.ok, complete.message)
    assert.equal(new OrchestratorApi(f.deps).getTask(id).ok, true)
    assert.equal(f.store.load().tasks[0]?.execution_state, "verified_complete")
    assert.equal((await change(f.api, id, "running")).ok, false)
  } finally {
    f.cleanup()
  }
})

test("task revisions, dependency admission, advisory ownership conflicts and bounded review cycles are enforced", async () => {
  const f = fixture()
  try {
    const assigned = await f.api.assignTask(f.assignment({ max_review_rounds: 1 }))
    const id = (assigned.data as { task_id: string }).task_id
    assert.ok((await change(f.api, id, "running")).ok)
    const stale = await f.api.transitionTask(id, {
      state: "blocked",
      actor_id: "operator",
      expected_revision: 1,
      blocker: "Wait",
    })
    assert.equal(stale.ok, false)
    assert.match(stale.message, /reload revision/)
    assert.equal((await change(f.api, id, "blocked", { actor_id: "another-agent", blocker: "Wait" })).ok, false)
    const overlap = await f.api.assignTask({
      ...f.assignment({ ownership: ["src/combat/attack.ts"] }),
      request_id: "assignment-2",
    })
    assert.equal(overlap.ok, false)
    assert.match(overlap.message, /ownership overlaps/)
    const blocked = await f.api.assignTask({
      ...f.assignment({ dependencies: [id], ownership: [] }),
      request_id: "assignment-3",
    })
    assert.equal(blocked.ok, false)
    assert.match(blocked.message, /Dependencies must be verified complete/)
    assert.ok((await change(f.api, id, "review")).ok)
    assert.equal((await change(f.api, id, "running")).ok, false)
    assert.ok(
      (
        await change(f.api, id, "running", {
          review: { outcome: "changes_requested", reviewer: "operator", summary: "Include occluded-target behavior." },
        })
      ).ok,
    )
    assert.equal((await change(f.api, id, "review")).ok, false)
    assert.ok(
      (await change(f.api, id, "failed", { blocker: "Review budget exhausted; scope an explicit follow-up task." })).ok,
    )
  } finally {
    f.cleanup()
  }
})

test("uncertain dispatch is durable and is never blindly repeated after a restart", async () => {
  const f = fixture()
  try {
    const api = new OrchestratorApi({
      ...f.deps,
      saveChannelEngineState() {
        throw new Error("simulated write failure")
      },
    })
    const result = await api.assignTask(f.assignment())
    assert.equal(result.ok, false)
    assert.match(result.message, /uncertain/)
    assert.equal(f.store.load().tasks[0]?.dispatch_state, "dispatching")
    const retried = await new OrchestratorApi(f.deps).assignTask(f.assignment())
    assert.equal(retried.ok, false)
    assert.match(retried.message, /uncertain dispatch/)
    assert.equal(f.sends(), 1)
    assert.equal(Object.keys(f.channelStore.load().messages).length, 0)
  } finally {
    f.cleanup()
  }
})

test("an interrupted save after queued delivery reconciles the journal and does not dispatch twice", async () => {
  const f = fixture()
  try {
    const api = new OrchestratorApi({
      ...f.deps,
      saveChannelEngineState(state) {
        f.channelStore.save(state as State)
        throw new Error("simulated crash after queue save")
      },
    })
    assert.equal((await api.assignTask(f.assignment())).ok, false)
    const replayed = await new OrchestratorApi(f.deps).assignTask(f.assignment())
    assert.ok(replayed.ok, replayed.message)
    const task = view(f.api, (replayed.data as { task_id: string }).task_id)
    assert.equal(task.execution_state, "assigned")
    assert.equal(task.delivery_state, "queued")
    assert.equal(f.sends(), 1)
  } finally {
    f.cleanup()
  }
})

test("legacy task migration preserves original data and never turns old replies into completed work", async () => {
  const f = fixture()
  try {
    const assigned = await f.api.assignTask(f.assignment())
    const id = (assigned.data as { task_id: string }).task_id
    const raw = JSON.parse(readFileSync(f.store.file, "utf8")) as Record<string, unknown>
    delete raw["task_schema_version"]
    delete raw["tasks"]
    delete raw["project_context"]
    const legacy = JSON.stringify(raw)
    writeFileSync(f.store.file, legacy)
    const before = view(f.api, id)
    assert.equal(before.legacy, true)
    assert.equal(before.execution_state, "assigned")
    assert.deepEqual(before.evidence, [])
    assert.ok(
      (await change(f.api, id, "running", { acceptance_criteria: ["Attack targets the nearest hostile entity"] })).ok,
    )
    assert.equal(readFileSync(join(f.dir, ".opencomms", "orchestrator.pre-tasks-v1.json"), "utf8"), legacy)
    assert.equal(f.store.load().tasks[0]?.legacy, true)
    const forged = structuredClone(f.store.load())
    forged.tasks[0]!.execution_state = "delivered" as never
    assert.equal(validateOrchestratorState(forged).ok, false)
    forged.tasks[0]!.execution_state = "verified_complete"
    assert.equal(validateOrchestratorState(forged).ok, false)
  } finally {
    f.cleanup()
  }
})

test("project context separates proposals, decisions and verified findings and remains project-local", async () => {
  const f = fixture()
  const other = fixture()
  try {
    assert.equal(
      (await f.api.addContext({ kind: "finding", status: "verified", title: "Attack fix", body: "Works" })).ok,
      false,
    )
    assert.equal(
      (await f.api.addContext({ kind: "proposal", status: "accepted", title: "Scope", body: "Proposal" })).ok,
      false,
    )
    const accepted = await f.api.addContext({
      kind: "decision",
      status: "accepted",
      title: "Targeting interface",
      body: "Select the nearest hostile entity.",
      references: ["src/combat/target.ts"],
    })
    assert.ok(accepted.ok, accepted.message)
    assert.ok(
      (
        await f.api.addContext({
          kind: "finding",
          status: "verified",
          title: "Attack targeting verified",
          body: "The scenario matched the acceptance criteria.",
          references: ["checks/scenario.log"],
        })
      ).ok,
    )
    assert.equal((f.api.listContext("targeting").data as { records: unknown[] }).records.length, 2)
    assert.equal((other.api.listContext().data as { records: unknown[] }).records.length, 0)
    const handoff = f.api.contextHandoff().data as { context: unknown[]; project: string }
    assert.equal(handoff.context.length, 2)
    assert.equal(handoff.project, f.dir)
  } finally {
    f.cleanup()
    other.cleanup()
  }
})

test("unreadable orchestration files are preserved during recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocm-task-corrupt-"))
  try {
    mkdirSync(join(dir, ".opencomms"), { recursive: true })
    writeFileSync(join(dir, ".opencomms", "orchestrator.json"), "{broken")
    const store = new OrchestratorStore(dir)
    assert.equal(store.load().events[0]?.type, "state_unreadable")
    const backup = readdirSync(store.dir).find((name) => name.startsWith("orchestrator.unreadable."))
    assert.ok(backup)
    assert.equal(readFileSync(join(store.dir, backup), "utf8"), "{broken")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("later malformed orchestration recovery preserves exact bytes even after the legacy migration backup exists", () => {
  const f = fixture()
  try {
    const migrationBackup = join(f.store.dir, "orchestrator.pre-tasks-v1.json")
    writeFileSync(migrationBackup, "prior migration bytes")
    const malformed = '{"tasks":[{"evidence":"preserve this incomplete write"}'
    writeFileSync(f.store.file, malformed)
    assert.equal(f.store.load().events[0]?.type, "state_unreadable")
    const backups = readdirSync(f.store.dir).filter((name) => name.startsWith("orchestrator.unreadable."))
    assert.equal(backups.length, 1)
    assert.equal(readFileSync(join(f.store.dir, backups[0]!), "utf8"), malformed)
    assert.equal(readFileSync(migrationBackup, "utf8"), "prior migration bytes")
    assert.equal(validateOrchestratorState(JSON.parse(readFileSync(f.store.file, "utf8"))).ok, true)
  } finally {
    f.cleanup()
  }
})

test("remote or inactive permission records never access the local runtime even when host session ids collide", async () => {
  const f = fixture()
  try {
    const remoteId = "node_remote_permissions",
      remoteAgentId = newAgentId()
    await f.store.update((state) => {
      state.nodes.push({
        ...state.nodes[0]!,
        id: remoteId,
        kind: "remote",
        status: "offline",
        approved_at: null,
        approved_by: null,
        grants: [],
      })
      state.agents.push({
        ...state.agents[0]!,
        id: remoteAgentId,
        name: "Remote worker",
        node_id: remoteId,
        status: "failed",
      })
    })
    let factories = 0,
      resumes = 0,
      answers = 0
    const api = new OrchestratorApi({
      ...f.deps,
      createRuntime: () => {
        factories++
        return {
          runtime: "opencode",
          host: "opencode",
          detect: () => ({ available: true }),
          create: async () => ({ ok: false as const, message: "Not used" }),
          shutdownNode: async () => {},
          resume: async () => {
            resumes++
            return {
              ok: true as const,
              handle: {
                status: async () => ({ status: "idle" as const }),
                deliver: async () => "delivered" as const,
                abort: async () => {},
                stop: async () => {},
                permissionsDrain: async () => [
                  { permission_id: "local-permission", request: { host_session_id: "worker-session" } },
                ],
                permissionsRespond: async () => {
                  answers++
                  return { ok: true, message: "Local permission answered" }
                },
              },
            }
          },
        }
      },
    })
    const remote = await api.listPermissions(remoteAgentId)
    assert.ok(remote.ok)
    assert.equal((remote.data as { supported: boolean }).supported, false)
    assert.match((remote.data as { detail: string }).detail, /Remote.*unsupported/)
    const answeredRemote = await api.respondPermission(remoteAgentId, "local-permission", { response: "allow" })
    assert.equal(answeredRemote.ok, false)
    assert.equal(answeredRemote.code, "unsupported")
    const remoteView = (
      api.listAgents().data as { agents: Array<{ id: string; permission_capability: { state: string } }> }
    ).agents.find((a) => a.id === remoteAgentId)!
    assert.equal(remoteView.permission_capability.state, "unsupported")
    for (const status of ["starting", "stale", "stopped", "failed"] as const) {
      await f.store.update((state) => {
        state.agents.find((a) => a.id === f.agentId)!.status = status
      })
      assert.equal((await api.listPermissions(f.agentId)).ok, false)
      assert.equal((await api.respondPermission(f.agentId, "local-permission", { response: "deny" })).ok, false)
    }
    assert.deepEqual({ factories, resumes, answers }, { factories: 0, resumes: 0, answers: 0 })
    assert.ok(
      (
        await api.approveOrRevoke(
          { node_id: remoteId, confirm_token: f.store.load().trust.owner_confirm_token },
          "revoke",
        )
      ).ok,
    )
    const revoked = f.store.load().events.find((event) => event.type === "revoke_agents_marked")!
    assert.match(revoked.message, /certificate revoked.*record\(s\) marked failed; no remote host interruption/)
    assert.doesNotMatch(revoked.message, /graceful stop requested/)
    assert.deepEqual({ factories, resumes, answers }, { factories: 0, resumes: 0, answers: 0 })
    await f.store.update((state) => {
      state.agents.find((a) => a.id === f.agentId)!.status = "idle"
    })
    assert.ok((await api.listPermissions(f.agentId)).ok)
    assert.ok((await api.respondPermission(f.agentId, "local-permission", { response: "allow" })).ok)
    assert.deepEqual({ factories, resumes, answers }, { factories: 2, resumes: 2, answers: 1 })
  } finally {
    f.cleanup()
  }
})

test("orchestration mutations delegate to the existing channel lock with the correct receiver", async () => {
  const f = fixture()
  try {
    const updated = await f.store.update((state) => {
      state.events_cursor = 17
    })
    assert.equal(updated.events_cursor, 17)
    assert.equal(f.store.load().events_cursor, 17)
  } finally {
    f.cleanup()
  }
})

test("production MCP task assignment persists its queue instead of reporting a fabricated send", async () => {
  const f = fixture()
  try {
    const api = buildOrchestratorApi(f.dir, f.channelStore)
    const tool = orchestratorTools(api, true).find((t) => t.name === "opencomms_task_assign")!
    const result = await tool.execute(f.assignment())
    assert.equal(result.isError, false, result.text)
    const messages = Object.values(new StateStore(f.dir).load().messages)
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.recipient_session_id, "worker-session")
    assert.equal(messages[0]?.sender_role, "Operator")
    assert.equal(f.store.load().tasks[0]?.execution_state, "assigned")
  } finally {
    f.cleanup()
  }
})

test("MCP task reports bind the live endpoint and cannot impersonate an operator or verify completion", async () => {
  const f = fixture()
  try {
    const result = await f.api.assignTask(f.assignment())
    const id = (result.data as { task_id: string }).task_id
    const tools = orchestratorTools(f.api, true, () => ({ session_id: "worker-session", host_session_id: null }))
    const report = tools.find((t) => t.name === "opencomms_task_report")!
    const reported = await report.execute({ task_id: id, state: "running", expected_revision: 1, actor_id: "operator" })
    assert.equal(reported.isError, false, reported.text)
    assert.equal(view(f.api, id).execution_state, "running")
    assert.equal(view(f.api, id).delivery_state, "acknowledged")
    const verified = await report.execute({
      task_id: id,
      state: "verified_complete",
      expected_revision: 2,
      actor_id: "operator",
    })
    assert.equal(verified.isError, true)
    assert.equal(view(f.api, id).execution_state, "running")
    const other = orchestratorTools(f.api, false, () => ({ session_id: "other-session", host_session_id: null }))
    assert.equal(
      (
        await other
          .find((t) => t.name === "opencomms_task_report")!
          .execute({ task_id: id, state: "review", expected_revision: 2 })
      ).isError,
      true,
    )
    assert.equal((await other.find((t) => t.name === "opencomms_task_get")!.execute({ task_id: id })).isError, true)
    const absent = orchestratorTools(f.api, true).find((t) => t.name === "opencomms_task_report")!
    assert.equal((await absent.execute({ task_id: id, state: "review", expected_revision: 2 })).isError, true)
  } finally {
    f.cleanup()
  }
})

test("known coordinator credentials cannot enter task records, evidence or shared context", async () => {
  const f = fixture()
  try {
    const api = new OrchestratorApi({ ...f.deps, servePassword: () => "secret-value-42" })
    const assignment = await api.assignTask(f.assignment({ body: "Echo secret-value-42" }))
    assert.equal(assignment.ok, false)
    assert.equal(f.sends(), 0)
    assert.equal(f.store.load().tasks.length, 0)
    assert.equal(
      (await api.addContext({ kind: "decision", status: "accepted", title: "Credential", body: "secret-value-42" })).ok,
      false,
    )
    assert.equal(JSON.stringify(f.store.load()).includes("secret-value-42"), false)
  } finally {
    f.cleanup()
  }
})

test("task CLI reports execution separately and sends revisioned evidence through the shared routes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocm-task-cli-"))
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = []
  const id = `tsk_${"a".repeat(24)}`
  try {
    writeFileSync(
      join(dir, "evidence.json"),
      JSON.stringify([
        { criterion: "Behavior", kind: "behavior", reference: "check.log", summary: "Passed", passed: true },
      ]),
    )
    writeFileSync(
      join(dir, "review.json"),
      JSON.stringify({ outcome: "accepted", reviewer: "operator", summary: "Observed" }),
    )
    setTaskDeps({
      base: "http://127.0.0.1:1",
      fetch: (async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
        return new Response(
          JSON.stringify({
            ok: true,
            message: "Recorded",
            data: {
              tasks: [
                {
                  task_id: id,
                  title: "Behavior",
                  owner: "worker",
                  execution_state: "review",
                  delivery_state: "acknowledged",
                },
              ],
            },
          }),
          { status: 200 },
        )
      }) as typeof fetch,
    })
    const list = await taskList([])
    assert.equal(list.code, 0)
    assert.match(list.output, new RegExp(id))
    assert.match(list.output, /execution=review \| delivery=acknowledged/)
    assert.equal(
      (
        await taskAssign([
          "--agent",
          "worker",
          "--title",
          "Behavior",
          "--body",
          "Fix",
          "--channel",
          "team",
          "--criterion",
          "Behavior",
          "--owns",
          "src/behavior",
          "--request-id",
          "same-op",
        ])
      ).code,
      0,
    )
    assert.equal(calls.at(-1)?.body?.["request_id"], "same-op")
    assert.equal(
      (
        await taskTransition([
          id,
          "--state",
          "verified_complete",
          "--revision",
          "3",
          "--evidence-file",
          join(dir, "evidence.json"),
          "--review-file",
          join(dir, "review.json"),
        ])
      ).code,
      0,
    )
    assert.equal(calls.at(-1)?.body?.["actor_id"], "operator")
    assert.equal(calls.at(-1)?.body?.["expected_revision"], 3)
    assert.ok(Array.isArray(calls.at(-1)?.body?.["evidence"]))
    assert.equal((await taskShow([id])).code, 0)
    assert.match(calls.at(-1)?.url ?? "", new RegExp(`/tasks/${id}$`))
    assert.equal((await taskContext(["handoff"])).code, 0)
    assert.match(calls.at(-1)?.url ?? "", /context\/handoff$/)
    assert.equal(
      (
        await taskReassign([
          id,
          "--agent",
          "replacement",
          "--reason",
          "Transfer work",
          "--revision",
          "4",
          "--request-id",
          "handoff-cli",
          "--handoff-confirmed",
        ])
      ).code,
      0,
    )
    assert.match(calls.at(-1)?.url ?? "", /\/reassign$/)
    assert.equal(calls.at(-1)?.body?.["handoff_confirmed"], true)
    assert.equal(calls.at(-1)?.body?.["request_id"], "handoff-cli")
  } finally {
    setTaskDeps(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("real HTTP and native backend execute assignment through evidence review with intact persisted state", async () => {
  const f = fixture()
  const target = await destination(f)
  const previous = process.env["OPENCOMMS_CONFIG_DIR"]
  process.env["OPENCOMMS_CONFIG_DIR"] = join(f.dir, "test-app-config")
  const handle = await startGuiServer({ projectDir: f.dir, port: 0, hostname: "127.0.0.1" })
  try {
    const http = async (path: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return (await response.json()) as {
        ok: boolean
        message: string
        data: { task_id?: string; task?: TaskRecord; records?: unknown[]; template?: { id: string; revision: number } }
      }
    }
    const assignment = await http("/api/orchestrator/tasks/assign", f.assignment())
    assert.ok(assignment.ok, assignment.message)
    const id = assignment.data.task_id!
    const core = handle.bridgeDeps()!
    const native: BridgeDeps = { ...core, getCoreDeps: handle.bridgeDeps, write() {}, error() {} }
    const nativeRunning = await dispatchBridgeCommand(native, {
      id: "native-running",
      cmd: "task_transition",
      args: {
        task_id: id,
        state: "running",
        actor_id: "operator",
        expected_revision: 1,
      },
    })
    assert.ok(nativeRunning.ok, nativeRunning.message)
    const reviewed = await http(`/api/orchestrator/tasks/${id}/transition`, {
      state: "review",
      actor_id: "operator",
      expected_revision: 2,
    })
    assert.ok(reviewed.ok, reviewed.message)
    const complete = await dispatchBridgeCommand(native, {
      id: "native-complete",
      cmd: "task_transition",
      args: {
        task_id: id,
        state: "verified_complete",
        actor_id: "operator",
        expected_revision: 3,
        evidence: [
          {
            criterion: "Attack targets the nearest hostile entity",
            kind: "behavior",
            reference: "checks/scenario.log",
            summary: "Recorded scenario demonstrates the requested attack target.",
            passed: true,
          },
        ],
        review: { outcome: "accepted", reviewer: "operator", summary: "Reviewed scenario evidence" },
      },
    })
    assert.ok(complete.ok, complete.message)
    const detail = await http(`/api/orchestrator/tasks/${id}`)
    assert.equal(detail.data.task?.execution_state, "verified_complete")
    assert.equal(detail.data.task?.delivery_state, "queued", "Operator acceptance never fabricates a host handover")
    assert.equal(f.store.load().tasks[0]?.evidence[0]?.reference, "checks/scenario.log")
    assert.equal(Object.values(f.channelStore.load().messages).length, 1)
    assert.ok(
      (
        await http("/api/orchestrator/context", {
          kind: "decision",
          status: "accepted",
          title: "Target selection",
          body: "Nearest hostile first",
        })
      ).ok,
    )
    assert.ok(
      (
        await http("/api/orchestrator/context", {
          kind: "decision",
          status: "accepted",
          title: "Unrelated",
          body: "Other decision",
        })
      ).ok,
    )
    assert.equal((await http("/api/orchestrator/context?query=Target")).data.records?.length, 1)
    const followUp = await http("/api/orchestrator/tasks/assign", {
      ...f.assignment(),
      request_id: "backend-handoff-assignment",
      task: { ...f.assignment().task, title: "Follow-up behavior" },
    })
    assert.ok(followUp.ok, followUp.message)
    const handed = await dispatchBridgeCommand(native, {
      id: "backend-native-handoff",
      cmd: "task_reassign",
      args: {
        task_id: followUp.data.task_id,
        agent_id: target,
        expected_revision: 1,
        request_id: "backend-handoff",
        reason: "Transfer remaining bounded behavior",
        actor_id: f.agentId,
      },
    })
    assert.ok(handed.ok, handed.message)
    assert.equal((await http(`/api/orchestrator/tasks/${followUp.data.task_id}`)).data.task?.owner, target)
    const template = await http("/api/orchestrator/team-templates", {
      name: "Backend team",
      entries: [
        {
          entry_id: "worker",
          role: "Worker",
          role_prompt: "Verify behavior",
          host: "opencode",
          runtime: "opencode",
          model: null,
          required_capabilities: ["push"],
        },
      ],
      budgets: { max_runtime_ms: null, max_delivered_messages: 20, max_review_rounds: 3 },
    })
    assert.ok(template.ok, template.message)
    const templateList = await dispatchBridgeCommand(native, {
      id: "backend-template-list",
      cmd: "team_template_list",
      args: {},
    })
    assert.equal((templateList.data as { templates: unknown[] }).templates.length, 1)
    const removed = await dispatchBridgeCommand(native, {
      id: "backend-template-delete",
      cmd: "team_template_delete",
      args: {
        template_id: template.data.template!.id,
        expected_revision: template.data.template!.revision,
      },
    })
    assert.ok(removed.ok, removed.message)
    assert.equal(f.store.load().team_templates.length, 0)
  } finally {
    await handle.close()
    if (previous === undefined) delete process.env["OPENCOMMS_CONFIG_DIR"]
    else process.env["OPENCOMMS_CONFIG_DIR"] = previous
    f.cleanup()
  }
})
