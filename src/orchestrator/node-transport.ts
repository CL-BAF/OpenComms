/**
 * M3 remote transport — outbound-only WSS node→coordinator (design §9c-4).
 *
 * FLOOR (ADR-0001 + research batch-1 §2, unchanged by research-m3 §2):
 *   - The NODE dials out; the coordinator opens no inbound ports.
 *   - Bearer credentials over `wss://` ONLY (never `ws://` cross-network —
 *     Codex `--remote` rule). The bearer is the node's cert-derived token.
 *   - Message framing identical local vs remote: MessageEnvelope content
 *     moves verbatim (single protocol surface, M0 ground rule).
 *
 * SHAPE (Buildkite / Remote Control model): register → poll/heartbeat →
 * accept job → stream output → report status. Reconnect reuses our local
 * machinery:
 *   - per-recipient sequence cursors: "deliver everything after seq N"
 *     (JetStream idea; the Remote Control queue-on-drop precedent),
 *   - REMOTE-ACK delivery: cross-node, `delivered` is committed only AFTER
 *     the node ACKs receipt — never on prompt-success alone (research
 *     batch-1 §3),
 *   - bounded give-up (~10 min, Remote Control precedent) with clean
 *     re-registration on return.
 *
 * P3-2 COMPOSITION SPEC (remote-ack × two-phase commit, Reviewer M3 P3-2):
 *   Local two-phase: drain marks in_flight (persisted) → host accepts →
 *   commitDelivery marks delivered. Cross-node composition:
 *   1. drainForDelivery marks the envelope in_flight as today (crash-safe).
 *   2. The WSS send hands the framed batch to the node; the envelope STAYS
 *      in_flight until the node's ACK arrives ("ack seq N").
 *   3. ACK receipt → commitDelivery (delivered). No ACK within the ack
 *      window → requeueFailedDelivery (FIFO preserved) + retry, exactly the
 *      M1 failed-delivery path. Idempotency on the node: the cursor+ack
 *      pair makes redelivery a no-op (the node drops envelopes with seq ≤
 *      its cursor).
 *   4. Crashed-coordinator window: the node may have executed an envelope
 *      the coordinator considers un-acked. That is the SAME at-least-once
 *      class as M1's crash window (PROTOCOL.md: bias toward re-deliver).
 *      Cursor+ack bounds the replay to the ack window; framing + dedup
 *      make the replay safe.
 *   5. sweepInFlight semantics are unchanged: envelopes stranded in_flight
 *      by a coordinator crash are re-queued at startup; remote nodes
 *      re-receive them after reconnect (cursor dedups on the node).
 */

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto"

/**
 * Node-side auth token: cert-derived bearer (design §9c-3/§9c-4). The
 * bearer is a detached signature over the connection nonce + node id,
 * verifiable against the CA public key WITHOUT storing CA secrets on the
 * node (the node pins the CA public-key fingerprint from pairing).
 */
export function nodeBearerToken(input: {
  node_id: string
  caPublicKeyPem: string
  nodePrivateKeyPem: string
  nonce: string
}): string {
  const payload = `${input.node_id}:${input.nonce}`
  const signature = sign(null, Buffer.from(payload, "utf8"), createPrivateKey(input.nodePrivateKeyPem)).toString(
    "base64",
  )
  return `node-${input.node_id}.${signature}`
}

/** Coordinator-side verification of a node bearer token (transport auth). */
export function verifyNodeBearer(input: {
  token: string
  nonce: string
  /** The node's CERT PEM from this handshake (verified against the CA first). */
  nodeCertPem: string
  /** Revocation check result — load-bearing (binding B): false = reject. */
  isRevoked: boolean
}): { ok: true; node_id: string } | { ok: false; reason: string } {
  const dot = input.token.indexOf(".")
  if (dot <= 0) return { ok: false, reason: "malformed node token" }
  const node_id = input.token.slice(0, dot).replace(/^node-/, "")
  const signature = input.token.slice(dot + 1)
  if (!node_id) return { ok: false, reason: "malformed node token" }
  // Load-bearing revocation gate: revoked certs CANNOT authenticate even
  // with a valid signature (binding B, transport enforcement point).
  if (input.isRevoked) return { ok: false, reason: "node certificate revoked" }
  // The nonce is bound to THIS connection (replay of a captured token on a
  // later connection fails the signature check).
  const payload = `${node_id}:${input.nonce}`
  let ok: boolean
  try {
    ok = verify(
      null,
      Buffer.from(payload, "utf8"),
      createPublicKey(input.nodeCertPem),
      Buffer.from(signature, "base64"),
    )
  } catch {
    return { ok: false, reason: "node token signature invalid" }
  }
  if (!ok) return { ok: false, reason: "node token signature invalid" }
  return { ok: true, node_id }
}

/** Per-recipient delivery cursor (JetStream idea, batch-1 §3). */
export interface NodeDeliveryCursor {
  node_id: string
  /** Highest envelope sequence the node has ACKed. */
  acked_seq: number
  updated_at: number
}

/** An outbound envelope queued for a remote node (cursor-addressed). */
export interface RemoteEnvelope {
  seq: number
  node_id: string
  /** OpenComms MessageEnvelope content — framing identical local/remote. */
  framed: string
  message_id: string
}

/**
 * Pure cursor+ack window helper: which envelopes still need (re)sending?
 * A node redelivery is a no-op for envelopes at or below its acked cursor.
 */
export function pendingForNode(envelopes: RemoteEnvelope[], cursor: { acked_seq: number } | null): RemoteEnvelope[] {
  const acked = cursor?.acked_seq ?? 0
  return envelopes.filter((e) => e.seq > acked).sort((a, b) => a.seq - b.seq)
}

/** Advance a cursor after a remote ACK (idempotent; monotonic). */
export function advanceCursor(
  cursor: { acked_seq: number; updated_at: number },
  acked_seq: number,
  now: number,
): { acked_seq: number; updated_at: number } {
  if (acked_seq <= cursor.acked_seq) return cursor
  return { acked_seq, updated_at: now }
}

/**
 * NODE-side dedup (P2-A single implementation point, Lead-owned seam): the
 * NODE drops envelopes at or below its own acked cursor — idempotent
 * redelivery is a no-op, out-of-order/stale envelopes are dropped before
 * execution. Platform's run loop CALLS this at the top of every batch; it
 * never re-implements the logic (cursor semantics live in exactly one
 * place per side: advanceCursor here for the coordinator, dedupeForNode
 * here for the node).
 */
export function dedupeForNode(envelopes: RemoteEnvelope[], nodeAckedSeq: number): RemoteEnvelope[] {
  return envelopes.filter((e) => e.seq > nodeAckedSeq).sort((a, b) => a.seq - b.seq)
}

/**
 * Bounded give-up (design §9c-4, Remote Control precedent ~10 min): a node
 * unreachable for longer than GIVE_UP_MS is marked offline by the
 * supervisor; re-registration on return is a fresh handshake (never silent
 * re-adopt).
 */
export const NODE_GIVE_UP_MS = 10 * 60_000

/** WSS URL builder: wss ONLY (Codex rule — never ws:// across networks). */
export function nodeWssUrl(base: string, nodeId: string, bearer: string): string {
  if (!base.startsWith("wss://")) throw new Error("node transport requires wss:// (ws:// is refused cross-network)")
  const url = new URL(base)
  url.searchParams.set("node_id", nodeId)
  // Bearer travels in the handshake ONLY over wss (never in the URL).
  return url.toString()
}

/** Connection nonce (replay defense for bearer tokens). */
export function newConnectionNonce(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex").slice(0, 32)
}
