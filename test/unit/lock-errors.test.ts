import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StateStore } from "../../src/core/store.js"
import { OrchestratorStore } from "../../src/orchestrator/state.js"

for (const Store of [StateStore, OrchestratorStore]) {
  for (const code of ["EACCES", "EROFS", "EMFILE"]) {
    test(`${Store.name} immediately preserves ${code} from lock creation`, async (t) => {
      const dir = fs.mkdtempSync(join(tmpdir(), "opencomms-lock-error-"))
      const error = Object.assign(new Error(`${code}: cannot create lock`), { code })
      let attempts = 0
      let called = false
      t.mock.method(fs, "openSync", () => {
        attempts++
        throw error
      })
      syncBuiltinESMExports()
      try {
        await assert.rejects(
          new Store(dir).withLock(() => {
            called = true
          }),
          (err) => err === error,
        )
        assert.equal(attempts, 1)
        assert.equal(called, false)
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test(`${Store.name} retries EEXIST and releases the acquired lock`, async (t) => {
    const dir = fs.mkdtempSync(join(tmpdir(), "opencomms-lock-retry-"))
    const originalOpen = fs.openSync
    let attempts = 0
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (++attempts === 1) throw Object.assign(new Error("already exists"), { code: "EEXIST" })
      return originalOpen(...args)
    })
    syncBuiltinESMExports()
    try {
      const store = new Store(dir)
      assert.equal(await store.withLock(() => "acquired"), "acquired")
      assert.equal(attempts, 2)
      assert.deepEqual(
        fs.readdirSync(store.dir).filter((name) => name.endsWith(".lock")),
        [],
      )
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
