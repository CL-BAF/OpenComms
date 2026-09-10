/**
 * App-level GUI preferences.
 *
 * Project state deliberately remains in each project's `.opencomms` folder.
 * This file only remembers which projects the local console should open and
 * a small amount of UI preference data. It is safe to discard at any time.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path"
import { randomBytes } from "node:crypto"

export interface WorkspacePreferences {
  schema_version: 1
  recent_projects: string[]
  pinned_projects: string[]
  last_project: string | null
  settings: {
    sidebar_collapsed?: boolean
  }
}

const MAX_RECENT_PROJECTS = 12

function appDataRoot(): string {
  if (process.platform === "win32") return process.env["LOCALAPPDATA"] || join(homedir(), "AppData", "Local")
  return process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config")
}

export function workspaceConfigDir(): string {
  if (process.env["OPENCOMMS_CONFIG_DIR"]) return resolve(process.env["OPENCOMMS_CONFIG_DIR"]!)
  return join(appDataRoot(), "OpenComms")
}

export function workspaceConfigFile(): string {
  return join(workspaceConfigDir(), "preferences.json")
}

export function emptyWorkspacePreferences(): WorkspacePreferences {
  return { schema_version: 1, recent_projects: [], pinned_projects: [], last_project: null, settings: {} }
}

export function loadWorkspacePreferences(): WorkspacePreferences {
  const fallback = emptyWorkspacePreferences()
  try {
    const parsed = JSON.parse(readFileSync(workspaceConfigFile(), "utf8")) as Partial<WorkspacePreferences>
    if (parsed.schema_version !== 1) return fallback
    const clean = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((p): p is string => typeof p === "string").slice(0, MAX_RECENT_PROJECTS) : []
    return {
      schema_version: 1,
      recent_projects: clean(parsed.recent_projects),
      pinned_projects: clean(parsed.pinned_projects),
      last_project: typeof parsed.last_project === "string" ? parsed.last_project : null,
      settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
    }
  } catch {
    return fallback
  }
}

export function saveWorkspacePreferences(preferences: WorkspacePreferences): void {
  const file = workspaceConfigFile()
  mkdirSync(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.preferences.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  writeFileSync(temporary, JSON.stringify(preferences, null, 2) + "\n", "utf8")
  try {
    renameSync(temporary, file)
  } catch {
    writeFileSync(file, JSON.stringify(preferences, null, 2) + "\n", "utf8")
  }
}

export function isExistingDirectory(value: string): boolean {
  try {
    return existsSync(resolve(value)) && statSync(resolve(value)).isDirectory()
  } catch {
    return false
  }
}

export function normalizeProjectPath(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 32_000) return null
  const project = resolve(trimmed)
  if (!isExistingDirectory(project)) return null
  try {
    // Resolve junctions/symlinks before applying the install-directory
    // boundary, so a friendly alias cannot point the GUI back into the app.
    return realpathSync(project)
  } catch {
    return null
  }
}

/** Do not let the GUI accidentally turn the installation directory into a project. */
export function isInsideInstallDirectory(project: string, installDir: string = dirname(process.execPath)): boolean {
  let canonicalProject = resolve(project)
  let canonicalInstall = resolve(installDir)
  try {
    canonicalProject = realpathSync(canonicalProject)
  } catch {
    /* fall back to lexical validation for a missing candidate */
  }
  try {
    canonicalInstall = realpathSync(canonicalInstall)
  } catch {
    /* fall back to lexical validation for a missing install path */
  }
  const rel = relative(canonicalInstall, canonicalProject)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function rememberWorkspaceProject(project: string, pinned = false): WorkspacePreferences {
  const normalized = normalizeProjectPath(project)
  if (!normalized) throw new Error("Project directory does not exist or is not a directory.")
  const preferences = loadWorkspacePreferences()
  preferences.recent_projects = [
    normalized,
    ...preferences.recent_projects.filter((p) => resolve(p) !== normalized),
  ].slice(0, MAX_RECENT_PROJECTS)
  if (pinned && !preferences.pinned_projects.includes(normalized)) preferences.pinned_projects.push(normalized)
  preferences.last_project = normalized
  saveWorkspacePreferences(preferences)
  return preferences
}

export function initialWorkspaceProject(explicit?: string | null): string | null {
  if (explicit) {
    const candidate = normalizeProjectPath(explicit)
    if (candidate && !isInsideInstallDirectory(candidate)) {
      try {
        rememberWorkspaceProject(candidate)
      } catch {
        /* the explicit project remains usable even if preferences are read-only */
      }
      return candidate
    }
    return null
  }
  const preferences = loadWorkspacePreferences()
  const last = preferences.last_project ? normalizeProjectPath(preferences.last_project) : null
  if (last && !isInsideInstallDirectory(last)) return last
  return (
    preferences.recent_projects
      .map((p) => normalizeProjectPath(p))
      .find((p): p is string => p !== null && !isInsideInstallDirectory(p)) ?? null
  )
}

export function workspaceSummary(currentProject: string | null): {
  current_project: string | null
  recent_projects: Array<{ path: string; exists: boolean; pinned: boolean }>
  config_file: string
} {
  const preferences = loadWorkspacePreferences()
  const paths = [...new Set([...preferences.pinned_projects, ...preferences.recent_projects])]
  return {
    current_project: currentProject,
    recent_projects: paths.map((path) => ({
      path,
      exists: isExistingDirectory(path),
      pinned: preferences.pinned_projects.includes(path),
    })),
    config_file: workspaceConfigFile(),
  }
}
