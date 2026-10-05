/**
 * Live OpenCode checks; skip when the configured server is unavailable.
 * Set OPENCODE_SERVER_URL, OPENCODE_SERVER_PASSWORD and OPENCOMMS_LIVE_PROJECT.
 * Autonomous delivery also needs OPENCODE_LIVE_MODEL=providerID/modelID.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createOpencodeClient } from "@opencode-ai/sdk"

const SERVER_URL = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096"
const SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD ?? ""
const PROJECT_DIR = process.env.OPENCOMMS_LIVE_PROJECT ?? ""
/** "providerID/modelID" for the autonomous-wake scenario (e.g. "openai/qwen3:0.6b"). */
const LIVE_MODEL = process.env.OPENCODE_LIVE_MODEL ?? ""

function parseModel(): { providerID: string; modelID: string } | null {
  if (!LIVE_MODEL.includes("/")) return null
  const [providerID = "", modelID = ""] = LIVE_MODEL.split("/", 2)
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

function authHeader(): string {
  return "Basic " + Buffer.from(`opencode:${SERVER_PASSWORD}`).toString("base64")
}

function client() {
  return createOpencodeClient({ baseUrl: SERVER_URL, headers: { Authorization: authHeader() } })
}

async function serverReachable(): Promise<boolean> {
  try {
    const res = await fetch(new URL("/session", SERVER_URL), {
      headers: { Authorization: authHeader() },
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok && Array.isArray(await res.json())
  } catch {
    return false
  }
}

async function promptSession(c: ReturnType<typeof client>, sessionId: string, text: string) {
  return c.session.prompt({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text }] },
  })
}

async function waitForToolResult(
  c: ReturnType<typeof client>,
  sessionId: string,
  toolName: string,
  timeoutMs = 60_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const msgs = await c.session.messages({ path: { id: sessionId } })
    const parts = (msgs.data ?? []).flatMap((m) => m.parts ?? [])
    const toolParts = parts.filter((p: any) => p.type === "tool" && p.tool === toolName)
    for (const tp of toolParts) {
      const state = (tp as any).state
      if (state && state.status === "completed" && state.output) {
        try {
          return JSON.parse(state.output)
        } catch {
          return { raw: state.output }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`Tool ${toolName} did not complete within ${timeoutMs}ms on session ${sessionId}`)
}

test("live: OpenCode server reachable, or suite skips", async (t) => {
  if (!(await serverReachable())) {
    t.skip("OpenCode server is unavailable or unauthenticated")
    return
  }
  assert.ok(true, "server reachable")
})

test("live: full Builder<->Reviewer acceptance flow", async (t) => {
  if (!(await serverReachable())) {
    t.skip("OpenCode server is unavailable or unauthenticated")
    return
  }
  if (!PROJECT_DIR) {
    t.skip("Set OPENCOMMS_LIVE_PROJECT to run the full live flow")
    return
  }
  const c = client()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // Scope both sessions to the project so their plugins share the same state.
  const bRes = await c.session.create({ body: { title: "ocm-live-builder" }, query: { directory: PROJECT_DIR } })
  const rRes = await c.session.create({ body: { title: "ocm-live-reviewer" }, query: { directory: PROJECT_DIR } })
  const builderId = bRes.data!.id
  const reviewerId = rRes.data!.id
  assert.ok(builderId, "builder session id recorded")
  assert.ok(reviewerId, "reviewer session id recorded")

  const bInfo = await c.session.get({ path: { id: builderId } })
  const rInfo = await c.session.get({ path: { id: reviewerId } })
  assert.ok(!bInfo.data!.parentID, "builder is root")
  assert.ok(!rInfo.data!.parentID, "reviewer is root")

  try {
    await promptSession(
      c,
      builderId,
      'Call opencomms_create with channel="live-feature", role="Builder", role_prompt="Implement requests and send completed work to Reviewer."',
    )
    const createRes = await waitForToolResult(c, builderId, "opencomms_create")
    assert.equal(createRes.ok, true, "create succeeded")

    const listAfterCreate = await c.session.list({})
    const ocmSessions = (listAfterCreate.data ?? []).filter((s) => s.directory === PROJECT_DIR)
    assert.equal(ocmSessions.length, 2, "no extra sessions created")

    await promptSession(
      c,
      reviewerId,
      'Call opencomms_join with channel="live-feature", role="Reviewer", role_prompt="Inspect Builder work and send findings."',
    )
    const joinRes = await waitForToolResult(c, reviewerId, "opencomms_join")
    assert.equal(joinRes.ok, true, "join succeeded")

    await promptSession(c, builderId, "Call opencomms_status")
    const statusRes = await waitForToolResult(c, builderId, "opencomms_status")
    const members = (statusRes.data as any).channels[0].members
    assert.equal(members.length, 2)
    const builderMember = members.find((m: any) => m.session_id === builderId)
    const reviewerMember = members.find((m: any) => m.session_id === reviewerId)
    assert.notEqual(builderMember.role_prompt, reviewerMember.role_prompt, "different role prompts")

    await promptSession(
      c,
      builderId,
      'Call opencomms_send with channel="live-feature", type="review_request", content="Implementation ready."',
    )
    const sendRes = await waitForToolResult(c, builderId, "opencomms_send")
    assert.equal(sendRes.ok, true, "builder send succeeded")

    await promptSession(c, reviewerId, 'Call opencomms_inbox with channel="live-feature"')
    const inboxRes = await waitForToolResult(c, reviewerId, "opencomms_inbox")
    assert.ok(
      (inboxRes.data as any).messages.some((m: any) => m.content.includes("Implementation ready")),
      "message reached reviewer inbox",
    )

    await promptSession(
      c,
      reviewerId,
      'Call opencomms_send with channel="live-feature", type="review_response", content="PASS."',
    )
    const replyRes = await waitForToolResult(c, reviewerId, "opencomms_send")
    assert.equal(replyRes.ok, true, "reviewer reply succeeded")
    await promptSession(c, builderId, 'Call opencomms_inbox with channel="live-feature"')
    const builderInbox = await waitForToolResult(c, builderId, "opencomms_inbox")
    assert.ok(
      (builderInbox.data as any).messages.some((m: any) => m.content.includes("PASS")),
      "reply reached builder inbox",
    )

    await promptSession(c, reviewerId, "Reply with the single word: OK")
    await sleep(3000)
    assert.ok(true, "reviewer independently promptable")

    await promptSession(c, builderId, 'Call opencomms_pause with channel="live-feature"')
    await waitForToolResult(c, builderId, "opencomms_pause")
    await promptSession(c, builderId, 'Call opencomms_send with channel="live-feature", content="paused message"')
    const pausedSend = await waitForToolResult(c, builderId, "opencomms_send")
    assert.equal(pausedSend.ok, false, "send rejected while paused")

    await promptSession(c, builderId, 'Call opencomms_resume with channel="live-feature"')
    await waitForToolResult(c, builderId, "opencomms_resume")

    await promptSession(c, builderId, 'Call opencomms_disconnect with channel="live-feature"')
    await waitForToolResult(c, builderId, "opencomms_disconnect")
    const bInfoAfter = await c.session.get({ path: { id: builderId } })
    const rInfoAfter = await c.session.get({ path: { id: reviewerId } })
    assert.ok(bInfoAfter.data, "builder session still exists after disconnect")
    assert.ok(rInfoAfter.data, "reviewer session still exists after disconnect")
  } finally {
    // Clean up: delete the test sessions we created. OpenComms never does this.
    try {
      await c.session.delete({ path: { id: builderId } })
    } catch {}
    try {
      await c.session.delete({ path: { id: reviewerId } })
    } catch {}
  }
})

/**
 * After the initial send, the test never prompts either session again.
 * The model must call tools; idle hooks own both automatic deliveries.
 */
test("live: two sessions exchange >=2 turns autonomously (no manual wake)", async (t) => {
  if (!(await serverReachable())) {
    t.skip("OpenCode server is unavailable or unauthenticated")
    return
  }
  const model = parseModel()
  if (!PROJECT_DIR || !model) {
    t.skip("Set OPENCOMMS_LIVE_PROJECT and OPENCODE_LIVE_MODEL=provider/model to run the wake scenario")
    return
  }
  const c = client()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const a = (await c.session.create({ body: { title: "ocm-live-wake-a" }, query: { directory: PROJECT_DIR } })).data!
  const b = (await c.session.create({ body: { title: "ocm-live-wake-b" }, query: { directory: PROJECT_DIR } })).data!
  try {
    // Register both members via real model turns.
    await c.session.prompt({
      path: { id: a.id },
      body: {
        model,
        parts: [
          {
            type: "text",
            text: `Call opencomms_create with channel="wake" role="Builder" role_prompt="Reply to any UNTRUSTED_PEER_MESSAGE by calling opencomms_send on channel wake with a short manual reply."`,
          },
        ],
      },
    })
    await waitForToolResult(c, a.id, "opencomms_create")
    await c.session.prompt({
      path: { id: b.id },
      body: {
        model,
        parts: [
          {
            type: "text",
            text: `Call opencomms_join with channel="wake" role="Reviewer" role_prompt="Reply to any UNTRUSTED_PEER_MESSAGE by calling opencomms_send on channel wake with a short manual reply."`,
          },
        ],
      },
    })
    await waitForToolResult(c, b.id, "opencomms_join")

    // After this send, neither session receives a manual wake.
    const t0 = Date.now()
    await c.session.prompt({
      path: { id: a.id },
      body: {
        model,
        parts: [
          {
            type: "text",
            text: `Call opencomms_send with channel="wake" type="manual" content="wake-ping". Then stop.`,
          },
        ],
      },
    })
    await waitForToolResult(c, a.id, "opencomms_send")

    const deadline = Date.now() + 180_000
    let bGot = false,
      bSent = false,
      aGot = false
    while (Date.now() < deadline && !(bGot && bSent && aGot)) {
      const bMsgs = await c.session.messages({ path: { id: b.id } })
      const bUser = (bMsgs.data ?? []).filter((m) => m.info?.role === "user").at(-1)
      if (!bGot) {
        const text = (bUser?.parts ?? [])
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n")
        if (text.includes("wake-ping")) bGot = true
      }
      if (bGot && !bSent) {
        const tools = (bMsgs.data ?? [])
          .flatMap((m) => m.parts ?? [])
          .filter(
            (p: any) =>
              p.type === "tool" &&
              p.tool === "opencomms_send" &&
              p.state?.status === "completed" &&
              (p.state?.time?.end ?? 0) >= t0,
          )
        if (tools.some((p: any) => (p.state?.output ?? "").includes('"ok":true'))) bSent = true
      }
      if (bSent && !aGot) {
        const aMsgs = await c.session.messages({ path: { id: a.id } })
        const aUser = (aMsgs.data ?? []).filter((m) => m.info?.role === "user").at(-1)
        const text = (aUser?.parts ?? [])
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n")
        if (text.includes("UNTRUSTED_PEER_MESSAGE")) aGot = true
      }
      await sleep(700)
    }
    console.log(`wake scenario: bGot=${bGot} bSent=${bSent} aGot=${aGot} in ${Date.now() - t0}ms`)
    assert.ok(bGot, "B must auto-receive the message with no manual wake")
    assert.ok(bSent, "B must reply via opencomms_send autonomously")
    assert.ok(aGot, "A must auto-receive B's reply with no manual wake")
  } finally {
    try {
      await c.session.delete({ path: { id: a.id } })
    } catch {}
    try {
      await c.session.delete({ path: { id: b.id } })
    } catch {}
  }
})
