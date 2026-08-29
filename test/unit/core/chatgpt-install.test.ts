/**
 * ChatGPT adapter tests (Stage 8) — honesty is the primary spec here.
 *
 * The adapter must never fake push, identity, or a working integration. The
 * scaffold must REFUSE unauthenticated public startup.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  scaffoldChatGptIntegration,
  CHATGPT_CAPABILITIES,
  detectChatGptDesktop,
} from "../../../src/adapters/chatgpt/install.js"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("chatgpt capability claims are honest (PULL-only, no push, no identity)", () => {
  assert.match(CHATGPT_CAPABILITIES["delivery"]!, /PULL/i)
  assert.match(CHATGPT_CAPABILITIES["existingConversationPush"]!, /UNSUPPORTED/i)
  assert.match(CHATGPT_CAPABILITIES["sessionIdentity"]!, /UNSUPPORTED/i)
  assert.match(CHATGPT_CAPABILITIES["roleInjection"]!, /UNSUPPORTED/i)
  assert.match(CHATGPT_CAPABILITIES["localBrokerExposure"]!, /FORBIDDEN/i)
})

test("scaffold refuses unauthenticated public startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-gpt-"))
  try {
    scaffoldChatGptIntegration(dir)
    const serverPath = join(dir, "opencomms-chatgpt", "mcp-streamable-server.mjs")
    assert.ok(existsSync(serverPath), "scaffold file written")
    const src = readFileSync(serverPath, "utf8")
    assert.ok(src.includes("OPENCOMMS_ALLOW_UNAUTHENTICATED"), "unauth guard present")
    assert.ok(src.includes("Refusing to run unauthenticated"), "explicit refusal")
    // Execute the guard logic against the compiled-free inline copy:
    const mod = await import(`file://${serverPath.replace(/\\/g, "/")}`)
    process.env["OPENCOMMS_PROJECT_DIR"] = dir
    delete process.env["OPENCOMMS_ALLOW_UNAUTHENTICATED"]
    assert.deepEqual(mod.assertConfiguration(), { projectDir: dir })
    process.env["OPENCOMMS_ALLOW_UNAUTHENTICATED"] = "1"
    assert.throws(() => mod.assertConfiguration(), /Refusing to run unauthenticated/)
    delete process.env["OPENCOMMS_ALLOW_UNAUTHENTICATED"]
    delete process.env["OPENCOMMS_PROJECT_DIR"]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scaffold documents the supported path and the forbidden one", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-gpt2-"))
  try {
    scaffoldChatGptIntegration(dir)
    const readme = readFileSync(join(dir, "opencomms-chatgpt", "README.md"), "utf8")
    assert.ok(readme.includes("PULL only"), "PULL documented")
    assert.ok(readme.includes("never port-forward"), "local exposure forbidden")
    assert.ok(readme.includes("OAuth 2.1 + PKCE"), "auth requirement documented")
    assert.ok(readme.includes("EXPERIMENTAL"), "honest labeling")
    assert.ok(readme.includes("developer mode"), "supported connection path documented")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("detectChatGptDesktop never scans private app data (returns not-detected)", () => {
  const result = detectChatGptDesktop()
  assert.equal(result.detected, false, "detection must not pretend (no documented API)")
})
