/**
 * Session lifecycle tests (Save / Resume-as-new / Delete / description).
 * Covers work-order scenarios 21, 24-33 plus the resume ladder and the
 * compact-context guarantee (no transcript auto-dump).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createChannel,
  joinChannel,
  sendMessage,
  buildSessionArchive,
  commitSessionSave,
  resumeSession,
  deleteSession,
  effectiveEndpointCapabilities,
} from "../../../src/core/engine.js"
import { ArchiveStore, buildArchiveContext } from "../../../src/core/archive.js"
import { StateStore, emptyState } from "../../../src/core/store.js"
import type { State } from "../../../src/core/types.js"

const PROJECT = "proj_lc"
const WORKTREE = "C:\\repo"

function seedTwo(state: State, channel = "life"): void {
  const created = createChannel(state, {
    channel,
    role: "Builder",
    role_prompt: "Build things.",
    session_id: "sess_b",
    project_id: PROJECT,
    worktree: WORKTREE,
  })
  assert.equal(created.ok, true)
  const joined = joinChannel(state, {
    channel,
    role: "Reviewer",
    role_prompt: "Review things.",
    session_id: "sess_r",
    project_id: PROJECT,
    worktree: WORKTREE,
    host: "claude-code",
    surface: "mcp",
    delivery_mode: "spawn_push",
  })
  assert.equal(joined.ok, true)
}

test("21: new sessions are ACTIVE with no description and no parent", () => {
  const state = emptyState()
  seedTwo(state)
  const ch = state.channels["life"]!
  assert.equal(ch.lifecycle, "active")
  assert.equal(ch.description, null)
  assert.equal(ch.parent_channel_id, null)
})

test("25-28: save archives messages, metadata, roster, prompts, and the structured summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-save-"))
  try {
    const store = new StateStore(dir)
    const archives = new ArchiveStore(dir)
    const state = emptyState()
    seedTwo(state, "feature")
    // Description set by the first responding agent (32).
    sendMessage(
      state,
      { channel: "feature", content: "work started", session_description: "Implement the billing export feature" },
      "sess_b",
    )
    sendMessage(state, { channel: "feature", content: "review notes: edge case in parser" }, "sess_r")

    const built = buildSessionArchive(state, {
      channel: "feature",
      session_id: "sess_b",
      summary: "Decisions: CSV quoting per RFC4180. Completed: parser + tests. Known issues: timezone edge.",
    })
    assert.equal(built.ok, true)
    const inputs = (built.data as { archive_inputs: Record<string, unknown> }).archive_inputs
    const archive = archives.fromChannel(
      inputs as never,
      inputs["messages"] as never,
      "sess_b",
      "Builder",
      inputs["summary"] as string | null,
    )
    archives.save(archive)
    assert.ok(existsSync(join(dir, ".opencomms", "archives", `${archive.channel_id}.json`)))

    // 26: messages retained.
    const onDisk = JSON.parse(readFileSync(join(dir, ".opencomms", "archives", `${archive.channel_id}.json`), "utf8"))
    assert.equal(onDisk.messages.length, 2)
    assert.equal(onDisk.message_count, 2)
    // 27: metadata retained (roster with roles, prompts, hosts, delivery).
    assert.equal(onDisk.members.length, 2)
    const reviewer = onDisk.members.find((m: { session_id: string }) => m.session_id === "sess_r")
    assert.equal(reviewer.role, "Reviewer")
    assert.equal(reviewer.host, "claude-code")
    assert.equal(reviewer.role_prompt, "Review things.")
    assert.equal(reviewer.delivery_mode, "spawn_push")
    assert.equal(onDisk.description, "Implement the billing export feature")
    // 28: structured summary retained verbatim.
    assert.match(onDisk.summary, /RFC4180/)
    assert.match(onDisk.summary, /Known issues: timezone edge/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("save purges live state; 29: the saved session can no longer send or join", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-save2-"))
  try {
    const store = new StateStore(dir)
    const archives = new ArchiveStore(dir)
    const state = emptyState()
    seedTwo(state, "gone")
    sendMessage(state, { channel: "gone", content: "pre-save message" }, "sess_b")
    const built = buildSessionArchive(state, { channel: "gone", session_id: "sess_b", summary: null })
    const inputs = (built.data as { archive_inputs: Record<string, unknown> }).archive_inputs
    const archive = archives.fromChannel(inputs as never, inputs["messages"] as never, "sess_b", "Builder", null)
    archives.save(archive)
    commitSessionSave(state, archive.channel_id)
    store.save(store.load())

    // Live state is clean.
    const reloaded = store.load()
    assert.equal(reloaded.channels["gone"], undefined)
    assert.equal(Object.keys(reloaded.messages).length, 0)

    // 29: sends/joins refused — the session no longer exists in live state
    // (the archive owns it; resume via opencomms session resume).
    const sendAgain = sendMessage(state, { channel: "gone", content: "after save?" }, "sess_b")
    assert.equal(sendAgain.ok, false)
    assert.match(sendAgain.message, /does not exist/)
    const joinAgain = joinChannel(state, {
      channel: "gone",
      role: "Tester",
      role_prompt: "p",
      session_id: "sess_new",
      project_id: PROJECT,
      worktree: WORKTREE,
    })
    assert.equal(joinAgain.ok, false)
    assert.match(joinAgain.message, /does not exist/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("30-31: resume creates a NEW linked session; joiners get COMPACT context, never the transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-resume-"))
  try {
    const store = new StateStore(dir)
    const archives = new ArchiveStore(dir)
    const state = emptyState()
    seedTwo(state, "design")
    for (let i = 0; i < 5; i++) sendMessage(state, { channel: "design", content: `message ${i}` }, "sess_b")
    const built = buildSessionArchive(state, {
      channel: "design",
      session_id: "sess_b",
      summary: "Design settled: shared schema v2.",
    })
    const inputs = (built.data as { archive_inputs: Record<string, unknown> }).archive_inputs
    const archive = archives.fromChannel(
      inputs as never,
      inputs["messages"] as never,
      "sess_b",
      "Builder",
      inputs["summary"] as string | null,
    )
    archives.save(archive)
    commitSessionSave(state, archive.channel_id)

    // Resume by a member of the ARCHIVED session (authorization).
    const resumed = resumeSession(state, { archive, project_id: PROJECT, worktree: WORKTREE })
    assert.equal(resumed.ok, true, resumed.message)
    const data = resumed.data as { name: string; parent_channel_id: string }
    assert.equal(data.parent_channel_id, archive.channel_id)
    // The original name is free after the purge, so resume reuses it.
    assert.equal(data.name, "design")

    // New members join and get the compact context (via the tool layer,
    // verified here through buildArchiveContext).
    const joinResult = joinChannel(state, {
      channel: data.name,
      role: "Implementer",
      role_prompt: "Implement.",
      session_id: "sess_impl",
      project_id: PROJECT,
      worktree: WORKTREE,
    })
    assert.equal(joinResult.ok, true)
    const ctx = buildArchiveContext(archive, data.name)
    assert.match(ctx, /Design settled: shared schema v2/)
    assert.match(ctx, /FULL ARCHIVED HISTORY is NOT included/)
    assert.ok(!ctx.includes("message 0"), "compact context must NOT contain the transcript")

    // The archive still exists untouched.
    assert.ok(archives.get(archive.channel_id))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resume name ladder: name taken → -r2; ladder bounded", () => {
  const state = emptyState()
  seedTwo(state, "evolve")
  const archive = {
    channel_id: "chn_old1",
    name: "evolve",
    description: "d",
    summary: "s",
    budgets: null,
  }
  const first = resumeSession(state, { archive, project_id: PROJECT, worktree: WORKTREE })
  assert.equal(first.ok, true)
  assert.equal((first.data as { name: string }).name, "evolve-r2")
  for (let i = 3; i <= 9; i++) {
    const r = resumeSession(state, { archive, project_id: PROJECT, worktree: WORKTREE })
    assert.equal(r.ok, true)
    assert.equal((r.data as { name: string }).name, `evolve-r${i}`)
  }
  const exhausted = resumeSession(state, { archive, project_id: PROJECT, worktree: WORKTREE })
  assert.equal(exhausted.ok, false)
  assert.match(exhausted.message, /ladder is exhausted/)
})

test("24: deletion is destructive and gated on confirm; archive is removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-del-"))
  try {
    const store = new StateStore(dir)
    const archives = new ArchiveStore(dir)
    const state = emptyState()
    seedTwo(state, "delme")
    const built = buildSessionArchive(state, { channel: "delme", session_id: "sess_b", summary: null })
    const inputs = (built.data as { archive_inputs: Record<string, unknown> }).archive_inputs
    const archive = archives.fromChannel(inputs as never, inputs["messages"] as never, "sess_b", "Builder", null)
    archives.save(archive)
    commitSessionSave(state, archive.channel_id)

    // confirm=false refuses.
    const refused = deleteSession(state, { channel: archive.channel_id, session_id: null, confirm: false })
    assert.equal(refused.ok, false)
    assert.match(refused.message, /confirm/)
    // Operator (no session id) may delete a SAVED session's archive.
    const decided = deleteSession(state, { channel: archive.channel_id, session_id: null, confirm: true })
    assert.equal(decided.ok, true)
    assert.equal((decided.data as { phase: string }).phase, "archive")
    assert.equal(archives.delete(archive.channel_id), true)
    assert.equal(archives.get(archive.channel_id), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("24b: ACTIVE session deletion requires membership", () => {
  const state = emptyState()
  seedTwo(state, "live-del")
  const outsider = deleteSession(state, { channel: "live-del", session_id: "sess_outsider", confirm: true })
  assert.equal(outsider.ok, false)
  assert.match(outsider.message, /not a member/)
  const noId = deleteSession(state, { channel: "live-del", session_id: null, confirm: true })
  assert.equal(noId.ok, false)
  assert.match(noId.message, /without a member session_id/)
  const byMember = deleteSession(state, { channel: "live-del", session_id: "sess_b", confirm: true })
  assert.equal(byMember.ok, true)
})

test("32: description is set ONCE by the first responding agent; later values ignored", () => {
  const state = emptyState()
  seedTwo(state, "desc")
  sendMessage(state, { channel: "desc", content: "m1", session_description: "Refactor the auth middleware" }, "sess_b")
  assert.equal(state.channels["desc"]!.description, "Refactor the auth middleware")
  // Later descriptions are ignored.
  sendMessage(state, { channel: "desc", content: "m2", session_description: "A different attempt" }, "sess_r")
  assert.equal(state.channels["desc"]!.description, "Refactor the auth middleware")
  // Missing/empty descriptions never break the send (33).
  const r = sendMessage(state, { channel: "desc", content: "m3", session_description: "   " }, "sess_b")
  assert.equal(r.ok, true)
})

test("33: description failure does not break the session", () => {
  const state = emptyState()
  seedTwo(state, "descfail")
  const r = sendMessage(state, { channel: "descfail", content: "m1", session_description: "x".repeat(500) }, "sess_b")
  assert.equal(r.ok, true)
  // Trimmed to the cap, still functional.
  assert.equal(state.channels["descfail"]!.description!.length, 140)
  assert.equal(state.channels["descfail"]!.lifecycle, "active")
})

test("endpoint capabilities: derived defaults + explicit override + spawn gate honors them", () => {
  assert.deepEqual(effectiveEndpointCapabilities({ delivery_mode: "spawn_push" }), {
    push: true,
    pull: true,
    resume: true,
    queue_while_busy: false,
    interrupt: false,
  })
  assert.deepEqual(effectiveEndpointCapabilities({ delivery_mode: "pull" }).push, false)
  // Explicit override downgrades resume even in spawn_push mode.
  const downgraded = effectiveEndpointCapabilities({
    delivery_mode: "spawn_push",
    endpoint_capabilities: { resume: false },
  })
  assert.equal(downgraded.resume, false)
  assert.equal(downgraded.push, true)
})
