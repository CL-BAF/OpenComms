/**
 * Orchestration event feed (M1 scope: kind "orchestration"; M2 adds
 * "channel_notice" + task_id + additive SSE topics — contract v0.3 §9).
 *
 * Events live in the orchestrator state ring (capped). The API layer
 * exposes `GET /api/orchestrator/events?since=` (cursor pagination) and
 * broadcasts an additive `orchestrator` SSE topic on the EXISTING
 * /api/events stream (generic refresh stays unchanged).
 *
 * Persistence happens via `mutate` (locked update that appends the event);
 * broadcast happens AFTER persistence succeeds, so a crashed write never
 * announces an event that was not stored.
 */

import type { OrchestratorState, OrchestrationEvent, OrchestrationEventKind } from "./state.js"
import { pushEvent } from "./state.js"

/** Event type literals for the orchestration kind (open set, additive). */
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
  /** Emit an orchestration event: persisted (locked) + broadcast. */
  emit(event: EmitInput): void
}

/**
 * Create the feed. `mutate` runs a locked orchestrator-state update; the
 * returned state (post-mutation) provides the appended event's seq for the
 * broadcast payload. Client callbacks must never throw across the ring.
 */
export function createOrchestratorFeed(
  mutate: (fn: (state: OrchestratorState) => number) => Promise<number>,
): OrchestratorFeed {
  const clients = new Set<(topic: string, data: unknown) => void>()
  return {
    emit(event) {
      void (async () => {
        const kind: OrchestrationEventKind = event.kind ?? "orchestration"
        const seq = await mutate((state) => {
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
        for (const send of clients) {
          try {
            send("orchestrator", { ...event, kind, seq })
          } catch {
            clients.delete(send)
          }
        }
      })()
    },
  }
}

/** Cursor-paginated read (pure; the API layer calls this on a snapshot). */
export function listEvents(state: OrchestratorState, since: number): { events: OrchestrationEvent[]; cursor: number } {
  const events = state.events.filter((e) => e.seq > since)
  const cursor = events.length > 0 ? (events[events.length - 1] as OrchestrationEvent).seq : since
  return { events, cursor }
}
