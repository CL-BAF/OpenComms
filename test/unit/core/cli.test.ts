/**
 * Shared CLI tests (Stage 9, Reviewer spec):
 * - installer idempotency across hosts
 * - uninstall completeness WITHOUT destroying state (.opencomms/state.json survives)
 * - doctor output (detected hosts, versions, capabilities, no secrets)
 * - Windows paths with spaces
 * - version/status accuracy
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { isCliEntryPoint, runCli } from "../../../src/cli/main.js"
import { StateStore } from "../../../src/core/store.js"
import { createChannel, joinChannel } from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."))

test("CLI entry detection handles Node SEA double-click launches without argv[1]", () => {
  const exe = "C:/Users/test/AppData/Local/Programs/OpenComms/opencomms.exe"
  assert.equal(isCliEntryPoint("", undefined, exe, true), true)
  assert.equal(isCliEntryPoint(exe, exe, exe, true), true)
  assert.equal(isCliEntryPoint("C:/repo/dist/cli/main.js", "C:/repo/dist/cli/main.js", exe), true)
  assert.equal(isCliEntryPoint("", undefined, exe), false)
  assert.equal(isCliEntryPoint("C:/repo/test-runner.js", "C:/repo/test-runner.js", exe, true), false)
})

function mkProject(name = "oc-cli"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "oc-cli-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function seedState(dir: string): void {
  const store = new StateStore(dir)
  const state = emptyState()
  const created = createChannel(state, {
    channel: "cli-ch",
    role: "Builder",
    role_prompt: "p",
    session_id: "sess_cli_a",
    project_id: "proj-cli",
    worktree: dir,
    host: "opencode",
    surface: "cli",
    delivery_mode: "push",
  })
  assert.equal(created.ok, true)
  const joined = joinChannel(state, {
    channel: "cli-ch",
    role: "Reviewer",
    role_prompt: "p",
    session_id: "sess_cli_b",
    project_id: "proj-cli",
    worktree: dir,
    host: "claude-desktop",
    surface: "mcp",
    delivery_mode: "pull",
    stale_policy: { mode: "none", window_ms: null },
  })
  assert.equal(joined.ok, true)
  store.save(state)
}

test("version command reports the version and schema", () => {
  const r = runCli(["version"])
  assert.equal(r.code, 0)
  // Version derives from package.json (P3-4): read the same source of truth.
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }
  assert.match(r.output, new RegExp(`opencomms ${pkg.version.replace(/\./g, "\\.")}`))
  assert.match(r.output, /schema v2/)
})

test("status reports channels, members, hosts and delivery modes from real state", () => {
  const p = mkProject()
  try {
    seedState(p.dir)
    const r = runCli(["status", "--project", p.dir])
    assert.equal(r.code, 0)
    assert.match(r.output, /cli-ch/)
    assert.match(r.output, /Builder \(opencode, delivery: push\)/)
    assert.match(r.output, /Reviewer \(claude-desktop, delivery: pull\)/)
  } finally {
    p.cleanup()
  }
})

test("members command lists the roster for a member-scoped lookup", () => {
  const p = mkProject()
  try {
    seedState(p.dir)
    const r = runCli(["members", "cli-ch", "--project", p.dir])
    assert.equal(r.code, 0)
    assert.match(r.output, /Builder: host=opencode/)
    assert.match(r.output, /Reviewer: host=claude-desktop surface=mcp delivery=pull/)
  } finally {
    p.cleanup()
  }
})

test("doctor reports state, hosts and pin without printing secrets", () => {
  const p = mkProject()
  try {
    seedState(p.dir)
    // Installer writes a pin file with a member id + role label.
    mkdirSync(join(p.dir, ".opencomms"), { recursive: true })
    writeFileSync(
      join(p.dir, ".opencomms", "member-pin.json"),
      JSON.stringify({ member_id: "sess_secret_pin_value", host: "claude-code" }),
      "utf8",
    )
    const r = runCli(["doctor", "--project", p.dir])
    assert.equal(r.code, 0)
    assert.match(r.output, /Hosts:/)
    assert.match(r.output, /OpenCode/)
    assert.match(r.output, /Claude Code/)
    assert.match(r.output, /delivery: PULL ONLY/) // Desktop row present
    // No secrets: full member id value must not appear.
    assert.ok(!r.output.includes("sess_secret_pin_value"), "doctor must not print pin values")
  } finally {
    p.cleanup()
  }
})

test("doctor lists per-member pins and still hides member ids (P1-1)", () => {
  const p = mkProject()
  try {
    seedState(p.dir)
    mkdirSync(join(p.dir, ".opencomms", "pins"), { recursive: true })
    writeFileSync(
      join(p.dir, ".opencomms", "pins", "sess_pin_doctor_a.json"),
      JSON.stringify({ member_id: "sess_pin_doctor_a", host: "claude-code" }),
    )
    writeFileSync(
      join(p.dir, ".opencomms", "pins", "sess_pin_doctor_b.json"),
      JSON.stringify({ member_id: "sess_pin_doctor_b", host: "claude-code" }),
    )
    const r = runCli(["doctor", "--project", p.dir])
    assert.equal(r.code, 0)
    assert.match(r.output, /Member pins: 2/)
    assert.ok(!r.output.includes("sess_pin_doctor_a"), "doctor must not print per-member pin values")
  } finally {
    p.cleanup()
  }
})

test("install-member: blind second run refuses; explicit --id registers a second pin", () => {
  const p = mkProject()
  try {
    seedState(p.dir) // state.json must exist for member registration
    const first = runCli(["install-member", "--project", p.dir, "--host", "claude-code"])
    assert.equal(first.code, 0, first.output)
    assert.match(first.output, /pins\//, "pin path points at the per-member pins directory")

    const blind = runCli(["install-member", "--project", p.dir, "--host", "claude-code"])
    assert.equal(blind.code, 1, "blind second registration must fail")
    assert.match(blind.output, /--id/, "refusal must tell the operator how to proceed")

    const second = runCli([
      "install-member",
      "--project",
      p.dir,
      "--host",
      "claude-code",
      "--id",
      "sess_pin_cli_second",
    ])
    assert.equal(second.code, 0, second.output)
    assert.ok(existsSync(join(p.dir, ".opencomms", "pins", "sess_pin_cli_second.json")), "second member pin written")
    // First member's pin untouched.
    const pins = readdirSync(join(p.dir, ".opencomms", "pins")).filter((f) => f.endsWith(".json"))
    assert.equal(pins.length, 2, "two independent member pins coexist")
  } finally {
    p.cleanup()
  }
})

test("uninstall claude-code removes hooks but KEEPS state.json (state survival)", () => {
  const p = mkProject()
  try {
    seedState(p.dir)
    // Register hooks like the installer does.
    mkdirSync(join(p.dir, ".claude"), { recursive: true })
    writeFileSync(
      join(p.dir, ".claude", "settings.json"),
      JSON.stringify({
        model: "keep-me",
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: 'node "${CLAUDE_PROJECT_DIR}/.opencomms/claude-code-hooks.mjs" session-start',
                },
              ],
            },
          ],
        },
      }),
      "utf8",
    )
    const r = runCli(["uninstall", "claude-code", "--project", p.dir])
    assert.equal(r.code, 0)
    const settings = JSON.parse(readFileSync(join(p.dir, ".claude", "settings.json"), "utf8")) as {
      model?: string
      hooks?: Record<string, unknown[]>
    }
    assert.equal(settings.model, "keep-me", "unrelated keys untouched")
    const entries = (settings.hooks?.SessionStart ?? []) as unknown[]
    assert.equal(entries.length, 0, "opencomms hooks removed")
    assert.ok(existsSync(join(p.dir, ".opencomms", "state.json")), "STATE MUST SURVIVE uninstall")
  } finally {
    p.cleanup()
  }
})

test("uninstall codex removes only the opencomms section (other config survives)", () => {
  const p = mkProject()
  try {
    seedState(p.dir)
    mkdirSync(join(p.dir, ".codex"), { recursive: true })
    writeFileSync(
      join(p.dir, ".codex", "config.toml"),
      'model = "keep"\n\n[mcp_servers.docs]\ncommand = "docs"\n\n[mcp_servers.opencomms]\ncommand = "node"\n\n[mcp_servers.opencomms.env]\nA = "b"\n',
      "utf8",
    )
    const r = runCli(["uninstall", "codex", "--project", p.dir])
    assert.equal(r.code, 0)
    const toml = readFileSync(join(p.dir, ".codex", "config.toml"), "utf8")
    assert.ok(!toml.includes("[mcp_servers.opencomms]"), "opencomms section removed")
    assert.ok(toml.includes('model = "keep"'), "unrelated keys preserved")
    assert.ok(toml.includes("[mcp_servers.docs]"), "other mcp servers preserved")
    assert.ok(existsSync(join(p.dir, ".opencomms", "state.json")), "STATE MUST SURVIVE uninstall")
  } finally {
    p.cleanup()
  }
})

test("install claude-code is idempotent across re-runs", () => {
  const p = mkProject()
  try {
    const distMain = join(process.cwd(), "dist", "mcp", "main.js")
    if (!existsSync(distMain)) return
    const r1 = runCli(["install", "claude-code", "--project", p.dir])
    assert.equal(r1.code, 0, r1.output)
    const r2 = runCli(["install", "claude-code", "--project", p.dir])
    assert.equal(r2.code, 0)
    assert.match(r2.output, /idempotent/)
    // Hooks exactly once.
    const settings = JSON.parse(readFileSync(join(p.dir, ".claude", "settings.json"), "utf8")) as {
      hooks?: Record<string, Array<{ hooks: unknown[] }>>
    }
    assert.equal((settings.hooks?.SessionStart ?? []).length, 1)
    // .mcp.json exactly once.
    const mcp = JSON.parse(readFileSync(join(p.dir, ".mcp.json"), "utf8")) as Record<string, unknown>
    assert.equal(Object.keys(mcp["mcpServers"] as object).filter((k) => k === "opencomms").length, 1)
  } finally {
    p.cleanup()
  }
})

test("Windows paths with spaces work end-to-end (status/doctor/uninstall)", () => {
  const base = mkdtempSync(join(tmpdir(), "oc win "))
  const dir = join(base, "project with spaces")
  mkdirSync(join(dir, ".opencomms"), { recursive: true })
  try {
    const store = new StateStore(dir)
    const state = emptyState()
    const created = createChannel(state, {
      channel: "space-ch",
      role: "Builder",
      role_prompt: "p",
      session_id: "sess_sp",
      project_id: "proj",
      worktree: dir,
    })
    assert.equal(created.ok, true)
    store.save(state)

    const status = runCli(["status", "--project", dir])
    assert.equal(status.code, 0)
    assert.match(status.output, /space-ch/)

    const doctor = runCli(["doctor", "--project", dir])
    assert.equal(doctor.code, 0)

    const uninstall = runCli(["uninstall", "codex", "--project", dir])
    assert.equal(uninstall.code, 0)
    assert.ok(existsSync(join(dir, ".opencomms", "state.json")))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test("unknown command exits 1 with help pointer; help lists commands", () => {
  const bad = runCli(["bogus"])
  assert.equal(bad.code, 1)
  assert.match(bad.output, /help/)
  const help = runCli(["help"])
  assert.equal(help.code, 0)
  assert.match(help.output, /doctor/)
  assert.match(help.output, /install-member/)
  assert.match(help.output, /session/)
})
