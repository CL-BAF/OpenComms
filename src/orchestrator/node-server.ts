/**
 * Remote contracts and in-memory test transport. Nodes dial outbound over WSS.
 * Admission verifies certificate, nonce-bound bearer and explicit revocation.
 * Watchdog READY follows dial and first heartbeat; pings use max(1s, WATCHDOG_USEC/2).
 * Absent supervision means no watchdog pings.
 */

import { createHash, randomBytes } from "node:crypto"

export interface NodeTransportSession {
  node_id: string
  connected_at: number
  last_heartbeat: number
}

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
  /** Inject the socket server and per-connection auth verifier. */
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

/** READY follows dial and first heartbeat; watchdog cadence comes from WATCHDOG_USEC. */
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

/** Outbound WSS client authenticated with a certificate and nonce-bound bearer. */
export interface NodeDaemonClient {
  connect(): Promise<void>
  onDeliver(handler: (framed: string, seq: number) => void): void
  ack(seq: number): void
  heartbeat(): Promise<void>
  close(): Promise<void>
}

/** Print the resolved coordinator WSS base in enrollment output. */
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

/** In-memory test transport; admit() assumes authentication already passed. */
export interface InMemoryNodeTransportServer extends NodeTransportServer {
  sessions: Map<string, NodeSession>
  /** Test hook: simulate the node sending an ack. */
  emitAck(nodeId: string, seq: number): void
  /** Test hook: admit a session AFTER auth passed (drives onAuthenticated). */
  admit(nodeId: string): NodeSession
}

export function createInMemoryNodeTransportServer(_deps: {
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
