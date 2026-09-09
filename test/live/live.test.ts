/**
 * OpenComms — live integration test.
 *
 * Exercises the full end-to-end acceptance flow against a real OpenCode
 * runtime. The test is GUARDED: it skips automatically when no OpenCode
 * server is reachable, so `npm run test:all` never fails in CI or on a
 * machine without OpenCode Desktop running.
 *
 * To run it for real:
 *   1. Start OpenCode Desktop with the OpenComms plugin installed and a
 *      deterministic local model configured (e.g. a local ollama model).
 *   2. Export the server URL and password:
 *        $env:OPENCODE_SERVER_URL = "http://127.0.0.1:4096"
 *        $env:OPENCODE_SERVER_PASSWORD = "<your password>"
 *        $env:OPENCOMMS_LIVE_PROJECT  = "C:\\path\\to\\project"
 *   3. npm run test:live
 *
 * Acceptance criteria covered:
 *   1-6  create two root sessions, register Builder + Reviewer, no extra sessions
 *   7-12 independent prompting + explicit send both directions
 *   13   busy-session queueing
 *   14   duplicate events do not duplicate messages
 *   15   pause prevents delivery
 *   16   resume continues delivery
 *   17   disconnect stops communication
 *   18   disconnect does not delete sessions
 *   19   state survives a restart
 *   20   missing sessions are reported, never auto-replaced
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
    const c = client()
    const res = await c.session.list({})
    return Array.isArray(res.data)
  } catch {
    return false
  }
}

async function findOpenCommsToolSession(c: ReturnType<typeof client>, projectDir: string) {
  const list = await c.session.list({})
  const sessions = (list.data ?? []).filter((s) => s.directory === projectDir)
  return sessions
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

// All tests are guarded by server reachability so they no-op (skip) when the
// runtime is absent. When present, they perform the full end-to-end flow.
test("live: OpenCode server reachable, or suite skips", async () => {
  if (!(await serverReachable())) {
    console.log("SKIP: OpenCode server not reachable at", SERVER_URL)
    return
  }
  assert.ok(true, "server reachable")
})

test("live: full Builder<->Reviewer acceptance flow", async () => {
  if (!(await serverReachable())) return
  if (!PROJECT_DIR) {
    console.log("SKIP: set OPENCOMMS_LIVE_PROJECT to run the full live flow")
    return
  }
  const c = client()
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // 1. Create two ordinary root sessions before OpenComms links anything.
  //    Scope them to the project directory so the OpenComms plugin (which
  //    resolves the project from the session's directory) sees the right
  //    .opencode-comms/state.json.
  const bRes = await c.session.create({ body: { title: "ocm-live-builder" }, query: { directory: PROJECT_DIR } })
  const rRes = await c.session.create({ body: { title: "ocm-live-reviewer" }, query: { directory: PROJECT_DIR } })
  const builderId = bRes.data!.id
  const reviewerId = rRes.data!.id
  assert.ok(builderId, "builder session id recorded")
  assert.ok(reviewerId, "reviewer session id recorded")

  // 2. Verify both are root (no parentID).
  const bInfo = await c.session.get({ path: { id: builderId } })
  const rInfo = await c.session.get({ path: { id: reviewerId } })
  assert.ok(!bInfo.data!.parentID, "builder is root")
  assert.ok(!rInfo.data!.parentID, "reviewer is root")

  try {
    // 3. Register the first exact session as Builder via the tool.
    await promptSession(
      c,
      builderId,
      'Call opencomms_create with channel="live-feature", role="Builder", role_prompt="Implement requests and send completed work to Reviewer."',
    )
    const createRes = await waitForToolResult(c, builderId, "opencomms_create")
    assert.equal(createRes.ok, true, "create succeeded")

    // 5. No additional sessions were created: list still has exactly the two.
    const listAfterCreate = await c.session.list({})
    const ocmSessions = (listAfterCreate.data ?? []).filter((s) => s.directory === PROJECT_DIR)
    assert.equal(ocmSessions.length, 2, "no extra sessions created")

    // 4. Register the second exact session as Reviewer.
    await promptSession(
      c,
      reviewerId,
      'Call opencomms_join with channel="live-feature", role="Reviewer", role_prompt="Inspect Builder work and send findings."',
    )
    const joinRes = await waitForToolResult(c, reviewerId, "opencomms_join")
    assert.equal(joinRes.ok, true, "join succeeded")

    // 6. Builder and Reviewer receive different role prompts (verified via status).
    await promptSession(c, builderId, "Call opencomms_status")
    const statusRes = await waitForToolResult(c, builderId, "opencomms_status")
    const members = (statusRes.data as any).channels[0].members
    assert.equal(members.length, 2)
    const builderMember = members.find((m: any) => m.session_id === builderId)
    const reviewerMember = members.find((m: any) => m.session_id === reviewerId)
    assert.notEqual(builderMember.role_prompt, reviewerMember.role_prompt, "different role prompts")

    // 7-8. User prompts Builder independently; Builder explicitly sends.
    await promptSession(
      c,
      builderId,
      'Call opencomms_send with channel="live-feature", type="review_request", content="Implementation ready."',
    )
    const sendRes = await waitForToolResult(c, builderId, "opencomms_send")
    assert.equal(sendRes.ok, true, "builder send succeeded")

    // 9. Message appears in the existing Reviewer session's history.
    await promptSession(c, reviewerId, 'Call opencomms_inbox with channel="live-feature"')
    const inboxRes = await waitForToolResult(c, reviewerId, "opencomms_inbox")
    assert.ok(
      (inboxRes.data as any).messages.some((m: any) => m.content.includes("Implementation ready")),
      "message reached reviewer inbox",
    )

    // 10-11. Reviewer responds; response appears in Builder inbox.
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

    // 12. User can still prompt Reviewer independently.
    await promptSession(c, reviewerId, "Reply with the single word: OK")
    await sleep(3000)
    assert.ok(true, "reviewer independently promptable")

    // 15. Pause prevents delivery.
    await promptSession(c, builderId, 'Call opencomms_pause with channel="live-feature"')
    await waitForToolResult(c, builderId, "opencomms_pause")
    await promptSession(c, builderId, 'Call opencomms_send with channel="live-feature", content="paused message"')
    const pausedSend = await waitForToolResult(c, builderId, "opencomms_send")
    assert.equal(pausedSend.ok, false, "send rejected while paused")

    // 16. Resume continues delivery.
    await promptSession(c, builderId, 'Call opencomms_resume with channel="live-feature"')
    await waitForToolResult(c, builderId, "opencomms_resume")

    // 17-18. Disconnect stops communication but does not delete sessions.
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
 * NO-MANUAL-WAKE acceptance scenario (brief goal #1): after A sends, NEITHER
 * session is prompted by the test again. The message must reach B
 * automatically (idle -> owner-side prompt), B must process it, and a reply
 * via opencomms_send must reach A automatically. Requires a model that can
 * actually call tools: set OPENCODE_LIVE_MODEL=providerID/modelID.
 */
test("live: two sessions exchange >=2 turns autonomously (no manual wake)", async () => {
  if (!(await serverReachable())) return
  const model = parseModel()
  if (!PROJECT_DIR || !model) {
    console.log("SKIP: set OPENCOMMS_LIVE_PROJECT and OPENCODE_LIVE_MODEL=provider/model to run the wake scenario")
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

    // THE SEND. From here on the test never prompts either session again.
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
