/**
 * IntegrationManager (M1 + R1 hardening): registry + single entry point for
 * GUI/bridge/CLI.
 *
 * - Adapters are registered by id; register() overwrites on duplicate id so
 *   tests and late-binding hosts stay simple.
 * - Unknown ids on Report paths return ok:false (never throw). detect() with
 *   an unknown id throws (programmer error — the caller asked about a host
 *   that was never registered).
 * - Adapter throws are caught and mapped to Report{ok:false} / broken
 *   detections so one bad host can never crash listing or batch detection.
 * - update() is a smart dispatcher: absent -> install, broken -> repair,
 *   outdated (adapter status OR marker version < current) -> update,
 *   installed-but-marker-absent -> update (pre-1.x adoption, P2-4),
 *   otherwise a no-op ok Report. install/repair/verify delegate directly.
 *
 * Concurrency + marker discipline (R1/P2-3):
 * - Every mutating op (install/update/repair/verify) is serialized through
 *   an in-process async mutex AND invokes the adapter inside
 *   StateStore.withLock (cross-process `.state.lock`), so integration.json
 *   per-id updates take the same lock as project state. Adapter file
 *   mutations use synchronous FS calls throughout, hence they execute
 *   inside the lock's synchronous window (the codebase's withLock
 *   convention: sync bodies; async continuations are covered by the
 *   in-process mutex).
 * - Reads (detect/detectAll, dispatch-time marker checks) stay lock-free per
 *   the project's read convention (writes are atomic temp+rename).
 * - The manager itself only writes markers to ROLL BACK a failure: the
 *   pre-operation marker version is snapshotted under the lock, and when
 *   the adapter Report is ok:false (or the adapter throws) the snapshot is
 *   restored — so a failed op never leaves a success stamp, even if a
 *   misbehaving adapter stamped before failing. Untouched markers cause no
 *   write at all.
 */

import { StateStore } from "../core/store.js"
import {
  failureReport,
  type HostIntegration,
  type IntegrationContext,
  type IntegrationDetection,
  type IntegrationReport,
} from "./types.js"
import { compareVersions, getInstalledVersion, removeIntegrationMarker, updateIntegrationMarker } from "./versioning.js"

function adapterError(message: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return detail ? `${message}: ${detail}` : message
}

/** Marker read that never throws (versioning readers are already total). */
function safeInstalledVersion(projectDir: string, id: string): string | null {
  try {
    return getInstalledVersion(projectDir, id)
  } catch {
    return null
  }
}

export class IntegrationManager {
  private readonly adapters = new Map<string, HostIntegration>()
  /** In-process async mutex: chained so concurrent ops fully serialize. */
  private queue: Promise<void> = Promise.resolve()

  register(adapter: HostIntegration): void {
    this.adapters.set(adapter.id, adapter)
  }

  list(): HostIntegration[] {
    return [...this.adapters.values()]
  }

  get(id: string): HostIntegration | null {
    return this.adapters.get(id) ?? null
  }

  /** Detect a single registered host. Throws on unknown id; maps adapter throws to broken. */
  async detect(ctx: IntegrationContext, id: string): Promise<IntegrationDetection> {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new Error(`Unknown integration "${id}".`)
    try {
      return await adapter.detect(ctx)
    } catch (error) {
      return { status: "broken", details: [], issues: [adapterError(`Detection for "${id}" failed`, error)] }
    }
  }

  /** Detect every registered host; per-host failures become broken entries, never throws. */
  async detectAll(ctx: IntegrationContext): Promise<Record<string, IntegrationDetection>> {
    const out: Record<string, IntegrationDetection> = {}
    for (const adapter of this.adapters.values()) {
      try {
        out[adapter.id] = await adapter.detect(ctx)
      } catch (error) {
        out[adapter.id] = {
          status: "broken",
          details: [],
          issues: [adapterError(`Detection for "${adapter.id}" failed`, error)],
        }
      }
    }
    return out
  }

  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue
    let release = (): void => undefined
    this.queue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Restore the pre-operation marker when an op fails, so ok:false never
   * leaves a success stamp. Best effort and write-free when untouched.
   */
  private rollbackMarker(projectDir: string, id: string, before: string | null): void {
    let now: string | null
    try {
      now = getInstalledVersion(projectDir, id)
    } catch {
      return
    }
    if (now === before) return
    try {
      if (before === null) removeIntegrationMarker(projectDir, id)
      else updateIntegrationMarker(projectDir, id, { version: before })
    } catch {
      /* rollback is best effort; the ok:false Report already carries the failure */
    }
  }

  /**
   * Run one mutating adapter op under the in-process mutex + the project
   * StateStore lock, with failure rollback of the integration.json marker.
   */
  private async runGuarded(
    ctx: IntegrationContext,
    id: string,
    op: string,
    invoke: () => Promise<IntegrationReport>,
  ): Promise<IntegrationReport> {
    const adapter = this.adapters.get(id)
    if (!adapter) return failureReport(`Unknown integration "${id}".`)
    return this.serialized(() => {
      const store = new StateStore(ctx.projectDir)
      return store.withLock(() => {
        const before = safeInstalledVersion(ctx.projectDir, id)
        const guard = (report: IntegrationReport): IntegrationReport => {
          if (!report.ok) this.rollbackMarker(ctx.projectDir, id, before)
          return report
        }
        let pending: Promise<IntegrationReport>
        try {
          pending = invoke()
        } catch (error) {
          this.rollbackMarker(ctx.projectDir, id, before)
          return Promise.resolve(failureReport(adapterError(`${op} for "${id}" failed`, error)))
        }
        return pending.then(guard, (error: unknown) => {
          this.rollbackMarker(ctx.projectDir, id, before)
          return failureReport(adapterError(`${op} for "${id}" failed`, error))
        })
      })
    })
  }

  async install(ctx: IntegrationContext, id: string): Promise<IntegrationReport> {
    const adapter = this.adapters.get(id)
    if (!adapter) return failureReport(`Unknown integration "${id}".`)
    return this.runGuarded(ctx, id, "Install", () => adapter.install(ctx))
  }

  /**
   * Smart update: absent -> install, broken -> repair, outdated (adapter
   * status OR marker drift) -> update, installed-but-marker-absent ->
   * update (pre-1.x adoption, P2-4), otherwise a no-op ok Report.
   */
  async update(ctx: IntegrationContext, id: string): Promise<IntegrationReport> {
    const adapter = this.adapters.get(id)
    if (!adapter) return failureReport(`Unknown integration "${id}".`)
    let detection: IntegrationDetection
    try {
      detection = await adapter.detect(ctx)
    } catch (error) {
      return failureReport(adapterError(`Detection for "${id}" failed`, error))
    }
    if (detection.status === "absent") {
      return this.runGuarded(ctx, id, "Install", () => adapter.install(ctx))
    }
    if (detection.status === "broken") {
      return this.runGuarded(ctx, id, "Repair", () => adapter.repair(ctx))
    }
    // Artifacts present (installed/outdated): the marker decides between
    // drift-update, pre-1.x adoption (marker absent), and no-op.
    const markerVersion = safeInstalledVersion(ctx.projectDir, id)
    const drift = markerVersion !== null && compareVersions(markerVersion, ctx.currentVersion) < 0
    const adoption = markerVersion === null
    if (detection.status !== "outdated" && !drift && !adoption) {
      return {
        ok: true,
        actions: [`"${id}" already current (version ${ctx.currentVersion}).`],
        warnings: [],
        capabilities: {},
        changedFiles: [],
      }
    }
    return this.runGuarded(ctx, id, "Update", () => adapter.update(ctx))
  }

  async repair(ctx: IntegrationContext, id: string): Promise<IntegrationReport> {
    const adapter = this.adapters.get(id)
    if (!adapter) return failureReport(`Unknown integration "${id}".`)
    return this.runGuarded(ctx, id, "Repair", () => adapter.repair(ctx))
  }

  async verify(ctx: IntegrationContext, id: string): Promise<IntegrationReport> {
    const adapter = this.adapters.get(id)
    if (!adapter) return failureReport(`Unknown integration "${id}".`)
    return this.runGuarded(ctx, id, "Verify", () => adapter.verify(ctx))
  }

  /**
   * Optional lifecycle: delegates to the adapter's uninstall member when it
   * has one. Removing the marker (adapters do this themselves) makes
   * uninstall a MUTATING op, so it runs in the same runGuarded window as
   * install/update/repair/verify. Adapters without the member report
   * ok:false "uninstall unsupported" — honest, never a crash.
   */
  async uninstall(ctx: IntegrationContext, id: string): Promise<IntegrationReport> {
    const adapter = this.adapters.get(id)
    if (!adapter) return failureReport(`Unknown integration "${id}".`)
    const member = adapter.uninstall
    if (!member) return failureReport(`Uninstall unsupported by "${id}".`)
    return this.runGuarded(ctx, id, "Uninstall", () => member(ctx))
  }
}
