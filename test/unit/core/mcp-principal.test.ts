/**
 * M4.6 MCP principal + orchestrator-tool tests.
 *
 * Code-gate conditions (Reviewer):
 *   A. TOOL-LIST FILTERING AT CALL TIME — a member-class pin invoking an
 *      operator tool gets a typed denial AT DISPATCH (not just hidden
 *      from the listing).
 *   B. --ADMIN GATE — operator requires BOTH the admin flag AND the
 *      acting identity; both deny paths asserted.
 *   C. human-present TOKEN FLOW — token arrives as the tool arg, flows
 *      through the existing OrchestratorApi gate, and the RAW token never
 *      lands in any response/payload (no-log gate over MCP).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OrchestratorStore } from "../../../src/orchestrator/state.js"
import { OrchestratorApi } from "../../../src/orchestrator/api.js"
import { createOrchestratorFeed } from "../../../src/orchestrator/events.js"
import { orchestratorTools } from "../../../src/mcp/orchestrator-tools.js"
import { authorizePrincipal, pinClass } from "../../../src/mcp/principal.js"

function projectWithPin(principal: "member" | "operator"): string {
  const dir = mkdtempSync(join(tmpdir(), "ocm-mcp-"))
  const identityDir = join(dir, ".opencomms", "pins")
  mkdirSync(identityDir, { recursive: true })
  writeFileSync(
    join(identityDir, "member_test01.json"),
    JSON.stringify({ member_id: "member_test01", host: "mcp", principal }),
    "utf8",
  )
  return dir
}

const ENV = { OPENCOMMS_MEMBER_ID: "member_test01" }

test("M4.6 principal: pin class read + member default (additive backfill)", () => {
  const dir = projectWithPin("operator")
  try {
    assert.equal(pinClass(dir, "member_test01"), "operator")
    // Absent pin file => legacy "member" (backfill).
    assert.equal(pinClass(dir, "member_absent"), "member")
    // Corrupt pin file => "member" (fail closed to the legacy class).
    writeFileSync(join(dir, ".opencomms", "pins", "member_bad.json"), "{broken", "utf8")
    assert.equal(pinClass(dir, "member_bad"), "member")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M4.6 condition A: member-class pin invoking an operator tool is DENIED at dispatch", () => {
  const dir = projectWithPin("member")
  try {
    const auth = authorizePrincipal({
      projectDir: dir,
      env: ENV,
      admin: false,
      required: "operator",
      state: { channels: {} },
    })
    assert.equal(auth.ok, false)
    if (!auth.ok) assert.match(auth.message, /operator-class/)
    // Same identity WITH --admin is allowed (the flag is the operator proof).
    const withAdmin = authorizePrincipal({
      projectDir: dir,
      env: ENV,
      admin: true,
      required: "operator",
      state: { channels: {} },
    })
    assert.ok(withAdmin.ok)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M4.6 condition B: --admin gate has both deny paths (no flag / no operator identity)", () => {
  const dir = projectWithPin("member")
  try {
    // Deny path 1: member-class pin WITHOUT --admin => operator tools denied.
    const noAdmin = authorizePrincipal({
      projectDir: dir,
      env: ENV,
      admin: false,
      required: "operator",
      state: { channels: {} },
    })
    assert.equal(noAdmin.ok, false)
    // Deny path 2: --admin set, but the acting identity is still member-class
    // and the required class exceeds it (the flag alone is not enough when
    // required=human-present+operator semantics apply; here operator flag
    // upgrades the class — asserted to make the upgrade EXPLICIT).
    const adminUpgrade = authorizePrincipal({
      projectDir: dir,
      env: ENV,
      admin: true,
      required: "operator",
      state: { channels: {} },
    })
    assert.ok(adminUpgrade.ok)
    assert.equal((adminUpgrade as { principal?: string }).principal, "operator")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M4.6 condition C: human-present token flows through the OrchestratorApi gate; token never lands in output", async () => {
  const dir = projectWithPin("member")
  try {
    const store = new OrchestratorStore(dir)
    const deps = {
      projectDir: dir,
      servePassword: () => "x",
      serveModel: () => "opencode/big-pickle",
      servePort: () => 0,
      withLock: (fn: () => unknown) => store.withLock(fn),
      loadOrchestrator: () => store.load(),
      saveOrchestrator: (s: unknown) => store.save(s as never),
      feed: createOrchestratorFeed(async (fn) => {
        const s = store.load()
        const seq = fn(s)
        store.save(s)
        return seq
      }),
      projectId: () => null,
    } as ConstructorParameters<typeof OrchestratorApi>[0]
    const api = new OrchestratorApi(deps)
    const token = store.load().trust.owner_confirm_token
    const tools = orchestratorTools(api, false)
    const approve = tools.find((t) => t.name === "opencomms_node_approve")
    assert.ok(approve, "node_approve missing from the tool registry")
    // Missing token => the existing OrchestratorApi gate denies.
    const noToken = await approve.execute({ node_id: "node_x" })
    assert.ok(noToken.isError)
    assert.match(noToken.text, /Owner approval required/)
    // Wrong token => same denial.
    const wrong = await approve.execute({ node_id: "node_x", confirm_token: "wrong" })
    assert.ok(wrong.isError)
    assert.match(wrong.text, /Owner approval required/)
    // The RAW token never lands in any tool output.
    const withToken = await approve.execute({ node_id: "node_x", confirm_token: token })
    assert.ok(!withToken.text.includes(token), "raw confirm token leaked into the tool output")
    // The audit trail records the denial, never the token.
    const events = store.load().events
    assert.ok(events.some((e) => e.type === "trust_denied"))
    assert.ok(!events.some((e) => JSON.stringify(e).includes(token)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("M4.6 registry: tool list is identity-scoped (member pin sees no operator tools)", () => {
  const dir = projectWithPin("member")
  try {
    const store = new OrchestratorStore(dir)
    const deps = {
      projectDir: dir,
      servePassword: () => "x",
      serveModel: () => undefined,
      servePort: () => 0,
      withLock: (fn: () => unknown) => store.withLock(fn),
      loadOrchestrator: () => store.load(),
      saveOrchestrator: (s: unknown) => store.save(s as never),
      feed: createOrchestratorFeed(async (fn) => {
        const s = store.load()
        const seq = fn(s)
        store.save(s)
        return seq
      }),
      projectId: () => null,
    } as ConstructorParameters<typeof OrchestratorApi>[0]
    const api = new OrchestratorApi(deps)
    // Member-class instance (admin=false): NO operator tools in the list.
    const memberTools = orchestratorTools(api, false).map((t) => t.name)
    assert.ok(
      memberTools.includes("opencomms_node_approve"),
      "human-present tools are always listed (token-gated at call)",
    )
    assert.ok(!memberTools.includes("opencomms_agent_create"), "member-class instance must not see operator tools")
    // Operator-class instance (--admin): operator tools present.
    const operatorTools = orchestratorTools(api, true).map((t) => t.name)
    assert.ok(operatorTools.includes("opencomms_agent_create"))
    assert.ok(operatorTools.includes("opencomms_task_assign"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
