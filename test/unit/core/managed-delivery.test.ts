/** Managed delivery with real persistence and injected host outcomes.
 * This verifies queue/recovery semantics, not vendor interoperability.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../../src/core/store.js"
import {
  createSessionAsOperator,
  joinChannel,
  sendMessageAsOperator,
  setSessionPausedAsOperator,
} from "../../../src/core/engine.js"
import {
  OrchestratorStore,
  newAgentId,
  type AgentRecord,
  type AgentRuntimeStatus,
} from "../../../src/orchestrator/state.js"
import { createManagedDelivery } from "../../../src/orchestrator/managed-delivery.js"
import type { AgentRuntime } from "../../../src/orchestrator/runtime.js"

async function withManaged(fn: (fixture: ManagedFixture) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oc-managed-delivery-"))
  const store = new StateStore(dir)
  const state = store.load()
  assert.equal(
    createSessionAsOperator(state, { channel: "work", project_id: "gui-local-project", worktree: dir }).ok,
    true,
  )
  assert.equal(
    joinChannel(state, {
      channel: "work",
      session_id: "managed-endpoint",
      project_id: "gui-local-project",
      worktree: dir,
      role: "Worker",
      role_prompt: "Verify requested behavior.",
      host: "opencode",
      surface: "api",
      delivery_mode: "pull",
      stale_policy: { mode: "none", window_ms: null },
    }).ok,
    true,
  )
  assert.equal(
    sendMessageAsOperator(state, {
      channel: "work",
      to: "managed-endpoint",
      content: "Perform the bounded task.",
      type: "review_request",
    }).ok,
    true,
  )
  store.save(state)
  const orchestrator = new OrchestratorStore(dir, store)
  const managed = orchestrator.load()
  const agent: AgentRecord = {
    id: newAgentId(),
    name: "worker",
    host: "opencode",
    role: "Worker",
    role_prompt: "Verify requested behavior.",
    runtime: "opencode",
    node_id: managed.local_node_id,
    worktree: dir,
    status: "idle",
    host_session_id: "managed-endpoint",
    spawn_cmd_redacted: "opencode serve",
    designated: null,
    channel_ids: ["work"],
    last_heartbeat: null,
    created_at: Date.now(),
    restart_count: 0,
    model: null,
  }
  managed.agents.push(agent)
  orchestrator.save(managed)
  try {
    await fn({ dir, store, orchestrator, agent, messageId: Object.keys(state.messages)[0]! })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface ManagedFixture {
  dir: string
  store: StateStore
  orchestrator: OrchestratorStore
  agent: AgentRecord
  messageId: string
}

function runtimeWith(
  status: () => Promise<AgentRuntimeStatus>,
  deliver: (framed: string) => Promise<"delivered" | "failed" | "uncertain">,
): AgentRuntime {
  return {
    runtime: "opencode",
    host: "opencode",
    detect: () => ({ available: true }),
    create: async () => {
      throw new Error("Existing endpoint delivery must not create a replacement.")
    },
    resume: async () => ({
      ok: true,
      handle: {
        status: async () => ({ status: await status() }),
        deliver,
        abort: async () => {},
        stop: async () => {},
      },
    }),
    shutdownNode: async () => {},
  }
}

test("managed delivery: busy endpoint stays queued; idle accepts persisted in-flight batch and commits delivery", async () => {
  await withManaged(async ({ store, orchestrator, messageId, agent }) => {
    let observed: AgentRuntimeStatus = "running",
      deliveries = 0,
      changed = 0
    const runtime = runtimeWith(
      async () => observed,
      async (framed) => {
        deliveries++
        assert.equal(
          store.load().messages[messageId]!.delivery_status,
          "in_flight",
          "write-ahead delivery state must precede host side effect",
        )
        assert.match(framed, /<<<UNTRUSTED_PEER_MESSAGE>>>/)
        assert.match(framed, /Perform the bounded task/)
        return "delivered"
      },
    )
    const controller = createManagedDelivery({
      store,
      orchestrator,
      runtime: () => runtime,
      changed: () => {
        changed++
      },
    })
    await controller.tick()
    assert.equal(deliveries, 0)
    assert.equal(store.load().messages[messageId]!.delivery_status, "pending")
    assert.deepEqual(store.load().queues["managed-endpoint"], [messageId])
    assert.equal(orchestrator.load().agents.find((item) => item.id === agent.id)!.status, "running")
    observed = "idle"
    await controller.tick()
    assert.equal(deliveries, 1)
    assert.equal(store.load().messages[messageId]!.delivery_status, "delivered")
    assert.equal((store.load().queues["managed-endpoint"] ?? []).length, 0)
    assert.ok(changed > 0)
    controller.close()
  })
})

test("managed delivery: uncertain host acceptance stays visible and is not replayed by another tick or controller restart", async () => {
  await withManaged(async ({ dir, store, orchestrator, messageId }) => {
    let deliveries = 0
    const runtime = runtimeWith(
      async () => "idle",
      async () => {
        deliveries++
        return "uncertain"
      },
    )
    const controller = createManagedDelivery({ store, orchestrator, runtime: () => runtime, changed: () => {} })
    await controller.tick()
    assert.equal(store.load().messages[messageId]!.delivery_status, "in_flight")
    assert.match(store.load().errors.at(-1)!.message, /uncertain.*inspect host messages/i)
    await controller.tick()
    assert.equal(deliveries, 1)
    controller.close()
    const freshStore = new StateStore(dir)
    const freshOrchestrator = new OrchestratorStore(dir, freshStore)
    const restarted = createManagedDelivery({
      store: freshStore,
      orchestrator: freshOrchestrator,
      runtime: () => runtime,
      changed: () => {},
    })
    await restarted.tick()
    assert.equal(deliveries, 1, "restart cannot assume an uncertain host side effect did not occur")
    assert.equal(freshStore.load().messages[messageId]!.delivery_status, "in_flight")
    restarted.close()
  })
})

test("managed delivery: known host rejection requeues instead of reporting delivery", async () => {
  await withManaged(async ({ store, orchestrator, messageId }) => {
    const runtime = runtimeWith(
      async () => "idle",
      async () => "failed",
    )
    const controller = createManagedDelivery({ store, orchestrator, runtime: () => runtime, changed: () => {} })
    await controller.tick()
    assert.equal(store.load().messages[messageId]!.delivery_status, "pending")
    assert.deepEqual(store.load().queues["managed-endpoint"], [messageId])
    controller.close()
  })
})

test("managed delivery: pause applied during host status lookup prevents draining", async () => {
  await withManaged(async ({ store, orchestrator, messageId }) => {
    let deliveries = 0
    const runtime = runtimeWith(
      async () => {
        await store.withLock(() => {
          const state = store.load()
          assert.equal(setSessionPausedAsOperator(state, { channel: "work", paused: true }).ok, true)
          store.save(state)
        })
        return "idle"
      },
      async () => {
        deliveries++
        return "delivered"
      },
    )
    const controller = createManagedDelivery({ store, orchestrator, runtime: () => runtime, changed: () => {} })
    await controller.tick()
    assert.equal(deliveries, 0)
    assert.equal(store.load().messages[messageId]!.delivery_status, "pending")
    assert.deepEqual(store.load().queues["managed-endpoint"], [messageId])
    controller.close()
  })
})

test("managed delivery: emergency close during host status lookup preserves queued work", async () => {
  await withManaged(async ({ store, orchestrator, messageId }) => {
    let deliveries = 0
    let close = () => {}
    const runtime = runtimeWith(
      async () => {
        close()
        return "idle"
      },
      async () => {
        deliveries++
        return "delivered"
      },
    )
    const controller = createManagedDelivery({ store, orchestrator, runtime: () => runtime, changed: () => {} })
    close = controller.close
    await controller.tick()
    assert.equal(deliveries, 0)
    assert.equal(store.load().messages[messageId]!.delivery_status, "pending")
    await controller.tick()
    assert.equal(deliveries, 0)
  })
})

test("managed delivery: stopped lifecycle wins over stale idle lookup before drain", async () => {
  await withManaged(async ({ store, orchestrator, agent, messageId }) => {
    let deliveries = 0
    const runtime = runtimeWith(
      async () => {
        await orchestrator.withLock(() => {
          const state = orchestrator.load()
          state.agents.find((item) => item.id === agent.id)!.status = "stopped"
          orchestrator.save(state)
        })
        return "idle"
      },
      async () => {
        deliveries++
        return "delivered"
      },
    )
    const controller = createManagedDelivery({ store, orchestrator, runtime: () => runtime, changed: () => {} })
    await controller.tick()
    assert.equal(deliveries, 0)
    assert.equal(store.load().messages[messageId]!.delivery_status, "pending")
    assert.equal(orchestrator.load().agents.find((item) => item.id === agent.id)!.status, "stopped")
    controller.close()
  })
})

test("managed delivery persists rejected queued envelopes even when no batch is handed over", async () => {
  await withManaged(async ({ store, orchestrator, messageId }) => {
    const state = store.load()
    state.messages[messageId]!.channel_id = "missing-channel"
    store.save(state)
    let changed = 0,
      deliveries = 0
    const runtime = runtimeWith(
      async () => "idle",
      async () => {
        deliveries++
        return "delivered"
      },
    )
    const controller = createManagedDelivery({
      store,
      orchestrator,
      runtime: () => runtime,
      changed: () => {
        changed++
      },
    })
    await controller.tick()
    assert.equal(deliveries, 0)
    assert.equal(store.load().messages[messageId]!.delivery_status, "rejected")
    assert.deepEqual(store.load().queues["managed-endpoint"], [])
    assert.equal(changed, 1)
    await controller.tick()
    assert.equal(changed, 1, "unchanged observations do not publish repeated refreshes")
    controller.close()
  })
})

test("managed delivery publishes changed status and persists redacted actionable connection details", async () => {
  await withManaged(async ({ orchestrator, store, agent }) => {
    let changed = 0
    const runtime = runtimeWith(
      async () => "idle",
      async () => "delivered",
    )
    runtime.resume = async () => ({
      ok: false,
      message: "Host rejected credentials secret-value; reconnect the session. Bearer abc123",
    })
    const controller = createManagedDelivery({
      store,
      orchestrator,
      runtime: () => runtime,
      changed: () => {
        changed++
      },
      redact: (detail) => detail.replace(/secret-value/g, "[REDACTED]").replace(/Bearer abc123/g, "Bearer [REDACTED]"),
    })
    await controller.tick()
    const failed = orchestrator.load().agents.find((a) => a.id === agent.id)!
    assert.equal(failed.status, "stale")
    assert.match(failed.status_detail!, /reconnect/)
    assert.doesNotMatch(JSON.stringify(orchestrator.load()), /secret-value|abc123/)
    assert.equal(changed, 1)
    await controller.tick()
    assert.equal(changed, 1)
    runtime.resume = runtimeWith(
      async () => "running",
      async () => "delivered",
    ).resume
    await controller.tick()
    assert.equal(orchestrator.load().agents[0]!.status_detail, null)
    assert.equal(changed, 2)
    controller.close()
  })
})
