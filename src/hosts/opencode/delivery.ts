/**
 * OpenCode adapter - owner-aware delivery controller.
 *
 * Extracted from plugin.ts (Reviewer: "avoid giant god files"). Everything
 * here is OpenCode-topology knowledge; the host-neutral core knows none of
 * it. See docs/OPENCODE.md "Topology & autonomy" for the evidence behind
 * the ownership rule.
 *
 * Why ownership matters: every `opencode` TUI / `serve` process runs its own
 * server + plugin instance + event bus, while session DATA is shared. A
 * cross-server `client.session.prompt` RESOLVES but executes the recipient's
 * turn on the WRONG server - the recipient's TUI never renders it and its
 * own bus stays silent. This controller therefore:
 *
 *  1. Learns which sessions are hosted on THIS server (`markLocal`: any
 *     session.* event on this bus, plus the system-prompt transform).
 *  2. Delivers (drain + prompt) ONLY to those local sessions.
 *  3. Wakes on state.json changes (fs.watchFile, `persistent:false` so the
 *     watcher never holds the host event loop) and drains queues that belong
 *     to local sessions - this is how mail queued by ANOTHER process
 *     reaches an idle recipient.
 *  4. Falls back to one cross-server prompt (5s) for PUSH members no
 *     instance owns (their TUI closed everywhere), so mail lands in shared
 *     storage instead of aging out. PULL members are never cross-prompted.
 *
 * Delivery is two-phase (crash-window fix): drain marks envelopes in_flight
 * (persisted BEFORE the prompt), commitDelivery marks delivered only after
 * the host accepted the prompt, and a startup sweep resurrects envelopes
 * stranded by a crash between the two.
 */

import { watchFile, type StatWatcher } from "node:fs"
import type { State } from "../../core/types.js"
import {
  commitDelivery,
  drainForDelivery,
  formatDeliveryBatch,
  pendingRecipients,
  requeueFailedDelivery,
  sweepInFlight,
} from "../../core/engine.js"

/** Delay before the cross-server delivery fallback fires. */
export const CROSS_SERVER_FALLBACK_MS = 5_000
/** Delay before a failed push delivery is retried (transient host errors). */
export const DELIVERY_RETRY_MS = 2_000
/** Debounce for fs-watch wake bursts (atomic saves fire many events). */
const WAKE_DEBOUNCE_MS = 150

/** Minimal shape of the OpenCode SDK client this controller needs. */
export interface DeliveryClient {
  session: {
    prompt(input: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }): Promise<unknown>
  }
}

export interface DeliveryControllerOptions {
  store: {
    dir: string
    file: string
    withLock<T>(fn: () => T): Promise<T>
    save(state: State): void
  }
  /** Lock-free state snapshot reader (atomic saves; no torn reads). */
  load(): State
  client: DeliveryClient
  /** Visible failure recorder (surfaces in opencomms_status errors). */
  recordError(message: string): void
}

export interface DeliveryController {
  /** Register positive evidence that a session is hosted on THIS server. */
  markLocal(sessionId: string | undefined | null): void
  /**
   * Drain the recipient's queue and prompt it once per batch.
   * Non-local recipients are skipped unless allowCrossServer is set.
   */
  deliverPending(sessionId: string, opts?: { allowCrossServer?: boolean }): Promise<void>
  /** Send-side notification: immediate for local recipients, fallback otherwise. */
  notifyRecipient(recipientSessionId: string): void
  /** Startup crash recovery: re-queue envelopes stranded in_flight. */
  startupSweep(): Promise<void>
}

export function createDeliveryController(opts: DeliveryControllerOptions): DeliveryController {
  const { store, client, recordError } = opts
  const load = opts.load

  /** Sessions proven (via bus events / system transform) to be on THIS server. */
  const localSessions = new Set<string>()
  /** Recipients with a prompt call in progress - duplicate-delivery guard. */
  const delivering = new Set<string>()

  const markLocal = (sessionId: string | undefined | null): void => {
    if (sessionId) localSessions.add(sessionId)
    ensureWatcher()
  }

  const deliverPending = async (
    sessionId: string,
    controllerOpts: { allowCrossServer?: boolean } = {},
  ): Promise<void> => {
    // Owner-side gate: without positive evidence that THIS server hosts the
    // recipient, prompting would execute the recipient's turn on the wrong
    // server (their TUI would never render it). The fs-watch wake routes the
    // batch to the owning instance instead; the timed fallback covers
    // recipients whose TUI is gone entirely.
    if (!localSessions.has(sessionId) && !controllerOpts.allowCrossServer) return
    // One prompt in flight per recipient: a second drain must not double-mark
    // envelopes while the first prompt is still undecided.
    if (delivering.has(sessionId)) return
    delivering.add(sessionId)
    try {
      await deliverPendingInner(sessionId, controllerOpts)
    } finally {
      delivering.delete(sessionId)
    }
  }

  const deliverPendingInner = async (
    sessionId: string,
    controllerOpts: { allowCrossServer?: boolean } = {},
  ): Promise<void> => {
    // Phase 1 (locked): atomically drain queues and persist the in_flight
    // marker BEFORE any prompt leaves this process. A crash between here and
    // the prompt is recovered by the startup sweep. Each envelope carries
    // its own channel's name - a session may belong to multiple channels, so
    // provenance is resolved per message, never once for the batch.
    let batch: Array<{ id: string; channelName: string }> = []
    try {
      const drained = await store.withLock(() => {
        const state = load()
        const pairs = drainForDelivery(state, sessionId)
        if (pairs.length > 0) store.save(state)
        return pairs.map((p) => ({ id: p.message_id, channelName: p.channel_name }))
      })
      batch = drained
    } catch (error) {
      recordError(`Delivery drain for ${sessionId} failed: ${(error as Error).message}`)
      return
    }
    if (batch.length === 0) return

    // Phase 2 (unlocked): prompt the peer once per batch. Peer content is
    // framed as untrusted data with per-envelope provenance.
    const ids = batch.map((b) => b.id)
    const text = batch.map((b) => formatOne(b)).join("\n\n---\n\n")

    function formatOne(b: { id: string; channelName: string }): string {
      const snapshot = load()
      const msg = snapshot.messages[b.id]
      if (!msg) return `(OpenComms: message ${b.id} no longer exists)`
      return formatDeliveryBatch([msg], b.channelName)
    }

    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
        },
      })
      // Phase 3 (locked): the HOST accepted the prompt - only now does the
      // envelope become "delivered". A crash before this point is recovered
      // by the startup sweep (at-least-once on the ambiguous window).
      await store.withLock(() => {
        const state2 = load()
        commitDelivery(state2, sessionId, ids)
        store.save(state2)
      })
    } catch (error) {
      // Delivery failed: do NOT leave messages marked in_flight (that would
      // silently drop or wedge them). Rebuild the FIFO in original order,
      // record the failure visibly, and schedule one delayed retry so a
      // transient host error cannot strand the batch until the next idle
      // event. The retry keeps the original allowance: a failed cross-server
      // fallback delivery must not silently strand because of the gate.
      try {
        await store.withLock(() => {
          const state2 = load()
          requeueFailedDelivery(state2, sessionId, ids)
          state2.errors.push({
            at: Date.now(),
            message: `Delivery to session ${sessionId} failed (${(error as Error).message}); ${ids.length} message(s) re-queued for retry.`,
          })
          if (state2.errors.length > 200) state2.errors = state2.errors.slice(-200)
          store.save(state2)
        })
        const t = setTimeout(() => void deliverPending(sessionId, controllerOpts), DELIVERY_RETRY_MS)
        t.unref?.()
      } catch (lockError) {
        recordError(`Requeue after failed delivery to ${sessionId} also failed: ${(lockError as Error).message}`)
      }
    }
  }

  const notifyRecipient = (recipientSessionId: string): void => {
    if (localSessions.has(recipientSessionId)) {
      void deliverPending(recipientSessionId)
      return
    }
    const t = setTimeout(() => {
      void (async () => {
        // Skip the fallback for PULL members (they drain via their own tools).
        // PUSH members were registered by an opencode plugin instance (this
        // adapter) - including legacy rows whose host label predates the
        // host stamp - so they are cross-promptable when ownerless.
        let mayFallback = false
        try {
          await store.withLock(() => {
            const state = load()
            for (const channel of Object.values(state.channels)) {
              const member = channel.members.find((m) => m.session_id === recipientSessionId)
              if (member && member.delivery_mode === "push") mayFallback = true
            }
            return null
          })
        } catch {
          mayFallback = false
        }
        if (mayFallback) await deliverPending(recipientSessionId, { allowCrossServer: true })
      })()
    }, CROSS_SERVER_FALLBACK_MS)
    t.unref?.()
  }

  // fs-watch wake: any state.json change may have queued mail for a session
  // hosted on THIS server (another process's send cannot reach this bus).
  // fs.watchFile with persistent:false never holds the host event loop open
  // (fs.watch on Windows cannot be fully unref'd) and is immune to the
  // atomic-rename inode churn that can silence directory watchers.
  let wakeTimer: NodeJS.Timeout | null = null
  let statWatcher: StatWatcher | null = null
  const onWake = (): void => {
    if (wakeTimer) return
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      try {
        const state = load()
        for (const rid of pendingRecipients(state)) {
          if (localSessions.has(rid)) void deliverPending(rid)
        }
      } catch (error) {
        recordError(`fs-watch wake failed: ${(error as Error).message}`)
      }
    }, WAKE_DEBOUNCE_MS)
    wakeTimer.unref?.()
  }
  const ensureWatcher = (): void => {
    if (statWatcher) return
    statWatcher = watchFile(store.file, { interval: 500, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) onWake()
    })
  }
  ensureWatcher()

  const startupSweep = async (): Promise<void> => {
    const swept = await store.withLock(() => {
      const state = load()
      const ids = sweepInFlight(state)
      if (ids.length > 0) store.save(state)
      return ids
    })
    if (swept.length > 0)
      recordError(`Startup sweep re-queued ${swept.length} in-flight message(s) from a previous process.`)
  }

  return { markLocal, deliverPending, notifyRecipient, startupSweep }
}
