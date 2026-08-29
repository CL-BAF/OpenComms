/**
 * MCP pull semantics tests (Reviewer Issue 4).
 *
 * opencomms_pull drains + marks delivered; opencomms_inbox previews without
 * consuming; output carries the untrusted framing note.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createChannel, joinChannel, sendMessage, history } from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"
import { StateStore } from "../../../src/core/store.js"
import type { State, ToolResult } from "../../../src/core/types.js"
import { buildMcpToolDefs } from "../../../src/mcp/opencomms-tools.js"

const PROJECT = "proj-pull"
const WORKTREE = "C:\\repo"
const PIN = "sess_pin_pull"

function setup(opts: { admin?: boolean; env?: Record<string, string> } = {}) {
  const state = emptyState()
  const created = createChannel(state, {
    channel: "pull-ch",
    role: "Builder",
    role_prompt: "p",
    session_id: "sess_peer",
    project_id: PROJECT,
    worktree: WORKTREE,
    stale_policy: { mode: "none", window_ms: null },
  })
  assert.equal(created.ok, true)
  // The PULL member (MCP-joined with a pin).
  process.env["OPENCOMMS_MEMBER_ID"] = PIN
  const joined = joinChannel(state, {
    channel: "pull-ch",
    role: "Reviewer",
    role_prompt: "p",
    session_id: PIN,
    project_id: PROJECT,
    worktree: WORKTREE,
    host: "claude-desktop",
    surface: "mcp",
    delivery_mode: "pull",
    stale_policy: { mode: "none", window_ms: null },
  })
  assert.equal(joined.ok, true)

  // Backing store so io.mutate persists.
  const dir = mkdtempSync(join(tmpdir(), "oc-pulltest-"))
  const store = new StateStore(dir)
  store.save(state)

  let live = store.load()
  const io = {
    mutate: async (mutate: (s: State) => ToolResult): Promise<ToolResult> =>
      store.withLock(() => {
        const s = store.load()
        const r = mutate(s)
        if (r.ok) store.save(s)
        return r
      }),
    readState: () => store.load(),
  }
  /** Locked send as the peer (persisted like the real write path). */
  const sendAsPeer = async (content: string): Promise<ToolResult> =>
    io.mutate((s) => sendMessage(s, { channel: "pull-ch", content }, "sess_peer"))
  const tools = buildMcpToolDefs(
    store,
    { host: "claude-desktop", admin: opts.admin ?? false, projectId: PROJECT, worktree: WORKTREE },
    io,
  )
  const find = (name: string) => tools.find((t) => t.name === name)
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; message: string; data?: any }> => {
    const tool = find(name)
    assert.ok(tool, `tool ${name} must exist`)
    const payload = await tool.execute(args)
    return JSON.parse(payload.text)
  }
  return { state: () => store.load(), call, sendAsPeer, cleanup, store }
  function cleanup(): void {
    delete process.env["OPENCOMMS_MEMBER_ID"]
    rmSync(dir, { recursive: true, force: true })
  }
}

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("opencomms_pull drains and MARKS DELIVERED (second pull returns nothing)", async () => {
  const h = setup()
  try {
    const sent = await h.sendAsPeer("pull me")
    assert.equal(sent.ok, true, `peer send failed: ${sent.message}`)

    const first = await h.call("opencomms_pull", { channel: "pull-ch" })
    assert.equal(first.ok, true, `pull failed: ${first.message}`)
    const framed = (first.data as { messages: Array<{ framed: string }> }).messages
    assert.equal(framed.length, 1)
    assert.ok(framed[0]!.framed.includes("pull me"))
    assert.ok(framed[0]!.framed.includes("UNTRUSTED_PEER_MESSAGE"), "pull output must be framed untrusted")

    const second = await h.call("opencomms_pull", { channel: "pull-ch" })
    assert.equal(
      (second.data as { messages: unknown[] }).messages.length,
      0,
      "second pull must return nothing (marked delivered)",
    )
  } finally {
    h.cleanup()
  }
})

test("opencomms_inbox previews WITHOUT consuming (messages stay pending)", async () => {
  const h = setup()
  try {
    const sent = await h.sendAsPeer("preview me")
    assert.equal(sent.ok, true, `peer send failed: ${sent.message}`)

    const preview = await h.call("opencomms_inbox", { channel: "pull-ch" })
    assert.equal(preview.ok, true)
    assert.equal((preview.data as { pending: number }).pending, 1, "inbox preview leaves messages pending")

    const statusData = await h.call("opencomms_status", { channel: "pull-ch" })
    const queues = (statusData.data as { channels: Array<{ queue_lengths: Record<string, number> }> }).channels[0]!
      .queue_lengths
    assert.equal(queues["sess_pin_pull"], 1, "preview must not drain the queue")
  } finally {
    h.cleanup()
  }
})

test("unpinned member cannot pull (fail closed)", async () => {
  const h = setup()
  try {
    delete process.env["OPENCOMMS_MEMBER_ID"]
    const result = await h.call("opencomms_pull", { channel: "pull-ch" })
    assert.equal(result.ok, false, "unpinned pull must be denied")
  } finally {
    h.cleanup()
  }
})
