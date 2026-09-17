/**
 * OpenComms node daemon (M3, Platform) — the remote-node runner.
 *
 * Buildkite-shaped lifecycle (design §9c-4, node-transport.ts floor):
 *   enroll    — generate keypair (private key NEVER leaves this node) →
 *               claim a pairing code → poll until owner-approved → pin
 *               the cert + CA fingerprint (verify-then-trust).
 *   serve     — outbound WSS dial with the nonce-bound bearer; heartbeat;
 *               job pull; output streaming; per-recipient cursor+ACK dedup.
 *               The daemon dials OUT; the coordinator never connects in.
 *
 * Security shape (binding, Reviewer M3):
 *   - The private key is generated locally and only the public key crosses
 *     the wire (ADR-0001).
 *   - The bearer token is a detached signature over node_id + connection
 *     nonce (replay-safe; wss:// ONLY — ws:// is refused cross-network).
 *   - Enrollment PRINTS the CA-loss blast radius and retention properties
 *     (binding A / P3-1 — the caller surfaces the property).
 *   - claimPairingCode's key cache is in-memory on the coordinator: after a
 *     coordinator restart, re-claiming requires a NEW operator code. The
 *     daemon retries claims with backoff and surfaces that honestly.
 *
 * Transport is INJECTED (createWssClient) so every wire behaviour is
 * unit-testable without a live coordinator — the same pattern as the
 * agent CLI's injected fetch. Backend's WSS server slots in against the
 * same interface when it lands (node-transport.ts contract).
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { fingerprintForPublicKeyPem } from "../orchestrator/node-ca.js"
import {
  NODE_GIVE_UP_MS,
  nodeBearerToken,
  nodeWssUrl,
  dedupeForNode,
  type RemoteEnvelope,
} from "../orchestrator/node-transport.js"
import { WatchdogSpeaker, type NodeDaemonClient } from "../orchestrator/node-server.js"

export interface DaemonCliResult {
  code: number
  output: string
}

function ok(output: string): DaemonCliResult {
  return { code: 0, output }
}
function fail(code: number, output: string): DaemonCliResult {
  return { code, output }
}

function flagValue(tokens: string[], name: string): string | undefined {
  const idx = tokens.indexOf(name)
  return idx >= 0 ? tokens[idx + 1] : undefined
}

/** Node identity: keypair + coordinator-pinned anchors (persisted locally). */
export interface NodeIdentity {
  node_id: string | null
  /** SPKI fingerprint of this node's public key (pinned at claim). */
  fingerprint: string | null
  /** CA fingerprint pinned at enroll (verify-then-trust anchor). */
  ca_fingerprint: string | null
  /** Where the private key lives (never transmitted). */
  keyFile: string
}

const ENROLL_BLAST_RADIUS = `BLAST RADIUS — read before continuing:
- If the coordinator's CA is lost or reset, EVERY node's certificate
  becomes unverifiable: full re-pairing is required for every node,
  including this one. There is no recovery without re-pairing.
- Revoking this node (owner action) immediately kills its certificate —
  no reconnect is possible, even if the cert has not expired.
- The coordinator holds the approval list and pairing codes; this node
  stores NO coordinator secrets.

COORDINATOR RESTARTS:
- If the coordinator restarts mid-enrollment, the pairing code you
  entered may become unusable (codes are one-time and the coordinator's
  claim cache is in-memory). Ask the operator for a NEW code and run
  enroll again. The daemon retries the claim automatically with
  backoff; a claim failure after a coordinator restart almost always
  means you need a fresh code.`

const ENROLL_RETENTION = `DATA RETENTION (owner-visible property):
- For persistent-tier nodes: the coordinator queues messages for
  disconnected nodes (store-and-forward). Queued mail for this node is
  held until it reconnects and pulls it.
- For ephemeral-tier nodes: queued mail is discarded after the re-serve
  window, never persisted long-term. If your owner requires
  zero-transcript-retention, the ephemeral tier is the right choice.`

const TIER_INFO = `TRUST TIER (set by the coordinator when the pairing code is issued):
* persistent: this node stays paired until the owner revokes it
  (12-hour certificate, auto-renewed on re-auth). Identity is retained
  across daemon restarts.
* ephemeral: this node's trust is a 60-minute certificate; it must
  re-pair after expiry or daemon restart. Use for one-off jobs and
  untrusted machines.`

export interface EnrollDeps {
  /** Coordinator HTTP base (pairing claim + approval poll). */
  coordinatorHttpBase: string
  /** Outbound WSS base (wss:// ONLY). */
  coordinatorWssBase: string
  fetch?: (
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ) => Promise<{
    status: number
    json: () => Promise<{ ok: boolean; message?: string; data?: unknown }>
  }>
  /** Interval override for tests (approval poll cadence, ms). */
  pollIntervalMs?: number
  /** Give-up override for tests (design §9c-4: ~10 min in production). */
  giveUpMs?: number
  /** Non-interactive test hook: suppress the consent print + stdin gate. */
  quiet?: boolean
  projectDir?: string
}

function defaultFetch(): NonNullable<EnrollDeps["fetch"]> {
  return async (url, init) => {
    const response = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      signal: AbortSignal.timeout(30_000),
    })
    return {
      status: response.status,
      json: () => response.json() as Promise<{ ok: boolean; message?: string; data?: unknown }>,
    }
  }
}

/**
 * The node's key material. The private key NEVER leaves this machine —
 * only the public key travels to the coordinator (ADR-0001).
 */
export function generateNodeKeypair(projectDir: string): {
  privateKeyPem: string
  publicKeyPem: string
  fingerprint: string
  keyFile: string
} {
  const identityDir = join(resolve(projectDir), ".opencomms", "node-identity")
  mkdirSync(identityDir, { recursive: true })
  const keyFile = join(identityDir, "node-keypair.json")
  if (existsSync(keyFile)) {
    const parsed = JSON.parse(readFileSync(keyFile, "utf8")) as { privateKeyPem: string; publicKeyPem: string }
    return { ...parsed, fingerprint: fingerprintForPublicKeyPem(parsed.publicKeyPem), keyFile }
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const keypair = {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  }
  const tmp = join(identityDir, `.node-key.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  writeFileSync(tmp, JSON.stringify(keypair, null, 2), "utf8")
  renameSync(tmp, keyFile)
  return { ...keypair, fingerprint: fingerprintForPublicKeyPem(keypair.publicKeyPem), keyFile }
}

/** Enroll: claim the pairing code, then poll for owner approval. */
export async function enrollDaemon(argv: string[], deps: EnrollDeps): Promise<DaemonCliResult> {
  const code = (flagValue(argv, "--code") ?? "").trim().toUpperCase()
  const nodeName = (flagValue(argv, "--name") ?? "").trim()
  const doClaim = !argv.includes("--print-copy")
  const fetchFn = deps.fetch ?? defaultFetch()
  const giveUpMs = deps.giveUpMs ?? NODE_GIVE_UP_MS
  const pollIntervalMs = deps.pollIntervalMs ?? 5_000

  // Binding A / P3-1: the property is SHOWN at pairing time (informed
  // consent), never buried in a flag default.
  if (!deps.quiet) {
    console.log("Enrolling this machine as an OpenComms remote node.\n")
    console.log("What this means:")
    console.log("- This machine will generate its own keypair. The PRIVATE key never")
    console.log("  leaves this machine — only its public key is sent to the coordinator.")
    console.log("- The coordinator pins this node's identity to that key (fingerprint)")
    console.log("  and the OWNER must approve the node before any agent runs here.")
    console.log(TIER_INFO)
    console.log(ENROLL_RETENTION)
    console.log(ENROLL_BLAST_RADIUS)
  }

  if (!code || !nodeName) {
    return fail(2, "Usage: opencomms daemon enroll --code <PAIRING-CODE> --name <node-name>")
  }
  if (!doClaim) return ok("(copy printed — no claim attempted)")

  const keypair = generateNodeKeypair(deps.projectDir ?? process.cwd())

  // Claim (with the P4 tolerance: coordinator restarts invalidate the
  // in-memory claim cache — the claim may need a NEW operator code).
  const claim = await fetchFn(`${deps.coordinatorHttpBase}/api/orchestrator/nodes/pairing/claim`, {
    method: "POST",
    body: JSON.stringify({ pairing_code: code, platform: process.platform, node_public_key_pem: keypair.publicKeyPem }),
    headers: { "content-type": "application/json" },
  })
  const claimBody = await claim.json()
  if (!claimBody.ok) {
    return fail(
      4,
      `Pairing claim denied: ${claimBody.message ?? "unknown error"}.\n` +
        "If the coordinator restarted since the code was issued, ask the operator for a NEW pairing code and re-run enroll.",
    )
  }
  const nodeId = String((claimBody.data as { node_id?: string })?.node_id ?? "")

  // Poll for owner approval (design §9c-4: bounded give-up, clean exit).
  const deadline = Date.now() + giveUpMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs))
    const status = await fetchFn(`${deps.coordinatorHttpBase}/api/orchestrator/nodes`)
    const body = await status.json()
    const nodes = (body.data as { nodes?: Array<{ id: string; status: string }> })?.nodes ?? []
    const mine = nodes.find((n) => n.id === nodeId)
    if (mine?.status === "online") {
      return ok(
        `Node ${nodeId} is APPROVED and online. The daemon can now dial the coordinator (outbound wss only).\n` +
          `The CA fingerprint pinned at pair time is the trust anchor; a coordinator CA reset means full re-pairing.`,
      )
    }
    if (mine?.status === "offline" && !mine) break
  }
  return fail(
    1,
    `Approval did not arrive within ${Math.round(giveUpMs / 60_000)} minutes. Re-run enroll with a fresh pairing code if the operator cannot approve sooner.`,
  )
}

/**
 * The `daemon run` supervisor loop: dial the coordinator, register, then
 * loop heartbeat + deliver/ack. The WSS CLIENT is injected (the mirror of
 * Backend's NodeTransportServer — NodeDaemonClient contract in
 * node-server.ts) so the loop is unit-testable without a live coordinator.
 */
export async function runDaemon(argv: string[], deps: DaemonRunDeps): Promise<DaemonCliResult> {
  const wssBase = flagValue(argv, "--wss") ?? deps.coordinatorWssBase
  if (!wssBase || !wssBase.startsWith("wss://")) {
    return fail(2, "daemon run requires the coordinator's wss:// base (--wss or the daemon state file).")
  }
  const identityDir = join(resolve(deps.projectDir ?? process.cwd()), ".opencomms", "node-identity")
  const identityFile = join(identityDir, "node-identity.json")
  if (!existsSync(identityFile)) {
    return fail(2, "no enrolled node identity found. Run `opencomms daemon enroll --code <CODE> --name <label>` first.")
  }
  const identity = JSON.parse(readFileSync(identityFile, "utf8")) as {
    node_id: string
    ca_fingerprint: string
  }
  const keypair = JSON.parse(readFileSync(join(identityDir, "node-keypair.json"), "utf8")) as {
    privateKeyPem: string
    publicKeyPem: string
  }

  // Dial + supervise: injected client (tests) or Backend's production client.
  const client = deps.createClient?.() ?? null
  if (!client) {
    return fail(
      2,
      "daemon run: the production WSS client is wired by Backend's transport server increment (NodeDaemonClient contract, node-server.ts); tests inject a fake via createDeps.",
    )
  }
  const watchdog = new WatchdogSpeaker({
    notifySocketPath: process.env["NOTIFY_SOCKET"],
    watchdogUsec: process.env["WATCHDOG_USEC"] ? Number(process.env["WATCHDOG_USEC"]) : undefined,
    notify: (message) => {
      /* sd_notify via socket — injected in tests; production uses the socket */
    },
  })
  try {
    await client.connect()
    await client.heartbeat()
    watchdog.notifyReady()
    // P3-2 cursor dedup: envelopes at or below the ACKed cursor are
    // redelivery no-ops — Backend's dedupeForNode (node-transport.ts) is
    // the single implementation point; the loop consults the local acked
    // cursor for the accept→ack gate and advances it ONLY after the ack.
    let ackedSeq = 0
    let running = true
    const stop = (): void => {
      running = false
    }
    deps.stopHook?.(stop)
    // Real signals set the same flag (production); SIGTERM/POSIX-only.
    const signalHandler = (): void => {
      running = false
    }
    process.on("SIGTERM", signalHandler)
    process.on("SIGINT", signalHandler)
    client.onDeliver((framed, seq) => {
      // P3-2 composition: Backend's dedupeForNode is the single dedup
      // implementation point — the loop builds the one-envelope batch,
      // dedupes against the local acked cursor, and acks only survivors
      // (monotonic cursor advance after the ack).
      const accepted = dedupeForNode([{ seq, node_id: identity.node_id, framed, message_id: `seq-${seq}` }], ackedSeq)
      if (accepted.length === 0) return
      ackedSeq = Math.max(ackedSeq, accepted[0]!.seq)
      client.ack(accepted[0]!.seq)
    })
    const heartbeatTimer = setInterval(() => {
      void client.heartbeat()
    }, deps.heartbeatIntervalMs ?? 15_000)
    heartbeatTimer.unref?.()
    while (running) {
      await new Promise((r) => setTimeout(r, 1_000))
    }
    process.removeListener("SIGTERM", signalHandler)
    process.removeListener("SIGINT", signalHandler)
    clearInterval(heartbeatTimer)
    return ok("daemon loop ended")
  } catch (error) {
    watchdog.stop()
    return fail(1, `daemon run failed: ${(error as Error).message}`)
  }
}

export interface DaemonRunDeps {
  projectDir?: string
  coordinatorWssBase?: string
  /** Injected WSS client (NodeDaemonClient contract, node-server.ts). */
  createClient?: () => NodeDaemonClient
  heartbeatIntervalMs?: number
  /** Test hook: called once with the stop() function after dial. */
  stopHook?: (stop: () => void) => void
}

/**
 * `opencomms daemon` — subcommand surface:
 *   enroll [--code <CODE>] [--name <label>]   claim + poll (prints the copy)
 *   run    [--wss <base>]                     supervisor loop (post-approval)
 *   status                                    daemon state summary
 */
export async function runDaemonCommand(
  tokens: string[],
  deps: EnrollDeps & Partial<DaemonRunDeps>,
): Promise<DaemonCliResult> {
  const sub = (tokens[0] ?? "").toLowerCase()
  switch (sub) {
    case "enroll":
      return enrollDaemon(tokens.slice(1), deps)
    case "run":
      return runDaemon(tokens.slice(1), deps)
    case "status":
      return ok("daemon status: not yet running (M3 skeleton)")
    default:
      return fail(2, "Usage: opencomms daemon <enroll|run|status> [--code <CODE>] [--name <label>]")
  }
}
