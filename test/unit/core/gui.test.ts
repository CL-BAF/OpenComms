/**
 * GUI server tests (loopback-only): API round-trips for the session
 * console â€” create/list, members, save, resume-as-new, delete, member
 * removal, join-command, and the loopback bind refusal. Runs against a
 * REAL HTTP server on an ephemeral 127.0.0.1 port.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGuiServer, memberState } from "../../../src/gui/server.js"
import { createChannel, joinChannel, sendMessage } from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"
import { joinCommandFor } from "../../../src/cli/join-command.js"

const PROJECT = "proj_gui"
const WORKTREE = "C:\\repo"

async function withServer(name: string, fn: (base: string, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oc-gui-"))
  const handle = await startGuiServer({ projectDir: dir, port: 0, hostname: "127.0.0.1" })
  try {
    await fn(`http://127.0.0.1:${handle.port}`, dir)
  } finally {
    await handle.close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
  void name
}

const api = async (base: string, path: string, method = "GET", body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = (await res.json()) as Record<string, unknown>
  return { status: res.status, body: payload }
}

test("GUI: create â†’ list shows the empty active session; join-command is the real one", async () => {
  await withServer("create", async (base) => {
    const created = (await (
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        body: JSON.stringify({ name: "billing-v2" }),
      })
    ).json()) as { ok: boolean; message: string }
    assert.equal(created.ok, true, created.message)

    const list = (await (await fetch(`${base}/api/sessions`)).json()) as {
      data: {
        live: Array<{ name: string; lifecycle: string; description: string; agents: unknown[] }>
      }
    }
    const card = list.data.live.find((s) => s.name === "billing-v2")!
    assert.ok(card, "created session appears as a card")
    assert.equal(card.lifecycle, "active")
    assert.equal(card.description, "No description yet")
    assert.equal(card.agents.length, 0)

    const cmd = (await (await fetch(`${base}/api/sessions/billing-v2/join-command?host=claude-code`)).json()) as {
      ok: boolean
      data: { command: string }
    }
    assert.equal(cmd.ok, true)
    assert.match(cmd.data.command, /opencomms_join\(channel="billing-v2"/)
    assert.match(cmd.data.command, /spawn_push=true/)
  })
})

test("GUI: members endpoint returns live roster with honest states; remove severs the link only", async () => {
  await withServer("gui2", async (base, dir) => {
    // Seed via the engine (simulating agents joining).
    const storeState = emptyState()
    createChannel(storeState, {
      channel: "app",
      role: "Builder",
      role_prompt: "p",
      session_id: "u_builder",
      project_id: PROJECT,
      worktree: WORKTREE,
    })
    joinChannel(storeState, {
      channel: "app",
      role: "Reviewer",
      role_prompt: "p",
      session_id: "u_rev",
      project_id: PROJECT,
      worktree: WORKTREE,
      host: "claude-code",
      delivery_mode: "spawn_push",
      host_session_id: "claude-1",
    })
    sendMessage(storeState, { channel: "app", content: "queued mail for reviewer", to: "Reviewer" }, "u_builder")
    // Persist through the SAME store the GUI server reads.
    const { StateStore } = await import("../../../src/core/store.js")
    const store = new StateStore(dir)
    await store.withLock(() => {
      store.save(storeState)
    })

    const members = (await (await fetch(`${base}/api/sessions/app/members`)).json()) as {
      ok: boolean
      data: { agents: Array<{ role: string; state: string }> }
    }
    assert.equal(members.ok, true)
    assert.equal(members.data.agents.length, 2)
    const reviewer = members.data.agents.find((a) => a.role === "Reviewer")!
    assert.equal(reviewer.state, "Working", "member with queued mail reports Working")
    const builder = members.data.agents.find((a) => a.role === "Builder")!
    assert.equal(builder.state, "Idle")

    const removed = (await (
      await fetch(`${base}/api/sessions/app/members/remove`, {
        method: "POST",
        body: JSON.stringify({ target_role: "Reviewer" }),
      })
    ).json()) as { ok: boolean; message: string }
    assert.equal(removed.ok, true, removed.message)
    assert.match(removed.message, /no provider processes were touched/i)

    const after = (await (await fetch(`${base}/api/sessions/app/members`)).json()) as {
      ok: boolean
      data: { agents: Array<{ role: string }> }
    }
    assert.equal(after.data.agents.length, 1)
    assert.equal(after.data.agents[0]!.role, "Builder")
  })
})

test("GUI: save â†’ archived card; resume-as-new; delete is destructive", async () => {
  await withServer("gui3", async (base) => {
    // Saving a nonexistent session fails cleanly.
    const nonexistent = (await (
      await fetch(`${base}/api/sessions/nonexistent/save`, { method: "POST", body: JSON.stringify({}) })
    ).json()) as { ok: boolean; message: string }
    assert.equal(nonexistent.ok, false, "saving a nonexistent session fails cleanly")

    // Create a session, save it, then check archive listing.
    const created = (await (
      await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({ name: "design2" }) })
    ).json()) as { ok: boolean; message: string }
    assert.equal(created.ok, true, created.message)
    const savedOk = (await (
      await fetch(`${base}/api/sessions/design2/save`, {
        method: "POST",
        body: JSON.stringify({ summary: "Design settled: shared schema v2." }),
      })
    ).json()) as {
      ok: boolean
      message: string
    }
    assert.equal(savedOk.ok, true, savedOk.message)

    const list = (await (await fetch(`${base}/api/sessions`)).json()) as {
      data: {
        live: Array<{ name: string }>
        archived: Array<{ name: string; message_count: number; summary: string }>
      }
    }
    assert.equal(
      list.data.live.find((s) => s.name === "design2"),
      undefined,
      "saved session left live state",
    )
    const arch = list.data.archived.find((a: { name: string }) => a.name === "design2")
    assert.ok(arch, "saved session appears in archives")
    assert.equal(arch.message_count, 0)
    assert.match(arch.summary, /Design settled/)

    // Resume as new.
    const resumed = (await (
      await fetch(`${base}/api/sessions/design2/resume`, { method: "POST", body: JSON.stringify({}) })
    ).json()) as {
      ok: boolean
      message: string
      data: { name: string }
    }
    assert.equal(resumed.ok, true, resumed.message)
    assert.equal(resumed.data.name, "design2", "name free after purge â†’ reuse")
    const detail = (await (await fetch(`${base}/api/sessions/design2/members`)).json()) as {
      ok: boolean
      data: { lifecycle: string; compact_context?: string }
    }
    assert.equal(detail.data.lifecycle, "active")
    assert.match(detail.data.compact_context ?? "", /Design settled/)

    // Delete (destructive, confirm built into the API as DELETE). Deleting
    // the RESUMED session removes only its live state â€” the parent archive
    // remains (session evolution keeps the chain).
    const deleted = (await (await fetch(`${base}/api/sessions/design2`, { method: "DELETE" })).json()) as {
      ok: boolean
      message: string
    }
    assert.equal(deleted.ok, true, deleted.message)
    const afterLive = (await (await fetch(`${base}/api/sessions/design2/members`)).json()) as {
      ok: boolean
      data: { lifecycle: string }
    }
    assert.equal(afterLive.ok, true, "the PARENT archive remains readable after deleting a resumed session")
    assert.equal(afterLive.data.lifecycle, "saved")

    // Deleting again (no live channel) targets the archive itself.
    const deletedArchive = (await (await fetch(`${base}/api/sessions/design2`, { method: "DELETE" })).json()) as {
      ok: boolean
      message: string
    }
    assert.equal(deletedArchive.ok, true, deletedArchive.message)
    const afterArchive = (await (await fetch(`${base}/api/sessions/design2/members`)).json()) as { ok: boolean }
    assert.equal(afterArchive.ok, false, "deleted sessions give no future context")
  })
})

test("GUI: binds loopback only â€” non-loopback hostnames are refused", async () => {
  await assert.rejects(() => startGuiServer({ projectDir: ".", port: 0, hostname: "0.0.0.0" }), /loopback only/)
})

test("memberState: honest three-state mapping (no fabricated busy signal)", () => {
  assert.equal(memberState({ stale: true }, 0), "Offline")
  assert.equal(memberState({ stale: false }, 0), "Idle")
  assert.equal(memberState({ stale: false }, 3), "Working")
})

test("join-command helper: real commands per host, fail-closed unknown host", () => {
  const oc = joinCommandFor("My-Feature", "opencode")
  assert.ok(!("error" in oc) && oc.command.includes("Channel=my-feature"), "names are normalized")
  const cc = joinCommandFor("lab", "claude-code")
  assert.ok(!("error" in cc) && cc.command.includes("spawn_push=true"))
  const bad = joinCommandFor("lab", "telepathy")
  assert.ok("error" in bad)
})
