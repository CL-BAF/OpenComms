import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDaemon, type DaemonRunDeps } from "../../../src/cli/daemon.js"

interface FakeClientState {
  connected: boolean
  heartbeats: number
  acked: number[]
  deliverHandler: ((framed: string, seq: number) => void) | null
  closed: boolean
}

function fakeClient(state: FakeClientState) {
  return {
    async connect() {
      state.connected = true
    },
    onDeliver(handler: (framed: string, seq: number) => void) {
      state.deliverHandler = handler
    },
    ack(seq: number) {
      state.acked.push(seq)
    },
    async heartbeat() {
      state.heartbeats++
    },
    async close() {
      state.closed = true
    },
  }
}

function enrollProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocm-daemon-"))
  const identityDir = join(dir, ".opencomms", "node-identity")
  mkdirSync(identityDir, { recursive: true })
  writeFileSync(
    join(identityDir, "node-identity.json"),
    JSON.stringify({ node_id: "node_abc", ca_fingerprint: "ff".repeat(32) }),
    "utf8",
  )
  writeFileSync(
    join(identityDir, "node-keypair.json"),
    JSON.stringify({
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----",
    }),
    "utf8",
  )
  return dir
}

test("daemon run: refuses non-wss coordinator base (exit 2)", async () => {
  const dir = enrollProject()
  try {
    const result = await runDaemon(["--wss", "http://insecure.example"], {
      projectDir: dir,
      coordinatorWssBase: undefined,
      createClient: undefined,
    })
    assert.equal(result.code, 2)
    assert.match(result.output, /wss:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("daemon run: refuses without an enrolled identity (exit 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocm-daemon-noempty-"))
  try {
    const result = await runDaemon(["--wss", "wss://coord.example"], {
      projectDir: dir,
      createClient: () => {
        throw new Error("should never be constructed without identity")
      },
    })
    assert.equal(result.code, 2)
    assert.match(result.output, /daemon enroll/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("daemon run: watchdog READY after connect + first heartbeat (P2-B-3)", async () => {
  const dir = enrollProject()
  const notifications: string[] = []
  const state: FakeClientState = { connected: false, heartbeats: 0, acked: [], deliverHandler: null, closed: false }
  const stopHooked: Array<() => void> = []
  try {
    const promise = runDaemon(["--wss", "wss://coord.example"], {
      projectDir: dir,
      createClient: () => fakeClient(state),
      heartbeatIntervalMs: 5,
      stopHook: (stop) => {
        stopHooked.push(stop)
      },
    })
    // Give the loop one tick to dial + heartbeat + notifyReady.
    await new Promise((r) => setTimeout(r, 60))
    // Drive the loop to exit via the stop hook (SIGTERM self-kill is
    // unreliable inside node:test on Windows — Windows emulates SIGTERM
    // as TerminateProcess; the flag-based hook is the portable path).
    stopHooked[0]?.()
    const result = await promise
    assert.equal(result.code, 0, result.output)
    assert.equal(state.connected, true)
    assert.ok(state.heartbeats >= 1)
    void notifications
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("daemon run: ack-after-deliver with cursor dedup (P2-B-4 / P2-A)", async () => {
  const dir = enrollProject()
  const state: FakeClientState = { connected: false, heartbeats: 0, acked: [], deliverHandler: null, closed: false }
  const stopHooked: Array<() => void> = []
  try {
    const promise = runDaemon(["--wss", "wss://coord.example"], {
      projectDir: dir,
      createClient: () => ({
        async connect() {
          state.connected = true
        },
        onDeliver(handler: (framed: string, seq: number) => void) {
          state.deliverHandler = handler
        },
        ack(seq: number) {
          state.acked.push(seq)
        },
        async heartbeat() {
          state.heartbeats++
        },
        async close() {
          state.closed = true
        },
      }),
      heartbeatIntervalMs: 5,
      stopHook: (stop) => {
        stopHooked.push(stop)
      },
    })
    // Wait for onDeliver registration, then simulate the coordinator
    // delivering: fresh envelope (seq 3) → ack; duplicate (seq 2 ≤ 3? no —
    // cursor is 3 after the first ack) → dedup, NO second ack; lower seq 1 →
    // dedup; higher (seq 7) → ack.
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(state.deliverHandler, "onDeliver handler was not registered")
    state.deliverHandler?.("framed-3", 3)
    await new Promise((r) => setTimeout(r, 20))
    state.deliverHandler?.("framed-3-redelivery", 3)
    await new Promise((r) => setTimeout(r, 20))
    state.deliverHandler?.("framed-2-old", 2)
    await new Promise((r) => setTimeout(r, 20))
    state.deliverHandler?.("framed-7-new", 7)
    await new Promise((r) => setTimeout(r, 20))
    // Cursor dedup: seq 3 acked once, seq 2 deduped, seq 7 acked.
    assert.deepEqual(state.acked, [3, 7])
    stopHooked[0]?.()
    const result = await promise
    assert.equal(result.code, 0, result.output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("daemon run: watchdog stops on failure (P2-B-5)", async () => {
  const dir = enrollProject()
  try {
    const result = await runDaemon(["--wss", "wss://coord.example"], {
      projectDir: dir,
      createClient: () => ({
        async connect() {
          throw new Error("dial refused")
        },
        onDeliver() {},
        ack() {},
        async heartbeat() {},
        async close() {},
      }),
    })
    assert.equal(result.code, 1)
    assert.match(result.output, /daemon run failed: dial refused/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("daemon run: cursor dedup via Backend's dedupeForNode (P2-A)", async () => {
  const dir = enrollProject()
  const state: FakeClientState = { connected: false, heartbeats: 0, acked: [], deliverHandler: null, closed: false }
  const stopHooked: Array<() => void> = []
  try {
    const promise = runDaemon(["--wss", "wss://coord.example"], {
      projectDir: dir,
      createClient: () => fakeClient(state),
      heartbeatIntervalMs: 5,
      stopHook: (stop) => {
        stopHooked.push(stop)
      },
    })
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(state.deliverHandler, "onDeliver handler was not registered")
    state.deliverHandler?.("framed-3", 3)
    await new Promise((r) => setTimeout(r, 20))
    state.deliverHandler?.("framed-3-redelivery", 3)
    await new Promise((r) => setTimeout(r, 20))
    state.deliverHandler?.("framed-2-old", 2)
    await new Promise((r) => setTimeout(r, 20))
    state.deliverHandler?.("framed-7-new", 7)
    await new Promise((r) => setTimeout(r, 20))
    // Backend's dedupeForNode drops seq <= acked cursor: 3 acked once,
    // redelivery + stale 2 dropped, 7 acked.
    assert.deepEqual(state.acked, [3, 7])
    const stop0 = stopHooked[0]
    assert.ok(stop0, "stopHook was not invoked after dial")
    stop0()
    const result = await promise
    assert.equal(result.code, 0, result.output)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("daemon run: stopHook exits the loop cleanly (P2-B signal path)", async () => {
  const dir = enrollProject()
  const stopHooked: Array<() => void> = []
  const state: FakeClientState = { connected: false, heartbeats: 0, acked: [], deliverHandler: null, closed: false }
  try {
    const promise = runDaemon(["--wss", "wss://coord.example"], {
      projectDir: dir,
      createClient: () => fakeClient(state),
      heartbeatIntervalMs: 5,
      stopHook: (stop) => {
        stopHooked.push(stop)
      },
    })
    await new Promise((r) => setTimeout(r, 60))
    const stop1 = stopHooked[0]
    assert.ok(stop1, "stopHook was not invoked after dial")
    stop1()
    const result = await promise
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /daemon loop ended/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
