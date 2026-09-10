/**
 * GUI server tests (loopback-only): API round-trips for the session
 * console â€” create/list, members, save, resume-as-new, delete, member
 * removal, join-command, and the loopback bind refusal. Runs against a
 * REAL HTTP server on an ephemeral 127.0.0.1 port.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGuiServer, memberState } from "../../../src/gui/server.js"
import {
  createChannel,
  joinChannel,
  sendMessage,
  drainQueue,
  createSessionAsOperator,
} from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"
import { ArchiveStore } from "../../../src/core/archive.js"
import { joinCommandFor } from "../../../src/cli/join-command.js"

const PROJECT = "proj_gui"
const WORKTREE = "C:\\repo"

const withServerDirs = new Map<string, string>()
function dirOf(base: string): string {
  return withServerDirs.get(base) ?? base
}

async function withServer(name: string, fn: (base: string, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oc-gui-"))
  const handle = await startGuiServer({ projectDir: dir, port: 0, hostname: "127.0.0.1" })
  const base = `http://127.0.0.1:${handle.port}`
  withServerDirs.set(base, dir)
  try {
    await fn(base, dir)
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

// ── Reviewer P0: operator-created sessions must accept REAL host identities ──

test("P0 repro: GUI-created empty session joined by an MCP-style caller (sentinel id) succeeds", async () => {
  await withServer("gui-join", async (base) => {
    const created = (await (
      await fetch(`${base}/api/sessions`, { method: "POST", body: JSON.stringify({ name: "joins" }) })
    ).json()) as { ok: boolean }
    assert.equal(created.ok, true)
    // MCP-style caller: project_id "local-project" (sentinel) — previously
    // failed against the GUI's "gui-local-project" sentinel scheme.
    const joined = joinChannel(emptyState(), {
      channel: "x",
      role: "x",
      role_prompt: "x",
      session_id: "x",
      project_id: PROJECT,
      worktree: WORKTREE,
    })
    void joined
    // Join via public fetch is a browser op; drive the engine on the same
    // file the GUI server owns:
    const { StateStore } = await import("../../../src/core/store.js")
    const store = new StateStore(dirOf(base))
    const result = await store.withLock(() => {
      const state = store.load()
      const r = joinChannel(state, {
        channel: "joins",
        role: "Reviewer",
        role_prompt: "Review.",
        session_id: "mcp-member-1",
        project_id: "local-project",
        worktree: dirOf(base),
      })
      if (r.ok) store.save(state)
      return r
    })
    assert.equal(result.ok, true, `MCP sentinel join failed: ${result.message}`)
    void created
  })
})

test("P0: empty operator session ADOPTS the first joiner's real host identity; later joiners compare strictly", () => {
  const state = emptyState()
  createSessionAsOperator(state, { channel: "adopt", project_id: "gui-local-project", worktree: "C:\\gui" })
  // First joiner: an OpenCode-plugin-style caller with a REAL SDK project hash.
  const first = joinChannel(state, {
    channel: "adopt",
    role: "Builder",
    role_prompt: "p",
    session_id: "u_front",
    project_id: "real-sdk-hash-abc",
    worktree: "C:\\real\\worktree",
  })
  assert.equal(first.ok, true, `first joiner must adopt: ${first.message}`)
  const ch = state.channels["adopt"]!
  assert.equal(ch.project_id, "real-sdk-hash-abc", "channel adopted the real id")
  assert.equal(ch.worktree, "C:\\real\\worktree")
  // Later joiner: same project + worktree → ok.
  const second = joinChannel(state, {
    channel: "adopt",
    role: "Reviewer",
    role_prompt: "p",
    session_id: "u_rev",
    project_id: "real-sdk-hash-abc",
    worktree: "C:\\real\\worktree",
  })
  assert.equal(second.ok, true)
  // Later joiner: DIFFERENT project (both real) → refused (fail-closed).
  const intruder = joinChannel(state, {
    channel: "adopt",
    role: "Tester",
    role_prompt: "p",
    session_id: "u_out",
    project_id: "other-project-hash",
    worktree: "C:\\real\\worktree",
  })
  assert.equal(intruder.ok, false)
  assert.match(intruder.message, /different project/)
  // Sentinel joiner into a populated channel: allowed only at the same worktree.
  const sentinelOk = joinChannel(state, {
    channel: "adopt",
    role: "Desktop",
    role_prompt: "p",
    session_id: "u_dt",
    project_id: "local-project",
    worktree: "C:\\real\\worktree",
  })
  assert.equal(sentinelOk.ok, true, "sentinel joiner with matching worktree joins")
  const sentinelWrong = joinChannel(state, {
    channel: "adopt",
    role: "Desktop2",
    role_prompt: "p",
    session_id: "u_desk",
    project_id: "local-project",
    worktree: "C:\\other\\worktree",
  })
  assert.equal(sentinelWrong.ok, false, "sentinel joiner with a different worktree is refused")
})

test("P0: mixed-host round-trip from the join-command output (opencode ↔ MCP)", () => {
  const state = emptyState()
  // OpenCode member creates the channel (real SDK hash).
  createChannel(state, {
    channel: "mix",
    role: "Builder",
    role_prompt: "p",
    session_id: "oc_builder",
    project_id: "sdk-hash-123",
    worktree: "C:\\proj",
  })
  // MCP member joins with the "local-project" sentinel, same directory.
  const mcpJoin = joinChannel(state, {
    channel: "mix",
    role: "Reviewer",
    role_prompt: "p",
    session_id: "cc_reviewer",
    project_id: "local-project",
    worktree: "C:\\proj",
  })
  assert.equal(mcpJoin.ok, true, `mixed-host join broken: ${mcpJoin.message}`)
  // Message routing across the mixed-host pair.
  const sent = sendMessage(state, { channel: "mix", content: "hello cross-host", to: "Reviewer" }, "oc_builder")
  assert.equal(sent.ok, true)
  assert.deepEqual((sent.data as { recipients: string[] }).recipients, ["cc_reviewer"])
  const pulled = drainQueue(state, "cc_reviewer")
  assert.equal(pulled.length, 1)
})

// ── Reviewer P1: browser-surface hardening (Host + Origin) ──

test("P1: spoofed (rebound/non-loopback) Host header is rejected with 403", async () => {
  await withServer("gui-h1", async (base) => {
    const url = new URL(base)
    // undici's fetch forbids overriding Host — use http.request directly.
    const { request } = await import("node:http")
    const evil = await new Promise<{ status: number }>((resolve) => {
      const req = request(
        { hostname: "127.0.0.1", port: url.port, path: "/api/sessions", headers: { Host: "evil.example.com" } },
        (res) => {
          res.resume()
          resolve({ status: res.statusCode ?? 0 })
        },
      )
      req.end()
    })
    assert.equal(evil.status, 403, "rebound Host must be 403")
    const good = await new Promise<{ status: number }>((resolve) => {
      const req = request(
        { hostname: "127.0.0.1", port: url.port, path: "/api/sessions", headers: { Host: `127.0.0.1:${url.port}` } },
        (res) => {
          res.resume()
          resolve({ status: res.statusCode ?? 0 })
        },
      )
      req.end()
    })
    assert.equal(good.status, 200, "loopback Host still works")
  })
})

function okRequest(x: unknown): { status: number } {
  return x as { status: number }
}

function okStatus(x: { status: number }): number {
  return x.status
}

test("SSE: archive-only changes (no state.json write) still fire refresh (stale-GUI regression)", async () => {
  await withServer("gui-arch-watch", async (base, dir) => {
    // Open the SSE stream like the browser does.
    const controller = new AbortController()
    const events: string[] = []
    const streamPromise = (async () => {
      const res = await fetch(`${base}/api/events`, { signal: controller.signal })
      assert.equal(res.status, 200)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          events.push(buf.slice(0, i))
          buf = buf.slice(i + 2)
        }
      }
    })()

    await new Promise((r) => setTimeout(r, 400))
    // External archive mutation WITHOUT touching state.json — exactly what
    // a CLI `session delete` of a SAVED session (or an MCP save) does.
    const archives = new ArchiveStore(dirOf(base))
    mkdirSync(archives.dir, { recursive: true })
    const archiveId = "chn_reg000000000000000000000000000a"
    archives.save({
      schema: 1,
      channel_id: archiveId,
      name: "external-archive-write",
      parent_channel_id: null,
      description: null,
      summary: "archive-only write",
      members: [],
      budgets: null,
      created_at: Date.now(),
      saved_at: Date.now(),
      saved_by: null,
      saved_by_role: null,
      message_count: 0,
      messages: [],
      final_state_note: null,
    })
    // The list must show it...
    const list = (await (await fetch(`${base}/api/sessions`)).json()) as {
      data: { archived: Array<{ name: string }> }
    }
    assert.ok(
      list.data.archived.some((a) => a.name === "external-archive-write"),
      "archive appears in the session list",
    )

    // ...and the SSE stream must have announced the change (watcher covers
    // the archives dir, not just state.json).
    const deadline = Date.now() + 10_000
    while (!events.some((e) => e.includes("event: refresh")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
    controller.abort()
    await streamPromise.catch(() => {})
    assert.ok(
      events.some((e) => e.includes("event: refresh")),
      `archive-only change must fire an SSE refresh (got: ${JSON.stringify(events)})`,
    )
  })
})

test("P1: cross-site write (simulated simple-request CSRF) is rejected with 403", async () => {
  await withServer("gui-h2", async (base) => {
    // Evil page DELETE with an evil Origin (browser simple-request signature).
    const res = await fetch(`${base}/api/sessions/whatever`, {
      method: "DELETE",
      headers: { Host: "127.0.0.1", Origin: "https://evil.site" },
    })
    assert.equal(res.status, 403)
    // Evil Origin on a POST create.
    const post = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.site" },
      body: JSON.stringify({ name: "evil" }),
    })
    assert.equal(post.status, 403)
    // same-origin signal passes.
    const ok = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
        Origin: `http://127.0.0.1:${new URL(base).port}`,
      },
      body: JSON.stringify({ name: "good" }),
    })
    assert.equal(ok.status, 200)
  })
})
