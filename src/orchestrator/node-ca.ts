/**
 * Project CA for pairing-authorized, short-lived node certificates.
 * Node private keys stay on the node; the coordinator signs their pinned public keys.
 * Expiry and explicit revocation gate authentication. CA loss requires full re-pairing.
 */

import { createHash, createPrivateKey, generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

export const NODE_CERT_VALIDITY_MS = 12 * 60 * 60_000
export const EPHEMERAL_NODE_CERT_VALIDITY_MS = 60 * 60_000
/** Explicit revocation rejects certificates before expiry. */
export const REVOKED_CERTS_FILE = "revoked-certs.json"

export interface NodeCertificate {
  node_id: string
  node_name: string
  /** SPKI hash of the node's public key — the identity anchor (design §9c-1). */
  fingerprint: string
  issued_at: number
  expires_at: number
  trust_tier: "persistent" | "ephemeral"
  /** Detached signature over the TBS payload, by the owner CA. */
  ca_signature: string
}

interface CaKeypair {
  privateKeyPem: string
  publicKeyPem: string
}

/** Deterministic TBS (to-be-signed) encoding — JSON of the stable fields. */
function certTbs(input: {
  node_id: string
  fingerprint: string
  issued_at: number
  expires_at: number
  trust_tier: string
}): string {
  return JSON.stringify({
    v: 1,
    node_id: input.node_id,
    fingerprint: input.fingerprint,
    issued_at: input.issued_at,
    expires_at: input.expires_at,
    trust_tier: input.trust_tier,
  })
}

/** SHA-256 SPKI fingerprint of a public key (the pinned identity anchor). */
export function fingerprintForPublicKeyPem(publicKeyPem: string): string {
  return createHash("sha256")
    .update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" }))
    .digest("hex")
}

/** Reuse the project CA: a replacement invalidates every issued certificate. */
export class NodeCertificateAuthority {
  private caDir: string
  private caFile: string
  private revokedFile: string
  private ca: CaKeypair | null = null

  constructor(projectDir: string) {
    this.caDir = join(projectDir, ".opencomms", "ca")
    this.caFile = join(this.caDir, "ca-keypair.json")
    this.revokedFile = join(this.caDir, "revoked.json")
  }

  /** Load or create the internal CA keypair. */
  ensure(): CaKeypair {
    if (this.ca) return this.ca
    mkdirSync(this.caDir, { recursive: true })
    if (existsSync(this.caFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.caFile, "utf8")) as CaKeypair
        if (typeof parsed.privateKeyPem === "string" && typeof parsed.publicKeyPem === "string") {
          this.ca = parsed
          return this.ca
        }
      } catch {
        /* fall through to regeneration */
      }
    }

    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const keypair: CaKeypair = {
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    }
    const tmp = join(this.caDir, `.ca.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
    writeFileSync(tmp, JSON.stringify(keypair, null, 2), "utf8")
    renameSync(tmp, this.caFile)
    this.ca = keypair
    return this.ca
  }

  /** CA public key fingerprint (what the node pins as its trust anchor). */
  caFingerprint(): string {
    return fingerprintForPublicKeyPem(this.ensure().publicKeyPem)
  }

  /** Issue a certificate for the public key pinned by an authorized pairing claim. */
  issue(input: {
    node_id: string
    node_name: string
    nodePublicKeyPem: string
    trust_tier: "persistent" | "ephemeral"
  }): NodeCertificate {
    const ca = this.ensure()
    const fingerprint = fingerprintForPublicKeyPem(input.nodePublicKeyPem)
    const issued_at = Date.now()

    const validity = input.trust_tier === "ephemeral" ? EPHEMERAL_NODE_CERT_VALIDITY_MS : NODE_CERT_VALIDITY_MS
    const expires_at = issued_at + validity
    const tbs = certTbs({ node_id: input.node_id, fingerprint, issued_at, expires_at, trust_tier: input.trust_tier })
    const ca_signature = sign(null, Buffer.from(tbs, "utf8"), createPrivateKey(ca.privateKeyPem)).toString("base64")
    return {
      node_id: input.node_id,
      node_name: input.node_name,
      fingerprint,
      issued_at,
      expires_at,
      trust_tier: input.trust_tier,
      ca_signature,
    }
  }

  /** Verify a node-presented certificate against THIS ca (no revocation check). */
  verify(cert: NodeCertificate): { ok: true } | { ok: false; reason: string } {
    if (cert.expires_at <= Date.now()) return { ok: false, reason: "certificate expired" }
    const ca = this.ensure()
    const tbs = certTbs({
      node_id: cert.node_id,
      fingerprint: cert.fingerprint,
      issued_at: cert.issued_at,
      expires_at: cert.expires_at,
      trust_tier: cert.trust_tier,
    })
    let ok: boolean
    try {
      ok = verify(null, Buffer.from(tbs, "utf8"), this.publicKey(ca), Buffer.from(cert.ca_signature, "base64"))
    } catch {
      return { ok: false, reason: "certificate signature invalid" }
    }
    if (!ok) return { ok: false, reason: "certificate signature invalid" }
    return { ok: true }
  }

  /** Revoke NOW: the cert is dead immediately, before its expiry (binding B). */
  revoke(nodeId: string): void {
    mkdirSync(this.caDir, { recursive: true })
    let list: Array<{ node_id: string; revoked_at: number }> = []
    if (existsSync(this.revokedFile)) {
      try {
        list = JSON.parse(readFileSync(this.revokedFile, "utf8")) as Array<{ node_id: string; revoked_at: number }>
      } catch {
        list = []
      }
    }
    if (!list.some((r) => r.node_id === nodeId)) {
      list.push({ node_id: nodeId, revoked_at: Date.now() })
      const tmp = join(this.caDir, `.revoked.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
      writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8")
      renameSync(tmp, this.revokedFile)
    }
  }

  /** Check explicit revocation on every transport authentication. */
  isRevoked(nodeId: string): boolean {
    if (!existsSync(this.revokedFile)) return false
    try {
      const list = JSON.parse(readFileSync(this.revokedFile, "utf8")) as Array<{ node_id: string; revoked_at: number }>
      return list.some((r) => r.node_id === nodeId)
    } catch {
      return false
    }
  }

  private publicKey(ca: CaKeypair) {
    return createPublicKey(ca.publicKeyPem)
  }
}
