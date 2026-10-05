/** Opt-in paid/authenticated vendor execution; protocol fixtures are separate unit tests. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { createAcpRuntime } from "../../src/orchestrator/runtimes/acp.js"
import {
  createHttpTransport,
  createOpencodeRuntime,
  lastAssistantText,
} from "../../src/orchestrator/runtimes/opencode.js"
import { formatUntrustedMessage } from "../../src/core/engine.js"
import type { MessageEnvelope } from "../../src/core/types.js"
import type { AgentRecord } from "../../src/orchestrator/state.js"

const optedIn = process.env.OPENCOMMS_VENDOR_LIVE === "1"
const host = process.env.OPENCOMMS_VENDOR_LIVE_HOST
function assignment(token: string): string {
  return formatUntrustedMessage(
    {
      message_id: "ocm_live",
      channel_id: "ch_live",
      sender_session_id: "operator_live",
      sender_role: "Operator",
      recipient_session_id: "managed_live",
      recipient_role: "Verifier",
      timestamp: Date.now(),
      message_type: "manual",
      content: `Reply with exactly ${token}. Do not call tools or change any files.`,
      reply_to: null,
      hop_count: 0,
      correlation_id: "cor_live",
      delivery_status: "pending",
      delivered_at: null,
      attempts: 0,
    } as MessageEnvelope,
    "live-verification",
  )
}

test(
  "LIVE managed ACP handshake/new/prompt/load preserves identity and receives a real agent text reply",
  { skip: !optedIn || host !== "acp", timeout: 240_000 },
  async () => {
    assert.ok(process.env.OPENCOMMS_ACP_COMMAND, "Configure an authenticated vendor ACP argv template first")
    assert.ok(
      !process.env.OPENCOMMS_ACP_COMMAND.includes("test/fixtures") &&
        !process.env.OPENCOMMS_ACP_COMMAND.includes("acp-agent.mjs"),
      "Protocol fixtures are not vendor live evidence",
    )
    assert.ok(process.env.OPENCOMMS_VENDOR_LIVE_PROJECT, "Select a real disposable project explicitly")
    const projectDir = resolve(process.env.OPENCOMMS_VENDOR_LIVE_PROJECT)
    let observed = ""
    const runtime = createAcpRuntime({
      projectDir,
      onSessionUpdate(params) {
        const payload = params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }
        if (payload.update?.sessionUpdate === "agent_message_chunk" && payload.update.content?.type === "text")
          observed = (observed + (payload.update.content.text ?? "")).slice(-100_000)
      },
    })
    try {
      const detected = await runtime.detect()
      assert.equal(detected.available, true, detected.detail)
      const created = await runtime.create({
        agent_id: "live",
        name: "OpenComms verification",
        role: "Verifier",
        role_prompt: "Answer the explicit verification message. Avoid all tools and file changes.",
        worktree: projectDir,
      })
      assert.ok(created.ok, created.ok ? "" : created.message)
      const token = `OPENCOMMS_LIVE_${randomBytes(8).toString("hex")}`
      assert.equal(await created.handle.deliver(assignment(token)), "delivered")
      assert.ok(observed.includes(token), "Real agent text must include the unique verification token")
      await created.handle.stop()
      const resumed = await runtime.resume({
        host_session_id: created.result.host_session_id,
        worktree: projectDir,
        role: "Verifier",
        role_prompt: "Preserve recorded identity",
      } as AgentRecord)
      assert.ok(resumed.ok, resumed.ok ? "" : resumed.message)
      assert.equal((await resumed.handle.status()).status, "idle")
    } finally {
      await runtime.shutdownNode()
    }
  },
)

test(
  "LIVE managed OpenCode create/accept/complete/resume observes an actual assistant reply",
  { skip: !optedIn || host !== "opencode", timeout: 240_000 },
  async () => {
    assert.ok(process.env.OPENCOMMS_VENDOR_LIVE_PROJECT, "Select a real disposable project explicitly")
    assert.ok(
      process.env.OPENCODE_SERVER_PASSWORD && process.env.OPENCODE_LIVE_MODEL,
      "Configure server authentication and provider/model explicitly",
    )
    const endpoint = new URL(process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096")
    assert.ok(
      endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname),
      "Vendor verification remains loopback-only",
    )
    const projectDir = resolve(process.env.OPENCOMMS_VENDOR_LIVE_PROJECT)
    const transport = createHttpTransport(
      endpoint.origin,
      process.env.OPENCODE_SERVER_PASSWORD,
      process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
      projectDir,
    )
    const runtime = createOpencodeRuntime({
      projectDir,
      port: Number(endpoint.port || "80"),
      transport,
      env: {
        ...process.env,
        OPENCOMMS_ORCH_SERVE_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
        OPENCOMMS_ORCH_SERVE_MODEL: process.env.OPENCODE_LIVE_MODEL,
      },
    })
    const created = await runtime.create({
      agent_id: "live",
      name: "OpenComms verification",
      role: "Verifier",
      role_prompt: "Only reply to explicit verification messages; do not call tools or change files.",
      worktree: projectDir,
    })
    assert.ok(created.ok, created.ok ? "" : created.message)
    try {
      const deadline = Date.now() + 180_000
      while ((await created.handle.status()).status !== "idle" && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 500))
      assert.equal((await created.handle.status()).status, "idle")
      const token = `OPENCOMMS_LIVE_${randomBytes(8).toString("hex")}`
      assert.equal(await created.handle.deliver(assignment(token)), "delivered")
      let text = ""
      while (Date.now() < deadline) {
        const latest = lastAssistantText(await transport.messages(created.result.host_session_id))
        if (latest.completed && latest.text.includes(token)) {
          text = latest.text
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      assert.ok(text.includes(token), "Real assistant completion must include the unique verification token")
      assert.ok(
        (await runtime.resume({ host_session_id: created.result.host_session_id, worktree: projectDir } as AgentRecord))
          .ok,
      )
    } finally {
      await created.handle.stop()
      await runtime.shutdownNode()
    }
  },
)
