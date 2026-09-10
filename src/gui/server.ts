/**
 * OpenComms local GUI server (work order 2026-09-08: "backend-ready now,
 * frontend later" â€” this IS the backend + a first frontend).
 *
 * SECURITY: binds to the loopback interface ONLY (127.0.0.1). No auth is
 * required for a loopback-only socket (same trust boundary as state.json â€”
 * any local process can already read/write the project state). Refuses any
 * non-loopback hostname. No provider credentials pass through this server.
 *
 * The API is provider-independent: it exposes sessions (live + archived),
 * members, lifecycle operations (create/save/delete/resume), member
 * removal (OpenComms link ONLY â€” never touches provider processes), the
 * real per-host join commands, and an SSE event stream for live updates.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { watchFile, unwatchFile, appendFileSync, mkdirSync, existsSync, type StatWatcher } from "node:fs"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import {
  normalizeChannelName,
  createSessionAsOperator,
  buildSessionArchive,
  commitSessionSave,
  deleteSession,
  removeMemberAsOperator,
  resumeSession,
  effectiveEndpointCapabilities,
  setSessionPausedAsOperator,
} from "../core/engine.js"
import { ArchiveStore, buildArchiveContext, type SessionArchive } from "../core/archive.js"
import { StateStore, emptyState } from "../core/store.js"
import type { Member, State } from "../core/types.js"
import { GUI_HTML } from "./ui.js"
import { joinCommandFor } from "../cli/join-command.js"
import {
  initialWorkspaceProject,
  isExistingDirectory,
  isInsideInstallDirectory,
  rememberWorkspaceProject,
  workspaceConfigDir,
  workspaceSummary,
} from "./workspace.js"
import { detectCodex } from "../adapters/codex/install.js"
import { detectChatGptDesktop } from "../adapters/chatgpt/install.js"
import { VERSION } from "../version.js"

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"])

function browseForDirectory(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null)
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::EnableVisualStyles(); $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='Choose an OpenComms project folder'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($d.SelectedPath) }"
  return new Promise((resolveBrowse) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 120_000 },
      (error, stdout) => resolveBrowse(error ? null : stdout.trim() || null),
    )
  })
}

/** Member runtime state as far as OpenComms can honestly observe it. */
export function memberState(member: { stale: boolean }, queueLength: number): "Working" | "Idle" | "Offline" {
  if (member.stale) return "Offline"
  return queueLength > 0 ? "Working" : "Idle"
}

export interface GuiDeps {
  projectDir?: string
  port: number
  hostname: string
}

export interface GuiServerHandle {
  server: Server
  port: number
  close(): Promise<void>
}

export function startGuiServer(deps: GuiDeps): Promise<GuiServerHandle> {
  if (!LOOPBACK_HOSTS.has(deps.hostname)) {
    return Promise.reject(
      new Error(`OpenComms GUI binds loopback only (requested "${deps.hostname}"). No network exposure, ever.`),
    )
  }
  let projectDir = initialWorkspaceProject(deps.projectDir)
  let store = projectDir ? new StateStore(projectDir) : null
  let archives = projectDir ? new ArchiveStore(projectDir) : null
  const load = (): State => store?.load() ?? emptyState()
  const recordError = (message: string): void => {
    if (store) {
      const activeStore = store
      void activeStore
        .withLock(() => {
          const state = activeStore.load()
          state.errors.push({ at: Date.now(), message })
          if (state.errors.length > 200) state.errors = state.errors.slice(-200)
          activeStore.save(state)
        })
        .catch(() => {})
    } else {
      try {
        const file = join(workspaceConfigDir(), "logs", "gui.log")
        mkdirSync(join(workspaceConfigDir(), "logs"), { recursive: true })
        appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, "utf8")
      } catch {
        /* diagnostics logging is best effort */
      }
    }
  }
  const sseClients = new Set<ServerResponse>()

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(payload)
      } catch {
        sseClients.delete(res)
      }
    }
  }
  // Live-state change detection (P3-1): real mtime watch on state.json —
  // change-driven events, not wall-clock ticks. persistent:false never
  // holds the host event loop open (same pattern as the delivery wake).
  let statWatcher: StatWatcher | null = null
  let statWatcherFile: string | null = null
  let refreshTimer: NodeJS.Timeout | null = null
  const onStatChange = (): void => {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      broadcast("refresh", { at: Date.now() })
    }, 200)
    refreshTimer.unref?.()
  }
  const ensureStatWatcher = (): void => {
    if (statWatcher || !store) return
    statWatcherFile = store.file
    statWatcher = watchFile(store.file, { interval: 750, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) onStatChange()
    })
  }
  ensureStatWatcher()
  // The GUI shows ARCHIVED sessions too: archive files are written/deleted
  // by OTHER processes (CLI session save/delete, MCP save) without touching
  // state.json, so a state.json-only watcher leaves the saved-sessions list
  // STALE. stat-poll the archives DIRECTORY as well: entry creates/replaces
  // (temp+rename saves) and deletions (unlink) update a directory's mtime,
  // so every archive mutation fires.
  let statWatcherArchives: StatWatcher | null = null
  let statWatcherArchivesDir: string | null = null
  const ensureArchivesWatcher = (): void => {
    if (statWatcherArchives || !archives) return
    statWatcherArchivesDir = archives.dir
    statWatcherArchives = watchFile(archives.dir, { interval: 750, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) onStatChange()
    })
  }
  ensureArchivesWatcher()

  const stopWatchers = (): void => {
    if (statWatcherFile) {
      try {
        unwatchFile(statWatcherFile)
      } catch {
        /* already gone */
      }
    }
    if (statWatcherArchivesDir) {
      try {
        unwatchFile(statWatcherArchivesDir)
      } catch {
        /* already gone */
      }
    }
    statWatcher = null
    statWatcherFile = null
    statWatcherArchives = null
    statWatcherArchivesDir = null
  }

  const selectProject = (candidate: string): string => {
    if (!isExistingDirectory(candidate)) throw new Error("Project directory does not exist or is not a directory.")
    const normalized = resolve(candidate)
    if (isInsideInstallDirectory(normalized))
      throw new Error("Choose a coding project outside the OpenComms installation folder.")
    rememberWorkspaceProject(normalized)
    stopWatchers()
    projectDir = normalized
    store = new StateStore(normalized)
    archives = new ArchiveStore(normalized)
    ensureStatWatcher()
    ensureArchivesWatcher()
    onStatChange()
    return normalized
  }

  const json = (res: ServerResponse, code: number, payload: unknown): void => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    res.end(JSON.stringify(payload))
  }

  /**
   * BROWSER-SURFACE GUARD (Reviewer P1): loopback binding protects against
   * NETWORK exposure but NOT against the user's browser. DNS rebinding
   * makes a remote page same-origin with our port; CORS-simple POSTs (no
   * preflight) can mutate state from any site. Defense:
   *   1. Host header must be loopback (with optional :port) — kills
   *      rebinding (the browser sends the rebound name as Host).
   *   2. Non-GET requests must carry Origin/Referer that is ABSENT (curl,
   *      same-process clients) or matches this loopback origin, or
   *      Sec-Fetch-Site: same-origin/none — kills simple-request CSRF.
   */
  const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"])
  const guard = (req: IncomingMessage): string | null => {
    const host = (req.headers["host"] ?? "").toLowerCase().trim()
    // IPv6-safe: "[::1]:3000" → "[::1]" (cut after ']'); plain "h:p" → "h".
    const bracketEnd = host.indexOf("]")
    const hostName = bracketEnd >= 0 ? host.slice(0, bracketEnd + 1) : (host.split(":")[0] ?? "")
    if (!(hostName === "127.0.0.1" || hostName === "localhost" || hostName === "[::1]")) {
      return `Rejected Host "${host}" (opencomms gui accepts loopback only)`
    }
    if (MUTATING.has((req.method ?? "GET").toUpperCase())) {
      const origin = req.headers["origin"]
      const referer = req.headers["referer"]
      const fetchSite = req.headers["sec-fetch-site"]
      const sameOrigin =
        (typeof origin === "string" && origin.toLowerCase() === `http://${host}`) ||
        (typeof referer === "string" && referer.toLowerCase().startsWith(`http://${host}/`))
      const fetchOk = fetchSite === "same-origin" || fetchSite === "none"
      const hasBrowserSignals = origin !== undefined || referer !== undefined || fetchSite !== undefined
      if (hasBrowserSignals && !(sameOrigin || fetchOk)) {
        return "Rejected cross-site request (write operations require a same-origin loopback client)"
      }
    }
    return null
  }

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let body = ""
    for await (const chunk of req) body += String(chunk)
    if (body.length > 1_000_000) throw new Error("request body too large")
    try {
      const parsed = JSON.parse(body || "{}") as unknown
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  /** Snapshot both views for the main screen (cards). */
  const sessionsPayload = () => {
    const state = load()
    const currentArchives = archives
    const live = Object.values(state.channels)
      .filter((c) => c.lifecycle !== "deleted")
      .map((c) => ({
        name: c.name,
        lifecycle: c.lifecycle,
        parent_channel_id: c.parent_channel_id,
        description: c.description ?? "No description yet",
        max_members: c.max_members,
        paused: c.paused,
        agents: c.members.map((m) => ({
          session_id: m.session_id,
          role: m.role,
          host: m.host,
          delivery_mode: m.delivery_mode,
          state: memberState(m, (state.queues[m.session_id] ?? []).length),
        })),
        last_activity:
          Object.values(state.messages)
            .filter((m) => m.channel_id === c.id)
            .reduce((latest, m) => Math.max(latest, m.timestamp), 0) || null,
      }))
    return {
      ok: true,
      data: {
        project: projectDir,
        live,
        archived: currentArchives?.list() ?? [],
      },
    }
  }

  const findLive = (name: string) => {
    const key = normalizeChannelName(name)
    return load().channels[key] ?? null
  }

  const server: Server = createServer((req, res) => {
    const rejected = guard(req)
    if (rejected) {
      recordError(`GUI request rejected: ${rejected}`)
      json(res, 403, { ok: false, message: rejected })
      return
    }
    void handle(req, res).catch((error) => {
      recordError(`GUI request failed: ${(error as Error).message}`)
      if (!res.headersSent) json(res, 500, { ok: false, message: `Internal error: ${(error as Error).message}` })
    })
  })

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.port}`)
    const path = url.pathname.replace(/\/+$/, "") || "/"
    const method = req.method ?? "GET"

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      res.end(GUI_HTML)
      return
    }
    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" })
      res.write(`event: hello\ndata: {}\n\n`)
      sseClients.add(res)
      // Keepalive: a periodic SSE comment keeps half-open connections
      // observable. A dead client surfaces as a write error (pruned below);
      // the BROWSER sees activity instead of a silent half-open stream and
      // EventSource reconnects (the frontend refetches on reconnect).
      const ping = setInterval(() => {
        for (const client of sseClients) {
          try {
            client.write(`: ping\n\n`)
          } catch {
            sseClients.delete(client)
          }
        }
      }, 10_000)
      ping.unref?.()
      req.on("close", () => {
        clearInterval(ping)
        sseClients.delete(res)
      })
      return
    }

    if (path === "/api/workspace") {
      if (method === "GET") {
        json(res, 200, { ok: true, data: workspaceSummary(projectDir) })
        return
      }
      if (method === "POST") {
        const body = await readBody(req)
        try {
          const selected = selectProject(String(body["path"] ?? ""))
          json(res, 200, { ok: true, message: `Project selected: ${selected}`, data: workspaceSummary(selected) })
        } catch (error) {
          json(res, 400, { ok: false, message: (error as Error).message })
        }
        return
      }
    }

    if (path === "/api/workspace/browse" && method === "POST") {
      const selected = await browseForDirectory()
      if (!selected) {
        json(res, 200, { ok: false, message: "No directory was selected (native browsing is available on Windows)." })
        return
      }
      try {
        const normalized = selectProject(selected)
        json(res, 200, { ok: true, message: `Project selected: ${normalized}`, data: workspaceSummary(normalized) })
      } catch (error) {
        json(res, 400, { ok: false, message: (error as Error).message })
      }
      return
    }

    if (method === "GET" && path === "/api/integrations") {
      const selected = projectDir
      const codex = detectCodex()
      const projectFile = (name: string): boolean =>
        Boolean(selected && isExistingDirectory(selected) && existsSync(join(selected, name)))
      json(res, 200, {
        ok: true,
        data: [
          {
            id: "opencode",
            name: "OpenCode",
            status: selected && projectFile(".opencode") ? "Available" : "Install in a project",
            delivery: "PUSH; system prompt role injection",
          },
          {
            id: "claude-code",
            name: "Claude Code",
            status: selected && projectFile(".mcp.json") ? "Configured" : "Not configured",
            delivery: "MCP + hooks; spawn-push when explicitly enabled",
          },
          {
            id: "codex",
            name: "Codex",
            status: codex.detected ? `Detected${codex.version ? ` (${codex.version})` : ""}` : "Not detected",
            delivery: "MCP pull; spawn-push for compatible resumed sessions",
          },
          {
            id: "claude-desktop",
            name: "Claude Desktop",
            status: selected && projectFile("opencomms-claude-desktop") ? "Bundle present" : "Not configured",
            delivery: "PULL only",
          },
          {
            id: "chatgpt",
            name: "ChatGPT",
            status: detectChatGptDesktop().detected ? "Detected" : "Platform setup required",
            delivery: "Remote MCP / PULL only",
          },
        ],
      })
      return
    }

    if (method === "GET" && path === "/api/diagnostics") {
      const stateFile = store?.file ?? null
      const archiveDir = archives?.dir ?? null
      const state = load()
      json(res, 200, {
        ok: true,
        data: {
          version: VERSION,
          project: projectDir,
          state_file: stateFile,
          state_exists: Boolean(stateFile && existsSync(stateFile)),
          state_schema: state.schema_version,
          archive_directory: archiveDir,
          archive_exists: Boolean(archiveDir && existsSync(archiveDir)),
          backend: "healthy",
          port: (server.address() as { port: number } | null)?.port ?? deps.port,
          app_config: workspaceConfigDir(),
          errors: state.errors.slice(-20).map((e) => ({ at: e.at, message: e.message })),
        },
      })
      return
    }

    if (path === "/api/sessions") {
      if (method === "GET") {
        json(res, 200, sessionsPayload())
        return
      }
      if (method === "POST") {
        if (!store || !archives || !projectDir) {
          json(res, 409, { ok: false, message: "Select a project before creating a session." })
          return
        }
        const activeStore = store
        const activeProjectDir = projectDir
        const body = await readBody(req)
        const result = await activeStore.withLock(() => {
          const state = load()
          const created = createSessionAsOperator(state, {
            channel: String(body["name"] ?? ""),
            project_id: "gui-local-project",
            worktree: activeProjectDir,
            max_members: typeof body["max_members"] === "number" ? body["max_members"] : undefined,
            rate_limit: typeof body["rate_limit"] === "number" ? body["rate_limit"] : undefined,
            max_hops: typeof body["max_hops"] === "number" ? body["max_hops"] : undefined,
            budgets:
              body["budgets"] && typeof body["budgets"] === "object"
                ? (body["budgets"] as { max_runtime_ms?: number | null; max_delivered_messages?: number | null })
                : undefined,
          })
          if (created.ok) activeStore.save(state)
          return created
        })
        if (result.ok) broadcast("refresh", { reason: "session_created" })
        json(res, result.ok ? 200 : 400, result)
        return
      }
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch && method === "DELETE") {
      if (!store || !archives) {
        json(res, 409, { ok: false, message: "Select a project before deleting a session." })
        return
      }
      const activeStore = store
      const activeArchives = archives
      const name = decodeURIComponent(sessionMatch[1]!)
      const result = await activeStore.withLock(() => {
        const state = activeStore.load()
        const decided = deleteSession(state, { channel: name, session_id: null, confirm: true, operator: true })
        if (!decided.ok) return decided
        const { phase, channel_id: channelId } = decided.data as { phase: string; channel_id: string }
        if (phase === "live") {
          const doomed = new Set(
            Object.values(state.messages)
              .filter((m: { channel_id: string }) => m.channel_id === channelId)
              .map((m: { message_id: string }) => m.message_id),
          )
          for (const id of doomed) {
            delete state.messages[id]
            delete state.delivered_to[id]
          }
          for (const key of Object.keys(state.queues)) {
            const ids: string[] = state.queues[key] ?? []
            const filtered = ids.filter((id: string) => !doomed.has(id))
            if (filtered.length !== ids.length) state.queues[key] = filtered
          }
          for (const key of Object.keys(state.channels)) {
            const ch = state.channels[key]
            if (ch && ch.id === channelId) delete state.channels[key]
          }
          activeStore.save(state)
          return { ok: true, message: `Session ${channelId} DELETED.` }
        }
        // Non-live phase: the decided id may be a NAME — resolve it to the
        // archive id (chn_*) before touching files.
        const archiveId = channelId.startsWith("chn_")
          ? channelId
          : (activeArchives.findByName(channelId)?.channel_id ?? null)
        const removed = archiveId ? activeArchives.delete(archiveId) : false
        return {
          ok: removed,
          message: removed ? "Archived session DELETED." : `No archive found for ${channelId}.`,
        }
      })
      if (result.ok) broadcast("refresh", { reason: "session_deleted" })
      json(res, result.ok ? 200 : 400, result)
      return
    }

    const saveMatch = path.match(/^\/api\/sessions\/([^/]+)\/save$/)
    if (saveMatch && method === "POST") {
      if (!store || !archives) {
        json(res, 409, { ok: false, message: "Select a project before saving a session." })
        return
      }
      const activeStore = store
      const activeArchives = archives
      const name = decodeURIComponent(saveMatch[1]!)
      const body = await readBody(req)
      const result = await activeStore.withLock(() => {
        const state = activeStore.load()
        const built = buildSessionArchive(state, {
          channel: name,
          session_id: null,
          summary: typeof body["summary"] === "string" ? body["summary"] : null,
        })
        if (!built.ok) return built
        const inputs = (built.data as { archive_inputs: Record<string, unknown> }).archive_inputs
        const archive: SessionArchive = activeArchives.fromChannel(
          inputs as never,
          inputs["messages"] as never,
          null,
          null,
          (inputs["summary"] as string | null) ?? null,
        )
        if (!archive.summary)
          archive.summary = `Session "${archive.name}" archived. ${archive.description ?? "No description recorded."}`
        activeArchives.save(archive)
        commitSessionSave(state, archive.channel_id)
        activeStore.save(state)
        return {
          ok: true,
          message: `Session "${archive.name}" SAVED (${archive.message_count} messages archived).`,
          data: { archive_id: archive.channel_id },
        }
      })
      if (result.ok) broadcast("refresh", { reason: "session_saved" })
      json(res, result.ok ? 200 : 400, result)
      return
    }

    const resumeMatch = path.match(/^\/api\/sessions\/([^/]+)\/resume$/)
    if (resumeMatch && method === "POST") {
      if (!store || !archives || !projectDir) {
        json(res, 409, { ok: false, message: "Select a project before resuming a session." })
        return
      }
      const activeStore = store
      const activeArchives = archives
      const activeProjectDir = projectDir
      const name = decodeURIComponent(resumeMatch[1]!)
      const body = await readBody(req)
      const result = await activeStore.withLock(() => {
        const state = activeStore.load()
        const archive = activeArchives.findByName(name) ?? activeArchives.get(name)
        if (!archive) return { ok: false as const, message: `No archived session matches "${name}".` }
        const resumed = resumeSession(state, {
          archive,
          new_name: typeof body["new_name"] === "string" ? body["new_name"] : null,
          project_id: "gui-local-project",
          worktree: activeProjectDir,
        })
        if (resumed.ok) activeStore.save(state)
        return resumed
      })
      if (result.ok) broadcast("refresh", { reason: "session_resumed" })
      json(res, result.ok ? 200 : 400, result)
      return
    }

    const membersMatch = path.match(/^\/api\/sessions\/([^/]+)\/members$/)
    if (membersMatch && method === "GET") {
      const name = decodeURIComponent(membersMatch[1]!)
      const live = findLive(name)
      if (live) {
        const state = load()
        // Resumed sessions carry their parent archive's COMPACT context in
        // the member view (never the transcript).
        let compactContext: string | undefined
        if (live.parent_channel_id) {
          const parent = archives?.get(live.parent_channel_id)
          if (parent) compactContext = buildArchiveContext(parent, live.name)
        }
        json(res, 200, {
          ok: true,
          data: {
            name: live.name,
            lifecycle: live.lifecycle,
            created_at: live.created_at,
            parent_channel_id: live.parent_channel_id,
            description: live.description ?? "No description yet",
            paused: live.paused,
            max_members: live.max_members,
            max_hops: live.max_hops,
            rate_limit: live.rate_limit,
            budgets: live.budgets,
            delivered_total: live.delivered_total,
            compact_context: compactContext,
            agents: live.members.map((m: Member) => ({
              session_id: m.session_id,
              role: m.role,
              host: m.host,
              surface: m.surface,
              delivery_mode: m.delivery_mode,
              host_session_id: m.host_session_id,
              endpoint_capabilities: effectiveEndpointCapabilities(m),
              stale: m.stale,
              state: memberState(m, (state.queues[m.session_id] ?? []).length),
            })),
          },
        })
        return
      }
      const archive = archives?.findByName(name) ?? archives?.get(name)
      if (archive) {
        json(res, 200, {
          ok: true,
          data: {
            name: archive.name,
            lifecycle: "saved",
            description: archive.description ?? "No description yet",
            summary: archive.summary,
            parent_channel_id: archive.parent_channel_id,
            created_at: archive.created_at,
            compact_context: buildArchiveContext(archive, archive.name),
            saved_at: archive.saved_at,
            message_count: archive.message_count,
            agents: archive.members.map((m) => ({
              session_id: m.session_id,
              role: m.role,
              host: m.host,
              surface: m.surface,
              delivery_mode: m.delivery_mode,
              host_session_id: m.host_session_id,
              endpoint_capabilities: effectiveEndpointCapabilities(m),
              state: "Offline",
            })),
          },
        })
        return
      }
      json(res, 404, { ok: false, message: `No live or archived session matches "${name}".` })
      return
    }

    const pauseMatch = path.match(/^\/api\/sessions\/([^/]+)\/(pause|unpause)$/)
    if (pauseMatch && method === "POST") {
      if (!store) {
        json(res, 409, { ok: false, message: "Select a project before changing session state." })
        return
      }
      const activeStore = store
      const name = decodeURIComponent(pauseMatch[1]!)
      const paused = pauseMatch[2] === "pause"
      const result = await activeStore.withLock(() => {
        const state = activeStore.load()
        const changed = setSessionPausedAsOperator(state, { channel: name, paused })
        if (changed.ok) activeStore.save(state)
        return changed
      })
      if (result.ok) broadcast("refresh", { reason: paused ? "session_paused" : "session_resumed" })
      json(res, result.ok ? 200 : 400, result)
      return
    }

    const removeMatch = path.match(/^\/api\/sessions\/([^/]+)\/members\/remove$/)
    if (removeMatch && method === "POST") {
      if (!store) {
        json(res, 409, { ok: false, message: "Select a project before removing an agent." })
        return
      }
      const activeStore = store
      const name = decodeURIComponent(removeMatch[1]!)
      const body = await readBody(req)
      const result = await activeStore.withLock(() => {
        const state = activeStore.load()
        const removed = removeMemberAsOperator(state, {
          channel: name,
          target_session_id: typeof body["target_session_id"] === "string" ? body["target_session_id"] : null,
          target_role: typeof body["target_role"] === "string" ? body["target_role"] : null,
        })
        if (removed.ok) activeStore.save(state)
        return removed
      })
      if (result.ok) broadcast("refresh", { reason: "member_removed" })
      json(res, result.ok ? 200 : 400, result)
      return
    }

    const joinMatch = path.match(/^\/api\/sessions\/([^/]+)\/join-command$/)
    if (joinMatch && method === "GET") {
      const name = decodeURIComponent(joinMatch[1]!)
      const host = url.searchParams.get("host") ?? "opencode"
      const result = joinCommandFor(name, host)
      if ("error" in result) json(res, 400, { ok: false, message: result.error })
      else json(res, 200, { ok: true, data: result })
      return
    }

    json(res, 404, { ok: false, message: `No GUI route for ${method} ${path}` })
  }

  return new Promise((resolve) => {
    server.listen(deps.port, deps.hostname, () => {
      resolve({
        server,
        port: (server.address() as { port: number }).port,
        close: () =>
          new Promise<void>((resolveClose) => {
            // The refresh timer is unref'd; unwind the stat watchers too.
            if (refreshTimer) clearTimeout(refreshTimer)
            stopWatchers()
            for (const res of sseClients) res.end()
            sseClients.clear()
            server.close(() => resolveClose())
          }),
      })
    })
  })
}
