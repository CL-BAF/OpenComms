import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { StateStore, emptyState } from "../../src/store.js"
import { createChannel } from "../../src/engine.js"

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "opencomms-store-"))
}

test("StateStore persists and reloads state", () => {
  const dir = tmpProject()
  try {
    const store = new StateStore(dir)
    const state = emptyState()
    createChannel(state, {
      channel: "persist",
      role: "Builder",
      role_prompt: "p",
      session_id: "s1",
      project_id: "proj",
      worktree: dir,
    })
    store.save(state)

    const reloaded = new StateStore(dir).load()
    assert.ok(reloaded.channels["persist"])
    assert.equal(reloaded.channels["persist"]!.members[0]!.session_id, "s1")
    assert.equal(reloaded.schema_version, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("StateStore recovers from corrupt state", () => {
  const dir = tmpProject()
  try {
    const store = new StateStore(dir)
    store.save(emptyState())
    // Corrupt the file.
    writeFileSync(store.file, "{not json", "utf8")
    const state = store.load()
    assert.equal(Object.keys(state.channels).length, 0)
    assert.ok(state.errors.length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("StateStore writes atomically (temp file + rename)", () => {
  const dir = tmpProject()
  try {
    const store = new StateStore(dir)
    const state = emptyState()
    store.save(state)
    assert.ok(existsSync(store.file))
    const entries = readFileSync(store.file, "utf8")
    assert.ok(entries.includes('"schema_version"'))
    // No leftover temp files.
    const leftovers = readdirSync(store.dir).filter((f) => f.endsWith(".tmp"))
    assert.equal(leftovers.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Load-time validation (tampered / stale-schema rejection) ──

function seedValidState(dir: string): void {
  const store = new StateStore(dir)
  const state = emptyState()
  createChannel(state, {
    channel: "valid",
    role: "Builder",
    role_prompt: "p",
    session_id: "s1",
    project_id: "proj",
    worktree: dir,
  })
  store.save(state)
}

test("load rejects a wrong schema_version and starts empty", () => {
  const dir = tmpProject()
  try {
    seedValidState(dir)
    const store = new StateStore(dir)
    const raw = JSON.parse(readFileSync(store.file, "utf8"))
    raw.schema_version = 999
    writeFileSync(store.file, JSON.stringify(raw), "utf8")
    const reloaded = store.load()
    assert.equal(Object.keys(reloaded.channels).length, 0)
    assert.ok(reloaded.errors.some((e) => e.message.includes("schema_version mismatch")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("load rejects tampered member rows (bad shape / bad role label)", () => {
  const dir = tmpProject()
  try {
    seedValidState(dir)
    const store = new StateStore(dir)

    const tamper = (mutate: (raw: any) => void): void => {
      const raw = JSON.parse(readFileSync(store.file, "utf8"))
      mutate(raw)
      writeFileSync(store.file, JSON.stringify(raw), "utf8")
      const state = store.load()
      assert.equal(Object.keys(state.channels).length, 0)
      assert.ok(state.errors.length >= 1)
      // Restore pristine state for the next mutation.
      seedValidState(dir)
    }

    tamper((raw) => {
      raw.channels.valid.members[0].role_prompt = { injected: true }
    })
    tamper((raw) => {
      raw.channels.valid.members[0].role = "-not a valid role!"
    })
    tamper((raw) => {
      raw.channels.valid.members.push({ hello: "world" })
    })
    tamper((raw) => {
      raw.messages = "not-an-object"
    })
    tamper((raw) => {
      raw.queues["s1"] = "not-an-array"
    })

    // Key/name mismatch (aliasing attempt): entry stored under "valid" whose
    // internal name claims to be "other".
    tamper((raw) => {
      raw.channels.valid.name = "other"
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("load backfills max_members and migrates legacy role-keyed timers", () => {
  const dir = tmpProject()
  try {
    seedValidState(dir)
    const store = new StateStore(dir)
    const raw = JSON.parse(readFileSync(store.file, "utf8"))
    const ch = raw.channels.valid
    delete ch.max_members
    ch.timer = {
      active_role: "Builder",
      segment_started_at: 123,
      elapsed_ms: { Builder: 4_000 },
      limit_ms: null,
      limit_role: null,
    }
    writeFileSync(store.file, JSON.stringify(raw), "utf8")

    const state = store.load()
    assert.equal(Object.keys(state.channels).length, 1)
    const migrated = state.channels["valid"]!
    assert.equal(migrated.max_members >= 2, true)
    assert.equal(migrated.timer.active_member_id, "s1")
    assert.ok((migrated.timer.elapsed_ms["s1"] ?? 0) >= 4_000)

    // Out-of-range persisted caps are clamped back into sane bounds.
    const clampDir = join(dir, "clamp")
    seedValidState(clampDir)
    const store2 = new StateStore(clampDir)
    const raw2 = JSON.parse(readFileSync(store2.file, "utf8"))
    raw2.channels.valid.max_members = 500
    writeFileSync(store2.file, JSON.stringify(raw2), "utf8")
    const clamped = store2.load().channels["valid"]!.max_members
    assert.equal(clamped >= 2 && clamped <= 8, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Cross-process locking (lost-update prevention) ──

test("withLock serializes concurrent processes: no lost updates under contention", async () => {
  const dir = tmpProject()
  try {
    seedValidState(dir)
    const workerSrc = `
import { StateStore } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist-test", "src", "store.js")).href)}
const store = new StateStore(process.argv[2])
for (let i = 0; i < 25; i++) {
  store.update((state) => {
    const q = state.queues["shared"] ?? []
    q.push("m" + process.pid + ":" + i)
    state.queues["shared"] = q
  })
}
`
    const workerPath = join(dir, "worker.mjs")
    writeFileSync(workerPath, workerSrc, "utf8")

    const spawnWorker = (): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [workerPath, dir], { cwd: process.cwd() })
        let stderr = ""
        child.stderr.on("data", (d) => (stderr += String(d)))
        child.on("close", (code) => resolve({ code, stderr }))
      })

    // Start both workers simultaneously so they contend for the lock.
    const [w1, w2] = await Promise.all([spawnWorker(), spawnWorker()])
    assert.equal(w1.code, 0, `worker1 failed: ${w1.stderr}`)
    assert.equal(w2.code, 0, `worker2 failed: ${w2.stderr}`)

    const final = new StateStore(dir).load()
    assert.equal(final.queues["shared"]!.length, 50, "interleaved writes lost updates")
    assert.ok(!existsSync(join(dir, ".opencode-comms", ".state.lock")), "lock file leaked")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
