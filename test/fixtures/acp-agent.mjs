// Deterministic protocol peer; contains no model and is not live vendor evidence.
import { createInterface } from "node:readline"
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
const log = join(process.cwd(), "acp-requests.jsonl")
const saved = join(process.cwd(), "acp-session.json")
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
let promptId
let sessionId
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  appendFileSync(log, line + "\n")
  const params = request.params ?? {}
  if (request.method === "initialize")
    return send({
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: !process.argv.includes("--no-load") },
        authMethods: [],
      },
    })
  if (request.method === "session/new") {
    sessionId = "fixture-managed-existing-identity"
    writeFileSync(saved, JSON.stringify({ sessionId, cwd: params.cwd }))
    return send({ id: request.id, result: { sessionId } })
  }
  if (request.method === "session/load") {
    const prior = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : null
    if (!prior || params.sessionId !== prior.sessionId || params.cwd !== prior.cwd)
      return send({ id: request.id, error: { code: -32000, message: "fixture identity/workspace mismatch" } })
    sessionId = prior.sessionId
    return send({ id: request.id, result: {} })
  }
  if (request.method === "session/prompt") {
    promptId = request.id
    if (process.argv.includes("--hang")) return
    if (process.argv.includes("--permission"))
      return send({
        id: "perm-one",
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: "tool-one", title: "fixture write" },
          options: [
            { optionId: "once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject", kind: "reject_once", name: "Reject once" },
          ],
        },
      })
    const update = {
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture-only reply" } },
      },
    }
    if (process.argv.includes("--fragmented-utf8")) {
      update.params.update.content.text = "fixture-only reply — café 🚀"
      const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...update }) + "\n")
      const split = frame.indexOf(Buffer.from("🚀")) + 2
      process.stdout.write(frame.subarray(0, split))
      setTimeout(() => {
        process.stdout.write(frame.subarray(split))
        send({ id: request.id, result: { stopReason: "end_turn" } })
      }, 15)
      return
    }
    send(update)
    return send({ id: request.id, result: { stopReason: "end_turn" } })
  }
  if (request.method === "session/cancel") {
    if (promptId !== undefined) send({ id: promptId, result: { stopReason: "cancelled" } })
    promptId = undefined
    return
  }
  if (request.id === "perm-one" && request.result && promptId !== undefined) {
    send({ id: promptId, result: { stopReason: "end_turn" } })
    promptId = undefined
  }
})
