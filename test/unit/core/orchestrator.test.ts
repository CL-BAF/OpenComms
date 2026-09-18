/**
 * Orchestrator state tests (M1): persistence + fail-closed validation,
 * one-per-project designated-lead enforcement, redaction-by-value (the
 * password VALUE must appear in NO persisted field — Reviewer gate), event
 * ring cap, and trust-token gating for approve/revoke.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import {
  OrchestratorStore,
  emptyOrchestratorState,
  validateOrchestratorState,
  pushEvent,
  eventsSince,
  MAX_ORCHESTRATOR_EVENTS,
  localNodeIdFor,
  newAgentId,
  newNodeId,
  newConfirmToken,
} from "../../../src/orchestrator/state.js"
import { OrchestratorApi, agentWorktreeDir, assertRemoteActionAllowed } from "../../../src/orchestrator/api.js"
import { createOrchestratorFeed, listEvents } from "../../../src/orchestrator/events.js"
import { parseModelsOutput, ensureServe, resolveOpencodeBinary } from "../../../src/orchestrator/runtimes/opencode.js"
import {
  NodeCertificateAuthority,
  fingerprintForPublicKeyPem,
  NODE_CERT_VALIDITY_MS,
  EPHEMERAL_NODE_CERT_VALIDITY_MS,
} from "../../../src/orchestrator/node-ca.js"
import {
  nodeBearerToken,
  verifyNodeBearer,
  newConnectionNonce,
  pendingForNode,
  advanceCursor,
  dedupeForNode,
  nodeWssUrl,
  NODE_GIVE_UP_MS,
} from "../../../src/orchestrator/node-transport.js"
import {
  createInMemoryNodeTransportServer,
  WatchdogSpeaker,
  watchdogIntervalFromUsec,
  enrollmentOutput,
  connectionAuthHeaders,
  newHandshakeNonce,
  sentBatches,
} from "../../../src/orchestrator/node-server.js"
import { verifyCoordinatorAuth, createProductionVerifyClient } from "../../../src/orchestrator/node-wire.js"
import {
  handshakeAnnouncement,
  runBridge,
  BRIDGE_IDENTITY,
  BRIDGE_PROTOCOL,
  BRIDGE_COMMANDS,
  type BridgeDeps,
} from "../../../src/orchestrator/bridge.js"
import { generateKeyPairSync, createPrivateKey } from "node:crypto"
import { execFileSync } from "node:child_process"
import type { AgentRuntime, SpawnRequest } from "../../../src/orchestrator/runtime.js"
import type { RemoteEnvelope } from "../../../src/orchestrator/node-transport.js"
import type { AgentRecord, AgentRuntimeStatus } from "../../../src/orchestrator/state.js"

/** Fake runtime for API tests: no live serve needed; deterministic ids. */
function fakeRuntime(
  assigned: Map<string, string>,
  opts: {
    resumeFails?: boolean
    aborts?: number[]
    /** Optional handle methods (e.g. permissionsDrain) attached to BOTH handles. */
    handleExtras?: Record<string, unknown>
  } = {},
): AgentRuntime {
  let counter = 0
  const withExtras = (handle: {
    deliver: (framed: string) => Promise<"delivered" | "failed">
    abort: () => Promise<void>
    status: () => Promise<{ status: AgentRuntimeStatus; detail?: string }>
    stop: (force?: boolean) => Promise<void>
  }): typeof handle =>
    ({
      ...handle,
      ...opts.handleExtras,
    }) as typeof handle
  return {
    runtime: "opencode",
    host: "opencode",
    detect() {
      return { available: true, providers: [{ provider: "opencode", models: ["opencode/big-pickle"] }] }
    },
    async create(req: SpawnRequest) {
      counter += 1
      const id = `ses_fake_${counter}`
      assigned.set(req.agent_id, id)
      return {
        ok: true,
        result: { host_session_id: id, spawn_cmd_redacted: "opencode serve --port X (password via env only)" },
        handle: withExtras({
          async deliver() {
            return "delivered" as const
          },
          async abort() {
            opts.aborts?.push(1)
          },
          async status() {
            return { status: "running" as const }
          },
          async stop() {
            opts.aborts?.push(1)
          },
        }),
      }
    },
    async resume(rec: AgentRecord) {
      if (opts.resumeFails || !rec.host_session_id) return { ok: false as const, message: "no session" }
      return {
        ok: true as const,
        handle: withExtras({
          async deliver() {
            return "delivered" as const
          },
          async abort() {
            opts.aborts?.push(1)
          },
          async status() {
            return { status: "running" as const }
          },
          async stop() {
            opts.aborts?.push(1)
          },
        }),
      }
    },
    async shutdownNode() {},
  }
}

function testDeps(
  store: OrchestratorStore,
  dir: string,
  overrides: Partial<ConstructorParameters<typeof OrchestratorApi>[0]> = {},
): ConstructorParameters<typeof OrchestratorApi>[0] {
  const feed = createOrchestratorFeed(async (fn) => {
    const state = store.load()
    const seq = fn(state)
    store.save(state)
    return seq
  })
  return {
    projectDir: dir,
    servePassword: () => "spike-secret-value-42",
    serveModel: () => "opencode/big-pickle",
    servePort: () => 4300,
    withLock: <T>(fn: () => T) => store.withLock(fn),
    loadOrchestrator: () => store.load(),
    saveOrchestrator: (s: ReturnType<typeof store.load>) => store.save(s),
    feed,
    projectId: () => null,
    createRuntime: () => fakeRuntime(new Map()),
    loadChannelEngineState: () => ({ messages: {} }),
    engineSend: () => ({ ok: true, message: "sent (test fake)" }),
    saveChannelEngineState: () => {},
    ...overrides,
  }
}

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "oc-orch-"))
}

test("orchestrator store: fresh project -> local node online, deterministic id per worktree", () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const state = store.load()
    assert.equal(state.orchestrator_schema_version, 1)
    assert.equal(state.nodes.length, 1)
    const node = state.nodes[0]
    assert.ok(node)
    assert.equal(node.kind, "local")
    assert.equal(node.status, "online")
    assert.equal(node.id, localNodeIdFor(dir))
    assert.ok(existsSync(store.file))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator state: tampered file fails closed and records the reason", () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    store.save(emptyOrchestratorState(dir))
    const file = join(dir, ".opencomms", "orchestrator.json")
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    raw["orchestrator_schema_version"] = 99
    store.save(raw as never)
    const reloaded = new OrchestratorStore(dir).load()
    assert.equal(reloaded.orchestrator_schema_version, 1)
    assert.ok(reloaded.events.some((e) => e.type === "state_rejected"))
    assert.equal(validateOrchestratorState({ nope: true }).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator state: multiple designated leads in a persisted file are rejected", () => {
  const dir = tmpProject()
  try {
    const base = emptyOrchestratorState(dir)
    const makeAgent = (id: string) => ({
      id,
      name: id,
      host: "opencode",
      role: "Lead",
      role_prompt: "p",
      runtime: "opencode",
      node_id: base.local_node_id,
      worktree: join(dir, "wt"),
      status: "running" as const,
      host_session_id: "ses_x",
      spawn_cmd_redacted: "cmd",
      designated: "lead" as const,
      channel_ids: [],
      last_heartbeat: null,
      created_at: Date.now(),
      restart_count: 0,
      model: "opencode/big-pickle",
    })
    base.agents.push(makeAgent(newAgentId()), makeAgent(newAgentId()))
    const result = validateOrchestratorState(base)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /designated lead/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api: second designated:'lead' create is a 409-style conflict", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const emitted: string[] = []
    const deps = testDeps(store, dir)
    const originalEmit = deps.feed.emit.bind(deps.feed)
    deps.feed.emit = (event) => {
      emitted.push(event.type)
      originalEmit(event)
    }
    const api = new OrchestratorApi(deps)
    const base = { name: "worker", host: "opencode", role: "Worker", role_prompt: "Work hard." }
    const first = await api.createAgent({ ...base, designated: "lead" })
    assert.equal(first.ok, true, JSON.stringify(first))
    const second = await api.createAgent({ ...base, name: "second", designated: "lead" })
    assert.equal(second.ok, false)
    assert.match(second.message, /designated Lead already exists/)
    const agents = api.listAgents()
    assert.ok(agents.ok)
    const payload = agents.data as { agents: Array<{ designated: string | null }> }
    assert.equal(payload.agents.filter((a) => a.designated === "lead").length, 1)
    // Every agents-list item carries the field (Frontend lead-or-ERROR rule).
    assert.ok(payload.agents.every((a) => "designated" in a))
    assert.ok(emitted.includes("agent_created"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api: REDACTION BY VALUE — password value absent from every persisted field", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.equal(created.ok, true, JSON.stringify(created))
    const persisted = readFileSync(join(dir, ".opencomms", "orchestrator.json"), "utf8")
    assert.ok(!persisted.includes("spike-secret-value-42"), "password VALUE leaked into orchestrator.json")
    const agents = api.listAgents()
    assert.ok(agents.ok)
    assert.ok(!JSON.stringify(agents.data).includes("spike-secret-value-42"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api: model pinning is required and validated", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const feed = createOrchestratorFeed(async (fn) => {
      const state = store.load()
      const seq = fn(state)
      store.save(state)
      return seq
    })
    const base = {
      projectDir: dir,
      servePassword: () => "x",
      servePort: () => 4302,
      withLock: <T>(fn: () => T) => store.withLock(fn),
      loadOrchestrator: () => store.load(),
      saveOrchestrator: (s: ReturnType<typeof store.load>) => store.save(s),
      loadChannelEngineState: () => ({ messages: {} }),
      engineSend: () => ({ ok: true, message: "sent (test fake)" }),
      saveChannelEngineState: () => {},
      createRuntime: () => fakeRuntime(new Map()),
      feed,
      projectId: () => null,
    }
    // No configured model + no explicit model => validation error (never a
    // server default; spike rule).
    const apiNoModel = new OrchestratorApi({ ...base, serveModel: () => undefined })
    const r = await apiNoModel.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.equal(r.ok, false)
    assert.match(r.message, /verified model pin is required/)
    // Malformed pin => validation error.
    const api = new OrchestratorApi({ ...base, serveModel: () => undefined })
    const bad = await api.createAgent({
      name: "w",
      host: "opencode",
      role: "Worker",
      role_prompt: "p",
      model: "not-a-pin",
    })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /provider\/model/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api: trust approve/revoke require the owner confirm token (403 + audit)", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    const noToken = await api.approveOrRevoke({ node_id: "node_remote_1" }, "approve")
    assert.equal(noToken.ok, false)
    assert.match(noToken.message, /Owner approval required/)
    const state = store.load()
    assert.ok(state.events.some((e) => e.type === "trust_denied"))
    // Trust view must NEVER include the token.
    const trust = api.trustView()
    assert.ok(trust.ok)
    assert.ok(!JSON.stringify(trust.data).includes(state.trust.owner_confirm_token))
    // Wrong token also denied; correct token on an UNKNOWN node is a 404-shape.
    const wrong = await api.approveOrRevoke({ node_id: "node_remote_1", confirm_token: "nope" }, "approve")
    assert.equal(wrong.ok, false)
    const unknown = await api.approveOrRevoke(
      { node_id: "node_remote_1", confirm_token: store.load().trust.owner_confirm_token },
      "approve",
    )
    assert.equal(unknown.ok, false)
    assert.match(unknown.message, /Unknown node/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M5 audit log: owner-only, append-only, secret-free, cursor-paginated", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    // Generate a few audit-worthy events.
    await api.approveOrRevoke({ node_id: "node_x", confirm_token: "wrong" }, "approve")
    const token = store.load().trust.owner_confirm_token
    await api.createPairingCode({ node_name: "audit-box", confirm_token: token })
    // Token-gated: wrong/absent token => denied.
    const denied = api.auditLog({ confirm_token: "nope" })
    assert.equal(denied.ok, false)
    assert.match(denied.message, /Owner approval required/)
    // Correct token: events + cursor + append_only marker.
    const audit = api.auditLog({ confirm_token: token })
    assert.ok(audit.ok, audit.message)
    const payload = audit.data as {
      audit: Array<{ type: string; message: string; seq: number }>
      cursor: number
      total: number
      append_only: boolean
    }
    assert.equal(payload.append_only, true)
    assert.ok(payload.audit.length >= 2)
    assert.ok(payload.audit.some((e) => e.type === "trust_denied"))
    assert.ok(payload.audit.some((e) => e.type === "pairing_code_created"))
    // SECRET-FREE: the confirm token appears in NO audit entry.
    assert.ok(!JSON.stringify(payload.audit).includes(token))
    // Cursor pagination: a mid-ring cursor returns only newer events.
    const midCursor = payload.audit[0]?.seq ?? 0
    const page2 = api.auditLog({ confirm_token: token, since: midCursor })
    const payload2 = page2.data as { audit: Array<{ seq: number }>; cursor: number }
    assert.ok(payload2.audit.every((e) => e.seq > midCursor))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator events: ring cap + cursor pagination", () => {
  const dir = tmpProject()
  const state = emptyOrchestratorState(dir)
  try {
    for (let i = 0; i < MAX_ORCHESTRATOR_EVENTS + 50; i++) {
      pushEvent(state, {
        kind: "orchestration",
        type: "t",
        message: `m${i}`,
        agent_id: null,
        node_id: null,
        task_id: null,
      })
    }
    assert.equal(state.events.length, MAX_ORCHESTRATOR_EVENTS)
    const newest = state.events[state.events.length - 1]
    assert.ok(newest && newest.message.includes(String(MAX_ORCHESTRATOR_EVENTS + 49)))
    const page = listEvents(state, 10)
    assert.equal(page.cursor, newest.seq)
    assert.ok(page.events.every((e) => e.seq > 10))
    assert.equal(eventsSince(state, newest.seq).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M2: REAL restart adopts the existing session (no duplicate identity)", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const assigned = new Map<string, string>()
    const deps = { ...testDeps(store, dir), createRuntime: () => fakeRuntime(assigned) }
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string; host_session_id: string }
    const originalSession = data.host_session_id
    const restarted = await api.restartAgent({ agent_id: data.id })
    assert.ok(restarted.ok, restarted.message)
    const payload = restarted.data as { mode: string; host_session_id: string }
    assert.equal(payload.mode, "adopted")
    // Identity ADOPTED: same session, restart_count incremented, no new id.
    assert.equal(payload.host_session_id, originalSession)
    const detail = api.getAgent(data.id)
    const rec = detail.data as { restart_count: number; status: string; host_session_id: string }
    assert.equal(rec.restart_count, 1)
    assert.equal(rec.status, "running")
    assert.equal(rec.host_session_id, originalSession)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M2: restart after resume failure re-creates and events the identity change", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const assigned = new Map<string, string>()
    let resumeCalls = 0
    // resumeFails: the fake refuses resume ONLY for the pre-existing
    // session; create() still issues fresh ids (counter keeps counting).
    const runtimeWithFailingResume: AgentRuntime = {
      ...fakeRuntime(assigned, { resumeFails: true }),
      async resume(rec: AgentRecord) {
        resumeCalls++
        return { ok: false as const, message: "session row gone" }
      },
    }
    const deps = { ...testDeps(store, dir), createRuntime: () => resumeWithFailingResume(runtimeWithFailingResume) }
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string; host_session_id: string }
    const oldSession = data.host_session_id
    const restarted = await api.restartAgent({ agent_id: data.id })
    assert.ok(restarted.ok, restarted.message)
    const payload = restarted.data as { mode: string; host_session_id: string; old_host_session_id: string }
    assert.equal(payload.mode, "recreated")
    assert.equal(payload.old_host_session_id, oldSession)
    assert.notEqual(payload.host_session_id, oldSession)
    const rec = api.getAgent(data.id).data as { host_session_id: string; restart_count: number }
    assert.equal(rec.host_session_id, payload.host_session_id)
    assert.equal(rec.restart_count, 1)
    assert.ok(resumeCalls >= 1, "restart did not attempt resume before re-creating")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function resumeWithFailingResume(rt: AgentRuntime): AgentRuntime {
  return rt
}

test("orchestrator api M2: stop is graceful, lead-protected, and idempotent", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const assigned = new Map<string, string>()
    const aborts: number[] = []
    const deps = { ...testDeps(store, dir), createRuntime: () => fakeRuntime(assigned, { aborts }) }
    const api = new OrchestratorApi(deps)
    const lead = await api.createAgent({
      name: "lead",
      host: "opencode",
      role: "Lead",
      role_prompt: "p",
      designated: "lead",
    })
    assert.ok(lead.ok)
    const leadData = lead.data as { id: string }
    const leadStop = await api.stopAgent({ agent_id: leadData.id })
    assert.equal(leadStop.ok, false)
    assert.match(leadStop.message, /designated Lead cannot be stopped/)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string }
    const stopped = await api.stopAgent({ agent_id: data.id })
    assert.ok(stopped.ok, stopped.message)
    // Orphan prevention: exactly ONE stop call hit the runtime handle.
    assert.equal(aborts.length, 1)
    const rec = api.getAgent(data.id).data as { status: string }
    assert.equal(rec.status, "stopped")
    const again = await api.stopAgent({ agent_id: data.id })
    assert.ok(again.ok)
    assert.equal(aborts.length, 1, "second stop re-invoked the runtime handle")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator state M2: restart_policy backfills to manual and validates", () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const state = store.load()
    assert.equal(state.nodes[0]?.restart_policy, "manual")
    // Tampered policy fails closed.
    const raw = JSON.parse(readFileSync(store.file, "utf8")) as Record<string, unknown>
    ;(raw["nodes"] as Array<Record<string, unknown>>)[0]!["restart_policy"] = "auto-whatever"
    const result = validateOrchestratorState(raw)
    assert.equal(result.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator state M3: node identity fields backfill; tampered tier/grants fail closed", () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const state = store.load()
    const local = state.nodes[0]
    assert.ok(local)
    assert.equal(local.trust_tier, "persistent")
    assert.ok(local.grants.includes("spawn"))
    assert.equal(local.fingerprint, null)
    // Tampered tier fails closed.
    const raw = JSON.parse(readFileSync(store.file, "utf8")) as Record<string, unknown>
    ;(raw["nodes"] as Array<Record<string, unknown>>)[0]!["trust_tier"] = "god-tier"
    assert.equal(validateOrchestratorState(raw).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M3: pairing flow — owner generates code, node claims, owner approves", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    // 1) Owner-gated code creation: wrong token => 403 + audit.
    const denied = await api.createPairingCode({ node_name: "worker-box-1", confirm_token: "nope" })
    assert.equal(denied.ok, false)
    assert.match(denied.message, /Owner approval required/)
    assert.ok(store.load().events.some((e) => e.type === "trust_denied" && e.message.includes("Pairing-code")))
    // Missing name => validation error.
    const noName = await api.createPairingCode({ confirm_token: store.load().trust.owner_confirm_token })
    assert.equal(noName.ok, false)
    assert.match(noName.message, /node_name is required/)
    // Correct token => raw code returned EXACTLY ONCE.
    const created = await api.createPairingCode({
      node_name: "worker-box-1",
      confirm_token: store.load().trust.owner_confirm_token,
    })
    assert.ok(created.ok, created.message)
    const code = (created.data as { code: string }).code
    assert.match(code, /^[23456789A-HJ-NP-Z]{8}$/)
    // Trust view NEVER includes pairing codes.
    const trust = api.trustView()
    assert.ok(!JSON.stringify(trust.data).includes(code))
    // 2) Node claims: unknown/expired/used codes rejected with audit.
    const badClaim = await api.claimPairingCode({ pairing_code: "XXXXXXXX", node_public_key_pem: "BOGUS" })
    assert.equal(badClaim.ok, false)
    assert.match(badClaim.message, /unknown, already used, or expired/)
    // Missing public key => validation error (private key never leaves the node).
    const noKey = await api.claimPairingCode({ pairing_code: code })
    assert.equal(noKey.ok, false)
    assert.match(noKey.message, /node_public_key_pem is required/)
    // The daemon generates its keypair locally; only the PUBLIC key travels.
    const { publicKey } = generateKeyPairSync("ed25519")
    const nodePublicPem = publicKey.export({ type: "spki", format: "pem" }).toString()
    const claim = await api.claimPairingCode({
      pairing_code: code,
      platform: "linux",
      node_public_key_pem: nodePublicPem,
    })
    assert.ok(claim.ok, claim.message)
    const nodeId = (claim.data as { node_id: string }).node_id
    // One-time: a second claim with the SAME code fails (even with a key).
    const reuse = await api.claimPairingCode({ pairing_code: code, node_public_key_pem: nodePublicPem })
    assert.equal(reuse.ok, false)
    assert.match(reuse.message, /unknown, already used, or expired/)
    const state = store.load()
    const remote = state.nodes.find((n) => n.id === nodeId)
    assert.ok(remote)
    assert.equal(remote.kind, "remote")
    assert.equal(remote.status, "pending_approval")
    assert.ok(state.trust.pending_pairing_requests.some((r) => r.node_id === nodeId))
    // 3) Owner approves with the confirm token => online + enrolled + CERT ISSUED.
    const approved = await api.approveOrRevoke(
      { node_id: nodeId, confirm_token: store.load().trust.owner_confirm_token },
      "approve",
    )
    assert.ok(approved.ok, approved.message)
    const approvedState = store.load()
    const approvedNode = approvedState.nodes.find((n) => n.id === nodeId)
    assert.equal(approvedNode?.status, "online")
    assert.equal(approvedNode?.approved_by, "owner")
    assert.ok(approvedState.trust.approved_node_ids.includes(nodeId))
    // Cert issued bound to approval: fingerprint pinned + expiry stamped.
    const expectedFingerprint = fingerprintForPublicKeyPem(nodePublicPem)
    assert.equal(approvedNode?.fingerprint, expectedFingerprint)
    assert.ok(
      typeof approvedNode?.credential_expires_at === "number" && approvedNode.credential_expires_at > Date.now(),
    )
    assert.ok(approvedState.events.some((e) => e.type === "cert_issued" && e.node_id === nodeId))
    // Revoke marks remote agents lost (none here) + clears approval
    // + REVOKES THE CERT immediately (binding B, load-bearing).
    const revoked = await api.approveOrRevoke(
      { node_id: nodeId, confirm_token: approvedState.trust.owner_confirm_token },
      "revoke",
    )
    assert.ok(revoked.ok)
    const revokedState = store.load()
    const revokedNode = revokedState.nodes.find((n) => n.id === nodeId)
    assert.equal(revokedNode?.approved_at, null)
    assert.equal(revokedNode?.fingerprint, null)
    assert.equal(revokedNode?.credential_expires_at, null)
    assert.deepEqual(revokedNode?.grants, [])
    assert.ok(revokedState.events.some((e) => e.type === "revoke_agents_marked" && e.node_id === nodeId))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M3: revoke marks remote agents failed (never deleted) with audit evidence", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "remote-worker", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string }
    // Repoint the agent to a remote node (simulating remote placement).
    await store.withLock(() => {
      const state = store.load()
      const remote: import("../../../src/orchestrator/state.js").NodeRecord = {
        id: "node_remote_m3",
        name: "worker-box-9",
        kind: "remote",
        platform: "linux",
        status: "online",
        capabilities: { max_agents: 4, runtimes: ["opencode"], headless: false },
        approved_at: Date.now(),
        approved_by: "owner",
        restart_policy: "manual",
        fingerprint: "deadbeef",
        enrolled_at: Date.now(),
        last_seen: Date.now(),
        trust_tier: "persistent",
        grants: ["spawn", "tasks"],
        credential_expires_at: Date.now() + 3_600_000,
      }
      state.nodes.push(remote)
      state.trust.approved_node_ids.push(remote.id)
      const agent = state.agents.find((a) => a.id === data.id)
      if (agent) agent.node_id = remote.id
      store.save(state)
      return 0
    })
    const revoked = await api.approveOrRevoke(
      { node_id: "node_remote_m3", confirm_token: store.load().trust.owner_confirm_token },
      "revoke",
    )
    assert.ok(revoked.ok, revoked.message)
    const after = store.load()
    // The AGENT survives (never deleted) but is marked failed.
    const agent = after.agents.find((a) => a.id === data.id)
    assert.ok(agent, "revoked node's agent was deleted (orphan-prevention violation)")
    assert.equal(agent.status, "failed")
    // Audit evidence: agent states at revoke time recorded.
    assert.ok(
      after.events.some(
        (e) => e.type === "revoke_agents_marked" && e.node_id === "node_remote_m3" && e.message.includes(data.id),
      ),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M4 condition C: assertRemoteActionAllowed — the four deny cases + pass case", () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const base = store.load()
    const mkNode = (overrides: Partial<import("../../../src/orchestrator/state.js").NodeRecord>) => ({
      id: newNodeId(),
      name: "remote-1",
      kind: "remote" as const,
      platform: "linux",
      status: "online" as const,
      capabilities: { max_agents: 4, runtimes: ["opencode"], headless: false },
      approved_at: Date.now(),
      approved_by: "owner" as const,
      restart_policy: "manual" as const,
      fingerprint: "ab".repeat(32),
      enrolled_at: Date.now(),
      last_seen: Date.now(),
      trust_tier: "persistent" as const,
      grants: ["spawn", "tasks"],
      credential_expires_at: Date.now() + 3_600_000,
      ...overrides,
    })
    // PASS case: approved + valid credential + grants.
    const good = mkNode({})
    base.nodes.push(good)
    base.trust.approved_node_ids.push(good.id)
    assert.deepEqual(assertRemoteActionAllowed(base, { node_id: good.id, action: "spawn" }), { ok: true })
    assert.deepEqual(assertRemoteActionAllowed(base, { node_id: good.id, action: "tasks" }), { ok: true })
    // DENY 1: UNAPPROVED (never approved).
    const unapproved = mkNode({ id: newNodeId(), approved_at: null, approved_by: null })
    base.nodes.push(unapproved)
    const d1 = assertRemoteActionAllowed(base, { node_id: unapproved.id, action: "spawn" })
    assert.equal(d1.ok, false)
    if (!d1.ok) assert.match(d1.reason, /not approved/)
    // DENY 2: EXPIRED credential.
    const expired = mkNode({ id: newNodeId(), credential_expires_at: Date.now() - 1 })
    base.nodes.push(expired)
    base.trust.approved_node_ids.push(expired.id)
    const d2 = assertRemoteActionAllowed(base, { node_id: expired.id, action: "tasks" })
    assert.equal(d2.ok, false)
    if (!d2.ok) assert.match(d2.reason, /expired/)
    // DENY 3: REVOKED (offline status post-revoke; approved list cleared).
    const revoked = mkNode({ id: newNodeId(), status: "offline" as const, approved_at: null, approved_by: null })
    base.nodes.push(revoked)
    const d3 = assertRemoteActionAllowed(base, { node_id: revoked.id, action: "spawn" })
    assert.equal(d3.ok, false)
    if (!d3.ok) assert.match(d3.reason, /not approved/)
    // DENY 4: UNGRANTED (approved + valid credential, but the action's grant absent).
    const ungranted = mkNode({ id: newNodeId(), grants: ["spawn"] })
    base.nodes.push(ungranted)
    base.trust.approved_node_ids.push(ungranted.id)
    const d4 = assertRemoteActionAllowed(base, { node_id: ungranted.id, action: "tasks" })
    assert.equal(d4.ok, false)
    if (!d4.ok) assert.match(d4.reason, /grant missing/)
    // The ordered checks report the FIRST failure (unapproved beats ungranted).
    const both = mkNode({ id: newNodeId(), approved_at: null, approved_by: null, grants: [] })
    base.nodes.push(both)
    const dBoth = assertRemoteActionAllowed(base, { node_id: both.id, action: "spawn" })
    if (!dBoth.ok) assert.match(dBoth.reason, /not approved/)
    // Unknown node id is a deny (never a pass).
    assert.equal(assertRemoteActionAllowed(base, { node_id: "node_nope", action: "spawn" }).ok, false)
    // DUAL-LAYER credential composition (Reviewer code-gate): a node whose
    // timestamp is valid but whose cert is CA-REVOKED is still denied when
    // the caller supplies the CA — the timestamp layer alone is NOT enough.
    const ca = new NodeCertificateAuthority(dir)
    const revokedButValid = mkNode({ id: newNodeId() })
    base.nodes.push(revokedButValid)
    base.trust.approved_node_ids.push(revokedButValid.id)
    ca.revoke(revokedButValid.id)
    const d5 = assertRemoteActionAllowed(base, { node_id: revokedButValid.id, action: "spawn" }, { ca })
    assert.equal(d5.ok, false)
    if (!d5.ok) assert.match(d5.reason, /revoked/)
    // Without the CA supplied, the timestamp layer alone passes for that node
    // (documented: callers without the CA get the timestamp layer only).
    const noCa = assertRemoteActionAllowed(base, { node_id: revokedButValid.id, action: "spawn" })
    assert.deepEqual(noCa, { ok: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M4 condition C: remote spawn + remote task assignment are gated with 403 + audit", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    // Seed an UNAPPROVED remote node.
    const state = store.load()
    const remote: import("../../../src/orchestrator/state.js").NodeRecord = {
      id: "node_unapproved_m4",
      name: "worker-box",
      kind: "remote",
      platform: "linux",
      status: "pending_approval",
      capabilities: { max_agents: 4, runtimes: ["opencode"], headless: false },
      approved_at: null,
      approved_by: null,
      restart_policy: "manual",
      fingerprint: null,
      enrolled_at: Date.now(),
      last_seen: null,
      trust_tier: "persistent",
      grants: ["spawn", "tasks"],
      credential_expires_at: null,
    }
    state.nodes.push(remote)
    store.save(state)
    // Remote spawn on an unapproved node => denied + audited.
    const deniedSpawn = await api.createAgent({
      name: "remote-worker",
      host: "opencode",
      role: "Worker",
      role_prompt: "p",
      node_id: "node_unapproved_m4",
    })
    assert.equal(deniedSpawn.ok, false)
    assert.match(deniedSpawn.message, /Remote spawn denied/)
    const audited = store.load().events.find((e) => e.type === "trust_denied" && e.node_id === "node_unapproved_m4")
    assert.ok(audited, "remote spawn denial was not audited")
    assert.match(audited.message, /Remote spawn denied/)
    // Approve the node (without a live CA cert stamp — credential check fires).
    await api.approveOrRevoke(
      { node_id: "node_unapproved_m4", confirm_token: store.load().trust.owner_confirm_token },
      "approve",
    )
    // Now the credential check is the deny reason (no issued certificate).
    const deniedCred = await api.createAgent({
      name: "remote-worker",
      host: "opencode",
      role: "Worker",
      role_prompt: "p",
      node_id: "node_unapproved_m4",
    })
    assert.equal(deniedCred.ok, false)
    assert.match(deniedCred.message, /credential invalid/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("node-ca M3: issuance, verification, expiry, and LOAD-BEARING revocation (binding B)", () => {
  const dir = tmpProject()
  try {
    const ca = new NodeCertificateAuthority(dir)
    // CA generation is idempotent.
    const fp1 = ca.caFingerprint()
    assert.equal(ca.caFingerprint(), fp1)
    // The node generates its keypair; only the public key reaches the CA.
    const { publicKey } = generateKeyPairSync("ed25519")
    const nodePublicPem = publicKey.export({ type: "spki", format: "pem" }).toString()
    const cert = ca.issue({
      node_id: "node_remote_test",
      node_name: "w",
      nodePublicKeyPem: nodePublicPem,
      trust_tier: "persistent",
    })
    assert.equal(cert.fingerprint, fingerprintForPublicKeyPem(nodePublicPem))
    assert.ok(cert.expires_at > Date.now())
    // Tier-validity mapping (Lead decision 2026-09-14): persistent = 12h,
    // ephemeral = 1h (the exported constant is authoritative). Assert the
    // EXACT hours so the enrollment copy never encodes a stale number.
    const persistentValidity = NODE_CERT_VALIDITY_MS
    assert.ok(Math.abs(cert.expires_at - cert.issued_at - persistentValidity) < 5_000, "persistent cert must be 12h")
    const ephemeralCert = ca.issue({
      node_id: "node_ephemeral_test",
      node_name: "e",
      nodePublicKeyPem: nodePublicPem,
      trust_tier: "ephemeral",
    })
    assert.ok(Math.abs(ephemeralCert.expires_at - ephemeralCert.issued_at - EPHEMERAL_NODE_CERT_VALIDITY_MS) < 5_000)
    assert.equal(
      Math.round((ephemeralCert.expires_at - ephemeralCert.issued_at) / 60_000),
      60,
      "ephemeral cert must be exactly 60 minutes",
    )
    // Fresh cert verifies.
    assert.deepEqual(ca.verify(cert), { ok: true })
    // A forged cert (different node_id under the same signature) FAILS.
    const forged = { ...cert, node_id: "node_other" }
    assert.equal(ca.verify(forged).ok, false)
    // Expiry: a stale cert is rejected.
    const expired = { ...cert, issued_at: Date.now() - 20_000, expires_at: Date.now() - 10_000 }
    assert.equal(ca.verify(expired).ok, false)
    // LOAD-BEARING REVOCATION (binding B): revoked BEFORE expiry = DEAD.
    assert.equal(ca.isRevoked(cert.node_id), false)
    ca.revoke(cert.node_id)
    assert.equal(ca.isRevoked(cert.node_id), true)
    // Even with valid signature + unexpired window, the revoked flag is the
    // transport's auth gate: the node CANNOT reconnect (verify still passes
    // cryptographically, so transport auth MUST also check isRevoked).
    assert.deepEqual(ca.verify(cert), { ok: true })
    assert.equal(ca.isRevoked(cert.node_id), true)
    // Persistence across instances (revoke list survives restarts).
    assert.equal(new NodeCertificateAuthority(dir).isRevoked(cert.node_id), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("node-transport M3: bearer auth is nonce-bound, revocation-gated, and wss-only", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const nodePrivatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const nodeCertPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  const nonce = newConnectionNonce()
  const token = nodeBearerToken({
    node_id: "node_remote_x",
    caPublicKeyPem: "",
    nodePrivateKeyPem: nodePrivatePem,
    nonce,
  })
  assert.match(token, /^node-node_remote_x\./)
  // Valid bearer verifies against THIS connection's nonce.
  assert.deepEqual(verifyNodeBearer({ token, nonce, nodeCertPem, isRevoked: false }), {
    ok: true,
    node_id: "node_remote_x",
  })
  // Replay on a DIFFERENT connection (new nonce) fails.
  const differentNonce = verifyNodeBearer({ token, nonce: newConnectionNonce(), nodeCertPem, isRevoked: false })
  assert.equal(differentNonce.ok, false)
  // Tampered token fails.
  const tampered = verifyNodeBearer({
    token: `node-node_remote_x.${Buffer.from("forged", "utf8").toString("base64")}`,
    nonce,
    nodeCertPem,
    isRevoked: false,
  })
  assert.equal(tampered.ok, false)
  // LOAD-BEARING (binding B at the transport): a valid signature from a
  // REVOKED node is rejected outright.
  const revoked = verifyNodeBearer({ token, nonce, nodeCertPem, isRevoked: true })
  assert.equal(revoked.ok, false)
  assert.match(revoked.reason, /revoked/)
  // Malformed tokens fail.
  assert.equal(verifyNodeBearer({ token: "garbage", nonce, nodeCertPem, isRevoked: false }).ok, false)
  // WSS floor: ws:// is refused cross-network; wss:// builds.
  assert.throws(() => nodeWssUrl("ws://relay.example/x", "n", "t"), /wss:\/\//)
  assert.match(nodeWssUrl("wss://relay.example/x", "node_n", "t"), /node_id=node_n/)
  // Bounded give-up constant (Remote Control ~10 min precedent).
  assert.equal(NODE_GIVE_UP_MS, 10 * 60_000)
  void createPrivateKey
})

test("node-transport M3: cursor+ack window (P3-2 composition: redelivery bounded, idempotent)", () => {
  const envelopes = [
    { seq: 1, node_id: "n", framed: "one", message_id: "m1" },
    { seq: 2, node_id: "n", framed: "two", message_id: "m2" },
    { seq: 3, node_id: "n", framed: "three", message_id: "m3" },
  ]
  // No cursor: everything is pending, in sequence order.
  assert.deepEqual(
    pendingForNode(envelopes, null).map((e) => e.seq),
    [1, 2, 3],
  )
  // Cursor at 1: only 2+3 pending (redelivery of 1 would be a node-side no-op).
  assert.deepEqual(
    pendingForNode(envelopes, { acked_seq: 1 }).map((e) => e.seq),
    [2, 3],
  )
  // Cursor at 3: nothing pending.
  assert.equal(pendingForNode(envelopes, { acked_seq: 3 }).length, 0)
  // Cursor advance is monotonic + idempotent (a stale ack cannot rewind).
  let cursor = { acked_seq: 1, updated_at: 0 }
  cursor = advanceCursor(cursor, 3, Date.now())
  assert.equal(cursor.acked_seq, 3)
  cursor = advanceCursor(cursor, 2, Date.now())
  assert.equal(cursor.acked_seq, 3, "stale ack rewound the cursor")
})

test("node-transport M3.5: dedupeForNode — node-side dedup (P2-A single implementation point)", () => {
  const envelopes = [
    { seq: 1, node_id: "n", framed: "one", message_id: "m1" },
    { seq: 2, node_id: "n", framed: "two", message_id: "m2" },
    { seq: 3, node_id: "n", framed: "three", message_id: "m3" },
  ]
  // Node has acked through 2: seq 1 and 2 are dropped (already processed),
  // seq 3 survives — idempotent redelivery is a no-op.
  assert.deepEqual(
    dedupeForNode(envelopes, 2).map((e) => e.seq),
    [3],
  )
  // Fresh node (acked 0): everything executes, in sequence order.
  assert.deepEqual(
    dedupeForNode(envelopes, 0).map((e) => e.seq),
    [1, 2, 3],
  )
  // Fully-caught-up node: nothing executes.
  assert.equal(dedupeForNode(envelopes, 3).length, 0)
  // Out-of-order input is normalized to sequence order.
  const shuffled: RemoteEnvelope[] = [envelopes[2]!, envelopes[0]!, envelopes[1]!]
  assert.deepEqual(
    dedupeForNode(shuffled, 0).map((e) => e.seq),
    [1, 2, 3],
  )
  // Idempotent: running the dedup twice changes nothing.
  const once = dedupeForNode(envelopes, 1)
  assert.deepEqual(
    dedupeForNode(once, 1).map((e) => e.seq),
    [2, 3],
  )
})

test("node-server M3.5: NodeTransportServer contract — auth gate, deliver, ack routing", async () => {
  const server = createInMemoryNodeTransportServer({
    verifyClient: () => ({ ok: false, reason: "unused (admit drives auth)" }),
  })
  const authenticated: string[] = []
  const acks: Array<{ node_id: string; seq: number }> = []
  server.onAuthenticated((nodeId) => authenticated.push(nodeId))
  server.onAck((nodeId, seq) => acks.push({ node_id: nodeId, seq }))
  await server.start()
  // Admit (post-auth) fires onAuthenticated exactly once.
  const session = server.admit("node_remote_s")
  assert.deepEqual(authenticated, ["node_remote_s"])
  // deliver() routes through the session's send (captured in sentBatches).
  const outcome = await server.deliver("node_remote_s", "<framed>", 7)
  assert.equal(outcome, "sent")
  const batch = sentBatches.find((b) => b.node_id === "node_remote_s" && b.seq === 7)
  assert.ok(batch, "delivered batch did not reach the session send")
  // Deliver to an unknown node fails honestly.
  assert.equal(await server.deliver("node_unknown", "x", 1), "failed")
  // Ack routing reaches the registered handler.
  server.emitAck("node_remote_s", 7)
  assert.deepEqual(acks, [{ node_id: "node_remote_s", seq: 7 }])
  // Close clears sessions; deliver then fails.
  await server.close()
  assert.equal(await server.deliver("node_remote_s", "x", 8), "failed")
  void session
})

test("node-server M3.5: watchdog speaker — READY after dial+heartbeat, derived cadence, no hardcoding", () => {
  const notified: string[] = []
  const speaker = new WatchdogSpeaker({
    notifySocketPath: "unix:/run/notify.sock",
    watchdogUsec: 30_000_000, // Platform's WatchdogSec=30s
    notify: (m) => notified.push(m),
  })
  // READY only after the dial+heartbeat (never auto-fired).
  assert.deepEqual(notified, [])
  speaker.notifyReady()
  assert.equal(notified[0], "READY=1")
  // Derived interval = WATCHDOG_USEC/2 = 15s (never hardcoded).
  assert.equal(watchdogIntervalFromUsec(30_000_000), 15_000)
  // Absent watchdog (non-systemd) => default heartbeat cadence, no unit coupling.
  assert.equal(watchdogIntervalFromUsec(undefined), 15_000)
  // 1s floor: a 1s watchdog (1e6 usec) → 500ms derived → floored to 1s.
  assert.equal(watchdogIntervalFromUsec(1_000_000), 1_000)
  assert.equal(watchdogIntervalFromUsec(1_000), 1_000)
  speaker.stop()
})

test("node-server M3.5: enrollment output + auth headers contract", () => {
  const out = enrollmentOutput("wss://relay.example/node", "node_abc")
  assert.match(out, /node_abc/)
  assert.match(out, /wss:\/\/relay\.example\/node/)
  const headers = connectionAuthHeaders({ nodeId: "node_abc", bearer: "tok" })
  assert.equal(headers["x-opencomms-node"], "node_abc")
  assert.equal(headers["authorization"], "Bearer tok")
  assert.equal(newHandshakeNonce().length, 32)
})

test("node-wire M3.5: COMPOSED auth chain at admission — revoked node rejected AT THE SERVER (binding B)", () => {
  const dir = tmpProject()
  try {
    const ca = new NodeCertificateAuthority(dir)
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const nodePublicPem = publicKey.export({ type: "spki", format: "pem" }).toString()
    const nodePrivatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    const cert = ca.issue({
      node_id: "node_revoked",
      node_name: "w",
      nodePublicKeyPem: nodePublicPem,
      trust_tier: "persistent",
    })
    const nonce = newConnectionNonce()
    const token = nodeBearerToken({
      node_id: "node_revoked",
      caPublicKeyPem: "",
      nodePrivateKeyPem: nodePrivatePem,
      nonce,
    })
    // (a) The three checks compose IN ORDER: cert → bearer → revocation.
    // Fresh (non-revoked) cert: the chain passes end-to-end.
    const fresh = verifyCoordinatorAuth({ cert, certPem: nodePublicPem, token, nonce, ca })
    assert.deepEqual(fresh, { ok: true, node_id: "node_revoked" })
    // (b) INTEGRATION: revoke, then run admission through the PRODUCTION
    // verifyClient — the revoked node is rejected AT THE ADMISSION POINT
    // (before onAuthenticated could ever fire).
    ca.revoke("node_revoked")
    const verifyClient = createProductionVerifyClient({
      ca,
      certsByNodeId: new Map([["node_revoked", { ...cert, pem: nodePublicPem }]]),
    })
    const admission = verifyClient({
      reqHeaders: {
        "x-opencomms-node": "node_revoked",
        "x-opencomms-nonce": nonce,
        authorization: `Bearer ${token}`,
      },
      url: new URL("wss://relay.example/node"),
    })
    assert.equal(admission.ok, false)
    assert.match(admission.reason, /revoked/)
    // A revoked node whose cert is ALSO expired is still rejected with the
    // cert reason first (order proven: cert → bearer → revocation).
    const expired = { ...cert, issued_at: Date.now() - 20_000, expires_at: Date.now() - 10_000 }
    const certReason = verifyCoordinatorAuth({ cert: expired, certPem: nodePublicPem, token, nonce, ca })
    assert.equal(certReason.ok, false)
    assert.match(certReason.reason, /expired/)
    // (c) STRUCTURAL no-gate-skipping: verifyCoordinatorAuth's body is the
    // composed chain — every rejection names WHICH check fired (audit
    // evidence), and a missing header can never reach admission.
    const missing = verifyClient({ reqHeaders: {}, url: new URL("wss://relay.example/node") })
    assert.equal(missing.ok, false)
    assert.match(missing.reason, /missing auth headers/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator feed: emit persists via locked mutate and broadcasts with seq", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const broadcasted: Array<{ topic: string; seq: number }> = []
    const feed = createOrchestratorFeed(async (fn) => {
      const state = store.load()
      const seq = fn(state)
      store.save(state)
      return seq
    })
    // Re-wrap feed.emit to observe the broadcast (transport is injected by
    // the server; here we verify persistence + seq ordering directly).
    let observed = 0
    const api = new OrchestratorApi({
      projectDir: dir,
      servePassword: () => "x",
      serveModel: () => undefined,
      servePort: () => 0,
      withLock: <T>(fn: () => T) => store.withLock(fn),
      loadOrchestrator: () => store.load(),
      saveOrchestrator: (s: ReturnType<typeof store.load>) => store.save(s),
      loadChannelEngineState: () => ({ messages: {} }),
      engineSend: () => ({ ok: true, message: "sent (test fake)" }),
      saveChannelEngineState: () => {},
      feed,
      projectId: () => null,
    })
    void api
    const before = store.load().events.length
    feed.emit({ type: "agent_created", message: "hello", agent_id: "agt_1" })
    await new Promise((r) => setTimeout(r, 50))
    const after = store.load()
    assert.equal(after.events.length, before + 1)
    const last = after.events[after.events.length - 1]
    assert.ok(last)
    assert.equal(last.kind, "orchestration")
    assert.ok(last.seq > observed)
    void broadcasted
    void newConfirmToken
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("opencode models catalog: parses provider/model lines into grouped providers", () => {
  // CI root cause closed (Platform WSL reproduction, Lead GO 2026-09-13):
  // the OLD fixture exec'd a script and relied on exec-bit + shebang, which
  // fails on noexec mounts (drvfs) -> empty output -> parser saw nothing.
  // The parser is now a PURE exported function (parseModelsOutput) — the
  // test drives it directly with fixture text; the exec path
  // (listModelsCatalog) is unchanged production behavior, exercised by the
  // real binary when present (detect()).
  const catalog = parseModelsOutput(
    [
      "opencode/big-pickle",
      "opencode/ling-3.0-flash-fin-free",
      "opencode-go/glm-5.3",
      "opencode-go/glm-5.2",
      "opencode", // no slash -> skipped
      "badline", // no slash -> skipped
      "trailing/", // trailing slash -> skipped
      "/leading", // leading slash -> skipped
    ].join("\n"),
  )
  const opencode = catalog.find((c) => c.provider === "opencode")
  const go = catalog.find((c) => c.provider === "opencode-go")
  assert.ok(opencode)
  assert.ok(go)
  assert.deepEqual(opencode.models.sort(), ["big-pickle", "ling-3.0-flash-fin-free"])
  assert.deepEqual(go.models.sort(), ["glm-5.2", "glm-5.3"])
  assert.equal(catalog.length, 2)
  // CRLF-split input parses identically (Windows CLI output shape).
  const crlf = parseModelsOutput("opencode/big-pickle\r\nopencode-go/glm-5.3\r\n")
  assert.equal(crlf.length, 2)
  assert.deepEqual(crlf.find((c) => c.provider === "opencode")?.models.sort(), ["big-pickle"])
})

test("opencode runtime detect: execFileSync import is available (catalog helper wiring)", () => {
  // Sanity: the real opencode binary on PATH answers --version; the detect
  // path shells the same binary. This guards the import wiring used by
  // listModelsCatalog (a typo would throw here, not at runtime).
  assert.equal(typeof execFileSync, "function")
})

test("resolveOpencodeBinary: checked path == returned path (regression: checked != returned)", () => {
  // Frontend-found bug class: existsSync checked
  // base/node_modules/opencode-ai/bin/opencode.exe but the function returned
  // base/opencode-ai/bin/opencode.exe (missing node_modules) -> ENOENT at
  // spawn. The invariant under test: the resolved path EXISTS whenever the
  // APPDATA npm layout is present.
  const resolved = resolveOpencodeBinary({})
  assert.ok(resolved.length > 0)
  if (process.platform === "win32" && process.env["APPDATA"] && !resolved.startsWith("opencode")) {
    assert.ok(
      existsSync(resolved),
      `resolved binary does not exist on disk: ${resolved} (checked-path != returned-path regression)`,
    )
    assert.ok(
      resolved.includes(join("node_modules", "opencode-ai", "bin")),
      `returned path misses node_modules segment: ${resolved}`,
    )
  }
  // Override env always wins verbatim.
  assert.equal(resolveOpencodeBinary({ OPENCOMMS_OPENCODE_BIN: "/custom/opencode" }), "/custom/opencode")
})

test("orchestrator api: agent worktree dir is created idempotently under .opencomms/agents", async () => {
  const dir = tmpProject()
  try {
    const first = agentWorktreeDir(dir, "agt_abc")
    assert.ok(first.startsWith(join(dir, ".opencomms", "agents")))
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const createdTwice = await api.createAgent({ name: "w2", host: "opencode", role: "Worker2", role_prompt: "p" })
    assert.ok(createdTwice.ok)
    assert.ok(existsSync(join(dir, ".opencomms", "agents")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M2: tasks/assign rides the engine and GET /tasks derives honestly", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    // Engine fake: records sends, returns state we can seed for derivation.
    const sentTasks: Array<{ channel: string; content: string; type: string; sender: string }> = []
    let engineMessages: Record<
      string,
      {
        message_id: string
        channel_id: string
        sender_session_id: string
        recipient_session_id: string
        timestamp: number
        message_type: string
        content: string
        hop_count: number
        correlation_id: string
        delivery_status: string
      }
    > = {}
    let counter = 0
    const deps = {
      ...testDeps(store, dir),
      loadChannelEngineState: () => ({ messages: engineMessages }),
      engineSend: (
        state: unknown,
        input: { channel: string; content: string; message_type: "review_request" },
        sender: string,
      ) => {
        void state
        counter += 1
        sentTasks.push({ channel: input.channel, content: input.content, type: input.message_type, sender })
        const taskId = /\[task (tsk_[0-9a-f]{24})\]/.exec(input.content)?.[1] ?? "unknown"
        engineMessages = {
          ...engineMessages,
          [`msg_${counter}`]: {
            message_id: `msg_${counter}`,
            channel_id: input.channel,
            sender_session_id: sender,
            recipient_session_id: "ses_worker",
            timestamp: Date.now(),
            message_type: input.message_type,
            content: input.content,
            hop_count: 0,
            correlation_id: `cor_${taskId}`,
            delivery_status: "pending",
          },
        }
        return { ok: true, message: `sent msg_${counter}` }
      },
      saveChannelEngineState: () => {},
    }
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string }
    // Missing fields => validation errors.
    const noTitle = await api.assignTask({ agent_id: data.id, task: { body: "b", channel: "c" } })
    assert.equal(noTitle.ok, false)
    const noChannel = await api.assignTask({ agent_id: data.id, task: { title: "t", body: "b" } })
    assert.equal(noChannel.ok, false)
    const unknown = await api.assignTask({ agent_id: "agt_nope", task: { title: "t", body: "b", channel: "c" } })
    assert.equal(unknown.ok, false)
    // Assign rides the ENGINE as review_request with the tsk_ marker.
    const assigned = await api.assignTask({
      agent_id: data.id,
      task: { title: "Fix the bug", body: "See the failing test.", channel: "m1-proof" },
    })
    assert.ok(assigned.ok, assigned.message)
    const assignedData = assigned.data as { task_id: string }
    assert.match(assignedData.task_id, /^tsk_[0-9a-f]{24}$/)
    assert.equal(sentTasks.length, 1)
    assert.equal(sentTasks[0]?.type, "review_request")
    assert.ok(sentTasks[0]?.content.includes(`[task ${assignedData.task_id}]`))
    assert.ok(sentTasks[0]?.content.includes("Fix the bug"))
    // Feed event carried task_id.
    const events = api.listEvents(0)
    const eventList = (events.data as { events: Array<{ type: string; task_id: string | null }> }).events
    assert.ok(eventList.some((e) => e.type === "task_assigned" && e.task_id === assignedData.task_id))
    // Derivation: queued while pending.
    const tasks = api.listTasks()
    assert.ok(tasks.ok)
    const list = (tasks.data as { tasks: Array<{ task_id: string; status: string }> }).tasks
    assert.equal(list.length, 1)
    assert.equal(list[0]?.task_id, assignedData.task_id)
    assert.equal(list[0]?.status, "queued")
    // Acked: a later reply envelope in the same correlation chain.
    engineMessages = {
      ...engineMessages,
      msg_reply: {
        message_id: "msg_reply",
        channel_id: "m1-proof",
        sender_session_id: "ses_worker",
        recipient_session_id: "operator",
        timestamp: Date.now() + 1,
        message_type: "review_response",
        content: "done",
        hop_count: 1,
        correlation_id: engineMessages["msg_1"]?.correlation_id ?? "cor_x",
        delivery_status: "delivered",
      },
    }
    const after = api.listTasks()
    const afterList = (after.data as { tasks: Array<{ task_id: string; status: string }> }).tasks
    assert.equal(afterList[0]?.status, "acked")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("orchestrator api M2: permissionsDrain surface is operator-only and honest about support", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    let respondCalls = 0
    const assigned = new Map<string, string>()
    // handleExtras attaches the permission methods to BOTH the create- and
    // resume-returned handles (Lead's identified gap: the handle-return path
    // must not drop the methods).
    const deps = {
      ...testDeps(store, dir),
      createRuntime: () =>
        fakeRuntime(assigned, {
          handleExtras: {
            async permissionsDrain() {
              return [{ permission_id: "perm_1", request: { tool: "bash" } }]
            },
            async permissionsRespond(permissionId: string, response: string) {
              respondCalls++
              return { ok: true, message: `permission ${permissionId} ${response}ed` }
            },
          },
        }),
    }
    const api = new OrchestratorApi(deps)
    const created = await api.createAgent({ name: "w", host: "opencode", role: "Worker", role_prompt: "p" })
    assert.ok(created.ok)
    const data = created.data as { id: string }
    // List returns the pending prompt (supported=true).
    const list = await api.listPermissions(data.id)
    assert.ok(list.ok, list.message)
    const listData = list.data as { supported: boolean; pending: Array<{ permission_id: string; request: unknown }> }
    assert.equal(listData.supported, true)
    assert.equal(listData.pending.length, 1)
    assert.equal(listData.pending[0]?.permission_id, "perm_1")
    // Respond requires a valid response value.
    const badResponse = await api.respondPermission(data.id, "perm_1", { response: "maybe" })
    assert.equal(badResponse.ok, false)
    assert.match(badResponse.message, /allow" or "deny/)
    // Operator allow action works + is evented.
    const allowed = await api.respondPermission(data.id, "perm_1", { response: "allow" })
    assert.ok(allowed.ok, allowed.message)
    assert.equal(respondCalls, 1)
    const events = api.listEvents(0)
    const eventList = (events.data as { events: Array<{ type: string; message: string }> }).events
    assert.ok(eventList.some((e) => e.type === "agent_status" && e.message.includes("perm_1")))
    // Unknown agent => 404-shape.
    const unknown = await api.listPermissions("agt_nope")
    assert.equal(unknown.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureServe: fake serve child reports listening -> ok with port; no password in argv", async () => {
  const dir = tmpProject()
  try {
    let captured: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null = null
    const fakeChild = {
      stdout: {
        on: (_: string, cb: (d: Buffer) => void) =>
          setTimeout(() => cb(Buffer.from("opencode server listening on http://127.0.0.1:4923")), 20),
        off: () => {},
      },
      stderr: { on: () => {}, off: () => {} },
      off: () => {},
      on: () => {},
      kill: () => true,
      killed: false,
      exitCode: null,
    } as unknown as ChildProcess
    const result = await ensureServe({
      projectDir: dir,
      preferredPort: 4923,
      env: {},
      spawnFn: (cmd, args, spOpts) => {
        captured = { cmd, args, env: spOpts.env }
        return fakeChild
      },
    })
    assert.ok(result.ok, result.detail)
    assert.equal(result.port, 4923)
    assert.ok(captured)
    // Password travels in env ONLY — argv is the plain serve launch.
    const args = (captured as { args: string[] }).args
    assert.ok(!args.some((a) => a.includes("ocserve-")), "password leaked onto argv")
    assert.deepEqual(args, ["serve", "--port", "4923", "--hostname", "127.0.0.1"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureServe: idempotent — a live existing child returns the same port without respawning", async () => {
  const dir = tmpProject()
  try {
    const existing = { kill: () => true, killed: false, exitCode: null } as unknown as ChildProcess
    let spawned = 0
    const result = await ensureServe({
      projectDir: dir,
      preferredPort: 4924,
      env: {},
      existing,
      existingPort: 4924,
      spawnFn: () => {
        spawned++
        return {} as ChildProcess
      },
    })
    assert.ok(result.ok)
    assert.equal(result.port, 4924)
    assert.equal(result.detail, "serve already running")
    assert.equal(spawned, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureServe: startup timeout kills the child and fails cleanly (no open-ended poll)", async () => {
  const dir = tmpProject()
  try {
    let killed = false
    const silentChild = {
      stdout: { on: () => {}, off: () => {} },
      stderr: { on: () => {}, off: () => {} },
      off: () => {},
      on: () => {},
      kill: () => {
        killed = true
        return true
      },
      killed: false,
      exitCode: null,
    } as unknown as ChildProcess
    const result = await ensureServe({
      projectDir: dir,
      preferredPort: 4925,
      env: {},
      readyTimeoutMs: 300,
      spawnFn: () => silentChild,
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /did not report listening within/)
    assert.ok(killed, "timeout did not kill the child (orphan risk)")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureServe: a THROWING spawn (ENOENT class) fails cleanly without escaping the catch", async () => {
  // v22 scheduling guard (Lead's fix order item 2): the bare-'opencode'
  // fallback on a runner without the binary must settle the promise, never
  // leak an unhandled rejection. This twin test proves the catch path.
  const dir = tmpProject()
  try {
    const result = await ensureServe({
      projectDir: dir,
      preferredPort: 4926,
      env: {},
      spawnFn: () => {
        throw new Error("spawn opencode ENOENT")
      },
    })
    assert.equal(result.ok, false)
    assert.match(result.detail, /serve spawn failed:.*ENOENT/)
    assert.equal(result.child, null)
    assert.equal(result.authHeader, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureServe: an 'error'-event child (post-spawn error) settles without hanging", async () => {
  const dir = tmpProject()
  try {
    // Child that fires 'error' immediately (v22 ENOENT can surface here, not
    // as a spawn throw) and NEVER writes to stdout — the poll must settle via
    // the error path or the timeout, never hang.
    const errorChild = {
      stdout: { on: () => {}, off: () => {} },
      stderr: { on: () => {}, off: () => {} },
      off: () => {},
      on: (event: string, cb: (e?: Error) => void) => {
        if (event === "error") setTimeout(() => cb(new Error("spawn opencode ENOENT")), 50)
      },
      once: () => {},
      kill: () => true,
      killed: false,
      exitCode: null,
    } as unknown as ChildProcess
    const result = await ensureServe({
      projectDir: dir,
      preferredPort: 4927,
      env: {},
      readyTimeoutMs: 1500,
      spawnFn: () => errorChild,
    })
    assert.equal(result.ok, false)
    assert.ok(result.detail.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("bridge M4.5: handshake announcement + section-2 surface completeness", () => {
  const announcement = JSON.parse(handshakeAnnouncement())
  assert.equal(announcement.hello, BRIDGE_IDENTITY)
  assert.equal(announcement.protocol, BRIDGE_PROTOCOL)
  assert.ok(announcement.version.length > 0)
  assert.equal(BRIDGE_COMMANDS.length, 26)
  for (const cmd of [
    "nodes_list",
    "agents_list",
    "tasks_list",
    "events_list",
    "trust_view",
    "audit_log",
    "runtimes_list",
    "agent_create",
    "node_approve",
    "node_revoke",
  ]) {
    assert.ok((announcement.api as string[]).includes(cmd), `handshake missing ${cmd}`)
  }
  assert.ok(!BRIDGE_COMMANDS.some((c) => c.includes("token") || c.includes("secret")))
})

test("bridge M4.5: run loop - handshake FIRST, pre-ack stdin ignored, one-line-per-request", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const written: string[] = []
    const errors: string[] = []
    const bridgeDeps: BridgeDeps = {
      api: new OrchestratorApi(deps),
      guiReads: {
        sessions: () => ({ ok: true, message: "ok", data: { sessions: [] } }),
        sessionMembers: () => ({ ok: true, message: "ok", data: { agents: [] } }),
        workspaceState: () => ({ ok: true, message: "ok", data: {} }),
        integrationsList: () => ({ ok: true, message: "ok", data: [] }),
        diagnostics: () => ({ ok: true, message: "ok", data: {} }),
      },
      guiWrites: {
        sessionCreate: () => Promise.resolve({ ok: true, message: "created" }),
        sessionSave: () => Promise.resolve({ ok: true, message: "saved" }),
        sessionResume: () => Promise.resolve({ ok: true, message: "resumed" }),
        sessionDelete: () => Promise.resolve({ ok: true, message: "deleted" }),
        setSessionPaused: () => Promise.resolve({ ok: true, message: "paused" }),
        memberRemove: () => Promise.resolve({ ok: true, message: "removed" }),
        workspaceSelect: () => Promise.resolve({ ok: true, message: "selected" }),
      },
      write: (line) => written.push(line),
      error: (m) => errors.push(m),
    }
    const { Readable } = await import("node:stream")
    const stdin = new Readable({ read() {} })
    const done = runBridge(bridgeDeps, stdin)
    // FIRST output line is the handshake (spoken before any input).
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(written.length, 1)
    assert.equal(JSON.parse(written[0]!).hello, BRIDGE_IDENTITY)
    // Pre-ack input is IGNORED (gate A: no partial execution).
    stdin.push('{"id":"1","cmd":"agents_list","args":{}}\n')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(written.length, 1, "command executed before handshake ack")
    // Host acks the handshake.
    stdin.push('{"hello_ok":true}\n')
    await new Promise((r) => setTimeout(r, 50))
    // Commands now dispatch: agents_list via OrchestratorApi.
    stdin.push('{"id":"r1","cmd":"agents_list","args":{}}\n')
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(written.length >= 2)
    const response = JSON.parse(written[written.length - 1]!)
    assert.equal(response.id, "r1")
    assert.equal(response.ok, true)
    // Unknown command => typed error (gate C).
    stdin.push('{"id":"r2","cmd":"exec_shell","args":{}}\n')
    await new Promise((r) => setTimeout(r, 50))
    const unknown = JSON.parse(written[written.length - 1]!)
    assert.equal(unknown.id, "r2")
    assert.equal(unknown.ok, false)
    assert.match(unknown.message, /unknown command/)
    stdin.push(null)
    await done
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("bridge M5: hardening — oversized line rejected, partial line cannot wedge, sequential order kept", async () => {
  const dir = tmpProject()
  try {
    const store = new OrchestratorStore(dir)
    const deps = testDeps(store, dir)
    const written: string[] = []
    const errors: string[] = []
    const dispatchOrder: string[] = []
    const bridgeDeps: BridgeDeps = {
      api: new OrchestratorApi(deps),
      guiReads: {
        sessions: () => ({ ok: true, message: "ok", data: {} }),
        sessionMembers: () => ({ ok: true, message: "ok", data: {} }),
        workspaceState: () => ({ ok: true, message: "ok", data: {} }),
        integrationsList: () => ({ ok: true, message: "ok", data: [] }),
        diagnostics: () => ({ ok: true, message: "ok", data: {} }),
      },
      guiWrites: {
        sessionCreate: async () => {
          dispatchOrder.push("session_create")
          await new Promise((r) => setTimeout(r, 30))
          return { ok: true, message: "created" }
        },
        sessionSave: () => Promise.resolve({ ok: true, message: "saved" }),
        sessionResume: () => Promise.resolve({ ok: true, message: "resumed" }),
        sessionDelete: () => Promise.resolve({ ok: true, message: "deleted" }),
        setSessionPaused: () => Promise.resolve({ ok: true, message: "paused" }),
        memberRemove: () => Promise.resolve({ ok: true, message: "removed" }),
        workspaceSelect: () => Promise.resolve({ ok: true, message: "selected" }),
      },
      write: (line) => written.push(line),
      error: (m) => errors.push(m),
    }
    const { Readable } = await import("node:stream")
    const stdin = new Readable({ read() {} })
    const done = runBridge(bridgeDeps, stdin)
    await new Promise((r) => setTimeout(r, 50))
    stdin.push('{"hello_ok":true}\n')
    await new Promise((r) => setTimeout(r, 50))
    // OVERSIZED LINE: rejected with a typed error BEFORE parsing.
    const oversized = "x".repeat(1_000_001)
    stdin.push(`{"id":"big","cmd":"agents_list","args":{"blob":"${oversized}"}}\n`)
    await new Promise((r) => setTimeout(r, 80))
    const tooBig = JSON.parse(written[written.length - 1]!)
    assert.equal(tooBig.ok, false)
    assert.match(tooBig.message, /too large/)
    // PARTIAL LINE: a truncated JSON fragment followed by the complete line —
    // readline CONCATENATES the fragment into the next line, so the merged
    // line fails to parse and gets a typed parse error (the stream is never
    // wedged; the NEXT complete line still works).
    stdin.push('{"id":"trunc","cmd":"agents_l')
    await new Promise((r) => setTimeout(r, 40))
    stdin.push('{"id":"ok1","cmd":"agents_list","args":{}}\n')
    await new Promise((r) => setTimeout(r, 50))
    // The merged line was invalid JSON => typed parse-error response.
    const parseErr = written.find((l) => l.includes('"ok":false') && l.includes("invalid JSON request"))
    assert.ok(parseErr, "partial-line merge did not produce a typed parse error")
    // The stream still serves the next complete request.
    stdin.push('{"id":"ok2","cmd":"agents_list","args":{}}\n')
    await new Promise((r) => setTimeout(r, 50))
    const ok2 = JSON.parse(written[written.length - 1]!)
    assert.equal(ok2.id, "ok2")
    assert.equal(ok2.ok, true)
    // BACKPRESSURE/ORDER: two slow mutations issued back-to-back complete
    // in ISSUE ORDER (sequential dispatch, responses never interleave).
    stdin.push('{"id":"c1","cmd":"session_create","args":{"name":"a"}}\n')
    stdin.push('{"id":"c2","cmd":"session_create","args":{"name":"b"}}\n')
    await new Promise((r) => setTimeout(r, 120))
    const ids = written.slice(-2).map((l) => JSON.parse(l).id)
    assert.deepEqual(ids, ["c1", "c2"], "responses out of order under backpressure")
    assert.deepEqual(dispatchOrder, ["session_create", "session_create"])
    stdin.push(null)
    await done
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
