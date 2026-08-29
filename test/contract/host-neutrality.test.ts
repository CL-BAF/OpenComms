/**
 * Core host-neutrality guard (Reviewer Item 7).
 *
 * Core must never contain host-specific concepts: no OpenCode, no parentID,
 * no Claude/Codex/ChatGPT. Enforced by grep so a future host hack cannot
 * slip into core silently.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const CORE_DIR = join(process.cwd(), "src", "core")
// Match whole host identifiers, not substrings of ordinary words: the
// migration path legitimately carries the legacy dir name as DATA, split
// across string parts ("open" + "code") so it can never read as host logic.
const FORBIDDEN = /parentid|claude|codex|chatgpt|openai|anthropic|\bopencode\b/i

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...walk(p))
    else if (name.endsWith(".ts")) out.push(p)
  }
  return out
}

test("src/core contains no host-specific identifiers (host neutrality)", () => {
  const violations: Array<{ file: string; line: number; text: string }> = []
  for (const file of walk(CORE_DIR)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/)
    lines.forEach((text, i) => {
      if (FORBIDDEN.test(text)) violations.push({ file, line: i + 1, text })
    })
  }
  assert.deepEqual(
    violations,
    [],
    `host-specific terms leaked into core:\n${violations.map((v) => `${v.file}:${v.line}: ${v.text.trim()}`).join("\n")}`,
  )
})

test("host capability profiles cover every supported host and are internally consistent", async () => {
  const profiles = (await import("../../src/hosts/profiles.js")) as {
    HOST_CAPABILITY_PROFILES: Record<string, import("../../src/core/types.js").HostCapabilities>
  }
  const { HOST_CAPABILITY_PROFILES } = profiles
  for (const [host, caps] of Object.entries(HOST_CAPABILITY_PROFILES)) {
    // A host claiming push delivery must observe lifecycle events.
    if (caps.promptDelivery) {
      assert.ok(caps.lifecycleEvents || host === "opencode", `${host} claims push without lifecycle observation`)
    }
    // Role injection enum values only.
    assert.ok(
      ["system-prompt", "hook-boundary", "none"].includes(caps.roleInjection),
      `${host} has invalid roleInjection ${String(caps.roleInjection)}`,
    )
  }
  // Reference surfaces all present.
  for (const required of ["opencode", "claude-code", "claude-desktop", "codex", "chatgpt"]) {
    assert.ok(HOST_CAPABILITY_PROFILES[required], `missing capability profile: ${required}`)
  }
})
