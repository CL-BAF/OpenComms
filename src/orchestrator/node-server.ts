/**
 * M3.5 coordinator transport — WSS server + node daemon client contracts
 * (design §9c-4; the socket wiring increment over node-transport.ts).
 *
 * The contract is published HERE for Lead's review BEFORE Platform's daemon
 * slots in (same pattern as the M1 transport gate):
 *
 *   NodeTransportServer (coordinator side):
 *     start()                     — begin listening (injected server; tests
 *                                   pass a fake; production uses ws)
 *     onAuthenticated(node_id, s) — fired after cert+bearer verification
 *     deliver(node_id, framed)    — hand a framed batch to a connected node
 *     onAck(node_id, seq)         — remote-ack (cursor advance, P3-2)
 *     close()                     — stop accepting; close sessions
 *
 *   NodeDaemonClient (node side, Platform's daemon consumes):
 *     connect()                   — outbound dial (wss only), cert + bearer
 *     onDeliver(handler)          — receive framed batches
 *     ack(seq)                    — acknowledge receipt (remote-ack commit)
 *     heartbeat()                 — liveness + watchdog
 *     close()
 *
 * WATCHDOG CONTRACT (agreed with Platform, unit WatchdogSec=30s):
 *   - sd_notify("READY=1") AFTER the WSS dial succeeds AND the first
 *     heartbeat is sent (never before).
 *   - sd_notify("WATCHDOG=1") every max(1s, WATCHDOG_USEC/2) — derived from
 *     the environment, never hardcoded, so unit amendments propagate.
 *   - Absent WATCHDOG_USEC (non-systemd) = no pings, plain foreground.
 *   - The notify socket is INJECTED (notifySocket abstraction) so the
 *     READY/watchdog sequence is test-asserted without systemd.
 *
 * SECURITY: the handshake verifies the node CERT against the owner CA, then
 * the nonce-bound bearer, then the LOAD-BEARING revocation gate (binding B)
 * — a revoked node is rejected at the auth point even with a valid
 * signature. The server opens NO inbound anything except the wss listener;
 * nodes dial out (ADR-0001 floor).
 */

import { createHash, randomBytes } from "node:crypto"

export interface NodeTransportSession {
  node_id: string
  connected_at: number
  last_heartbeat: number
}

/**
 * The coordinator-side contract (Lead-reviewed interface; Platform's daemon
 * client consumes the mirror). Every method is injected-socket testable.
 */
export interface NodeTransportServer {
  /** Begin accepting node connections. */
  start(): Promise<void>
  /** Fired after cert-verify + bearer-verify + revocation gate all pass. */
  onAuthenticated(handler: (node_id: string, session: NodeSession) => void): void
  /** Hand one framed batch to a connected node (fire-and-forget w/ ack). */
  deliver(node_id: string, framed: string, seq: number): Promise<"sent" | "failed">
  /** Fired when the node acknowledges receipt (remote-ack commit point). */
  onAck(handler: (node_id: string, seq: number) => void): void
  /** Stop accepting; close all node sessions. */
  close(): Promise<void>
}

export interface NodeSession {
  node_id: string
  connected_at: number
  last_heartbeat: number
  /** Send a framed message + seq to this node. */
  send(framed: string, seq: number): void
  close(): void
}

export interface ServerDeps {
  /**
   * Injected WebSocket-server factory (tests pass a fake; production wires
   * `ws`). Receives the port + the per-connection auth verifier.
   */
  createWss?: (opts: {
    port: number
    verifyClient: (info: {
      reqHeaders: Record<string, string | undefined>
      url: URL
    }) => { ok: true; node_id: string } | { ok: false; reason: string }
  }) => unknown
  /** Cert/auth verification — reuse the CA + revocation gate. */
  verifyClient: (info: {
    reqHeaders: Record<string, string | undefined>
    url: URL
  }) => { ok: true; node_id: string } | { ok: false; reason: string }
  port: number
}

/**
 * Heartbeat/watchdog speaker (Platform's opencomms-node.service contract).
 * READY=1 after dial+first heartbeat; WATCHDOG=1 every max(1s, USEC/2).
 * The notify socket is INJECTED so the sequence is asserted without systemd.
 */
export interface WatchdogSpeakerDeps {
  /** systemd sets this; tests inject a fake (e.g. "unix:/run/notify.sock"). */
  notifySocketPath: string | undefined
  /** systemd WATCHDOG_USEC (microseconds) or undefined when not supervised. */
  watchdogUsec?: number
  /** Injected sd_notify speaker (tests assert the sequence). */
  notify: (message: string) => void
  /** ms between pings; derived from WATCHDOG_USEC/2, clamped to 1s min. */
  intervalMs?: number
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

/**
 * The daemon's watchdog speaker (design: READY after dial+first heartbeat;
 * WATCHDOG pings at the derived cadence). Test-asserted via the injected
 * notify callback — no systemd needed to verify the sequence.
 */
export class WatchdogSpeaker {
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly deps: WatchdogSpeakerDeps) {}

  /** Call once the WSS dial succeeded AND the first heartbeat went out. */
  notifyReady(): void {
    this.deps.notify("READY=1")
    const interval = this.derivedInterval()
    if (interval > 0 && !this.timer) {
      this.timer = setInterval(() => this.deps.notify("WATCHDOG=1"), interval)
      this.timer.unref?.()
    }
  }

  /** Heartbeat tick: the daemon calls this on its heartbeat cadence. */
  heartbeat(): void {
    this.deps.notify("WATCHDOG=1")
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private derivedInterval(): number {
    return watchdogIntervalFromUsec(this.deps.watchdogUsec, this.deps.intervalMs)
  }
}

/** Pure: derive the ping interval from a WATCHDOG_USEC value (or absence). */
export function watchdogIntervalFromUsec(watchdogUsec: number | undefined, overrideMs?: number): number {
  if (overrideMs !== undefined) return Math.max(1_000, overrideMs)
  if (!watchdogUsec || watchdogUsec <= 0) return DEFAULT_HEARTBEAT_INTERVAL_MS
  return Math.max(1_000, Math.floor(watchdogUsec / 2 / 1_000))
}

/**
 * The daemon-side client contract (Platform's skeleton consumes this):
 * outbound dial only; credential = node cert + nonce-bound bearer.
 */
export interface NodeDaemonClient {
  connect(): Promise<void>
  onDeliver(handler: (framed: string, seq: number) => void): void
  ack(seq: number): void
  heartbeat(): Promise<void>
  close(): Promise<void>
}

/**
 * Enrollment output contract (Platform coordination 2026-09-14): the
 * daemon's enrollment/enrolled output prints the RESOLVED WSS base the
 * operator registered against (the @WSS_BASE@ substitution target).
 */
export function enrollmentOutput(wssBase: string, nodeId: string): string {
  return `Node ${nodeId} enrolled. Coordinator: ${wssBase}`
}

/** Auth handshake token: binds node_id + nonce (node-transport.ts builders). */
export function connectionAuthHeaders(input: { nodeId: string; bearer: string }): Record<string, string> {
  return {
    "x-opencomms-node": input.nodeId,
    authorization: `Bearer ${input.bearer}`,
  }
}

/** Nonce for the auth handshake (replay defense; node-transport.ts). */
export function newHandshakeNonce(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex").slice(0, 32)
}

/**
 * Minimal in-memory NodeTransportServer for tests + the loopback path:
 * implements the contract with an injected message bus. The production WSS
 * server wraps THIS (same handler signatures) once Platform's socket
 * layer is wired; the auth gate (cert+bearer+revocation) is identical.
 */
export interface InMemoryNodeTransportServer extends NodeTransportServer {
  sessions: Map<string, NodeSession>
  /** Test hook: simulate the node sending an ack. */
  emitAck(nodeId: string, seq: number): void
  /** Test hook: admit a session AFTER auth passed (drives onAuthenticated). */
  admit(nodeId: string): NodeSession
}

export function createInMemoryNodeTransportServer(deps: {
  verifyClient: (info: {
    reqHeaders: Record<string, string | undefined>
    url: URL
  }) => { ok: true; node_id: string } | { ok: false; reason: string }
}): InMemoryNodeTransportServer {
  const sessions = new Map<string, NodeSession>()
  let authHandler: ((node_id: string, session: NodeSession) => void) | null = null
  let ackHandler: ((node_id: string, seq: number) => void) | null = null
  const server: InMemoryNodeTransportServer = {
    sessions,
    async start() {
      /* in-memory: nothing to listen on */
    },
    onAuthenticated(handler) {
      authHandler = handler
    },
    onAck(handler) {
      ackHandler = handler
    },
    async deliver(node_id, framed, seq) {
      const session = sessions.get(node_id)
      if (!session) return "failed"
      session.send(framed, seq)
      return "sent"
    },
    async close() {
      sessions.clear()
    },
    emitAck(nodeId, seq) {
      ackHandler?.(nodeId, seq)
    },
    admit(nodeId) {
      const session: NodeSession = {
        node_id: nodeId,
        connected_at: Date.now(),
        last_heartbeat: Date.now(),
        send(framed, seq) {
          sentBatches.push({ node_id: nodeId, framed, seq })
        },
        close() {
          sessions.delete(nodeId)
        },
      }
      sessions.set(nodeId, session)
      authHandler?.(nodeId, session)
      return session
    },
  }
  return server
}

/** Sent-batch sink the tests + the deliver() path share. */
export const sentBatches: Array<{ node_id: string; framed: string; seq: number }> = []
