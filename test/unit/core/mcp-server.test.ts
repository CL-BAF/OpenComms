/**
 * MCP server transport tests (Reviewer LOW follow-ups):
 * - oversize line -> -32700 error, process survives, initialize still works
 * - full JSON-RPC round-trip over a real stdio pipe:
 *   initialize -> tools/list -> tools/call(opencomms_pull)
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(join(here, "..", "..", "..", ".."))
const MCP_CLI = join(repoRoot, "dist", "mcp", "main.js")

interface SeedOpts {
  memberId?: string
}

function seedState(dir: string, opts: SeedOpts = {}): void {
  mkdirSync(join(dir, ".opencomms"), { recursive: true })
  const now = Date.now()
  const memberId = opts.memberId ?? "sess_pin_pull"
  const state = {
    schema_version: 2,
    channels: {
      "pipe-ch": {
        id: "chn_pipe",
        name: "pipe-ch",
        project_id: "proj-pipe",
        worktree: dir,
        created_at: now,
        paused: false,
        paused_at: null,
        members: [
          {
            session_id: "sess_peer",
            role: "Builder",
            role_prompt: "p",
            joined_at: now,
            stale: false,
            stale_at: null,
            host: "generic",
            surface: "cli",
            delivery_mode: "push",
            host_session_id: null,
            stale_policy: { mode: "none", window_ms: null },
          },
          {
            session_id: memberId,
            role: "Reviewer",
            role_prompt: "p",
            joined_at: now,
            stale: false,
            stale_at: null,
            host: "claude-desktop",
            surface: "mcp",
            delivery_mode: "pull",
            host_session_id: null,
            stale_policy: { mode: "none", window_ms: null },
          },
        ],
        max_members: 8,
        rate: { window_start: now, count: 0 },
        cooldown_until: {},
        seen_content: {},
        processed_correlations: [],
        max_hops: 4,
        rate_limit: 20,
        delivery_cooldown_ms: 1000,
        stale_event_ms: 300_000,
        timer: {
          active_member_id: null,
          segment_started_at: null,
          elapsed_ms: {},
          limit_ms: null,
          limit_member_id: null,
        },
      },
    },
    messages: {
      ocm_p1: {
        message_id: "ocm_p1",
        channel_id: "chn_pipe",
        sender_session_id: "sess_peer",
        sender_role: "Builder",
        recipient_session_id: memberId,
        recipient_role: "Reviewer",
        timestamp: now,
        message_type: "manual",
        content: "piped pull payload",
        reply_to: null,
        hop_count: 0,
        delivery_status: "pending",
        correlation_id: "cor_p1",
        delivered_at: null,
        attempts: 0,
      },
    },
    queues: { [memberId]: ["ocm_p1"] },
    delivered_to: {},
    errors: [],
  }
  writeFileSync(join(dir, ".opencomms", "state.json"), JSON.stringify(state), "utf8")
}

/** Run the MCP server with the given newline-delimited requests on stdin. */
function runServer(
  dir: string,
  requests: string[],
  env: Record<string, string> = {},
): {
  stdoutLines: unknown[]
  status: number
} {
  const res = spawnSync(process.execPath, [MCP_CLI, dir, "--host", "claude-desktop"], {
    input: requests.map((r) => `${r}\n`).join(""),
    timeout: 20_000,
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, OPENCOMMS_MEMBER_ID: "sess_pin_pull", ...env },
  })
  const stdoutLines = (res.stdout ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown)
  return { stdoutLines, status: res.status ?? -1 }
}

test("JSON-RPC round-trip over a real stdio pipe: initialize -> tools/list -> tools/call(pull)", async (t) => {
  if (!existsSync(MCP_CLI)) {
    t.skip("dist/mcp/main.js missing â€” run npm run build")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-mcp-"))
  try {
    await new Promise<void>((r) => {
      seedState(dir)
      r()
    })
    const { stdoutLines } = runServer(dir, [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "opencomms_pull", arguments: { channel: "pipe-ch" } },
      }),
    ])
    const byId = new Map<number, Record<string, unknown>>()
    for (const line of stdoutLines) {
      const rec = line as { id?: number; result?: unknown; error?: unknown }
      if (typeof rec["id"] === "number") byId.set(rec["id"], rec)
    }
    const init = byId.get(1) as { result?: { protocolVersion?: string; serverInfo?: { name?: string } } } | undefined
    assert.ok(init?.result, "initialize must succeed")
    assert.equal(init.result?.serverInfo?.name, "opencomms")

    const list = byId.get(2) as { result?: { tools?: Array<{ name: string }> } } | undefined
    const names = (list?.result?.tools ?? []).map((tool) => tool.name)
    assert.ok(names.includes("opencomms_pull"), `tools/list must include opencomms_pull: ${names.join(",")}`)

    const call = byId.get(3) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } } | undefined
    const text = call?.result?.content?.[0]?.text ?? ""
    const parsed = JSON.parse(text) as { ok: boolean; data?: { messages: Array<{ framed: string }> } }
    assert.equal(parsed.ok, true, "pull over the wire must succeed")
    assert.ok(
      (parsed.data?.messages?.[0]?.framed ?? "").includes("piped pull payload"),
      "pulled message content must arrive over the real pipe",
    )
    assert.ok(parsed.data!.messages[0]!.framed.includes("UNTRUSTED_PEER_MESSAGE"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("oversized frame gets -32700 and the server survives (initialize afterwards still works)", async (t) => {
  if (!existsSync(MCP_CLI)) {
    t.skip("dist/mcp/main.js missing")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-mcp-big-"))
  try {
    seedState(dir)
    const oversized = "x".repeat(1_048_576 + 100)
    const { stdoutLines, status } = runServer(dir, [
      oversized,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    ])
    assert.equal(status, 0, "server process must survive the oversized frame")
    const err = stdoutLines.find((l) => (l as { error?: { code?: number } }).error) as
      { error?: { code?: number; message?: string } } | undefined
    assert.ok(err?.error, "oversized frame must produce an error response")
    assert.equal(err.error!.code, -32700)

    const init = stdoutLines.find((l) => (l as { id?: number; result?: { serverInfo?: unknown } }).id === 1) as
      { result?: { serverInfo?: { name?: string } } } | undefined
    assert.ok(init?.result?.serverInfo, "initialize after the oversized frame must still succeed")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
