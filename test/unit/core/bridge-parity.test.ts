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
 *    runtimes_list returns ok (catalog or honest empty) — never an
 *    unknown-command/handshake error.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BRIDGE_COMMANDS } from "../../../src/orchestrator/bridge.js"

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
    assert.equal(
      runtimes["ok"],
      true,
      `runtimes_list must return ok (catalog or honest empty), never unknown-command: ${JSON.stringify(runtimes).slice(0, 300)}`,
    )
    assert.ok(!String(runtimes["message"] ?? "").includes("unknown command"), "no unknown-command refusal")
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
