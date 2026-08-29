/**
 * Claude Code hook integration tests (Reviewer Issues 1-3).
 *
 * Runs the COMPILED hook CLI as a child process with real stdin/stdout â€”
 * the only honest way to test hook delivery (in-process tests could never
 * catch the async spin-wait bug).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(join(here, "..", "..", "..", ".."))
const HOOK_CLI = join(repoRoot, "dist", "adapters", "claude-code", "hook-cli.js")

interface HookResult {
  status: number
  stdout: string
  stderr: string
}

function runHookCli(
  projectDir: string,
  sub: string,
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): HookResult {
  const res = spawnSync(process.execPath, [HOOK_CLI, sub], {
    input: JSON.stringify(payload),
    cwd: projectDir,
    timeout: 20_000,
    encoding: "utf8",
    // Default: production wiring — member-pin.json on disk, NO env pin
    // (Claude Code hook commands carry no env block). Tests that want the
    // env-override path pass env explicitly.
    env: { ...process.env, ...env },
  })
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
}

/** Simulate the installer's member registration (writes member-pin.json). */
function installPin(projectDir: string, memberId: string, host = "claude-code"): void {
  mkdirSync(join(projectDir, ".opencomms"), { recursive: true })
  writeFileSync(
    join(projectDir, ".opencomms", "member-pin.json"),
    JSON.stringify({ member_id: memberId, host, saved_at: Date.now() }, null, 2),
    "utf8",
  )
}

interface SeedOpts {
  memberId: string
  hostSessionId: string | null
  stale?: boolean
}

function seedState(
  projectDir: string,
  opts: { memberId: string; hostSessionId: string | null; stale?: boolean },
): void {
  mkdirSync(join(projectDir, ".opencomms"), { recursive: true })
  const now = Date.now()
  const state = {
    schema_version: 2,
    channels: {
      "cc-ch": {
        id: "chn_cc",
        name: "cc-ch",
        project_id: "proj-cc",
        worktree: projectDir,
        created_at: now,
        paused: false,
        paused_at: null,
        members: [
          {
            session_id: opts.memberId,
            role: "Builder",
            role_prompt: "p",
            joined_at: now,
            stale: opts.stale === true,
            stale_at: opts.stale ? now : null,
            host: "claude-code",
            surface: "mcp",
            delivery_mode: "pull",
            host_session_id: opts.hostSessionId,
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
    messages: {},
    queues: {},
    delivered_to: {},
    errors: [],
  }
  writeFileSync(stateFileOf(projectDir), JSON.stringify(state), "utf8")
}

function stateFileOf(dir: string): string {
  return join(dir, ".opencomms", "state.json")
}
const stateFile = stateFileOf

/** Append a pending message for memberId from a peer. */
function queueMessage(projectDir: string, memberId: string, content: string): void {
  const path = stateFileOf(projectDir)
  const state = JSON.parse(readFileSync(path, "utf8")) as {
    messages: Record<string, unknown>
    queues: Record<string, string[]>
  }
  state.messages["ocm_h1"] = {
    message_id: "ocm_h1",
    channel_id: "chn_cc",
    sender_session_id: "sess_peer",
    sender_role: "Peer",
    recipient_session_id: memberId,
    recipient_role: "Builder",
    timestamp: Date.now(),
    message_type: "manual",
    content,
    reply_to: null,
    hop_count: 0,
    delivery_status: "pending",
    correlation_id: "cor_h1",
    delivered_at: null,
    attempts: 0,
  }
  state.queues[memberId] = ["ocm_h1"]
  writeFileSync(path, JSON.stringify(state), "utf8")
}

test("hook CLI: SessionStart binds pinned member to the Claude session and drains queued messages", async (t) => {
  if (!existsSync(HOOK_CLI)) {
    t.skip("dist/adapters/claude-code/hook-cli.js missing â€” run npm run build")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-hook-"))
  try {
    seedState(dir, { memberId: "sess_pin_builder", hostSessionId: null })
    queueMessage(dir, "sess_pin_builder", "hook-delivery test payload")
    // PRODUCTION WIRING (Reviewer Issue 9): pin comes from the installer's
    // member-pin.json file — the child env carries NO OPENCOMMS_MEMBER_ID.
    installPin(dir, "sess_pin_builder")

    // Hook fires with CLAUDE's session uuid — a different namespace from the
    // pinned member id (Reviewer Issue 2). SessionStart must bind + deliver.
    const res = runHookCli(dir, "session-start", { session_id: "claude-uuid-1", cwd: dir })
    assert.equal(res.status, 0, `hook failed: ${res.stderr}`)
    const out = JSON.parse(res.stdout || "{}") as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string }
    }
    const ctx = out.hookSpecificOutput?.additionalContext ?? ""
    assert.ok(ctx.includes("hook-delivery test payload"), `queued message not delivered: ${res.stdout}`)
    assert.ok(ctx.includes("UNTRUSTED_PEER_MESSAGE"), "delivery must carry untrusted framing")

    const updated = JSON.parse(readFileSync(stateFileOf(dir), "utf8"))
    assert.equal(updated.channels["cc-ch"].members[0].host_session_id, "claude-uuid-1", "host session binding recorded")
    assert.equal(updated.messages["ocm_h1"].delivery_status, "delivered", "message marked delivered on hook delivery")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("hook CLI: stale member is cleared at SessionStart (Reviewer Issue 3)", async (t) => {
  if (!existsSync(HOOK_CLI)) {
    t.skip("dist build missing")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-hook2-"))
  try {
    seedState(dir, { memberId: "sess_pin_builder", hostSessionId: "claude-uuid-1", stale: true })
    installPin(dir, "sess_pin_builder")
    const res = runHookCli(dir, "session-start", { session_id: "claude-uuid-1", cwd: dir })
    assert.equal(res.status, 0)
    const updated = JSON.parse(readFileSync(stateFileOf(dir), "utf8"))
    assert.equal(updated.channels["cc-ch"].members[0].stale, false, "SessionStart must clear staleness")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("hook CLI completes fast when the queue is empty (no 5s spin-wait stall)", async (t) => {
  if (!existsSync(HOOK_CLI)) {
    t.skip("dist build missing")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-hook3-"))
  try {
    seedState(dir, { memberId: "sess_pin_builder", hostSessionId: "claude-uuid-1" })
    installPin(dir, "sess_pin_builder")
    const start = Date.now()
    const res = runHookCli(dir, "user-prompt-submit", { session_id: "claude-uuid-1", cwd: dir })
    const elapsed = Date.now() - start
    assert.equal(res.status, 0)
    assert.equal(JSON.parse(res.stdout || "{}").hookSpecificOutput, undefined)
    assert.ok(elapsed < 5_000, `hook took ${elapsed}ms â€” spin-wait stall regression (Reviewer Issue 1)`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two Claude sessions on one channel receive only their own messages", async (t) => {
  if (!existsSync(HOOK_CLI)) {
    t.skip("dist build missing")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-hook3-"))
  try {
    mkdirSync(join(dir, ".opencomms"), { recursive: true })
    const now = Date.now()
    const state = {
      schema_version: 2,
      channels: {
        "cc-ch": {
          id: "chn_cc",
          name: "cc-ch",
          project_id: "proj-cc",
          worktree: dir,
          created_at: now,
          paused: false,
          paused_at: null,
          members: [
            {
              session_id: "sess_pin_a",
              role: "Builder",
              role_prompt: "p",
              joined_at: now,
              stale: false,
              stale_at: null,
              host: "claude-code",
              surface: "mcp",
              delivery_mode: "pull",
              host_session_id: "claude-uuid-A",
              stale_policy: { mode: "none", window_ms: null },
            },
            {
              session_id: "sess_pin_b",
              role: "Reviewer",
              role_prompt: "p",
              joined_at: now,
              stale: false,
              stale_at: null,
              host: "claude-code",
              surface: "mcp",
              delivery_mode: "pull",
              host_session_id: "claude-uuid-B",
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
        ocm_to_a: {
          message_id: "ocm_to_a",
          channel_id: "chn_cc",
          sender_session_id: "sess_pin_b",
          sender_role: "Reviewer",
          recipient_session_id: "sess_pin_a",
          recipient_role: "Builder",
          timestamp: now,
          message_type: "manual",
          content: "message addressed to Builder only",
          reply_to: null,
          hop_count: 0,
          delivery_status: "pending",
          correlation_id: "cor_x",
          delivered_at: null,
          attempts: 0,
        },
      },
      queues: { sess_pin_a: ["ocm_to_a"] },
      delivered_to: {},
      errors: [],
    }
    writeFileSync(stateFileOf(dir), JSON.stringify(state), "utf8")
    // One pin file per member, as two separate installs would produce... but
    // the pin file is per-PROJECT (single-member identity): both members run
    // in the SAME project here, so each hook uses the env-override path
    // (multi-instance) — pass pins explicitly per session.
    const resB = runHookCli(
      dir,
      "session-start",
      { session_id: "claude-uuid-B", cwd: dir },
      {
        OPENCOMMS_MEMBER_ID: "sess_pin_b",
      },
    )
    assert.equal(resB.status, 0)
    const outB = JSON.parse(resB.stdout || "{}")
    assert.equal(outB.hookSpecificOutput, undefined, "member B must not receive A's message")

    // Builder's hook receives it (its pin via env override).
    const resA = runHookCli(
      dir,
      "session-start",
      { session_id: "claude-uuid-A", cwd: dir },
      {
        OPENCOMMS_MEMBER_ID: "sess_pin_a",
      },
    )
    const outA = JSON.parse(resA.stdout || "{}")
    assert.ok(
      (outA.hookSpecificOutput?.additionalContext ?? "").includes("message addressed to Builder"),
      "member A must receive their own message",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
