/**
 * Codex adapter tests (Stage 7).
 *
 * The installer registers [mcp_servers.opencomms] in the project
 * .codex/config.toml. Verified 2026-08-29 (developers.openai.com/codex):
 * stdio via {command, args, env}; hooks are trust-gated (/hooks review).
 * External injection into TUI sessions: NOT documented — never attempted.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { installCodex, detectCodex, CODEX_CAPABILITIES } from "../../../src/adapters/codex/install.js"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("codex capability claims stay honest (PULL, no TUI push, app-server EXPERIMENTAL)", () => {
  assert.match(CODEX_CAPABILITIES["delivery"]!, /PULL/i)
  assert.match(CODEX_CAPABILITIES["existingSessionPush"]!, /UNSUPPORTED/i)
  assert.match(CODEX_CAPABILITIES["managedThreads"]!, /EXPERIMENTAL/i)
})

test("installCodex registers the MCP server section and copies the bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-codex-"))
  try {
    // dist bundle must exist for the copy path (built by test runbook).
    const distMain = join(process.cwd(), "dist", "mcp", "main.js")
    if (!existsSync(distMain)) {
      return // skipped implicitly when no dist; CI always builds first
    }
    const report = installCodex(dir)
    assert.equal(report.ok, true, report.warnings.join("; "))
    assert.ok(existsSync(join(dir, ".opencomms", "opencomms-mcp.mjs")), "mcp server copied")
    const toml = readFileSync(join(dir, ".codex", "config.toml"), "utf8")
    assert.ok(toml.includes("[mcp_servers.opencomms]"), "mcp_servers section registered")
    assert.ok(toml.includes('command = "node"'), "stdio command present")
    assert.ok(toml.includes("OPENCOMMS_MEMBER_ID"), "pin placeholder present")
    assert.ok(!toml.includes("[hooks]"), "no hooks registered silently (trust-gated in Codex)")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("installCodex is idempotent (second run does not duplicate the section)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-codex2-"))
  try {
    const distMain = join(process.cwd(), "dist", "mcp", "main.js")
    if (!existsSync(distMain)) return
    installCodex(dir)
    installCodex(dir)
    const toml = readFileSync(join(dir, ".codex", "config.toml"), "utf8")
    assert.equal(toml.split("[mcp_servers.opencomms]").length - 1, 1, "exactly one section")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("installCodex preserves an existing unrelated config.toml", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-codex3-"))
  try {
    const distMain = join(process.cwd(), "dist", "mcp", "main.js")
    if (!existsSync(distMain)) return
    mkdirSync(join(dir, ".codex"), { recursive: true })
    const preexisting = [
      'model = "gpt-5.2"',
      'approval_policy = "on-request"',
      "",
      "[mcp_servers.docs]",
      'command = "docs-server"',
    ].join("\n")
    writeFileSync(join(dir, ".codex", "config.toml"), preexisting, "utf8")
    installCodex(dir)
    const toml = readFileSync(join(dir, ".codex", "config.toml"), "utf8")
    assert.ok(toml.includes('model = "gpt-5.2"'), "existing keys preserved")
    assert.ok(toml.includes('approval_policy = "on-request"'), "existing keys preserved (2)")
    assert.ok(toml.includes("[mcp_servers.docs]"), "other MCP servers preserved")
    assert.ok(toml.includes("[mcp_servers.opencomms]"), "opencomms section appended")
    assert.ok(toml.indexOf("[mcp_servers.docs]") < toml.indexOf("[mcp_servers.opencomms]"), "append order stable")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("installCodex uses absolute paths + explicit cwd (no cwd assumptions)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-codex4-"))
  try {
    const distMain = join(process.cwd(), "dist", "mcp", "main.js")
    if (!existsSync(distMain)) return
    const report = installCodex(dir)
    assert.equal(report.ok, true)
    const toml = readFileSync(join(dir, ".codex", "config.toml"), "utf8")
    // args[0] absolute (escaped forward slashes), args[1] = absolute project dir.
    assert.ok(
      toml.includes(`"${join(dir, ".opencomms", "opencomms-mcp.mjs").replace(/\\/g, "/")}"`),
      "absolute server path in args",
    )
    assert.ok(toml.includes(`"${dir.replace(/\\/g, "/")}"`), "absolute project dir as args[1]")
    assert.ok(/cwd = "\."/.test(toml), "documented cwd option set explicitly")
    // Trusted-project warning surfaced.
    assert.ok(
      report.warnings.some((w) => w.includes("TRUSTED")),
      "trusted-project caveat surfaced",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("detectCodex returns a deterministic shape (detected or not) without throwing", () => {
  const result = detectCodex()
  assert.equal(typeof result.detected, "boolean")
  if (result.detected) assert.equal(typeof result.version, "string")
})
