import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
