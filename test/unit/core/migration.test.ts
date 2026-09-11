/**
 * Core migration tests (schema v1 -> v2) â€” Stage 2.
 *
 * Reviewer Item 4: cutover discipline â€” single migration, backup, marker
 * prevents re-run, legacy file untouched, tampered legacy never trusted.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../../src/core/store.js"
import { MIGRATION_MARKER } from "../../../src/core/types.js"
import { createSessionAsOperator } from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "oc-migrate-"))
}

/** A realistic v1 fixture: live channel, members, queue, timer, message. */
function v1Fixture(): Record<string, any> {
  const now = Date.now() - 60_000
  return {
    schema_version: 1,
    channels: {
      "feat-x": {
        id: "chn_test123",
        name: "feat-x",
        project_id: "proj1",
        worktree: "C:\\repo",
        created_at: now,
        paused: false,
        paused_at: null,
        members: [
          {
            session_id: "sess_v1_a",
            role: "Builder",
            role_prompt: "build things",
            joined_at: now,
            stale: false,
            stale_at: null,
          },
          {
            session_id: "sess_v1_b",
            role: "Reviewer",
            role_prompt: "review things",
            joined_at: now,
            stale: false,
            stale_at: null,
          },
        ],
        max_members: 8,
        rate: { window_start: now, count: 3 },
        cooldown_until: { sess_v1_b: now + 1000 },
        seen_content: { "sess_v1_a:abc": now },
        processed_correlations: ["cor_1"],
        max_hops: 4,
        rate_limit: 20,
        delivery_cooldown_ms: 1000,
        stale_event_ms: 300_000,
        timer: {
          active_member_id: "sess_v1_a",
          segment_started_at: now,
          elapsed_ms: { sess_v1_a: 5000 },
          limit_ms: 60_000,
          limit_member_id: null,
        },
      },
    },
    messages: {
      ocm_1: {
        message_id: "ocm_1",
        channel_id: "chn_test123",
        sender_session_id: "sess_v1_a",
        sender_role: "Builder",
        recipient_session_id: "sess_v1_b",
        recipient_role: "Reviewer",
        timestamp: now,
        message_type: "manual",
        content: "hello from v1",
        reply_to: null,
        hop_count: 0,
        delivery_status: "pending",
        correlation_id: "cor_1",
        delivered_at: null,
        attempts: 0,
      },
    },
    queues: { sess_v1_b: ["ocm_1"] },
    delivered_to: {},
    errors: [],
  }
}

test("v1 state migrates to v2 on first load: members enriched, queues/messages preserved", () => {
  const dir = tmpProject()
  try {
    // Legacy layout only: .opencode-comms/state.json (v1), no .opencomms.
    mkdirSync(join(dir, ".opencode-comms"), { recursive: true })
    writeFileSync(join(dir, ".opencode-comms", "state.json"), JSON.stringify(v1Fixture()), "utf8")

    const store = new StateStore(dir)
    const state = store.load()

    // Migration happened and is visible.
    assert.equal(state.schema_version, 2)
    assert.ok(state.errors.some((e: { message: string }) => e.message.includes("Migrated")))

    const channel = state.channels["feat-x"]
    assert.ok(channel, "channel preserved")
    assert.equal(channel.members.length, 2)
    const first = channel.members[0]!
    assert.equal(first.session_id, "sess_v1_a")
    assert.equal(first.role, "Builder")
    assert.equal(first.host, "opencode-comms") // legacy rows keep their era label
    assert.equal(first.surface, "cli")
    assert.equal(first.delivery_mode, "push")
    assert.deepEqual(first.stale_policy, { mode: "window", window_ms: 300_000 })
    // Queues and messages survive verbatim.
    assert.deepEqual(state.queues["sess_v1_b"], ["ocm_1"])
    assert.equal(state.messages["ocm_1"]?.content, "hello from v1")
    // Timer preserved (member-keyed v1 timers pass through).
    assert.equal(channel.timer.active_member_id, "sess_v1_a")
    assert.equal(channel.timer.elapsed_ms["sess_v1_a"], 5000)
    // Backup + marker exist.
    assert.ok(existsSync(join(dir, ".opencomms", "state.v1.bak.json")))
    assert.ok(existsSync(join(dir, ".opencomms", MIGRATION_MARKER)))
    // Original legacy file untouched.
    assert.ok(existsSync(join(dir, ".opencode-comms", "state.json")))
    assert.equal(JSON.parse(readFileSync(join(dir, ".opencode-comms", "state.json"), "utf8")).schema_version, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("second load does NOT re-migrate (marker discipline)", () => {
  const dir = tmpProject()
  try {
    mkdirSync(join(dir, ".opencode-comms"), { recursive: true })
    writeFileSync(join(dir, ".opencode-comms", "state.json"), JSON.stringify(v1Fixture()), "utf8")

    const first = new StateStore(dir).load()
    assert.equal(first.schema_version, 2)
    const noticeCount1 = first.errors.filter((e: { message: string }) => e.message.includes("Migrated")).length
    assert.equal(noticeCount1, 1)

    // Second load: marker present, no duplicate migration notice, members not
    // re-wrapped (would reset joined_at etc.).
    const second = new StateStore(dir).load()
    assert.equal(second.schema_version, 2)
    assert.equal(second.errors.filter((e: { message: string }) => e.message.includes("Migrated")).length, noticeCount1)
    assert.equal(second.channels["feat-x"]!.members[0]!.joined_at, first.channels["feat-x"]!.members[0]!.joined_at)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("legacy state recovers over an empty GUI placeholder with the same channel name", () => {
  const dir = tmpProject()
  try {
    mkdirSync(join(dir, ".opencode-comms"), { recursive: true })
    writeFileSync(join(dir, ".opencode-comms", "state.json"), JSON.stringify(v1Fixture()), "utf8")

    // An older GUI may have created the v2 file before this migration path
    // existed. It is safe to replace only because it contains no activity.
    const placeholder = emptyState()
    const created = createSessionAsOperator(placeholder, {
      channel: "feat-x",
      project_id: "gui-local-project",
      worktree: dir,
    })
    assert.equal(created.ok, true)
    const store = new StateStore(dir)
    store.save(placeholder)

    const state = store.load()
    assert.equal(state.channels["feat-x"]!.members.length, 2)
    assert.equal(state.messages["ocm_1"]?.content, "hello from v1")
    assert.ok(state.errors.some((e) => e.message.includes("recovered over empty GUI placeholders")))
    assert.ok(existsSync(join(dir, ".opencomms", "state.v1.bak.json")))
    assert.ok(existsSync(join(dir, ".opencomms", "state.v2.empty.bak.json")))
    assert.ok(existsSync(join(dir, ".opencomms", MIGRATION_MARKER)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("tampered legacy state is never migrated; starts empty with recorded reason", () => {
  const dir = tmpProject()
  try {
    mkdirSync(join(dir, ".opencode-comms"), { recursive: true })
    const bad = v1Fixture()
    bad.channels["feat-x"].members = undefined as never
    writeFileSync(join(dir, ".opencode-comms", "state.json"), JSON.stringify(bad), "utf8")

    const state = new StateStore(dir).load()
    assert.equal(Object.keys(state.channels).length, 0)
    assert.ok(state.errors.some((e: { message: string }) => e.message.includes("Legacy state rejected")))
    // Legacy file still untouched.
    assert.ok(existsSync(join(dir, ".opencode-comms", "state.json")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("no legacy dir: plain empty state, no migration noise", () => {
  const dir = tmpProject()
  try {
    const state = new StateStore(dir).load()
    assert.equal(state.schema_version, 2)
    assert.equal(Object.keys(state.channels).length, 0)
    assert.equal(state.errors.filter((e: { message: string }) => e.message.includes("Migrated")).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
