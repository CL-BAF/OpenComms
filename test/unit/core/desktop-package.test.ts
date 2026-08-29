/**
 * Claude Desktop packaging smoke test (Stage 6, Reviewer-mandated).
 *
 * Proves the .mcpb bundle layout would actually work: build the bundle
 * exactly as `mcpb pack` would zip it, then drive its self-contained server
 * over stdio as Claude Desktop would â€” initialize -> tools/call(pull) â€” and
 * verify the delivered message is framed untrusted and marked delivered.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildDesktopBundle,
  validateDesktopManifest,
  DESKTOP_CAPABILITIES,
} from "../../../src/adapters/claude-desktop/package.js"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname as pathDirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = pathDirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(join(here, "..", "..", "..", ".."))

test("manifest validates against the MCPB v0.3 essentials (documented 2026-08-29)", () => {
  const check = validateDesktopManifest(join(repoRoot, "adapters", "claude-desktop", "manifest.json"))
  assert.equal(check.ok, true, JSON.stringify(check))
})

test("desktop capability claims stay honest (PULL-only, no push/identity/roleInjection)", () => {
  assert.match(DESKTOP_CAPABILITIES["delivery"]!, /PULL/i)
  assert.match(DESKTOP_CAPABILITIES["existingConversationPush"]!, /UNSUPPORTED/i)
  assert.match(DESKTOP_CAPABILITIES["sessionIdentity"]!, /UNSUPPORTED/i)
  assert.match(DESKTOP_CAPABILITIES["roleInjection"]!, /UNSUPPORTED/i)
})

test("bundle layout + self-contained server end-to-end pull (packaging smoke)", async (t) => {
  // esbuild must be available for the self-contained bundle.
  const esbuildBin = join(repoRoot, "node_modules", "esbuild", "bin", "esbuild")
  if (!existsSync(esbuildBin)) {
    t.skip("esbuild not installed â€” run npm install")
    return
  }

  const project = mkdtempSync(join(tmpdir(), "oc-desktop-e2e-"))
  try {
    // Target project state: an Architect (claude-desktop, PULL member) with
    // a queued message from a peer.
    const now = Date.now()
    const state = {
      schema_version: 2,
      channels: {
        ch: {
          id: "chn_e2e",
          name: "ch",
          project_id: "p",
          worktree: project,
          created_at: now,
          paused: false,
          paused_at: null,
          members: [
            {
              session_id: "sess_pin_dt",
              role: "Architect",
              role_prompt: "p",
              joined_at: now,
              stale: false,
              stale_at: null,
              host: "claude-desktop",
              surface: "mcp",
              delivery_mode: "pull",
              host_session_id: null,
              stale_policy: { mode: "none", window_ms: null },
            },
          ],
          max_members: 8,
          rate: { window_start: now, count: 0 },
          cooldown_until: {},
          seen_content: {},
          processed_correlations: [],
          max_hops: 4,
          rate_limit: 20,
          delivery_cooldown_ms: 1000,
          stale_event_ms: 300_000,
          timer: {
            active_member_id: null,
            segment_started_at: null,
            elapsed_ms: {},
            limit_ms: null,
            limit_member_id: null,
          },
        },
      },
      messages: {
        ocm_e1: {
          message_id: "ocm_e1",
          channel_id: "chn_e2e",
          sender_session_id: "sess_peer",
          sender_role: "Builder",
          recipient_session_id: "sess_pin_dt",
          recipient_role: "Architect",
          timestamp: now - 1000,
          message_type: "manual",
          content: "desktop pull e2e payload",
          reply_to: null,
          hop_count: 0,
          delivery_status: "pending",
          correlation_id: "cor_e1",
          delivered_at: null,
          attempts: 0,
        },
      },
      queues: { sess_pin_dt: ["ocm_e1"] },
      delivered_to: {},
      errors: [],
    }
    mkdirSync(join(project, ".opencomms"), { recursive: true })
    writeFileSync(join(project, ".opencomms", "state.json"), JSON.stringify(state), "utf8")
    // Installer writes the pin file (opencomms install-member equivalent).
    writeFileSync(
      join(project, ".opencomms", "member-pin.json"),
      JSON.stringify({ member_id: "sess_pin_dt", host: "claude-desktop", saved_at: now }),
      "utf8",
    )

    // Build the bundle (manifest + self-contained server).
    const bundle = buildDesktopBundle({ projectDir: repoRoot, outDir: join(project, "bundle") })
    assert.equal(bundle.ok, true, bundle.warnings.join("; "))
    assert.ok(existsSync(join(bundle.bundleDir!, "manifest.json")))
    const serverPath = join(bundle.bundleDir!, "server", "main.mjs")
    assert.ok(existsSync(serverPath))

    // Drive the packaged server over stdio exactly as Claude Desktop would.
    const res = spawnSync(process.execPath, [serverPath, project, "--host", "claude-desktop"], {
      input:
        [
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "opencomms_pull", arguments: { channel: "ch" } },
          }),
        ].join("\n") + "\n",
      timeout: 30_000,
      encoding: "utf8",
      cwd: project,
      // Claude Desktop substitutes ${user_config.member_id} into env.
      env: { ...process.env, OPENCOMMS_MEMBER_ID: "sess_pin_dt" },
    })
    assert.equal(res.status, 0, `bundle server failed: ${res.stderr?.slice(0, 300)}`)
    const lines = (res.stdout ?? "").split(/\r?\n/).filter((l) => l.trim())
    const call = lines
      .map((l) => {
        try {
          return JSON.parse(l) as { id?: number; result?: { content?: Array<{ text?: string }> } }
        } catch {
          return null
        }
      })
      .find((rec) => rec?.id === 2)
    assert.ok(call, "tools/call(pull) must respond")
    const parsed = JSON.parse(call?.result?.content?.[0]?.text ?? "{}") as {
      ok: boolean
      data?: { messages: Array<{ framed: string }> }
    }
    assert.equal(parsed.ok, true)
    const framed = parsed.data?.messages?.[0]?.framed ?? ""
    assert.ok(framed.includes("desktop pull e2e payload"), "queued message must arrive through the packaged server")
    assert.ok(framed.includes("UNTRUSTED_PEER_MESSAGE"), "pull output must carry untrusted framing")

    // Delivered-on-read persisted in the target project.
    const after = JSON.parse(readFileSync(join(project, ".opencomms", "state.json"), "utf8")) as {
      messages: Record<string, { delivery_status: string }>
    }
    assert.equal(after.messages["ocm_e1"]?.delivery_status, "delivered")
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

function callRes(x: unknown) {
  return x
}
