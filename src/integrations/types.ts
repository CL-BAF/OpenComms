/** Project scope permits file changes; machine scope is detection-only in the GUI. */

export type IntegrationScope = "project" | "machine"

export type IntegrationStatus = "absent" | "installed" | "outdated" | "broken"

export interface IntegrationContext {
  projectDir: string
  /** Current package version (e.g. "1.3.1") — compared against the marker. */
  currentVersion: string
}

export interface IntegrationDetection {
  status: IntegrationStatus
  installedVersion?: string | null
  currentVersion?: string | null
  details: string[]
  issues: string[]
}

export interface IntegrationReport {
  ok: boolean
  actions: string[]
  warnings: string[]
  capabilities: Record<string, string>
  changedFiles: string[]
}

export interface HostIntegration {
  id: string
  name: string
  scope: IntegrationScope
  detect(ctx: IntegrationContext): Promise<IntegrationDetection>
  install(ctx: IntegrationContext): Promise<IntegrationReport>
  update(ctx: IntegrationContext): Promise<IntegrationReport>
  repair(ctx: IntegrationContext): Promise<IntegrationReport>
  verify(ctx: IntegrationContext): Promise<IntegrationReport>
  /**
   * Remove ONLY OpenComms-owned entries (never state.json, pins/, or
   * unrelated user config). Idempotent: already-absent => ok:true no-op.
   * Report.changedFiles[] = exactly what was removed; Report.warnings[]
   * carries the standing caveat that state.json and pins/ are shared project
   * state and intentionally survive. Optional: adapters without it report
   * "uninstall unsupported by <id>" at the manager layer.
   */
  uninstall?(ctx: IntegrationContext): Promise<IntegrationReport>
}

/**
 * The ENTIRE issue string adapters emit for the unreplaced member-env
 * placeholder (structural contract): doctor checks
 * `issues.includes(PLACEHOLDER_ISSUE)` — never text matching against
 * arbitrary content. Adapters MUST emit this constant verbatim; doctor's
 * /placeholder/i test survives only as a legacy fallback.
 */
export const PLACEHOLDER_ISSUE = "member env placeholder not replaced — run opencomms install-member"

export function emptyDetection(overrides: Partial<IntegrationDetection> = {}): IntegrationDetection {
  return {
    status: "absent",
    installedVersion: null,
    currentVersion: null,
    details: [],
    issues: [],
    ...overrides,
  }
}

export function failureReport(message: string, capabilities: Record<string, string> = {}): IntegrationReport {
  return {
    ok: false,
    actions: [],
    warnings: [message],
    capabilities,
    changedFiles: [],
  }
}
