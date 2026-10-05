/** Managed-only queue delivery; linked host processes retain their own delivery controller. */
import { commitDelivery, drainQueue, formatUntrustedMessage, requeueFailedDelivery } from "../core/engine.js"
import type { StateStore } from "../core/store.js"
import type { OrchestratorStore, AgentRecord } from "./state.js"
import type { AgentRuntime } from "./runtime.js"

export interface ManagedDeliveryDeps {
  store: StateStore
  orchestrator: OrchestratorStore
  runtime: (agent: AgentRecord) => AgentRuntime
  changed: () => void
  /** The owner supplies actual runtime credentials; never persist raw host diagnostics. */
  redact?: (detail: string) => string
}

export function createManagedDelivery(deps: ManagedDeliveryDeps): { tick(): Promise<void>; close(): void } {
  let stopped = false
  let running = false
  return {
    close() {
      stopped = true
    },
    async tick() {
      if (stopped || running) return
      running = true
      try {
        // Bound concurrency to one accepted batch per tick. No automatic replay of uncertain prompts.
        for (const agent of deps.orchestrator.load().agents) {
          if (stopped) break
          if (
            !agent.host_session_id ||
            agent.node_id !== deps.orchestrator.load().local_node_id ||
            agent.status === "stopped" ||
            agent.status === "failed"
          )
            continue
          const endpoint = agent.host_session_id
          const runtime = deps.runtime(agent)
          const resumed = await runtime.resume(agent).catch((error: unknown) => ({
            ok: false as const,
            message: error instanceof Error ? error.message : "Host connection failed; reconnect the managed session.",
          }))
          const observed = resumed.ok
            ? await resumed.handle.status().catch((error: unknown) => ({
                status: "stale" as const,
                detail:
                  error instanceof Error ? error.message : "Host status unavailable; reconnect the managed session.",
              }))
            : { status: "stale" as const, detail: resumed.message }
          const detail = observed.detail
            ? (deps.redact
                ? deps.redact(observed.detail)
                : observed.detail
                    .replace(/(Bearer|Basic)\s+[A-Za-z0-9+/=_-]+/gi, "$1 [REDACTED]")
                    .replace(/((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
              ).slice(0, 2_000)
            : null
          let statusChanged = false
          await deps.orchestrator.withLock(() => {
            const state = deps.orchestrator.load()
            const fresh = state.agents.find((a) => a.id === agent.id)
            if (
              fresh &&
              fresh.host_session_id === endpoint &&
              fresh.status !== "stopped" &&
              fresh.status !== "failed"
            ) {
              statusChanged = fresh.status !== observed.status || (fresh.status_detail ?? null) !== detail
              fresh.status = observed.status
              fresh.status_detail = detail
              if (observed.status !== "stale") fresh.last_heartbeat = Date.now()
              deps.orchestrator.save(state)
            }
          })
          if (statusChanged) deps.changed()
          if (!resumed.ok || observed.status !== "idle" || stopped) continue
          let queueChanged = false
          const batch = await deps.store.withLock(() => {
            const state = deps.store.load()
            const latest = deps.orchestrator.load().agents.find((a) => a.id === agent.id)
            if (stopped || !latest || latest.status !== "idle" || latest.host_session_id !== endpoint) return []
            // Any prior in-flight prompt is uncertain after restart. Keep it visible for operator reconciliation.
            if (
              Object.values(state.messages).some(
                (m) => m.recipient_session_id === endpoint && m.delivery_status === "in_flight",
              )
            )
              return []
            const queueSnapshot = () =>
              JSON.stringify((state.queues[endpoint] ?? []).map((id) => [id, state.messages[id]?.delivery_status]))
            const before = queueSnapshot()
            const drained = drainQueue(state, endpoint, {
              canDeliver: (msg) =>
                Object.values(state.channels).some(
                  (c) =>
                    c.id === msg.channel_id &&
                    c.members.some(
                      (m) => m.session_id === endpoint && m.surface === "api" && m.delivery_mode === "pull",
                    ),
                ),
            })
            queueChanged = before !== queueSnapshot()
            if (drained.length || queueChanged) deps.store.save(state)
            return drained.map((message) => ({
              message,
              name: Object.values(state.channels).find((c) => c.id === message.channel_id)?.name ?? "unknown",
            }))
          })
          if (queueChanged && !batch.length) deps.changed()
          if (!batch.length) continue
          if (stopped) {
            await deps.store.withLock(() => {
              const state = deps.store.load()
              requeueFailedDelivery(
                state,
                endpoint,
                batch.map((b) => b.message.message_id),
              )
              deps.store.save(state)
            })
            break
          }
          let outcome: "delivered" | "failed" | "uncertain" = "uncertain"
          try {
            outcome = await resumed.handle.deliver(
              batch.map((b) => formatUntrustedMessage(b.message, b.name)).join("\n\n"),
            )
          } catch {
            /* outcome remains uncertain */
          }
          await deps.store.withLock(() => {
            const state = deps.store.load()
            const ids = batch.map((b) => b.message.message_id)
            if (outcome === "delivered") commitDelivery(state, endpoint, ids)
            else if (outcome === "failed") requeueFailedDelivery(state, endpoint, ids)
            if (outcome === "uncertain") {
              state.errors.push({
                at: Date.now(),
                message: `Managed prompt outcome uncertain for ${endpoint}; inspect host messages before replay. Messages: ${ids.join(", ")}`,
              })
              state.errors = state.errors.slice(-200)
            }
            deps.store.save(state)
          })
          deps.changed()
          break
        }
      } finally {
        running = false
      }
    },
  }
}
