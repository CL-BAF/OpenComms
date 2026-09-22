import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore, emptyState } from "../../src/core/store.js"
import { OrchestratorStore, emptyOrchestratorState } from "../../src/orchestrator/state.js"

const stores = [
  {
    name: "StateStore",
    create(dir: string) {
      const store = new StateStore(dir)
      return {
        file: store.file,
        dir: store.dir,
        save(revision: number) {
          const state = { ...emptyState(), revision }
          store.save(state)
        },
      }
    },
  },
  {
    name: "OrchestratorStore",
    create(dir: string) {
      const store = new OrchestratorStore(dir)
      return {
        file: store.file,
        dir: store.dir,
        save(revision: number) {
          const state = { ...emptyOrchestratorState(dir), revision }
          store.save(state)
        },
      }
    },
  },
]

for (const fixture of stores) {
  for (const succeeds of [true, false]) {
    test(`${fixture.name}: rename ${succeeds ? "retry succeeds" : "failure preserves previous state"}`, (t) => {
      const dir = fs.mkdtempSync(join(tmpdir(), "opencomms-atomic-"))
      try {
        const store = fixture.create(dir)
        store.save(1)
        const previous = fs.readFileSync(store.file, "utf8")
        const rename = fs.renameSync
        const error = Object.assign(new Error("replacement denied"), { code: "EPERM" })
        let attempts = 0
        t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
          attempts++
          if (succeeds && attempts === 2) return rename(from, to)
          throw error
        })
        syncBuiltinESMExports()
        if (succeeds) {
          store.save(2)
          assert.equal(JSON.parse(fs.readFileSync(store.file, "utf8")).revision, 2)
          assert.equal(attempts, 2)
        } else {
          assert.throws(() => store.save(2), /failed to persist/)
          assert.equal(fs.readFileSync(store.file, "utf8"), previous)
          assert.ok(attempts >= 2 && attempts <= 3)
        }
        assert.deepEqual(
          fs.readdirSync(store.dir).filter((name) => name.endsWith(".tmp")),
          [],
        )
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
}
for (const fixture of stores) {
  test(`${fixture.name}: partial temporary write is cleaned up without touching state`, (t) => {
    const dir = fs.mkdtempSync(join(tmpdir(), "opencomms-atomic-"))
    try {
      const store = fixture.create(dir)
      store.save(1)
      const previous = fs.readFileSync(store.file, "utf8")
      const write = fs.writeFileSync
      const error = Object.assign(new Error("disk full"), { code: "ENOSPC" })
      t.mock.method(fs, "writeFileSync", (file: fs.PathOrFileDescriptor) => {
        write(file, "partial")
        throw error
      })
      const rename = t.mock.method(fs, "renameSync")
      syncBuiltinESMExports()
      assert.throws(
        () => store.save(2),
        (caught: unknown) => {
          assert.ok(caught instanceof Error)
          assert.match(caught.message, /failed to persist/)
          assert.equal(caught.cause, error)
          return true
        },
      )
      assert.equal(rename.mock.callCount(), 0)
      assert.equal(fs.readFileSync(store.file, "utf8"), previous)
      assert.deepEqual(
        fs.readdirSync(store.dir).filter((name) => name.endsWith(".tmp")),
        [],
      )
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
