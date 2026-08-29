import type { State } from "../core/types.js"

/** Minimal store surface the MCP layer needs (StateStore satisfies this). */
export interface McpStore {
  load(): State
  withLock<T>(fn: () => T): Promise<T>
  save(state: State): void
}
