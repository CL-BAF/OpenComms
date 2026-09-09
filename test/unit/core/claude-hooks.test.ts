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
import { registerProjectMember } from "../../../src/adapters/claude-code/install.js"

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

/** Simulate the installer's member registration (writes a per-member pin). */
function installPin(projectDir: string, memberId: string, host = "claude-code"): void {
  mkdirSync(join(projectDir, ".opencomms", "pins"), { recursive: true })
  writeFileSync(
    join(projectDir, ".opencomms", "pins", `${memberId}.json`),
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
    // per-member pin file — the child env carries NO OPENCOMMS_MEMBER_ID.
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
    // One pin file per member (per-member pins, P1-1). Both members are
    // already BOUND here, so pin ambiguity cannot arise; each hook receives
    // only its own queue. The env-override path is exercised explicitly to
    // prove pins never leak across members.
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

function seedTwoUnboundMembers(projectDir: string, ids: [string, string]): void {
  mkdirSync(join(projectDir, ".opencomms"), { recursive: true })
  const now = Date.now()
  const [idA, idB] = ids
  const member = (sessionId: string, role: string) => ({
    session_id: sessionId,
    role,
    role_prompt: "p",
    joined_at: now,
    stale: false,
    stale_at: null,
    host: "claude-code",
    surface: "mcp",
    delivery_mode: "pull",
    host_session_id: null,
    stale_policy: { mode: "none", window_ms: null },
  })
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
        members: [member(idA, "Builder"), member(idB, "Reviewer")],
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
      ocm_for_a: {
        message_id: "ocm_for_a",
        channel_id: "chn_cc",
        sender_session_id: idB,
        sender_role: "Reviewer",
        recipient_session_id: idA,
        recipient_role: "Builder",
        timestamp: now,
        message_type: "manual",
        content: "payload for member A only",
        reply_to: null,
        hop_count: 0,
        delivery_status: "pending",
        correlation_id: "cor_a",
        delivered_at: null,
        attempts: 0,
      },
      ocm_for_b: {
        message_id: "ocm_for_b",
        channel_id: "chn_cc",
        sender_session_id: idA,
        sender_role: "Builder",
        recipient_session_id: idB,
        recipient_role: "Reviewer",
        timestamp: now,
        message_type: "manual",
        content: "payload for member B only",
        reply_to: null,
        hop_count: 0,
        delivery_status: "pending",
        correlation_id: "cor_b",
        delivered_at: null,
        attempts: 0,
      },
    },
    queues: { [idA]: ["ocm_for_a"], [idB]: ["ocm_for_b"] },
    delivered_to: {},
    errors: [],
  }
  writeFileSync(stateFileOf(projectDir), JSON.stringify(state), "utf8")
}

function deliveryPayload(stdout: string): string {
  const out = JSON.parse(stdout || "{}") as {
    hookSpecificOutput?: { additionalContext?: string }
    systemMessage?: string
  }
  return out.hookSpecificOutput?.additionalContext ?? ""
}

test("P1-1: two install-member runs + sequential SessionStarts bind each Claude session to its OWN member (no env pin)", async (t) => {
  if (!existsSync(HOOK_CLI)) {
    t.skip("dist build missing")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-hook-pins1-"))
  try {
    // Project has OpenComms state (possibly channel-less) before members register.
    mkdirSync(join(dir, ".opencomms"), { recursive: true })
    writeFileSync(
      stateFileOf(dir),
      JSON.stringify({ schema_version: 2, channels: {}, messages: {}, queues: {}, delivered_to: {}, errors: [] }),
      "utf8",
    )
    // Install-member run 1: no pins yet -> mints member A.
    const regA = registerProjectMember(dir, { host: "claude-code" })
    assert.ok(regA.ok, `first registration must succeed: ${JSON.stringify(regA)}`)
    const idA = regA.ok ? regA.memberId : ""
    const regB1 = registerProjectMember(dir, { host: "claude-code" })
    assert.equal(regB1.ok, false, "second BLIND registration must refuse (would orphan member A)")

    // Member A joins the channel via its MCP tools (simulated in state):
    // the roster now holds A (pinned) + B (present but NOT yet pinned).
    seedTwoUnboundMembers(dir, [idA, "sess_pin_b"])

    // Session 1 starts: exactly one unbound PINNED member -> binds A, drains A only.
    const res1 = runHookCli(dir, "session-start", { session_id: "claude-uuid-1", cwd: dir })
    assert.equal(res1.status, 0, res1.stderr)
    const after1 = JSON.parse(readFileSync(stateFileOf(dir), "utf8"))
    const memberA = after1.channels["cc-ch"].members.find((m: { session_id: string }) => m.session_id === idA)
    const memberB = after1.channels["cc-ch"].members.find((m: { session_id: string }) => m.session_id === "sess_pin_b")
    assert.equal(memberA.host_session_id, "claude-uuid-1", "session 1 bound to member A")
    assert.equal(memberB.host_session_id, null, "member B remains unbound")
    assert.ok(deliveryPayload(res1.stdout).includes("payload for member A only"))
    assert.ok(!deliveryPayload(res1.stdout).includes("payload for member B only"), "A must not receive B's mail")

    // Install-member run 2 happens AFTER session 1 (true sequential
    // onboarding): explicit --id registers member B's own pin file.
    const regB = registerProjectMember(dir, { host: "claude-code", memberId: "sess_pin_b" })
    assert.ok(regB.ok, `explicit registration must succeed: ${JSON.stringify(regB)}`)

    // Session 2 starts: exactly one unbound pinned member left -> binds B.
    const res2 = runHookCli(dir, "session-start", { session_id: "claude-uuid-2", cwd: dir })
    assert.equal(res2.status, 0, res2.stderr)
    const after2 = JSON.parse(readFileSync(stateFileOf(dir), "utf8"))
    const memberB2 = after2.channels["cc-ch"].members.find((m: { session_id: string }) => m.session_id === "sess_pin_b")
    assert.equal(memberB2.host_session_id, "claude-uuid-2", "session 2 bound to member B")
    assert.ok(deliveryPayload(res2.stdout).includes("payload for member B only"))
    assert.ok(!deliveryPayload(res2.stdout).includes("payload for member A only"), "B must not receive A's mail")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P1-1: multiple unbound pins are AMBIGUOUS - no auto-bind, guidance message, no delivery", async (t) => {
  if (!existsSync(HOOK_CLI)) {
    t.skip("dist build missing")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-hook-pins2-"))
  try {
    // Both members registered (pinned) BEFORE any session starts.
    seedTwoUnboundMembers(dir, ["sess_pin_a2", "sess_pin_b2"])
    installPin(dir, "sess_pin_a2")
    installPin(dir, "sess_pin_b2")

    const res = runHookCli(dir, "session-start", { session_id: "claude-uuid-x", cwd: dir })
    assert.equal(res.status, 0, res.stderr)
    const out = JSON.parse(res.stdout || "{}") as { systemMessage?: string; hookSpecificOutput?: unknown }
    assert.equal(out.hookSpecificOutput, undefined, "ambiguous pins must deliver NOTHING")
    assert.match(out.systemMessage ?? "", /ambiguous/, "guidance must say why binding did not happen")
    const after = JSON.parse(readFileSync(stateFileOf(dir), "utf8"))
    for (const m of after.channels["cc-ch"].members) {
      assert.equal(m.host_session_id, null, "no member may be bound on ambiguity")
    }
    assert.equal(after.queues["sess_pin_a2"]?.length, 1, "A's mail stays queued")
    assert.equal(after.queues["sess_pin_b2"]?.length, 1, "B's mail stays queued")
  } finally {
    rmDirQuiet(dir)
  }
})

test("P1-1: stale (session-ended) member is rebindable at SessionStart - no silent loss after a Claude restart", async (t) => {
  if (!existsSync(HOOK_CLI)) {
    t.skip("dist build missing")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-hook-pins4-"))
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
          members: [
            {
              session_id: "sess_pin_restart",
              role: "Builder",
              role_prompt: "p",
              joined_at: now,
              stale: true, // SessionEnd ran for the OLD Claude session
              stale_at: now,
              host: "claude-code",
              surface: "mcp",
              delivery_mode: "pull",
              host_session_id: "claude-uuid-old",
              stale_policy: { mode: "none", window_ms: null },
            },
          ],
        },
      },
      messages: {},
      queues: {},
      delivered_to: {},
      errors: [],
    }
    writeFileSync(stateFileOf(dir), JSON.stringify(state), "utf8")
    installPin(dir, "sess_pin_restart")

    // The user restarts Claude -> NEW session uuid. The stale member's old
    // binding must not strand it: the pin reclaims the member.
    const res = runHookCli(dir, "session-start", { session_id: "claude-uuid-new", cwd: dir })
    assert.equal(res.status, 0, res.stderr)
    const after = JSON.parse(readFileSync(stateFileOf(dir), "utf8"))
    const member = after.channels["cc-ch"].members[0]
    assert.equal(member.host_session_id, "claude-uuid-new", "stale member rebound to the new session")
    assert.equal(member.stale, false, "staleness cleared on rebind")
  } finally {
    rmDirQuiet(dir)
  }
})

function rmDirQuiet(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

test("P1-1 negative: member A's pin can never bind or drain for member B", async (t) => {
  if (!existsSync(HOOK_CLI)) {
    t.skip("dist build missing")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-hook-pins3-"))
  try {
    seedTwoUnboundMembers(dir, ["sess_pin_a3", "sess_pin_b3"])
    installPin(dir, "sess_pin_a3") // ONLY A is pinned
    // Session 1 binds A (single unbound pinned member) and drains A's queue.
    const res1 = runHookCli(dir, "session-start", { session_id: "claude-uuid-1", cwd: dir })
    assert.equal(res1.status, 0)
    assert.ok(deliveryPayload(res1.stdout).includes("payload for member A only"))

    // Session 2 (B's session, NO env pin): A is already bound, B has no pin,
    // so NOTHING may bind and B's mail must stay queued.
    const res2 = runHookCli(dir, "session-start", { session_id: "claude-uuid-2", cwd: dir })
    assert.equal(res2.status, 0)
    const out2 = JSON.parse(res2.stdout || "{}") as { hookSpecificOutput?: unknown }
    assert.equal(out2.hookSpecificOutput, undefined, "unpinned member B must not receive anything")
    const after = JSON.parse(readFileSync(stateFileOf(dir), "utf8"))
    const memberA = after.channels["cc-ch"].members.find((m: { session_id: string }) => m.session_id === "sess_pin_a3")
    assert.equal(memberA.host_session_id, "claude-uuid-1", "A's binding must be untouched by session 2")
    assert.equal(
      after.channels["cc-ch"].members.find((m: { session_id: string }) => m.session_id === "sess_pin_b3")
        .host_session_id,
      null,
      "B must remain unbound",
    )
    assert.equal(after.queues["sess_pin_b3"]?.length, 1, "B's mail untouched")

    // Forged identity: an env pin naming a non-member must bind nothing.
    const res3 = runHookCli(
      dir,
      "session-start",
      { session_id: "claude-uuid-3", cwd: dir },
      { OPENCOMMS_MEMBER_ID: "sess_forged_identity" },
    )
    assert.equal(res3.status, 0)
    const out3 = JSON.parse(res3.stdout || "{}") as { hookSpecificOutput?: unknown }
    assert.equal(out3.hookSpecificOutput, undefined, "forged env pin must deliver nothing")
    const after3 = JSON.parse(readFileSync(stateFileOf(dir), "utf8"))
    assert.equal(
      after3.channels["cc-ch"].members.find((m: { session_id: string }) => m.session_id === "sess_pin_b3")
        .host_session_id,
      null,
      "forged pin must not bind any member",
    )
    assert.equal(after3.queues["sess_pin_a3"]?.length, 0, "A's already-delivered mail not resurrected")
  } finally {
    rmDirQuiet(dir)
  }
})
