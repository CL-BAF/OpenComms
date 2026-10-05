/**
 * Capped, cursor-addressed events. Each append uses the supplied locked mutation.
 */

import type { OrchestratorState, OrchestrationEvent, OrchestrationEventKind } from "./state.js"
import { pushEvent } from "./state.js"

export type OrchestrationEventType =
  | "agent_created"
  | "agent_starting"
  | "agent_running"
  | "agent_idle"
  | "agent_stale"
  | "agent_stopped"
  | "agent_failed"
  | "agent_restarted"
  | "agent_status"
  | "node_added"
  | "node_approved"
  | "node_revoked"
  | "state_rejected"
  | "state_unreadable"
  | (string & {})

export interface EmitInput {
  type: OrchestrationEventType
  message: string
  agent_id?: string | null
  node_id?: string | null
  task_id?: string | null
  kind?: OrchestrationEventKind
}

export interface OrchestratorFeed {
  /** Append through the supplied locked mutation. */
  emit(event: EmitInput): void
}

export function createOrchestratorFeed(
  mutate: (fn: (state: OrchestratorState) => number) => Promise<number>,
): OrchestratorFeed {
  return {
    emit(event) {
      void (async () => {
        const kind: OrchestrationEventKind = event.kind ?? "orchestration"
        await mutate((state) => {
          pushEvent(state, {
            kind,
            type: event.type,
            message: event.message,
            agent_id: event.agent_id ?? null,
            node_id: event.node_id ?? null,
            task_id: event.task_id ?? null,
          })
          const last = state.events[state.events.length - 1]
          return last?.seq ?? 0
        })
      })()
    },
  }
}

export function listEvents(state: OrchestratorState, since: number): { events: OrchestrationEvent[]; cursor: number } {
  const events = state.events.filter((e) => e.seq > since).slice(0, 100)
  const cursor = events.length > 0 ? (events[events.length - 1] as OrchestrationEvent).seq : since
  return { events, cursor }
}
