/**
 * M3.5 production WSS wire-up — the composed auth chain at the server
 * admission point (Reviewer's carried P2, binding B meets the socket).
 *
 * The three checks compose IN ORDER in verifyClient, and admission CANNOT
 * be reached without passing all three:
 *   1. CERT VERIFY — the presented cert verifies against the owner CA.
 *   2. NONCE-BOUND BEARER — the bearer signature binds THIS connection's
 *      nonce (replay on a later connection fails).
 *   3. LOAD-BEARING REVOCATION — isRevoked is checked LAST but is
 *      decisive: a revoked node is rejected even with valid signature.
 *
 * The composition is PROVEN, not asserted: verifyCoordinatorAuth() is a
 * PURE function whose body IS the composed chain (no early-return path
 * that skips a check), and the integration-style test drives admission
 * through the server contract with a revoked node — rejection happens AT
 * THE ADMISSION POINT, before onAuthenticated can ever fire.
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

/**
 * The COMPOSED admission chain (in order, no gate-skipping path):
 * cert-verify → nonce-bound bearer → revocation. The server's verifyClient
 * delegates here; production wiring MUST call exactly this function (the
 * integration test asserts a revoked node is rejected at admission).
 */
export function verifyCoordinatorAuth(input: {
  cert: NodeCertificate
  /** The node's public key PEM from THIS handshake (bearer verifies against it). */
  certPem: string
  token: string
  nonce: string
  ca: NodeCertificateAuthority
}): CoordinatorAuthResult {
  // 1. Cert verify (signature + expiry against the owner CA).
  const certCheck = input.ca.verify(input.cert)
  if (!certCheck.ok) {
    return { ok: false, reason: `certificate rejected: ${certCheck.reason}`, rejected_at: "cert" }
  }
  // 2. Nonce-bound bearer (this connection's nonce; replay fails).
  const bearerCheck = verifyNodeBearer({
    token: input.token,
    nonce: input.nonce,
    nodeCertPem: input.certPem,
    isRevoked: false, // revocation is check 3 — deliberately NOT short-circuited
  })
  if (!bearerCheck.ok) {
    return { ok: false, reason: bearerCheck.reason, rejected_at: "bearer" }
  }
  // 3. LOAD-BEARING revocation gate (binding B): a revoked node is dead
  //    regardless of signature validity or remaining validity window.
  if (input.ca.isRevoked(input.cert.node_id)) {
    return { ok: false, reason: "node certificate revoked", rejected_at: "revocation" }
  }
  return { ok: true, node_id: input.cert.node_id }
}

/**
 * The PRODUCTION verifyClient for the WSS server: composes
 * verifyCoordinatorAuth with the handshake's cert/bearer/nonce, and is the
 * ONLY admission path (no gate-skipping: the server constructor takes this
 * verifier and admit() is not exported — sessions are created solely by
 * the auth flow).
 */
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
// Re-export for the wire-up integration test.
export { verifyNodeBearer }
