/**
 * Admission chain: owner-CA certificate, nonce-bound bearer, then explicit revocation.
 * All three checks must pass before admission.
 */

import { NodeCertificateAuthority, type NodeCertificate } from "./node-ca.js"
import { verifyNodeBearer } from "./node-transport.js"

export type CoordinatorAuthResult =
  | { ok: true; node_id: string }
  | {
      ok: false
      reason: string
      /** Which of the three composed checks rejected (audit evidence). */
      rejected_at: "cert" | "bearer" | "revocation"
    }

/** Shared admission verifier; callers must not bypass any check. */
export function verifyCoordinatorAuth(input: {
  cert: NodeCertificate
  /** The node's public key PEM from THIS handshake (bearer verifies against it). */
  certPem: string
  token: string
  nonce: string
  ca: NodeCertificateAuthority
}): CoordinatorAuthResult {
  const certCheck = input.ca.verify(input.cert)
  if (!certCheck.ok) {
    return { ok: false, reason: `certificate rejected: ${certCheck.reason}`, rejected_at: "cert" }
  }

  const bearerCheck = verifyNodeBearer({
    token: input.token,
    nonce: input.nonce,
    nodeCertPem: input.certPem,
    isRevoked: false, // revocation is check 3 — deliberately NOT short-circuited
  })
  if (!bearerCheck.ok) {
    return { ok: false, reason: bearerCheck.reason, rejected_at: "bearer" }
  }
  // A valid signature never overrides explicit revocation.
  if (input.ca.isRevoked(input.cert.node_id)) {
    return { ok: false, reason: "node certificate revoked", rejected_at: "revocation" }
  }
  return { ok: true, node_id: input.cert.node_id }
}

/** Adapt handshake headers to the shared certificate/bearer/revocation verifier. */
export function createProductionVerifyClient(deps: {
  ca: NodeCertificateAuthority
  certsByNodeId: Map<string, NodeCertificate & { pem: string }>
}) {
  return (info: {
    reqHeaders: Record<string, string | undefined>
    url: URL
  }): { ok: true; node_id: string } | { ok: false; reason: string } => {
    const nodeId = input(info.reqHeaders)
    const nonce = info.reqHeaders["x-opencomms-nonce"]
    const token = bearerFrom(info.reqHeaders)
    if (!nodeId || !nonce || !token) {
      return { ok: false, reason: "missing auth headers" }
    }
    const entry = deps.certsByNodeId.get(nodeId)
    if (!entry) {
      return { ok: false, reason: "unknown node (no issued certificate)" }
    }
    return verifyCoordinatorAuth({
      cert: { ...entry, pem: undefined } as unknown as NodeCertificate,
      certPem: entry.pem,
      token,
      nonce,
      ca: deps.ca,
    })
  }
}

function input(reqHeaders: Record<string, string | undefined>): string {
  return reqHeaders["x-opencomms-node"] ?? ""
}
function bearerFrom(reqHeaders: Record<string, string | undefined>): string {
  const auth = reqHeaders["authorization"] ?? ""
  return auth.startsWith("Bearer ") ? auth.slice(7) : ""
}

export { verifyNodeBearer }
