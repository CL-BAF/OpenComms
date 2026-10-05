/** Real atomic state reloads; no live vendor process or prompt is fabricated. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, unwatchFile } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../../src/core/store.js"
import { createChannel, joinChannel, sendMessage } from "../../../src/core/engine.js"
import { createDeliveryController } from "../../../src/hosts/opencode/delivery.js"
import { deliverViaSpawn } from "../../../src/hosts/spawn-delivery.js"
import type { Member } from "../../../src/core/types.js"

function queued(spawn: boolean, terminal: "stale" | "rejected") {
  const dir = mkdtempSync(join(tmpdir(), "oc-linked-cleanup-"))
  const store = new StateStore(dir)
  const state = store.load()
  assert.ok(
    createChannel(state, {
      channel: "work",
      role: "Lead",
      role_prompt: "Coordinate",
      session_id: "lead",
      project_id: "cleanup",
      worktree: dir,
    }).ok,
  )
  assert.ok(
    joinChannel(state, {
      channel: "work",
      role: "Worker",
      role_prompt: "Work",
      session_id: "worker",
      project_id: "cleanup",
      worktree: dir,
      host: spawn ? "codex" : "opencode",
      surface: spawn ? "mcp" : "cli",
      delivery_mode: spawn ? "spawn_push" : "push",
      host_session_id: spawn ? "saved-codex-session" : "worker",
    }).ok,
  )
  assert.ok(sendMessage(state, { channel: "work", content: "Bounded linked assignment" }, "lead").ok)
  const message = Object.values(state.messages)[0]!
  if (terminal === "stale") message.timestamp = Date.now() - 60 * 60_000
  else message.channel_id = "missing-channel"
  store.save(state)
  return {
    dir,
    store,
    messageId: message.message_id,
    member: state.channels["work"]!.members.find((m) => m.session_id === "worker") as Member,
    cleanup: () => {
      unwatchFile(store.file)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

for (const terminal of ["stale", "rejected"] as const) {
  test(`linked OpenCode persists ${terminal} cleanup when no host prompt is dispatched`, async () => {
    const f = queued(false, terminal)
    try {
      let prompts = 0
      const errors: string[] = []
      const controller = createDeliveryController({
        store: f.store,
        load: () => f.store.load(),
        client: {
          session: {
            prompt: async () => {
              prompts++
              return {}
            },
          },
        },
        recordError: (message) => errors.push(message),
      })
      await controller.deliverPending("worker", { allowCrossServer: true })
      const fresh = new StateStore(f.dir).load()
      assert.equal(prompts, 0)
      assert.deepEqual(errors, [])
      assert.equal(fresh.messages[f.messageId]!.delivery_status, terminal)
      assert.deepEqual(fresh.queues["worker"], [])
      await controller.deliverPending("worker", { allowCrossServer: true })
      assert.equal(prompts, 0)
      assert.equal(new StateStore(f.dir).load().messages[f.messageId]!.delivery_status, terminal)
    } finally {
      f.cleanup()
    }
  })
  test(`linked spawn delivery persists ${terminal} cleanup without starting a vendor process`, async () => {
    const f = queued(true, terminal)
    try {
      let spawned = 0
      const errors: string[] = []
      const result = await deliverViaSpawn(
        {
          withLock: (fn) => f.store.withLock(fn),
          load: () => f.store.load(),
          save: (state) => f.store.save(state),
          cwd: f.dir,
          spawn: async () => {
            spawned++
            return { ok: true, stdout: "unexpected" }
          },
          recordError: (message) => errors.push(message),
        },
        f.member,
      )
      const fresh = new StateStore(f.dir).load()
      assert.equal(result.status, "skipped")
      assert.equal(spawned, 0)
      assert.deepEqual(errors, [])
      assert.equal(fresh.messages[f.messageId]!.delivery_status, terminal)
      assert.deepEqual(fresh.queues["worker"], [])
    } finally {
      f.cleanup()
    }
  })
}
