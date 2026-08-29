/**
 * Plugin wiring tests.
 *
 * Unit tests cover the engine; these invoke the actual plugin factory with a
 * stub client and call the tool execute functions — catching wrong-function
 * wiring that engine-only tests cannot see (Reviewer R4 follow-up: a fix
 * once landed in opencomms_history instead of opencomms_status).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCommsPlugin } from "../../src/plugin.js"

const SESSION_A = "sess_wiring_a"
const SESSION_B = "sess_wiring_b"
const OUTSIDER = "sess_wiring_outsider"
const PROJECT_ID = "proj_wiring"

type ToolMap = Record<string, { execute: (args: never, ctx: never) => Promise<string> }>

interface Harness {
  dir: string
  tools: ToolMap
  cleanup: () => void
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "oc-plugin-"))
  const hooks = (await (OpenCommsPlugin as (input: unknown) => Promise<unknown>)({
    client: {
      session: {
        get: async () => ({ data: { id: SESSION_A, parentID: undefined } }),
        prompt: async () => ({ data: null }),
      },
    },
    project: { id: PROJECT_ID },
    directory: dir,
    worktree: dir,
  })) as unknown as { tool: ToolMap }
  return { dir, tools: hooks.tool, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const ctxFor = (sessionID: string) => ({ sessionID }) as never

test("opencomms_status tool scopes the roster to the calling session", async () => {
  const h = await makeHarness()
  try {
    const created = JSON.parse(
      await h.tools["opencomms_create"]!.execute(
        { channel: "wiring", role: "Builder", role_prompt: "p" } as never,
        { sessionID: SESSION_A } as never,
      ),
    )
    assert.equal(created.ok, true, `create failed: ${created.message}`)

    const mine = JSON.parse(
      await h.tools["opencomms_status"]!.execute({ channel: undefined } as never, { sessionID: SESSION_A } as never),
    )
    assert.ok(Array.isArray(mine.data?.channels), "status must return a channels array")
    assert.equal(mine.data.channels.length, 1)
    assert.equal(mine.data.channels[0].name, "wiring")

    const outsider = JSON.parse(
      await h.tools["opencomms_status"]!.execute({ channel: "wiring" } as never, { sessionID: OUTSIDER } as never),
    )
    assert.equal(outsider.data?.channels?.length ?? 0, 0, "non-member must not see the roster")
  } finally {
    h.cleanup()
  }
})

test("opencomms_history tool returns message history, not a status report (R4 wiring regression)", async () => {
  const h = await makeHarness()
  try {
    JSON.parse(
      await h.tools["opencomms_create"]!.execute(
        { channel: "hist", role: "Builder", role_prompt: "p" } as never,
        { sessionID: SESSION_A } as never,
      ),
    )
    await h.tools["opencomms_join"]!.execute(
      { channel: "hist", role: "Reviewer", role_prompt: "p" } as never,
      { sessionID: SESSION_B } as never,
    )
    const sent = JSON.parse(
      await h.tools["opencomms_send"]!.execute(
        { channel: "hist", content: "wiring hello", to: "Reviewer" } as never,
        { sessionID: SESSION_A } as never,
      ),
    )
    assert.equal(sent.ok, true, `send failed: ${sent.message}`)

    const raw = await h.tools["opencomms_history"]!.execute(
      { channel: "hist", limit: 20 } as never,
      { sessionID: SESSION_A } as never,
    )
    const parsed = JSON.parse(raw)
    assert.equal(parsed.ok, true)
    assert.ok(Array.isArray(parsed.data?.messages), "history must return a messages array")
    assert.equal(parsed.data.messages.length, 1)
    assert.equal(parsed.data.messages[0].content, "wiring hello")
    assert.equal(parsed.data.channels, undefined, "history must not carry status fields")
  } finally {
    h.cleanup()
  }
})
