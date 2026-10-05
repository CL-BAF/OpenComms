import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { StateStore } from "../../../src/core/store.js"
import { createChannel, joinChannel, sendMessage, drainForDelivery } from "../../../src/core/engine.js"
import { createDeliveryController } from "../../../src/hosts/opencode/delivery.js"

test("plugin startup recovers linked deliveries and preserves managed uncertain acceptance without prompting managed queues", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-owner-delivery-"))
  try {
    const store = new StateStore(dir)
    const state = store.load()
    assert.ok(
      createChannel(state, {
        channel: "work",
        role: "Lead",
        role_prompt: "p",
        session_id: "lead",
        project_id: "p",
        worktree: dir,
      }).ok,
    )
    for (const [sessionId, role, surface, deliveryMode] of [
      ["managed", "Managed", "api", "pull"],
      ["linked", "Linked", "cli", "push"],
    ] as const) {
      assert.ok(
        joinChannel(state, {
          channel: "work",
          role,
          role_prompt: "p",
          session_id: sessionId,
          project_id: "p",
          worktree: dir,
          host: "opencode",
          surface,
          delivery_mode: deliveryMode,
        }).ok,
      )
      assert.ok(sendMessage(state, { channel: "work", to: sessionId, content: `assignment for ${role}` }, "lead").ok)
      assert.equal(drainForDelivery(state, sessionId).length, 1)
    }
    store.save(state)
    let prompts = 0
    const notices: string[] = []
    const controller = createDeliveryController({
      store,
      load: () => store.load(),
      client: {
        session: {
          async prompt() {
            prompts++
            return {}
          },
        },
      },
      recordError(message) {
        notices.push(message)
      },
    })
    await controller.startupSweep()
    const swept = store.load()
    assert.equal(
      Object.values(swept.messages).find((message) => message.recipient_session_id === "managed")?.delivery_status,
      "in_flight",
    )
    assert.equal(
      Object.values(swept.messages).find((message) => message.recipient_session_id === "linked")?.delivery_status,
      "pending",
    )
    assert.ok(
      sendMessage(swept, { channel: "work", to: "managed", content: "additional managed assignment" }, "lead").ok,
    )
    store.save(swept)
    await controller.deliverPending("managed", { allowCrossServer: true })
    assert.equal(prompts, 0, "plugin cannot prompt a coordinator-owned endpoint")
    assert.equal(store.load().queues.managed?.length, 1, "queued managed work stays available to coordinator")
    assert.equal(notices.length, 1, "linked crash recovery is visible")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
