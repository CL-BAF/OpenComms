/**
 * Project integration version marker (M1).
 *
 * File: <project>/.opencomms/integration.json
 * Shape: { schema_version: 1, integrations: Record<id, Marker> }
 * Marker: { version, installed_at, updated_at, host_meta? }
 *
 * - Travels with the project (next to state.json), NOT in user preferences.
 * - Writes are atomic (temp file in the same directory + rename).
 * - Reads never throw: missing file, malformed JSON, or wrong shape all
 *   return null so callers fall back to the repair path instead of bricking.
 * - Per-id updates preserve every other id's marker.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { randomBytes } from "node:crypto"

export const CURRENT_INTEGRATION_SCHEMA_VERSION = 1

export const INTEGRATION_STATE_DIR = ".opencomms"
export const INTEGRATION_FILE_NAME = "integration.json"

export interface IntegrationMarker {
  version: string
  installed_at: number
  updated_at: number
  host_meta?: Record<string, unknown>
}

export interface IntegrationFile {
  schema_version: 1
  integrations: Record<string, IntegrationMarker>
}

export function integrationFilePath(projectDir: string): string {
  return join(resolve(projectDir), INTEGRATION_STATE_DIR, INTEGRATION_FILE_NAME)
}

export function emptyIntegrationFile(): IntegrationFile {
  return { schema_version: CURRENT_INTEGRATION_SCHEMA_VERSION, integrations: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isValidMarker(value: unknown): value is IntegrationMarker {
  if (!isRecord(value)) return false
  if (typeof value["version"] !== "string" || !value["version"]) return false
  if (typeof value["installed_at"] !== "number" || typeof value["updated_at"] !== "number") return false
  if (value["host_meta"] !== undefined && !isRecord(value["host_meta"])) return false
  return true
}

/**
 * Read the integration marker file. Returns null when the file is missing,
 * malformed, or fails shape validation — never throws.
 */
export function readIntegrationMarkers(projectDir: string): IntegrationFile | null {
  let raw: string
  try {
    const file = integrationFilePath(projectDir)
    if (!existsSync(file)) return null
    raw = readFileSync(file, "utf8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed["schema_version"] !== CURRENT_INTEGRATION_SCHEMA_VERSION) return null
  const integrations = parsed["integrations"]
  if (!isRecord(integrations)) return null
  const clean: Record<string, IntegrationMarker> = {}
  for (const [id, marker] of Object.entries(integrations)) {
    if (!id || !isValidMarker(marker)) return null
    clean[id] = {
      version: marker.version,
      installed_at: marker.installed_at,
      updated_at: marker.updated_at,
      ...(marker.host_meta !== undefined ? { host_meta: marker.host_meta } : {}),
    }
  }
  return { schema_version: CURRENT_INTEGRATION_SCHEMA_VERSION, integrations: clean }
}

/**
 * Compat alias for readIntegrationMarkers (same contract: null when
 * missing/malformed, never throws). Retained so adapter-layer tests and
 * older call sites keep compiling against one canonical reader.
 */
export function readIntegrationFile(projectDir: string): IntegrationFile | null {
  return readIntegrationMarkers(projectDir)
}

/** Atomic write (temp + rename) of the full marker file. */
export function writeIntegrationMarkers(projectDir: string, file: IntegrationFile): void {
  const target = integrationFilePath(projectDir)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.integration.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8")
  try {
    renameSync(temporary, target)
  } catch {
    // Windows AV/OneDrive can briefly hold a handle; fall back to a direct
    // write so the marker is never lost silently.
    writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, "utf8")
  }
}

/** Read a single id's marker; null when missing/malformed — never throws. */
export function getIntegrationMarker(projectDir: string, id: string): IntegrationMarker | null {
  try {
    const file = readIntegrationMarkers(projectDir)
    if (!file) return null
    const marker = file.integrations[id]
    return marker ?? null
  } catch {
    return null
  }
}

/**
 * Adapter-facing alias: installed version string for one host, or null when
 * absent/malformed. Never throws (malformed marker file reads as absent so
 * callers fall back to the repair path).
 */
export function getInstalledVersion(projectDir: string, id: string): string | null {
  return getIntegrationMarker(projectDir, id)?.version ?? null
}

/**
 * Adapter-facing alias: stamp one host's marker at `version`, preserving all
 * other ids. Creates or repairs the file as needed.
 */
export function setInstalledVersion(
  projectDir: string,
  id: string,
  version: string,
  host_meta?: Record<string, unknown>,
): void {
  updateIntegrationMarker(projectDir, id, { version, ...(host_meta !== undefined ? { host_meta } : {}) })
}

/**
 * Upsert one id's marker, preserving all other ids. Creates the file when
 * absent; repairs (replaces) it when malformed. Returns the file that was
 * written. Timestamps default to now; version defaults to currentVersion.
 */
export function updateIntegrationMarker(
  projectDir: string,
  id: string,
  opts: { version: string; host_meta?: Record<string, unknown>; now?: number },
): IntegrationFile {
  const now = opts.now ?? Date.now()
  const existing = readIntegrationMarkers(projectDir) ?? emptyIntegrationFile()
  const previous = existing.integrations[id]
  const next: IntegrationMarker = {
    version: opts.version,
    installed_at: previous?.installed_at ?? now,
    updated_at: now,
    ...(opts.host_meta !== undefined ? { host_meta: opts.host_meta } : {}),
  }
  const file: IntegrationFile = {
    schema_version: CURRENT_INTEGRATION_SCHEMA_VERSION,
    integrations: { ...existing.integrations, [id]: next },
  }
  writeIntegrationMarkers(projectDir, file)
  return file
}

/**
 * Remove one id's marker, preserving all other ids. No-op when the id (or
 * the file) is absent. Used by the manager's failure rollback so a failed
 * op never leaves a success stamp behind.
 */
export function removeIntegrationMarker(projectDir: string, id: string): IntegrationFile | null {
  const existing = readIntegrationMarkers(projectDir)
  if (!existing || !(id in existing.integrations)) return existing
  const rest: Record<string, IntegrationMarker> = { ...existing.integrations }
  delete rest[id]
  const file: IntegrationFile = { schema_version: CURRENT_INTEGRATION_SCHEMA_VERSION, integrations: rest }
  writeIntegrationMarkers(projectDir, file)
  return file
}

function parseVersionParts(value: string): [number, number, number] {
  // Leading "v" strip (Reviewer P3-1): GitHub tags like "v1.3.1" must
  // compare equal to "1.3.1" — same semantics src/cli/update.ts relied on.
  const core = value.trim().replace(/^v/, "").split("-")[0]?.split("+")[0] ?? ""
  const parts = core.split(".").map((p) => {
    const n = Number.parseInt(p, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/**
 * Semver-ish major/minor/patch comparison — SINGLE SOURCE OF TRUTH (Reviewer
 * P3-1; src/cli/update.ts imports this). Non-numeric segments and missing
 * parts count as 0 (NaN->0 parity with the old update.ts copy); prerelease/
 * build suffixes are ignored. Returns -1 | 0 | 1.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [aMajor, aMinor, aPatch] = parseVersionParts(a)
  const [bMajor, bMinor, bPatch] = parseVersionParts(b)
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1
  return 0
}
