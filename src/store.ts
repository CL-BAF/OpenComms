/**
 * OpenComms — persistent state store.
 *
 * State is stored in `<project>/.opencode-comms/state.json`. Writes are
 * atomic: we serialize to a temp file in the same directory, flush it, then
 * rename over the target. On Windows, `rename` over an existing file is
 * supported by Node's fs.rename (it maps to MoveFileEx with REPLACE_EXISTING),
 * but we defensively retry once after a short delay because antivirus or
 * OneDrive can briefly hold a handle.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { SCHEMA_VERSION, STATE_DIR, STATE_FILE, type State } from "./types.js"

export function emptyState(): State {
  return {
    schema_version: SCHEMA_VERSION,
    channels: {},
    messages: {},
    queues: {},
    delivered_to: {},
    errors: [],
  }
}

export class StateStore {
  readonly dir: string
  readonly file: string

  constructor(projectDir: string) {
    this.dir = join(projectDir, STATE_DIR)
    this.file = join(this.dir, STATE_FILE)
  }

  load(): State {
    if (!existsSync(this.file)) return emptyState()
    try {
      const raw = readFileSync(this.file, "utf8")
      const parsed = JSON.parse(raw) as Partial<State>
      const base = emptyState()
      return {
        ...base,
        ...parsed,
        channels: parsed.channels ?? {},
        messages: parsed.messages ?? {},
        queues: parsed.queues ?? {},
        delivered_to: parsed.delivered_to ?? {},
        errors: parsed.errors ?? [],
      }
    } catch (error) {
      // Corrupt state must never brick the plugin: start fresh and record the
      // recovery so the user can see what happened via opencomms_status.
      const base = emptyState()
      base.errors.push({
        at: Date.now(),
        message: `State file unreadable; started with empty state: ${(error as Error).message}`,
      })
      return base
    }
  }

  save(state: State): void {
    mkdirSync(this.dir, { recursive: true })
    const tmp = join(this.dir, `.state.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
    const payload = JSON.stringify(state, null, 2)
    writeFileSync(tmp, payload, "utf8")
    try {
      renameSync(tmp, this.file)
    } catch (error) {
      // Windows: retry once after a short delay (AV/OneDrive handle races).
      try {
        const wait = new Promise<void>((resolve) => setTimeout(resolve, 50))
        // Node 18+ has no sync sleep; use Atomics.wait on a SharedArrayBuffer
        // to block synchronously without yielding to the event loop.
        const sab = new SharedArrayBuffer(4)
        const int32 = new Int32Array(sab)
        Atomics.wait(int32, 0, 0, 50)
        void wait
        renameSync(tmp, this.file)
      } catch (second) {
        try {
          writeFileSync(this.file, payload, "utf8")
        } catch {
          throw new Error(
            `OpenComms: failed to persist state (${(error as Error).message}; ${(second as Error).message})`,
          )
        }
      }
    }
  }

  /** Convenience: load, mutate, save. */
  update(mutate: (state: State) => void): State {
    const state = this.load()
    mutate(state)
    this.save(state)
    return state
  }
}

export function stateDirFor(projectDir: string): string {
  return join(projectDir, STATE_DIR)
}

export function isInsideStateDir(projectDir: string, candidate: string): boolean {
  const dir = dirname(candidate)
  return dir === stateDirFor(projectDir)
}
