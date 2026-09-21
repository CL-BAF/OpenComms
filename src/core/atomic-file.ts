import { renameSync, rmSync, writeFileSync } from "node:fs"

/** Keep the last valid file intact if an atomic replacement is unavailable. */
export function replaceStateFile(file: string, temporary: string, payload: string): void {
  try {
    writeFileSync(temporary, payload, { encoding: "utf8", flush: true })
    const pause = new Int32Array(new SharedArrayBuffer(4))
    for (const delay of [0, 50, 100]) {
      // Persistence is synchronous; only this bounded failure path blocks.
      if (delay) Atomics.wait(pause, 0, 0, delay)
      try {
        renameSync(temporary, file)
        return
      } catch (error) {
        if (delay === 100) throw error
      }
    }
  } catch (cause) {
    throw new Error(`OpenComms: failed to persist state at ${file}`, { cause })
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Cleanup is best-effort and must not hide the persistence error.
    }
  }
}
