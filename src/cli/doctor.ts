/**
 * Structured doctor backend (M2): the single diagnostics implementation
 * shared by `opencomms doctor [--fix]` (CLI dispatch lands in
 * `src/cli/main.ts`, owned by Lead) and the future GUI Integrations
 * surface (M3). Human-readable text output stays in `fmtDoctor`
 * (`src/cli/main.ts`); this module is the machine-readable backend both
 * consumers reuse so the two can never drift.
 *
 * Backend = the IntegrationManager from `src/integrations/registry.ts`
 * (all five hosts). No second diagnostics implementation, no network
 * calls, no new dependencies.
 *
 * Check semantics:
 * - checks[] reflect state observed during detection (pre-fix). `fixed[]`
 *   / `unfixable[]` describe what `--fix` did about it. A second run after
 *   successful repairs therefore shows clean checks with empty `fixed[]`
 *   (idempotent: nothing left to fix).
 * - ok = no check with status "fail" in THIS report. Warnings (absent
 *   integrations, missing CLIs, no pins) do not fail the run.
 * - "absent" integrations are NEVER installed implicitly (charter rule):
 *   --fix skips them entirely.
 * - Placeholder member env (P1-1: adapter issues mentioning "placeholder")
 *   lands in unfixable[] with install-member guidance; repair is not
 *   attempted (it would only reinstall the same placeholder) and
 *   install-member is never auto-run.
 * - Locking lives in the manager's runGuarded; doctor adds no second lock.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { StateStore } from "../core/store.js"
import { listMemberPins, type PinnedMember } from "../mcp/identity.js"
import { detectCodex } from "../adapters/codex/install.js"
import { detectClaudeCode } from "../adapters/claude-code/install.js"
import { detectChatGptDesktop } from "../adapters/chatgpt/install.js"
import { VERSION } from "../version.js"
import { createDefaultManager } from "../integrations/registry.js"
import { PLACEHOLDER_ISSUE } from "../integrations/types.js"
import type { IntegrationManager } from "../integrations/manager.js"
import type { IntegrationContext, IntegrationDetection } from "../integrations/types.js"

export type DoctorCheckStatus = "ok" | "warn" | "fail"

export interface DoctorCheck {
  id: string
  label: string
  status: DoctorCheckStatus
  detail: string
  fixable: boolean
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
  fixed: string[]
  unfixable: string[]
}

const PLACEHOLDER_PATTERN = /placeholder/i

function isPlaceholderBroken(detection: IntegrationDetection): boolean {
  // PRIMARY contract (Reviewer R2): structural equality against the shared
  // constant adapters emit verbatim. The /placeholder/i regex remains ONLY
  // as a legacy fallback for markers/issues written before the contract.
  if (detection.issues.includes(PLACEHOLDER_ISSUE)) return true
  return PLACEHOLDER_PATTERN.test([...detection.issues, ...detection.details].join(" "))
}

function failOf(id: string, label: string, detail: string, fixable: boolean): DoctorCheck {
  return { id, label, status: "fail", detail, fixable }
}

function hostCheck(id: string, label: string, detection: IntegrationDetection, currentVersion: string): DoctorCheck {
  switch (detection.status) {
    case "installed":
      return {
        id: `host:${id}`,
        label,
        status: "ok",
        detail: `installed${detection.installedVersion ? ` (${detection.installedVersion})` : ""}`,
        fixable: false,
      }
    case "absent":
      return {
        id: `host:${id}`,
        label,
        status: "warn",
        detail: `Not installed — run \`opencomms install ${id}\` to add it to this project.`,
        fixable: false,
      }
    case "outdated": {
      const have = detection.installedVersion ?? "unknown"
      return {
        id: `host:${id}`,
        label,
        status: "warn",
        detail: `installed ${have} < current ${currentVersion} (update available via \`opencomms doctor --fix\`)`,
        fixable: true,
      }
    }
    case "broken":
      return failOf(
        `host:${id}`,
        label,
        [...detection.issues, ...detection.details].join("; ") || "broken (no details reported)",
        !isPlaceholderBroken(detection),
      )
  }
}

function machineCheck(
  id: string,
  label: string,
  probe: () => { detected: boolean; version: string | null },
  missingDetail: string,
): DoctorCheck {
  try {
    const found = probe()
    if (found.detected) {
      return {
        id,
        label,
        status: "ok",
        detail: `detected${found.version ? ` (${found.version})` : ""}`,
        fixable: false,
      }
    }
    return { id, label, status: "warn", detail: missingDetail, fixable: false }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { id, label, status: "warn", detail: `detection failed (treated as missing): ${detail}`, fixable: false }
  }
}

function stateCheck(projectDir: string): DoctorCheck {
  try {
    const store = new StateStore(projectDir)
    const fresh = !existsSync(store.file)
    const state = store.load()
    return {
      id: "state",
      label: "Project state",
      status: "ok",
      detail: fresh
        ? "fresh project (no .opencomms/state.json yet)"
        : `.opencomms/state.json present (schema v${state.schema_version})`,
      fixable: false,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return failOf("state", "Project state", `state unreadable: ${detail}`, false)
  }
}

function pinsCheck(projectDir: string): DoctorCheck {
  let pins: PinnedMember[]
  try {
    pins = listMemberPins(projectDir)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return failOf("pins", "Member pins", `pin listing failed: ${detail}`, false)
  }
  if (pins.length === 0) {
    return {
      id: "pins",
      label: "Member pins",
      status: "warn",
      detail: "none — run `opencomms install-member` inside a host session to pin a member",
      fixable: false,
    }
  }
  const shown = pins
    .map((p) => `${p.member_id.slice(0, 12)}...`)
    .join(", ")
    .slice(0, 200)
  return { id: "pins", label: "Member pins", status: "ok", detail: `${pins.length} pinned (${shown})`, fixable: false }
}

function permsCheck(projectDir: string): DoctorCheck {
  const dir = join(projectDir, ".opencomms")
  const probe = join(dir, `.doctor-probe.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, "doctor write probe", "utf8")
    return {
      id: "perms",
      label: "Filesystem permissions",
      status: "ok",
      detail: ".opencomms/ is writable",
      fixable: false,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return failOf("perms", "Filesystem permissions", `.opencomms/ is not writable: ${detail}`, false)
  } finally {
    try {
      unlinkSync(probe)
    } catch {
      /* probe cleanup is best effort */
    }
  }
}

/**
 * Shared implementation; `manager` is injectable so tests can register a
 * throwing mock entry without touching the real five-host registry.
 */
export async function doctorReportWithManager(
  projectDir: string,
  opts: { fix: boolean },
  manager: IntegrationManager,
): Promise<DoctorReport> {
  const target = resolve(projectDir)
  const currentVersion = VERSION
  const ctx: IntegrationContext = { projectDir: target, currentVersion }
  const checks: DoctorCheck[] = [stateCheck(target)]
  const hostIds = manager.list().map((a) => ({ id: a.id, name: a.name }))

  for (const host of hostIds) {
    let detection: IntegrationDetection
    try {
      detection = await manager.detect(ctx, host.id)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      checks.push(failOf(`host:${host.id}`, host.name, `detection failed: ${detail}`, false))
      continue
    }
    checks.push(hostCheck(host.id, host.name, detection, currentVersion))
  }

  checks.push(
    machineCheck(
      "machine:codex",
      "Codex CLI",
      detectCodex,
      "not detected on PATH (project Codex config can still exist)",
    ),
    machineCheck(
      "machine:claude-code",
      "Claude Code CLI",
      detectClaudeCode,
      "not detected on PATH (project hooks/MCP config can still exist)",
    ),
    machineCheck(
      "machine:chatgpt",
      "ChatGPT Desktop",
      detectChatGptDesktop,
      "not directly detectable by design (no documented API); scaffold status is the project signal",
    ),
    pinsCheck(target),
    permsCheck(target),
  )

  const fixed: string[] = []
  const unfixable: string[] = []
  if (opts.fix) {
    for (const check of checks) {
      if (!check.id.startsWith("host:")) continue
      const id = check.id.slice("host:".length)
      const current = await safeDetect(manager, ctx, id)
      if (!current) continue
      if (current.status === "absent" || current.status === "installed") continue
      if (current.status === "broken" && isPlaceholderBroken(current)) {
        unfixable.push(
          `${id}: ${PLACEHOLDER_ISSUE} — run \`opencomms install-member --host ${id} --role <label>\` inside a host session to bind a member (never auto-run; repair would only reinstall the placeholder)`,
        )
        continue
      }
      if (!check.fixable) continue
      const action = current.status === "outdated" ? "update" : "repair"
      let report
      try {
        report = action === "update" ? await manager.update(ctx, id) : await manager.repair(ctx, id)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        unfixable.push(`${id}: ${action} threw: ${detail}`)
        continue
      }
      if (report.ok) fixed.push(`${action === "update" ? "updated" : "repaired"} ${id}: ${report.actions.join("; ")}`)
      else unfixable.push(`${id}: ${report.warnings.join("; ") || `${action} failed`}`)
    }
  }

  return { ok: checks.every((c) => c.status !== "fail") && unfixable.length === 0, checks, fixed, unfixable }
}

async function safeDetect(
  manager: IntegrationManager,
  ctx: IntegrationContext,
  id: string,
): Promise<IntegrationDetection | null> {
  try {
    return await manager.detect(ctx, id)
  } catch {
    return null
  }
}

/** Public entry: detection + optional fix against the canonical five-host registry. */
export async function doctorReport(projectDir: string, opts: { fix: boolean }): Promise<DoctorReport> {
  return doctorReportWithManager(projectDir, opts, createDefaultManager())
}
