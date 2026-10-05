import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGuiServer, type GuiServerHandle } from "../../../src/gui/server.js"
import { StateStore } from "../../../src/core/store.js"
import { OrchestratorStore } from "../../../src/orchestrator/state.js"

test("emergency coordination state stays project-local and survives restart without unpausing unrelated operator pauses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-coordination-state-"))
  const a = join(dir, "project-a"),
    b = join(dir, "project-b")
  mkdirSync(a)
  mkdirSync(b)
  const previous = process.env["OPENCOMMS_CONFIG_DIR"]
  process.env["OPENCOMMS_CONFIG_DIR"] = join(dir, "config")
  let handle: GuiServerHandle | null = await startGuiServer({ projectDir: a, port: 0, hostname: "127.0.0.1" })
  const call = async (
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; message: string; data?: { coordination_stopped?: boolean } }> => {
    const response = await fetch(`http://127.0.0.1:${handle!.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const result = (await response.json()) as {
      ok: boolean
      message: string
      data?: { coordination_stopped?: boolean }
    }
    assert.ok(result.ok, result.message)
    return result
  }
  try {
    await call("/api/sessions", { name: "shared-name" })
    await call("/api/sessions", { name: "manually-paused" })
    await call("/api/sessions/manually-paused/pause", {})
    await call("/api/emergency-stop", {})
    assert.equal((await call("/api/capabilities")).data?.coordination_stopped, true)
    const aOrch = new OrchestratorStore(a)
    assert.deepEqual(aOrch.load().coordination, { stopped: true, emergency_paused_channels: ["shared-name"] })
    await call("/api/workspace", { path: b })
    assert.equal((await call("/api/capabilities")).data?.coordination_stopped, false)
    await call("/api/sessions", { name: "shared-name" })
    await call("/api/sessions/shared-name/pause", {})
    await call("/api/emergency-stop", { resume: true })
    assert.equal(
      new StateStore(b).load().channels["shared-name"]!.paused,
      true,
      "resume in B cannot unpause an identically named session from A",
    )
    await call("/api/workspace", { path: a })
    assert.equal((await call("/api/capabilities")).data?.coordination_stopped, true)
    await handle!.close()
    handle = null
    handle = await startGuiServer({ projectDir: a, port: 0, hostname: "127.0.0.1" })
    assert.equal((await call("/api/capabilities")).data?.coordination_stopped, true)
    await call("/api/emergency-stop", { resume: true })
    const resumed = new StateStore(a).load()
    assert.equal(resumed.channels["shared-name"]!.paused, false)
    assert.equal(resumed.channels["manually-paused"]!.paused, true)
    assert.deepEqual(aOrch.load().coordination, { stopped: false, emergency_paused_channels: [] })
  } finally {
    await handle?.close()
    if (previous === undefined) delete process.env["OPENCOMMS_CONFIG_DIR"]
    else process.env["OPENCOMMS_CONFIG_DIR"] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
