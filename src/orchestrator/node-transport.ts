/**
 * Remote helpers: outbound WSS, nonce-bound credentials and unchanged framing.
 * Delivery commits after ACK; monotonic cursors suppress received sequences.
 * A crash can leave accepted work unacknowledged, so replay remains at-least-once.
 * Return after the bounded offline window requires a fresh authenticated handshake.
 */

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto"

/**
 * Sign the connection nonce and node id with the node private key.
 * Verify with the node public key pinned by pairing.
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
  /** True rejects authentication even with a valid signature. */
  isRevoked: boolean
}): { ok: true; node_id: string } | { ok: false; reason: string } {
  const dot = input.token.indexOf(".")
  if (dot <= 0) return { ok: false, reason: "malformed node token" }
  const node_id = input.token.slice(0, dot).replace(/^node-/, "")
  const signature = input.token.slice(dot + 1)
  if (!node_id) return { ok: false, reason: "malformed node token" }
  // Revocation rejects otherwise valid credentials.
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

/** Drop node-side sequences at or below the cursor before execution. */
export function dedupeForNode(envelopes: RemoteEnvelope[], nodeAckedSeq: number): RemoteEnvelope[] {
  return envelopes.filter((e) => e.seq > nodeAckedSeq).sort((a, b) => a.seq - b.seq)
}

/** After the bounded offline window, return requires fresh authenticated registration. */
export const NODE_GIVE_UP_MS = 10 * 60_000

/** WSS only; credentials must never appear in the URL. */
export function nodeWssUrl(base: string, nodeId: string, _bearer: string): string {
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
