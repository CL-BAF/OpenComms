/**
 * Bridge parity tests (1.4.0 release/debug slice).
 *
 * 1. Drift gate: the Rust sidecar allowlist
 *    (desktop/src-tauri/src/main.rs ALLOWED_COMMANDS) must equal the TS
 *    command surface (src/orchestrator/bridge.ts BRIDGE_COMMANDS) EXACTLY.
 *    The 1.4.0 incident (stale 1.2.0 sidecar missing runtimes_list) was a
 *    bundled-binary drift failure; this gate catches the SOURCE drift class
 *    in CI instead of at runtime handshake refusal.
 * 2. Live sidecar probe (Windows only, skipped elsewhere or when the
 *    packaged binary is absent): spawn the coordinator exe, validate the
 *    handshake, ack it, then nodes_list -> runtimes_list. Acceptance:
 *    runtimes_list returns a catalog or an explicit unavailable-capability
 *    result with recovery and correlation — never a routing/protocol error.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Readable } from "node:stream"
import {
  BRIDGE_COMMANDS,
  BRIDGE_MAX_LINE_CHARS,
  boundedBridgeLines,
  dispatchBridgeCommand,
  parseBridgeRequest,
  runBridge,
  type BridgeDeps,
} from "../../../src/orchestrator/bridge.js"
import type { OrchestratorApi, ApiResult } from "../../../src/orchestrator/api.js"
import { ACTION_ROUTES, resolveAction } from "../../../src/gui/contracts.js"

const REPO_ROOT = (() => {
  let dir = resolve(process.cwd())
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "orchestrator", "bridge.ts"))) return dir
    const parent = resolve(join(dir, ".."))
    if (parent === dir) return resolve(process.cwd())
    dir = parent
  }
})()

const MAIN_RS = join(REPO_ROOT, "desktop", "src-tauri", "src", "main.rs")
const SIDECAR = join(REPO_ROOT, "desktop", "src-tauri", "binaries", "opencomms-coordinator-x86_64-pc-windows-msvc.exe")

/** Extract the ALLOWED_COMMANDS string entries from main.rs source text. */
export function extractAllowedCommands(rustSource: string): string[] {
  const anchor = "const ALLOWED_COMMANDS"
  const start = rustSource.indexOf(anchor)
  assert.ok(start >= 0, "main.rs must declare const ALLOWED_COMMANDS")
  const arrayOpen = rustSource.indexOf("&[", start)
  assert.ok(arrayOpen >= 0, "ALLOWED_COMMANDS must be a &[&str] array")
  const arrayClose = rustSource.indexOf("];", arrayOpen)
  assert.ok(arrayClose > arrayOpen, "ALLOWED_COMMANDS array must terminate with ];")
  const body = rustSource.slice(arrayOpen, arrayClose)
  const entries = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string)
  assert.ok(entries.length > 0, "ALLOWED_COMMANDS must contain entries")
  return entries
}

test("bridge parity: Rust ALLOWED_COMMANDS equals TS BRIDGE_COMMANDS exactly", () => {
  assert.ok(existsSync(MAIN_RS), `sidecar source missing: ${MAIN_RS}`)
  const rust = extractAllowedCommands(readFileSync(MAIN_RS, "utf8"))
  const ts = [...BRIDGE_COMMANDS]
  assert.equal(rust.length, ts.length, `length drift: Rust=${rust.length} TS=${ts.length}`)
  assert.deepEqual(
    [...rust].sort(),
    [...ts].sort(),
    "command surface drift between main.rs ALLOWED_COMMANDS and bridge.ts BRIDGE_COMMANDS",
  )
  assert.ok(rust.includes("runtimes_list"), "regression: runtimes_list must be relayed (1.4.0 incident)")
  assert.ok(rust.includes("integrations_list"), "regression: integrations_list must be relayed")
  for (const route of ACTION_ROUTES) {
    assert.ok(rust.includes(route.command), `visible route lacks native IPC command: ${route.method} ${route.path}`)
  }
})

function bridgeFixture(
  calls: Array<{ name: string; args: unknown }>,
  written: string[] = [],
  errors: string[] = [],
): BridgeDeps {
  const call = (name: string, args: unknown = {}): ApiResult => {
    calls.push({ name, args })
    return { ok: true, message: `${name}: persisted outcome`, data: { name, args } }
  }
  return {
    api: {
      listNodes: () => call("nodes_list"),
      listAgents: () => call("agents_list"),
      listTasks: () => call("tasks_list"),
      listEvents: (since: number) => call("events_list", { since }),
      trustView: () => call("trust_view"),
      auditLog: (args: Record<string, unknown>) => call("audit_log", args),
      listRuntimes: (node_id: string) => call("runtimes_list", { node_id }),
      createAgent: (args: Record<string, unknown>) => call("unbootstrapped_agent_create", args),
      stopAgent: (args: Record<string, unknown>) => call("agent_stop", args),
      restartAgent: (args: Record<string, unknown>) => call("agent_restart", args),
      assignTask: (args: Record<string, unknown>) => call("task_assign", args),
      getTask: (task_id: string) => call("task_get", { task_id }),
      transitionTask: (task_id: string, args: Record<string, unknown>) => call("task_transition", { ...args, task_id }),
      reassignTask: (task_id: string, args: Record<string, unknown>) => call("task_reassign", { ...args, task_id }),
      listTeamTemplates: () => call("team_template_list"),
      saveTeamTemplate: (args: Record<string, unknown>) => call("team_template_save", args),
      deleteTeamTemplate: (template_id: string, args: Record<string, unknown>) =>
        call("team_template_delete", { ...args, template_id }),
      listContext: (q: string) => call("context_list", { q }),
      addContext: (args: Record<string, unknown>) => call("context_add", args),
      contextHandoff: () => call("context_handoff"),
      listPermissions: (agent_id: string) => call("permissions_list", { agent_id }),
      respondPermission: (agent_id: string, permission_id: string, args: Record<string, unknown>) =>
        call("permission_respond", { ...args, agent_id, permission_id }),
      approveOrRevoke: (args: Record<string, unknown>, action: string) => call(`node_${action}`, args),
    } as unknown as OrchestratorApi,
    guiReads: {
      sessions: () => call("sessions_list"),
      sessionMembers: (name) => call("session_members", { name }),
      sessionDetail: (name) => call("session_detail", { name }),
      sessionJoinCommand: (name, host, role) => call("session_join_command", { name, host, role }),
      capabilities: () => call("capabilities"),
      workspaceState: () => call("workspace_state"),
      integrationsList: () => call("integrations_list"),
      integrationsOverview: async () => call("integrations_overview"),
      integrationBootstrap: async () => call("integration_bootstrap"),
      diagnostics: () => call("diagnostics"),
    },
    guiWrites: {
      sessionCreate: async (args) => call("session_create", args),
      sessionSave: async (args) => call("session_save", args),
      sessionResume: async (args) => call("session_resume", args),
      sessionDelete: async (args) => call("session_delete", args),
      setSessionPaused: async (args, paused) => call(paused ? "session_pause" : "session_unpause", args),
      memberRemove: async (args) => call("member_remove", args),
      workspaceSelect: async (args) => call("workspace_select", args),
      integrationAction: async (args) => call("integration_action", args),
      agentCreate: async (args) => call("agent_create", args),
      agentLink: async (args) => call("agent_link", args),
      emergencyStop: async (args) => call("emergency_stop", args),
      taskReassign: async (task_id, args) => call("task_reassign", { ...args, task_id }),
    },
    write: (line) => written.push(line),
    error: (message) => errors.push(message),
  }
}

test("native action contract: visible mutations dispatch to the advertised operation", async () => {
  const calls: Array<{ name: string; args: unknown }> = []
  const deps = bridgeFixture(calls)
  for (const [path, method, body, expected] of [
    ["/api/orchestrator/agents/create", "POST", { name: "worker" }, "agent_create"],
    ["/api/orchestrator/agents/stop", "POST", { agent_id: "worker" }, "agent_stop"],
    ["/api/orchestrator/agents/restart", "POST", { agent_id: "worker" }, "agent_restart"],
    ["/api/orchestrator/tasks/assign", "POST", { agent_id: "worker", request_id: "stable" }, "task_assign"],
    ["/api/sessions/feature/members/remove", "POST", { target_session_id: "member" }, "member_remove"],
    ["/api/sessions/feature/join-command?host=codex", "GET", {}, "session_join_command"],
    ["/api/orchestrator/tasks/task-1/transition", "POST", { state: "review", expected_revision: 2 }, "task_transition"],
    ["/api/orchestrator/tasks/task-1/reassign", "POST", { agent_id: "worker", expected_revision: 2 }, "task_reassign"],
    ["/api/orchestrator/team-templates", "GET", {}, "team_template_list"],
    ["/api/orchestrator/team-templates", "POST", { name: "Team" }, "team_template_save"],
    ["/api/orchestrator/team-templates/team-1", "DELETE", { expected_revision: 1 }, "team_template_delete"],
    ["/api/integrations/codex/repair", "POST", {}, "integration_action"],
    ["/api/emergency-stop", "POST", {}, "emergency_stop"],
  ] as const) {
    const route = resolveAction(path, method, body)
    assert.ok(route, `missing route ${path}`)
    assert.equal(route.command, expected)
    const result = await dispatchBridgeCommand(deps, { id: "contract", cmd: route.command, args: route.args })
    assert.equal(result.ok, true)
    assert.equal(calls.at(-1)?.name, expected)
  }
  assert.ok(
    !calls.some((entry) => entry.name === "unbootstrapped_agent_create"),
    "native create must share coordinator bootstrap",
  )
  assert.deepEqual(calls.find((entry) => entry.name === "member_remove")?.args, {
    name: "feature",
    target_session_id: "member",
    request_id: "contract",
    operation_id: "contract",
  })
  assert.equal(resolveAction("/api/sessions/feature/members/remove/extra", "POST", {}), null)
  assert.equal(resolveAction("/api/sessions/feature/members", "POST", {}), null)
  assert.equal(
    (calls.find((entry) => entry.name === "task_reassign")?.args as Record<string, unknown>)["actor_id"],
    "operator",
    "the native handoff route carries operator authority from its owner surface",
  )
})

test("every advertised GUI route resolves to an implemented native dispatcher", async () => {
  const calls: Array<{ name: string; args: unknown }> = []
  const deps = bridgeFixture(calls)
  for (const route of ACTION_ROUTES) {
    const path = route.path.replace(/:([a-z_]+)/g, (_match, name: string) => `fixture-${name}`)
    const action = resolveAction(path, route.method, { since: 0 })
    assert.ok(action, `visible route must resolve: ${route.path}`)
    const count = calls.length
    const result = await dispatchBridgeCommand(deps, { id: "advertised", cmd: action.command, args: action.args })
    assert.equal(result.ok, true, `${route.method} ${route.path}: ${result.message}`)
    assert.equal(calls.length, count + 1, "advertised route must reach exactly one backend provider")
  }
})

test("bridge rejects arbitrary proxies and malformed arguments without reflecting sensitive input", async () => {
  const calls: Array<{ name: string; args: unknown }> = []
  const deps = bridgeFixture(calls)
  for (const cmd of ["exec_shell", "__proto__", "http_request", "/api/orchestrator/agents/create"]) {
    const result = await dispatchBridgeCommand(deps, { id: "deny", cmd, args: {} })
    assert.equal(result.ok, false)
  }
  assert.equal(calls.length, 0)
  for (const raw of [
    "[]",
    '{"id":"a","cmd":"agents_list","args":[]}',
    '{"id":"a","cmd":"agents_list","args":null}',
    '{"token":"private-token"',
  ]) {
    const parsed = parseBridgeRequest(raw)
    assert.ok("error" in parsed)
    assert.ok(!JSON.stringify(parsed).includes("private-token"))
  }
})

test("native mutations share lifetime tracking, keep one project binding, and release tracking on failure", async () => {
  const calls: Array<{ name: string; args: unknown }> = []
  const deps = bridgeFixture(calls)
  let active = 0,
    tracked = 0,
    bindings = 0
  deps.withMutation = async (fn) => {
    active++
    tracked++
    try {
      return await fn()
    } finally {
      active--
    }
  }
  deps.normalizeResult = (result) => {
    assert.equal(active, 1)
    return result
  }
  deps.getCoreDeps = () => {
    bindings++
    return deps
  }
  deps.guiWrites.sessionCreate = async () => {
    assert.equal(active, 1, "HTTP project switching must see native mutation pending")
    return { ok: true, message: "created in bound project" }
  }
  assert.equal((await dispatchBridgeCommand(deps, { id: "success", cmd: "session_create", args: {} })).ok, true)
  assert.equal(active, 0)
  assert.equal(bindings, 1, "project dependencies must not be rebound after await")
  deps.guiWrites.sessionCreate = async () => {
    throw new Error("execution failed")
  }
  await assert.rejects(
    dispatchBridgeCommand(deps, { id: "failure", cmd: "session_create", args: {} }),
    /execution failed/,
  )
  assert.equal(active, 0)
  assert.equal(tracked, 2)
  deps.normalizeResult = (result) => result
  await dispatchBridgeCommand(deps, { id: "read", cmd: "agents_list", args: {} })
  assert.equal(tracked, 2, "reads must not consume mutation ownership")
})

test("bridge preserves real outcome and correlation fields and redacts dispatch exceptions", async () => {
  const calls: Array<{ name: string; args: unknown }> = []
  const written: string[] = []
  const errors: string[] = []
  const deps = bridgeFixture(calls, written, errors)
  deps.guiWrites.agentCreate = async () => {
    throw new Error("provider password=private-token")
  }
  await runBridge(
    deps,
    Readable.from([
      '{"hello_ok":true}\n',
      '{"id":"save-1","cmd":"session_save","args":{"name":"feature"}}\n',
      '{"id":"create-1","cmd":"agent_create","args":{"token":"private-token"}}\n',
    ]),
  )
  const saved = JSON.parse(written[1]!) as Record<string, unknown>
  assert.equal(saved["message"], "session_save: persisted outcome")
  assert.equal(saved["request_id"], "save-1")
  assert.equal(saved["operation"], "session_save")
  const failed = JSON.parse(written[2]!) as Record<string, unknown>
  assert.equal(failed["ok"], false)
  assert.equal(failed["code"], "failed")
  assert.equal(failed["request_id"], "create-1")
  assert.ok(!written.join("\n").includes("private-token"))
  assert.ok(!errors.join("\n").includes("private-token"))
})

test("bridge bounds incomplete input, discards oversized frames, and recovers at the next frame", async () => {
  const frames = []
  for await (const frame of boundedBridgeLines(
    Readable.from(["x".repeat(BRIDGE_MAX_LINE_CHARS), 'overflow\n{"valid":true}\npartial']),
  ))
    frames.push(frame)
  assert.deepEqual(frames, [{ error: "oversized" }, { line: '{"valid":true}' }, { error: "partial" }])
  const written: string[] = []
  const calls: Array<{ name: string; args: unknown }> = []
  await runBridge(
    bridgeFixture(calls, written),
    Readable.from(['{"hello_ok":true}\n', '{"id":"partial","cmd":"session_delete","args":{"name":"feature"}}']),
  )
  assert.equal(calls.length, 0, "EOF before newline must not execute a mutation")
  assert.match(written.at(-1)!, /not executed/)
})

function sidecarReady(): boolean {
  return process.platform === "win32" && existsSync(SIDECAR)
}

interface LineReader {
  nextLine(timeoutMs: number): Promise<string>
  close(): void
}

function lineReader(child: ChildProcess): LineReader {
  let buffer = ""
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = []
  const onData = (chunk: Buffer | string): void => {
    buffer += String(chunk)
    let index = buffer.indexOf("\n")
    while (index >= 0 && waiters.length > 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      const waiter = waiters.shift()
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve(line)
      }
      index = buffer.indexOf("\n")
    }
  }
  child.stdout?.on("data", onData)
  return {
    nextLine: (timeoutMs: number) =>
      new Promise<string>((resolve, reject) => {
        const newline = buffer.indexOf("\n")
        if (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "")
          buffer = buffer.slice(newline + 1)
          resolve(line)
          return
        }
        const timer = setTimeout(() => {
          const at = waiters.findIndex((w) => w.timer === timer)
          if (at >= 0) waiters.splice(at, 1)
          reject(new Error(`timed out after ${timeoutMs}ms waiting for a sidecar line`))
        }, timeoutMs)
        timer.unref?.()
        waiters.push({ resolve, reject, timer })
      }),
    close: () => {
      child.stdout?.off("data", onData)
    },
  }
}

test("bridge probe: packaged sidecar handshakes, acks, and serves runtimes_list", async (t) => {
  if (!sidecarReady()) {
    t.skip("packaged Windows sidecar absent (or non-Windows platform)")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "oc-bridge-probe-"))
  const child = spawn(SIDECAR, ["bridge", "--port", "4919", "--project", dir], { stdio: ["pipe", "pipe", "pipe"] })
  const reader = lineReader(child)
  try {
    const helloRaw = await reader.nextLine(30_000)
    const hello = JSON.parse(helloRaw) as Record<string, unknown>
    assert.equal(hello["hello"], "opencomms-coordinator", "handshake identity")
    assert.equal(hello["protocol"], 1, "handshake protocol version")
    assert.ok(typeof hello["version"] === "string" && hello["version"], "handshake carries a version")
    const api = hello["api"]
    assert.ok(Array.isArray(api), "handshake announces the api surface")
    assert.deepEqual(
      [...api].sort(),
      [...BRIDGE_COMMANDS].sort(),
      "packaged sidecar matches the current named IPC contract",
    )
    assert.ok(api.includes("runtimes_list"), "stale-binary regression: handshake must announce runtimes_list")
    assert.ok(api.includes("integrations_list"), "handshake must announce integrations_list")

    child.stdin?.write(JSON.stringify({ hello_ok: true }) + "\n")
    const send = async (id: string, cmd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      child.stdin?.write(JSON.stringify({ id, cmd, args }) + "\n")
      const raw = await reader.nextLine(30_000)
      return JSON.parse(raw) as Record<string, unknown>
    }

    const nodes = await send("t1", "nodes_list", {})
    assert.equal(nodes["id"], "t1")
    assert.equal(nodes["ok"], true, `nodes_list must succeed: ${JSON.stringify(nodes).slice(0, 300)}`)
    const nodeList = (nodes["data"] as { nodes?: Array<{ id?: unknown; kind?: unknown }> } | null)?.nodes ?? []
    const local = nodeList.find((n) => n.kind === "local" && typeof n.id === "string")
    assert.ok(local?.id, "nodes_list must include the local node")

    const runtimes = await send("t2", "runtimes_list", { node_id: local?.id })
    assert.equal(runtimes["id"], "t2")
    assert.equal(runtimes["request_id"], "t2", "response retains originating correlation")
    assert.equal(runtimes["operation"], "runtimes_list")
    assert.equal(typeof runtimes["ok"], "boolean", "catalog discovery reports an actual outcome")
    const message = String(runtimes["message"] ?? "")
    assert.doesNotMatch(message, /unknown.command|unsupported command|missing IPC|handshake|protocol mismatch/i)
    if (runtimes["ok"] === true) {
      assert.ok(Array.isArray(runtimes["data"]), "successful discovery reports its runtime catalog")
    } else {
      const error = runtimes["error"] as { state?: unknown; recovery?: unknown } | undefined
      const allowed = ["not_configured", "unsupported", "temporarily_unavailable"]
      assert.ok(
        allowed.includes(String(runtimes["code"] ?? error?.state)),
        "failure must explicitly name unavailable capability",
      )
      assert.ok(
        allowed.includes(String(error?.state)),
        "error state must preserve the actionable capability classification",
      )
      assert.ok(message.trim().length > 10, "unavailable host needs an actionable explanation")
      assert.ok(
        typeof error?.recovery === "string" && error.recovery.length > 0,
        "unavailable host needs recovery guidance",
      )
    }
  } finally {
    reader.close()
    try {
      child.stdin?.end()
    } catch {
      /* best effort */
    }
    child.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000)
      timer.unref?.()
      child.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
    rmSync(dir, { recursive: true, force: true })
  }
})
