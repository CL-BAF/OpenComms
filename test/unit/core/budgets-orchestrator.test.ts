/**
 * M5 (2): budgets verification against the ORCHESTRATOR surfaces.
 *
 * The conversation budgets (max_runtime_ms + max_delivered_messages) are
 * CHANNEL-level guards enforced by the engine's budgetRefusal() on every
 * send (src/core/engine.ts:947) â€” the orchestrator's task-assignment path
 * routes through engineSend, so the SAME guard applies to remote tasks.
 * These tests prove the composition: an orchestrator task assignment
 * against a budget-exhausted channel is REFUSED by the engine guard, and
 * the refusal surfaces to the API caller verbatim (no silent bypass).
 *
 * Runtime budget (max_runtime_ms): verified in multi-provider.test.ts
 * ("stops a conversation past its runtime cap"); delivered-message budget
 * (max_delivered_messages): verified ("caps lifetime handovers"). This
 * file adds the ORCHESTRATOR-side composition proof.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OrchestratorStore, emptyOrchestratorState, newAgentId } from "../../../src/orchestrator/state.js"
import { OrchestratorApi } from "../../../src/orchestrator/api.js"
import { createOrchestratorFeed } from "../../../src/orchestrator/events.js"
import { emptyState } from "../../../src/core/store.js"
import { createChannel, sendMessage, drainForDelivery } from "../../../src/core/engine.js"
import type { State } from "../../../src/core/types.js"

const PROJECT = "proj_budget"
const WORKTREE = "C:\\repo-budget"

test("M5 budgets: orchestrator task assignment respects the channel message budget (no bypass)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocm-budget-"))
  try {
    const orchStore = new OrchestratorStore(dir)
    const budgetAgentId = newAgentId()
    const runtimeAgentId = newAgentId()
    const engineState = emptyState()
    // Operator creates a channel with a delivered-message budget of 1.
    createChannel(engineState, {
      channel: "budgeted",
      role: "Coordinator",
      role_prompt: "coord",
      session_id: "op0",
      project_id: PROJECT,
      worktree: WORKTREE,
      budgets: { max_delivered_messages: 1 },
    })
    engineState.channels["budgeted"]!.members.push({
      session_id: "ses_worker",
      role: "Worker",
      role_prompt: "w",
      joined_at: Date.now(),
      stale: false,
      stale_at: null,
      host: "opencode",
      surface: "cli",
      delivery_mode: "push",
      host_session_id: "ses_worker",
      stale_policy: { mode: "window", window_ms: 300_000 },
    } as never)
    // One message queued + DRAINED: budget consumed at handover
    // (delivered_total increments on drainForDelivery).
    sendMessage(engineState, { channel: "budgeted", content: "consume budget" }, "op0")
    drainForDelivery(engineState, "ses_worker")

    const orchStore2 = orchStore
    const api = new OrchestratorApi({
      projectDir: dir,
      servePassword: () => "x",
      serveModel: () => "opencode/big-pickle",
      servePort: () => 0,
      withLock: (fn) => orchStore2.withLock(fn),
      loadOrchestrator: () => orchStore2.load(),
      saveOrchestrator: (s) => orchStore2.save(s),
      loadChannelEngineState: () => engineState,
      // The operator session (op0) IS the budgeted channel's coordinator
      // member — the sender id must be a MEMBER for budgetRefusal to fire.
      engineSend: (state, input, sender) =>
        sendMessage(
          state as unknown as State,
          { channel: input.channel, content: input.content, type: input.message_type },
          "op0",
        ),
      saveChannelEngineState: () => {},
      feed: createOrchestratorFeed(async (fn) => {
        const s = orchStore2.load()
        const seq = fn(s)
        orchStore2.save(s)
        return seq
      }),
      projectId: () => PROJECT,
    })
    // Seed a running agent on the budgeted channel.
    await orchStore2.withLock(() => {
      const s = orchStore2.load()
      s.agents.push({
        id: budgetAgentId,
        name: "worker",
        host: "opencode",
        role: "Worker",
        role_prompt: "w",
        runtime: "opencode",
        node_id: s.local_node_id,
        worktree: join(dir, "wt"),
        status: "running",
        host_session_id: "ses_worker",
        spawn_cmd_redacted: "cmd",
        designated: null,
        channel_ids: ["budgeted"],
        last_heartbeat: null,
        created_at: Date.now(),
        restart_count: 0,
        model: "opencode/big-pickle",
      })
      orchStore2.save(s)
      return 0
    })
    void orchStore
    void emptyOrchestratorState
    // The assignment rides engineSend -> budgetRefusal refuses (budget exhausted).
    const assigned = await api.assignTask({
      agent_id: budgetAgentId,
      task: { title: "Work", body: "Do the thing", channel: "budgeted" },
    })
    assert.equal(assigned.ok, false)
    assert.match(assigned.message, /message budget/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M5 budgets: orchestrator task assignment respects the runtime budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocm-runtime-"))
  try {
    const orchStore = new OrchestratorStore(dir)
    const budgetAgentId = newAgentId()
    const runtimeAgentId = newAgentId()
    const engineState = emptyState()
    createChannel(engineState, {
      channel: "runtime",
      role: "Coordinator",
      role_prompt: "coord",
      session_id: "op0",
      project_id: PROJECT,
      worktree: WORKTREE,
      budgets: { max_runtime_ms: 60_000 },
    })
    engineState.channels["runtime"]!.members.push({
      session_id: "ses_worker",
      role: "Worker",
      role_prompt: "w",
      joined_at: Date.now(),
      stale: false,
      stale_at: null,
      host: "opencode",
      surface: "cli",
      delivery_mode: "push",
      host_session_id: "ses_worker",
      stale_policy: { mode: "window", window_ms: 300_000 },
    } as never)
    // Age the conversation past the runtime cap.
    engineState.channels["runtime"]!.created_at = Date.now() - 120_000

    const api = new OrchestratorApi({
      projectDir: dir,
      servePassword: () => "x",
      serveModel: () => "opencode/big-pickle",
      servePort: () => 0,
      withLock: (fn) => orchStore.withLock(fn),
      loadOrchestrator: () => orchStore.load(),
      saveOrchestrator: (s) => orchStore.save(s),
      loadChannelEngineState: () => engineState,
      engineSend: (state, input, sender) =>
        sendMessage(
          state as unknown as State,
          { channel: input.channel, content: input.content, type: input.message_type },
          "op0",
        ),
      saveChannelEngineState: () => {},
      feed: createOrchestratorFeed(async (fn) => {
        const s = orchStore.load()
        const seq = fn(s)
        orchStore.save(s)
        return seq
      }),
      projectId: () => PROJECT,
    })
    await orchStore.withLock(() => {
      const s = orchStore.load()
      s.agents.push({
        id: runtimeAgentId,
        name: "worker",
        host: "opencode",
        role: "Worker",
        role_prompt: "w",
        runtime: "opencode",
        node_id: s.local_node_id,
        worktree: join(dir, "wt"),
        status: "running",
        host_session_id: "ses_worker",
        spawn_cmd_redacted: "cmd",
        designated: null,
        channel_ids: ["runtime"],
        last_heartbeat: null,
        created_at: Date.now(),
        restart_count: 0,
        model: "opencode/big-pickle",
      })
      orchStore.save(s)
      return 0
    })
    const assigned = await api.assignTask({
      agent_id: runtimeAgentId,
      task: { title: "Work", body: "Do the thing", channel: "runtime" },
    })
    assert.equal(assigned.ok, false)
    assert.match(assigned.message, /runtime budget/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
