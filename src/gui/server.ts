/**
 * OpenComms local GUI server (work order 2026-09-08: "backend-ready now,
 * frontend later" — this IS the backend + a first frontend).
 *
 * SECURITY: binds to the loopback interface ONLY (127.0.0.1). No auth is
 * required for a loopback-only socket (same trust boundary as state.json —
 * any local process can already read/write the project state). Refuses any
 * non-loopback hostname. No provider credentials pass through this server.
 *
 * The API is provider-independent: it exposes sessions (live + archived),
 * members, lifecycle operations (create/save/delete/resume), member
 * removal (OpenComms link ONLY — never touches provider processes), the
 * real per-host join commands, and an SSE event stream for live updates.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { watchFile, unwatchFile, appendFileSync, mkdirSync, existsSync, type StatWatcher } from "node:fs"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
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
  sendMessage,
  sendMessageAsOperator,
  joinChannel,
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
import { integrationsOverview, integrationsListSync, integrationAction, projectBootstrap } from "./integrations.js"
import { VERSION } from "../version.js"
import { OrchestratorStore } from "../orchestrator/state.js"
import { createOrchestratorFeed } from "../orchestrator/events.js"
import { OrchestratorApi, permissionCapability } from "../orchestrator/api.js"
import { ensureServe, createOpencodeRuntime } from "../orchestrator/runtimes/opencode.js"
import { ACTION_ROUTES, knownFailureState, redactDiagnostic, type ActionCapability } from "./contracts.js"
import { createManagedDelivery } from "../orchestrator/managed-delivery.js"
import type { ApiResult } from "../orchestrator/api.js"

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
export function memberState(member: { stale: boolean }, queueLength: number): "Queued" | "Unknown" | "Offline" {
  if (member.stale) return "Offline"
  return queueLength > 0 ? "Queued" : "Unknown"
}

export interface GuiDeps {
  projectDir?: string
  /**
   * Sidecar-only storage used before the owner chooses a project. It keeps
   * the bridge alive for workspace_state/workspace_select without exposing
   * the install/runtime directory as the current project.
   */
  bridgeStorageDir?: string
  port: number
  hostname: string
}

export interface GuiServerHandle {
  server: Server
  port: number
  close(): Promise<void>
  /**
   * M4.5 bridge: the SAME OrchestratorApi + GUI closures the HTTP routes
   * use, exposed for the stdio bridge (cli main wires `bridge` to
   * runBridge with these + stdout/stderr). Null before a project is
   * selected.
   */
  bridgeDeps: () => import("../orchestrator/bridge.js").BridgeCoreDeps | null
}

export function startGuiServer(deps: GuiDeps): Promise<GuiServerHandle> {
  if (!LOOPBACK_HOSTS.has(deps.hostname)) {
    return Promise.reject(
      new Error(`OpenComms GUI binds loopback only (requested "${deps.hostname}"). No network exposure, ever.`),
    )
  }
  let projectDir = initialWorkspaceProject(deps.projectDir)
  let storageProjectDir = projectDir ?? (deps.bridgeStorageDir ? resolve(deps.bridgeStorageDir) : null)
  let store = storageProjectDir ? new StateStore(storageProjectDir) : null
  let archives = storageProjectDir ? new ArchiveStore(storageProjectDir) : null
  // Orchestrator core (M1): in-process in THIS server (ADR-0005 leaning);
  // Tauri sidecar argv stays exactly `gui --port N --server --project dir`.
  let orchestratorStore: OrchestratorStore | null = null
  if (storageProjectDir && store) {
    orchestratorStore = new OrchestratorStore(storageProjectDir, store)
  }
  // Serve password + model are in-memory only (never persisted, never
  // returned, never logged; Reviewer redaction-by-value gate).
  const servePassword = (): string => {
    const env = process.env["OPENCOMMS_ORCH_SERVE_PASSWORD"]
    return env?.trim() ? env : ""
  }
  const serveModel = (): string | undefined => {
    const env = process.env["OPENCOMMS_ORCH_SERVE_MODEL"]
    return env?.trim() ? env.trim() : undefined
  }
  let servePort = 0
  // Managed shared serve (M1 ensureServe): ONE child per project, spawned
  // lazily on the first agent create; password is generated here, held in
  // memory + the child's env only (never logged, never persisted). Killed
  // on server close � no orphans. authHeader lives in process memory only
  // and is handed to the runtime env for transport authentication.
  let serveChild: import("node:child_process").ChildProcess | null = null
  let serveAuthHeader: string | null = null
  const instanceId = randomUUID()
  let activeMutations = 0
  let deliveryController: ReturnType<typeof createManagedDelivery> | null = null
  let coordinationStopped = false
  let emergencyPaused = new Set<string>()
  const savedCoordination = orchestratorStore?.load().coordination
  if (savedCoordination) {
    coordinationStopped = savedCoordination.stopped
    emergencyPaused = new Set(savedCoordination.emergency_paused_channels)
  }
  const coordinationByProject = new Map<string, { stopped: boolean; paused: Set<string> }>()
  let serveStartup: Promise<{ ok: boolean; message: string }> | null = null
  let closing = false
  const resolvedServePassword = (): string =>
    serveAuthHeader?.startsWith("Basic ")
      ? Buffer.from(serveAuthHeader.slice(6), "base64").toString("utf8").split(":").slice(1).join(":")
      : servePassword()
  const ensureServeRunning = async (): Promise<{ ok: boolean; message: string }> => {
    if (!projectDir) return { ok: false, message: "Select a project before spawning agents." }
    if (serveStartup) return serveStartup
    const startupProject = projectDir
    const startupStore = orchestratorStore
    serveStartup = (async () => {
      const result = await ensureServe({
        projectDir: startupProject,
        preferredPort: servePort || 4923,
        existing: serveChild,
        existingPort: servePort || undefined,
      })
      if (!result.ok) return { ok: false, message: result.detail }
      if (closing) {
        result.child?.kill("SIGTERM")
        return { ok: false, message: "The coordinator closed during startup." }
      }
      serveChild = result.child
      servePort = result.port
      if (result.authHeader) serveAuthHeader = result.authHeader
      // Record port + serve_started_at on the local node record (locked).
      if (startupStore) {
        const activeStore = startupStore
        await activeStore
          .withLock(() => {
            const oState = activeStore.load()
            const local = oState.nodes.find((n) => n.id === oState.local_node_id)
            if (local) {
              oState.serve = { port: result.port, password_redacted: true }
              if (!("serve_started_at" in (local as unknown as Record<string, unknown>))) {
                ;(local as unknown as Record<string, unknown>)["serve_started_at"] = Date.now()
              }
            }
            activeStore.save(oState)
            return 0
          })
          .catch(() => {})
      }
      return { ok: true, message: result.detail }
    })()
    try {
      return await serveStartup
    } finally {
      serveStartup = null
    }
  }
  let feed: ReturnType<typeof createOrchestratorFeed> | null = null
  if (orchestratorStore) {
    const initialOrchestratorStore = orchestratorStore
    feed = createOrchestratorFeed((fn) =>
      initialOrchestratorStore.withLock(() => {
        const oState = initialOrchestratorStore.load()
        const seq = fn(oState)
        initialOrchestratorStore.save(oState)
        return seq
      }),
    )
  }
  let orchestratorApi: OrchestratorApi | null = null
  let bridgeDepsProvider: (() => import("../orchestrator/bridge.js").BridgeCoreDeps | null) | null = null
  const handlePortRef = (): number => {
    try {
      return (server?.address() as { port: number } | null)?.port ?? 4919
    } catch {
      return 4919
    }
  }
  if (storageProjectDir && orchestratorStore && feed && store) {
    const initialStorageProjectDir = storageProjectDir
    const apiOrchestratorStore = orchestratorStore
    const apiStore = store
    const apiFeed = feed
    // servePassword serves BOTH roles: when the env pin is set, it is the
    // operator-provided password; after ensureServe bootstraps, the in-memory
    // serveAuthHeader carries the generated credential for the transports.
    const orchestratorServePassword = (): string => resolvedServePassword()
    orchestratorApi = new OrchestratorApi({
      projectDir: initialStorageProjectDir,
      servePassword: orchestratorServePassword,
      serveModel: () => process.env["OPENCOMMS_ORCH_SERVE_MODEL"],
      servePort: () => servePort,
      withLock: (fn) => apiStore.withLock(fn),
      loadOrchestrator: () => apiOrchestratorStore.load(),
      saveOrchestrator: (s) => apiOrchestratorStore.save(s),
      feed: apiFeed,
      projectId: () => null,
      loadChannelEngineState: () => apiStore.load(),
      engineSend: (state, input, senderSessionId) =>
        sendMessageAsOperator(state as never, {
          channel: input.channel,
          content: input.content,
          type: input.message_type,
          to: input.to,
        }),
      saveChannelEngineState: (state) => apiStore.save(state as never),
    })
    // M4.5 bridge deps: the SAME api + closures the HTTP routes use, so the
    // stdio bridge (cli main's `bridge` dispatch) shares one core.
    const currentOrchestratorApi = orchestratorApi
    if (currentOrchestratorApi) {
      bridgeDepsProvider = () => ({
        api: currentOrchestratorApi,
        guiReads: {
          sessions: () => {
            const sp = sessionsPayload()
            return { ok: true, message: "ok", data: sp.data }
          },
          sessionMembers: (name: string) => {
            const live = findLive(name)
            if (live) {
              const st = load()
              return {
                ok: true,
                message: "ok",
                data: {
                  name: live.name,
                  lifecycle: live.lifecycle,
                  description: live.description ?? "No description yet",
                  agents: live.members.map((m: Member) => ({
                    session_id: m.session_id,
                    role: m.role,
                    host: m.host,
                    delivery_mode: m.delivery_mode,
                    state: memberState(m, (st.queues[m.session_id] ?? []).length),
                  })),
                },
              }
            }
            const archive = archives?.findByName(name) ?? archives?.get(name)
            if (archive) {
              return {
                ok: true,
                message: "ok",
                data: {
                  name: archive.name,
                  lifecycle: "saved",
                  agents: archive.members.map((m) => ({
                    session_id: m.session_id,
                    role: m.role,
                    host: m.host,
                    state: "Offline",
                  })),
                },
              }
            }
            return { ok: false, message: `No live or archived session matches "${name}".` }
          },
          workspaceState: () => ({ ok: true, message: "ok", data: workspaceSummary(projectDir) }),
          integrationsList: () => ({ ok: true, message: "ok", data: integrationsListSync(projectDir) }),
          diagnostics: () => {
            const st = load()
            return {
              ok: true,
              message: "ok",
              data: {
                version: VERSION,
                project: projectDir,
                state_exists: Boolean(store?.file && existsSync(store.file)),
                state_schema: st.schema_version,
                backend: "healthy",
                port: handlePortRef(),
                errors: st.errors.slice(-20).map((e) => ({ at: e.at, message: e.message })),
              },
            }
          },
        },
        guiWrites: {
          sessionCreate: async (body) => {
            const st = load()
            const created = createSessionAsOperator(st, {
              channel: String(body["name"] ?? ""),
              project_id: "gui-local-project",
              worktree: projectDir ?? "",
              max_members: typeof body["max_members"] === "number" ? body["max_members"] : undefined,
              rate_limit: typeof body["rate_limit"] === "number" ? body["rate_limit"] : undefined,
              max_hops: typeof body["max_hops"] === "number" ? body["max_hops"] : undefined,
              budgets: body["budgets"] as { max_runtime_ms?: number; max_delivered_messages?: number } | undefined,
            })
            if (created.ok) apiStore.save(st)
            return created
          },
          sessionSave: async (body) => {
            const st = load()
            const built = buildSessionArchive(st, {
              channel: String(body["name"] ?? ""),
              session_id: null,
              summary: typeof body["summary"] === "string" ? body["summary"] : null,
            })
            if (!built.ok) return built
            const inputs = (built.data as { archive_inputs: Record<string, unknown> }).archive_inputs
            const archive = (archives ?? null)?.fromChannel(
              inputs as never,
              inputs["messages"] as never,
              null,
              null,
              (inputs["summary"] as string | null) ?? null,
            )
            if (!archive) return { ok: false, message: "archive store unavailable" }
            ;(archives ?? null)?.save(archive)
            commitSessionSave(st, archive.channel_id)
            apiStore.save(st)
            return { ok: true, message: `Session "${archive.name}" SAVED.` }
          },
          sessionResume: async (body) => {
            const st = load()
            const archive =
              (archives ?? null)?.findByName(String(body["name"] ?? "")) ??
              (archives ?? null)?.get(String(body["name"] ?? ""))
            if (!archive) return { ok: false, message: `No archived session matches "${String(body["name"] ?? "")}".` }
            const resumed = resumeSession(st, {
              archive,
              new_name: typeof body["new_name"] === "string" ? body["new_name"] : null,
              project_id: "gui-local-project",
              worktree: projectDir ?? "",
            })
            if (resumed.ok) apiStore.save(st)
            return resumed
          },
          sessionDelete: async (body) => {
            const st = load()
            const decided = deleteSession(st, {
              channel: String(body["name"] ?? ""),
              session_id: null,
              confirm: true,
              operator: true,
            })
            if (!decided.ok) return decided
            const { channel_id: channelId } = decided.data as { phase: string; channel_id: string }
            if (
              decided.data &&
              typeof decided.data === "object" &&
              "phase" in (decided.data as Record<string, unknown>) &&
              (decided.data as { phase: string }).phase === "live"
            ) {
              const doomed = new Set(
                Object.values(st.messages)
                  .filter((m) => m.channel_id === channelId)
                  .map((m) => m.message_id),
              )
              for (const id of doomed) {
                delete st.messages[id]
                delete st.delivered_to[id]
              }
              for (const key of Object.keys(st.queues)) {
                const ids: string[] = st.queues[key] ?? []
                const filtered = ids.filter((id) => !doomed.has(id))
                if (filtered.length !== ids.length) st.queues[key] = filtered
              }
              for (const key of Object.keys(st.channels)) {
                const ch = st.channels[key]
                if (ch && ch.id === channelId) delete st.channels[key]
              }
              apiStore.save(st)
            } else {
              const archiveId = channelId.startsWith("chn_")
                ? channelId
                : ((archives ?? null)?.findByName(channelId)?.channel_id ?? null)
              const removed = archiveId ? (archives ?? null)?.delete(archiveId) : false
              return {
                ok: removed ?? false,
                message: removed ? "Archived session DELETED." : `No archive found for ${channelId}.`,
              }
            }
            return { ok: true, message: `Session ${channelId} DELETED.` }
          },
          setSessionPaused: async (body, paused) => {
            const st = load()
            const changed = setSessionPausedAsOperator(st, { channel: String(body["name"] ?? ""), paused })
            if (changed.ok) apiStore.save(st)
            return changed
          },
          memberRemove: async (body) => {
            const st = load()
            const removed = removeMemberAsOperator(st, {
              channel: String(body["name"] ?? ""),
              target_session_id: typeof body["target_session_id"] === "string" ? body["target_session_id"] : null,
              target_role: typeof body["target_role"] === "string" ? body["target_role"] : null,
            })
            if (removed.ok) apiStore.save(st)
            return removed
          },
          workspaceSelect: async (body) => {
            const selected = selectProject(String(body["path"] ?? ""))
            return { ok: true, message: `Project selected: ${selected}`, data: workspaceSummary(projectDir) }
          },
        },
      })
    }
  }
  const load = (): State => store?.load() ?? emptyState()
  const recordError = (message: string): void => {
    message = redactDiagnostic(message, [servePassword(), resolvedServePassword(), serveAuthHeader ?? ""])
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
  // Live-state change detection (P3-1): real mtime watch on state.json �
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
    if (activeMutations > 1)
      throw new Error("A project operation is still pending. Wait for its outcome before switching projects.")
    if (serveChild && !serveChild.killed && serveChild.exitCode === null && normalized !== projectDir)
      throw new Error(
        "Managed agents are attached to this project's coordinator. Stop the coordinator before switching projects, then select the other project. Linked sessions are unaffected.",
      )
    if (
      normalized !== projectDir &&
      orchestratorStore
        ?.load()
        .agents.some((a) => a.runtime === "acp" && ["running", "idle", "starting"].includes(a.status))
    )
      throw new Error(
        "Stop the managed ACP agents before switching projects; their owned processes remain attached to this project's coordinator.",
      )
    if (isInsideInstallDirectory(normalized))
      throw new Error("Choose a coding project outside the OpenComms installation folder.")
    if (normalized === projectDir) return normalized
    if (projectDir) coordinationByProject.set(projectDir, { stopped: coordinationStopped, paused: emergencyPaused })
    const coordination = coordinationByProject.get(normalized)
    coordinationStopped = coordination?.stopped ?? false
    emergencyPaused = coordination?.paused ?? new Set<string>()
    rememberWorkspaceProject(normalized)
    deliveryController?.close()
    deliveryController = null
    stopWatchers()
    projectDir = normalized
    storageProjectDir = normalized
    store = new StateStore(normalized)
    archives = new ArchiveStore(normalized)
    orchestratorStore = new OrchestratorStore(normalized, store)
    const persistedCoordination = orchestratorStore.load().coordination
    if (persistedCoordination) {
      coordinationStopped = persistedCoordination.stopped
      emergencyPaused = new Set(persistedCoordination.emergency_paused_channels)
    }
    const activeOrchestratorStore = orchestratorStore
    feed = createOrchestratorFeed((fn) =>
      activeOrchestratorStore.withLock(() => {
        const oState = activeOrchestratorStore.load()
        const seq = fn(oState)
        activeOrchestratorStore.save(oState)
        return seq
      }),
    )
    const activeStoreRef = store
    const activeFeedRef = feed
    // Same credential resolution as the initial wiring: env pin wins, else
    // the in-memory serveAuthHeader from the managed bootstrap.
    const projectServePassword = (): string => resolvedServePassword()
    orchestratorApi = new OrchestratorApi({
      projectDir: normalized,
      servePassword: projectServePassword,
      serveModel: () => process.env["OPENCOMMS_ORCH_SERVE_MODEL"],
      servePort: () => servePort,
      withLock: (fn) => activeStoreRef.withLock(fn),
      loadOrchestrator: () => activeOrchestratorStore.load(),
      saveOrchestrator: (s) => activeOrchestratorStore.save(s),
      feed: activeFeedRef,
      projectId: () => null,
      loadChannelEngineState: () => activeStoreRef.load(),
      engineSend: (state, input, senderSessionId) =>
        sendMessageAsOperator(state as never, {
          channel: input.channel,
          content: input.content,
          type: input.message_type,
          to: input.to,
        }),
      saveChannelEngineState: (state) => activeStoreRef.save(state as never),
    })
    // Rebuild the bridge deps for the newly selected project (same closures).
    if (orchestratorApi) {
      const apiRef = orchestratorApi
      bridgeDepsProvider = () => ({
        api: apiRef,
        guiReads: {
          sessions: () => {
            const sp = sessionsPayload()
            return { ok: true, message: "ok", data: sp.data }
          },
          sessionMembers: (name: string) => {
            const live = findLive(name)
            if (live) {
              const st = load()
              return {
                ok: true,
                message: "ok",
                data: {
                  name: live.name,
                  lifecycle: live.lifecycle,
                  description: live.description ?? "No description yet",
                  agents: live.members.map((m: Member) => ({
                    session_id: m.session_id,
                    role: m.role,
                    host: m.host,
                    delivery_mode: m.delivery_mode,
                    state: memberState(m, (st.queues[m.session_id] ?? []).length),
                  })),
                },
              }
            }
            const archive = archives?.findByName(name) ?? archives?.get(name)
            if (archive) {
              return {
                ok: true,
                message: "ok",
                data: {
                  name: archive.name,
                  lifecycle: "saved",
                  agents: archive.members.map((m) => ({
                    session_id: m.session_id,
                    role: m.role,
                    host: m.host,
                    state: "Offline",
                  })),
                },
              }
            }
            return { ok: false, message: `No live or archived session matches "${name}".` }
          },
          workspaceState: () => ({ ok: true, message: "ok", data: workspaceSummary(projectDir) }),
          integrationsList: () => ({ ok: true, message: "ok", data: integrationsListSync(projectDir) }),
          diagnostics: () => {
            const st = load()
            return {
              ok: true,
              message: "ok",
              data: {
                version: VERSION,
                project: projectDir,
                state_exists: Boolean(store?.file && existsSync(store.file)),
                state_schema: st.schema_version,
                backend: "healthy",
                port: handlePortRef(),
                errors: st.errors.slice(-20).map((e) => ({ at: e.at, message: e.message })),
              },
            }
          },
        },
        guiWrites: {
          sessionCreate: async (body) => {
            const st = load()
            const created = createSessionAsOperator(st, {
              channel: String(body["name"] ?? ""),
              project_id: "gui-local-project",
              worktree: projectDir ?? "",
              max_members: typeof body["max_members"] === "number" ? body["max_members"] : undefined,
              rate_limit: typeof body["rate_limit"] === "number" ? body["rate_limit"] : undefined,
              max_hops: typeof body["max_hops"] === "number" ? body["max_hops"] : undefined,
            })
            if (created.ok) activeStoreRef.save(st)
            return created
          },
          sessionSave: async (body) => {
            const st = load()
            const built = buildSessionArchive(st, {
              channel: String(body["name"] ?? ""),
              session_id: null,
              summary: typeof body["summary"] === "string" ? body["summary"] : null,
            })
            if (!built.ok) return built
            const inputs = (built.data as { archive_inputs: Record<string, unknown> }).archive_inputs
            const archive = (archives ?? null)?.fromChannel(
              inputs as never,
              inputs["messages"] as never,
              null,
              null,
              (inputs["summary"] as string | null) ?? null,
            )
            if (!archive) return { ok: false, message: "archive store unavailable" }
            ;(archives ?? null)?.save(archive)
            commitSessionSave(st, archive.channel_id)
            activeStoreRef.save(st)
            return { ok: true, message: `Session "${archive.name}" SAVED.` }
          },
          sessionResume: async (body) => {
            const st = load()
            const name = String(body["name"] ?? "")
            const archive = (archives ?? null)?.findByName(name) ?? (archives ?? null)?.get(name)
            if (!archive) return { ok: false, message: `No archived session matches "${name}".` }
            const resumed = resumeSession(st, {
              archive,
              new_name: typeof body["new_name"] === "string" ? body["new_name"] : null,
              project_id: "gui-local-project",
              worktree: projectDir ?? "",
            })
            if (resumed.ok) activeStoreRef.save(st)
            return resumed
          },
          sessionDelete: async (body) => {
            const st = load()
            const decided = deleteSession(st, {
              channel: String(body["name"] ?? ""),
              session_id: null,
              confirm: true,
              operator: true,
            })
            if (!decided.ok) return decided
            const { channel_id: channelId, phase } = decided.data as { phase: string; channel_id: string }
            if (phase === "live") {
              const doomed = new Set(
                Object.values(st.messages)
                  .filter((m) => m.channel_id === channelId)
                  .map((m) => m.message_id),
              )
              for (const id of doomed) {
                delete st.messages[id]
                delete st.delivered_to[id]
              }
              for (const key of Object.keys(st.queues)) {
                const ids: string[] = st.queues[key] ?? []
                const filtered = ids.filter((id) => !doomed.has(id))
                if (filtered.length !== ids.length) st.queues[key] = filtered
              }
              for (const key of Object.keys(st.channels)) {
                const ch = st.channels[key]
                if (ch && ch.id === channelId) delete st.channels[key]
              }
              activeStoreRef.save(st)
              return { ok: true, message: `Session ${channelId} DELETED.` }
            }
            const archiveId = channelId.startsWith("chn_")
              ? channelId
              : ((archives ?? null)?.findByName(channelId)?.channel_id ?? null)
            const removed = archiveId ? (archives ?? null)?.delete(archiveId) : false
            return {
              ok: removed ?? false,
              message: removed ? "Archived session DELETED." : `No archive found for ${channelId}.`,
            }
          },
          setSessionPaused: async (body, paused) => {
            const st = load()
            const changed = setSessionPausedAsOperator(st, { channel: String(body["name"] ?? ""), paused })
            if (changed.ok) activeStoreRef.save(st)
            return changed
          },
          memberRemove: async (body) => {
            const st = load()
            const removed = removeMemberAsOperator(st, {
              channel: String(body["name"] ?? ""),
              target_session_id: typeof body["target_session_id"] === "string" ? body["target_session_id"] : null,
              target_role: typeof body["target_role"] === "string" ? body["target_role"] : null,
            })
            if (removed.ok) activeStoreRef.save(st)
            return removed
          },
          workspaceSelect: async (body) => {
            const selected = selectProject(String(body["path"] ?? ""))
            return { ok: true, message: `Project selected: ${selected}`, data: workspaceSummary(projectDir) }
          },
        },
      })
    }
    ensureStatWatcher()
    ensureArchivesWatcher()
    onStatChange()
    return normalized
  }

  const json = (res: ServerResponse, code: number, payload: unknown): void => {
    const secrets = [servePassword(), serveAuthHeader ?? "", orchestratorStore?.load().trust.owner_confirm_token ?? ""]
    if (serveAuthHeader?.startsWith("Basic "))
      secrets.push(Buffer.from(serveAuthHeader.slice(6), "base64").toString("utf8").split(":").slice(1).join(":"))
    let envelope = payload as Record<string, unknown>
    if (envelope && envelope["ok"] === false) {
      const message = String(envelope["message"] ?? "Request failed")
      const state =
        knownFailureState(envelope["code"]) ??
        (code === 403
          ? "permission_denied"
          : code === 401
            ? "authentication_required"
            : code === 404 && (message.startsWith("No GUI route") || message.startsWith("No orchestrator route"))
              ? "unsupported"
              : code === 409 && !projectDir
                ? "not_configured"
                : code === 503
                  ? "temporarily_unavailable"
                  : "execution_failed")
      envelope = {
        ...envelope,
        message,
        error: {
          state,
          recovery:
            code >= 500
              ? "Inspect Diagnostics using the request ID before retrying mutations."
              : "Correct the request or check the host configuration.",
        },
      }
    }
    envelope = { ...envelope, request_id: res.getHeader("X-OpenComms-Request-Id") ?? randomUUID() }
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
    res.end(
      JSON.stringify(envelope, (_key, value: unknown) =>
        typeof value === "string" ? redactDiagnostic(value, secrets) : value,
      ),
    )
  }

  /**
   * BROWSER-SURFACE GUARD (Reviewer P1): loopback binding protects against
   * NETWORK exposure but NOT against the user's browser. DNS rebinding
   * makes a remote page same-origin with our port; CORS-simple POSTs (no
   * preflight) can mutate state from any site. Defense:
   *   1. Host header must be loopback (with optional :port) � kills
   *      rebinding (the browser sends the rebound name as Host).
   *   2. Non-GET requests must carry Origin/Referer that is ABSENT (curl,
   *      same-process clients) or matches this loopback origin, or
   *      Sec-Fetch-Site: same-origin/none � kills simple-request CSRF.
   */
  const MUTATING = new Set(["POST", "PUT", "DELETE", "PATCH"])
  const guard = (req: IncomingMessage): string | null => {
    const host = (req.headers["host"] ?? "").toLowerCase().trim()
    // IPv6-safe: "[::1]:3000" ? "[::1]" (cut after ']'); plain "h:p" ? "h".
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
      if (hasBrowserSignals && !sameOrigin && (!fetchOk || origin !== undefined || referer !== undefined)) {
        return "Rejected cross-site request (write operations require a same-origin loopback client)"
      }
    }
    return null
  }

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let body = ""
    for await (const chunk of req) {
      body += String(chunk)
      if (Buffer.byteLength(body) > 1_000_000)
        throw Object.assign(new Error("Request body too large (maximum 1 MB)."), { status: 413 })
    }
    try {
      const parsed = JSON.parse(body || "{}") as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("Expected a JSON object.")
      const result = parsed as Record<string, unknown>
      if (typeof result["request_id"] !== "string" && typeof req.headers["x-opencomms-operation-id"] === "string")
        result["request_id"] = req.headers["x-opencomms-operation-id"]
      return result
    } catch {
      throw Object.assign(new Error("Invalid request JSON. Submit a JSON object."), { status: 400 })
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
      message: "ok",
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

  const capabilityPayload = (): ApiResult => {
    const actions: Record<string, ActionCapability> = {}
    for (const route of ACTION_ROUTES) {
      actions[route.command] =
        projectDir || ["workspace_state", "workspace_select", "diagnostics", "capabilities"].includes(route.command)
          ? { state: "supported" }
          : { state: "not_configured", reason: "No project selected.", recovery: "Choose an existing coding project." }
    }
    if (coordinationStopped) {
      for (const command of ["agent_create", "task_assign", "task_reassign"])
        actions[command] = {
          state: "temporarily_unavailable",
          reason: "Coordination delivery is stopped.",
          recovery: "Resume coordination explicitly.",
        }
    }
    if (projectDir)
      for (const command of ["node_approve", "node_revoke", "audit_log"])
        actions[command] = {
          state: "authentication_required",
          reason: "An owner confirmation token is required for this action.",
          recovery:
            "The local owner can read trust.owner_confirm_token in the selected project's .opencomms/orchestrator.json and enter it in this form.",
        }
    const orchestration = orchestratorStore?.load()
    const agents = orchestration?.agents ?? []
    const agentCapabilities = Object.fromEntries(
      agents.map((agent) => [
        agent.id,
        {
          operating_mode: "managed",
          identity: agent.host_session_id ? "reported" : "unknown",
          model: agent.model ?? "unknown",
          usage: "unknown",
          permissions: permissionCapability(agent, orchestration!.local_node_id).state,
          permissions_detail: permissionCapability(agent, orchestration!.local_node_id).reason ?? null,
          status: agent.status,
          detail: agent.status_detail ?? null,
          worktree: agent.worktree,
          isolation: agent.worktree === projectDir ? "shared_source_tree" : "recorded_separate_worktree",
        },
      ]),
    )
    if (
      projectDir &&
      !coordinationStopped &&
      !agents.some(
        (agent) =>
          agent.node_id === orchestration?.local_node_id &&
          ["idle", "running"].includes(agent.status) &&
          agent.channel_ids.length,
      )
    )
      actions["task_assign"] = {
        state: "not_configured",
        reason: "No running or idle worker is linked to a session.",
        recovery: "Create or resume a managed worker and link its existing host identity to a matching session.",
      }
    return {
      ok: true,
      message: "ok",
      data: {
        version: VERSION,
        contract_version: 1,
        instance_id: instanceId,
        actions,
        agents: agentCapabilities,
        managed_runtimes: ["opencode", ...(process.env["OPENCOMMS_ACP_COMMAND"] ? ["acp"] : [])],
        visibility: "Host model usage and cost remain unknown unless reported by the host.",
        coordination_stopped: coordinationStopped,
        folder_browse: process.platform === "win32" ? "supported" : "unsupported",
        updates: { state: "unsupported", recovery: "Run opencomms update from the CLI after reviewing its target." },
        isolated_worktrees: {
          state: projectDir && existsSync(join(projectDir, ".git")) ? "supported" : "not_configured",
          recovery:
            "Opt in during managed creation in a Git repository root. The new worktree requires a matching channel; ownership in shared workspaces remains advisory.",
        },
        remote_runtime_control: {
          state: "unsupported",
          recovery:
            "Use the authenticated node daemon and CLI; this coordinator does not dispatch remote managed sessions.",
        },
      },
    }
  }

  const sessionDetailPayload = (name: string): ApiResult => {
    const state = load()
    const live = state.channels[normalizeChannelName(name)]
    if (live)
      return {
        ok: true,
        message: "ok",
        data: {
          ...live,
          compact_context:
            live.parent_channel_id && archives?.get(live.parent_channel_id)
              ? buildArchiveContext(archives.get(live.parent_channel_id)!, live.name)
              : undefined,
          agents: live.members.map((member) => ({
            ...member,
            operating_mode: member.surface === "api" ? "managed" : "linked",
            endpoint_capabilities: effectiveEndpointCapabilities(member),
            queued_messages: (state.queues[member.session_id] ?? []).length,
            state: memberState(member, (state.queues[member.session_id] ?? []).length),
          })),
        },
      }
    const archive = archives?.findByName(name) ?? archives?.get(name)
    if (archive)
      return {
        ok: true,
        message: "ok",
        data: {
          ...archive,
          lifecycle: "saved",
          compact_context: buildArchiveContext(archive, archive.name),
          agents: archive.members.map((member) => ({
            ...member,
            endpoint_capabilities: effectiveEndpointCapabilities(member),
            state: "Offline",
          })),
        },
      }
    return { ok: false, message: `No live or archived session matches "${name}".` }
  }

  const joinPayload = (name: string, host: string): ApiResult => {
    if (!findLive(name)) return { ok: false, message: "Choose an active session before retrieving its join command." }
    const result = joinCommandFor(name, host)
    return "error" in result ? { ok: false, message: result.error } : { ok: true, message: "ok", data: result }
  }

  const linkManagedAgent = async (body: Record<string, unknown>): Promise<ApiResult> => {
    if (!projectDir || !store || !orchestratorStore) return { ok: false, message: "Select a project first." }
    const activeStore = store,
      activeOrchestrator = orchestratorStore,
      activeProject = projectDir
    return activeStore.withLock(() => {
      const state = activeStore.load(),
        managed = activeOrchestrator.load()
      const agent = managed.agents.find((a) => a.id === body["agent_id"])
      if (!agent?.host_session_id) return { ok: false, message: "Choose a managed agent with a verified host session." }
      if (agent.node_id !== managed.local_node_id)
        return { ok: false, message: "Remote managed linking is unsupported on this coordinator." }
      const channelName = String(body["channel"] ?? "")
      const channel = state.channels[normalizeChannelName(channelName)]
      if (!channel) return { ok: false, message: "Create the OpenComms session before linking this managed agent." }
      if (agent.worktree !== channel.worktree)
        return {
          ok: false,
          message:
            "The agent and session must use the same worktree. Create a session scoped to this managed worktree before linking.",
        }
      const existing = channel.members.find((m) => m.session_id === agent.host_session_id)
      if (!existing) {
        const result = joinChannel(state, {
          channel: channelName,
          role: agent.role,
          role_prompt: agent.role_prompt,
          session_id: agent.host_session_id,
          project_id: channel.project_id,
          worktree: agent.worktree,
          host: agent.host,
          surface: "api",
          delivery_mode: "pull",
          host_session_id: agent.host_session_id,
          stale_policy: { mode: "none", window_ms: null },
        })
        if (!result.ok) return result
        const member = channel.members.find((m) => m.session_id === agent.host_session_id)!
        member.endpoint_capabilities = {
          push: true,
          pull: false,
          resume: true,
          queue_while_busy: false,
          interrupt: true,
        }
      }
      if (!agent.channel_ids.includes(channel.name)) agent.channel_ids.push(channel.name)
      activeStore.save(state)
      activeOrchestrator.save(managed)
      broadcast("refresh", { reason: "managed_agent_linked" })
      return {
        ok: true,
        message: `Managed agent ${agent.name} linked to ${channel.name}. Its host identity is unchanged.`,
      }
    })
  }

  const createGuiSession = async (body: Record<string, unknown>): Promise<ApiResult> => {
    if (!projectDir || !store) return { ok: false, message: "Select a project before creating a session." }
    const activeStore = store,
      activeProject = projectDir
    const worktreeAgentId = body["worktree_agent_id"]
    const agent = worktreeAgentId
      ? orchestratorStore?.load().agents.find((item) => item.id === worktreeAgentId)
      : undefined
    if (
      worktreeAgentId &&
      (!agent || agent.node_id !== orchestratorStore?.load().local_node_id || !isExistingDirectory(agent.worktree))
    )
      return { ok: false, message: "Choose an existing local managed agent worktree." }
    return activeStore.withLock(() => {
      const state = activeStore.load()
      const created = createSessionAsOperator(state, {
        channel: String(body["name"] ?? ""),
        project_id: "gui-local-project",
        worktree: agent?.worktree ?? activeProject,
        max_members: typeof body["max_members"] === "number" ? body["max_members"] : undefined,
        rate_limit: typeof body["rate_limit"] === "number" ? body["rate_limit"] : undefined,
        max_hops: typeof body["max_hops"] === "number" ? body["max_hops"] : undefined,
        budgets: body["budgets"] as
          { max_runtime_ms?: number | null; max_delivered_messages?: number | null } | undefined,
      })
      if (created.ok) {
        activeStore.save(state)
        broadcast("refresh", { reason: "session_created" })
      }
      return created
    })
  }

  const createManagedAgent = async (body: Record<string, unknown>): Promise<ApiResult> => {
    if (!projectDir || !orchestratorApi || coordinationStopped)
      return { ok: false, message: "Select a project and resume coordination before creating managed agents." }
    // Validate essential inputs before starting a child; never start serve from malformed submissions.
    if (
      !body["name"] ||
      !body["role"] ||
      !body["role_prompt"] ||
      (body["host"] !== "acp" && !body["model"] && !serveModel())
    )
      return { ok: false, message: "Name, role, role prompt and a provider/model pin are required." }
    if (body["host"] && body["host"] !== "opencode" && body["host"] !== "acp")
      return {
        ok: false,
        message: "Managed creation supports OpenCode and explicitly configured ACP; use Sessions to link other hosts.",
      }
    const api = orchestratorApi
    if (body["host"] === "acp") return api.createAgent(body)
    const ready = await ensureServeRunning()
    if (!ready.ok) return { ok: false, message: ready.message }
    return api.createAgent(body)
  }

  const emergencyStop = async (body: Record<string, unknown>): Promise<ApiResult> => {
    if (!store || !orchestratorStore) return { ok: false, message: "Select a project before changing coordination." }
    const activeStore = store,
      managedStore = orchestratorStore
    if (body["resume"] === true) {
      await activeStore.withLock(() => {
        const state = activeStore.load()
        for (const name of emergencyPaused)
          if (state.channels[name]) setSessionPausedAsOperator(state, { channel: name, paused: false })
        activeStore.save(state)
        const managed = managedStore.load()
        managed.coordination = { stopped: false, emergency_paused_channels: [] }
        managedStore.save(managed)
      })
      emergencyPaused.clear()
      coordinationStopped = false
      return {
        ok: true,
        message: "Delivery resumed for sessions paused by this stop. Restart stopped managed agents explicitly.",
      }
    }
    coordinationStopped = true
    deliveryController?.close()
    deliveryController = null
    await activeStore.withLock(() => {
      const state = activeStore.load()
      for (const channel of Object.values(state.channels))
        if (!channel.paused) {
          emergencyPaused.add(channel.name)
          setSessionPausedAsOperator(state, { channel: channel.name, paused: true })
        }
      activeStore.save(state)
      const managed = managedStore.load()
      managed.coordination = { stopped: true, emergency_paused_channels: [...emergencyPaused] }
      managedStore.save(managed)
    })
    const outcomes: Array<{ agent_id: string; ok: boolean; message: string }> = []
    if (body["interrupt_managed"] === true)
      for (const agent of managedStore.load().agents) {
        if (agent.node_id !== managedStore.load().local_node_id || !agent.host_session_id || agent.status === "stopped")
          continue
        try {
          const runtime = managedRuntime(agent)
          const resumed = await runtime.resume(agent)
          if (!resumed.ok) throw new Error(resumed.message)
          await resumed.handle.stop()
          await managedStore.withLock(() => {
            const state = managedStore.load(),
              fresh = state.agents.find((a) => a.id === agent.id)
            if (fresh) fresh.status = "stopped"
            managedStore.save(state)
          })
          outcomes.push({ agent_id: agent.id, ok: true, message: "Host interruption accepted." })
        } catch (error) {
          outcomes.push({
            agent_id: agent.id,
            ok: false,
            message: redactDiagnostic((error as Error).message, [servePassword()]),
          })
        }
      }
    broadcast("refresh", { reason: "coordination_stopped" })
    return {
      ok: outcomes.every((o) => o.ok),
      message:
        "OpenComms delivery paused. Linked host processes continue running." +
        (outcomes.some((o) => !o.ok) ? " Some managed interruptions failed; inspect outcomes." : ""),
      data: { outcomes },
    }
  }

  const managedRuntime = (agent: import("../orchestrator/state.js").AgentRecord) =>
    orchestratorApi?.runtimeForAgent(agent) ??
    createOpencodeRuntime({
      projectDir: projectDir!,
      port: servePort,
      env: {
        ...process.env,
        OPENCOMMS_ORCH_SERVE_PASSWORD: resolvedServePassword(),
        OPENCOMMS_ORCH_SERVE_MODEL: agent.model ?? "",
      },
    })
  const managedTimer = setInterval(() => {
    if (!store || !orchestratorStore || coordinationStopped || closing) return
    if (servePort <= 0 && !orchestratorStore.load().agents.some((a) => a.runtime === "acp" && a.status !== "stopped"))
      return
    if (!deliveryController)
      deliveryController = createManagedDelivery({
        store,
        orchestrator: orchestratorStore,
        runtime: managedRuntime,
        changed: () => broadcast("refresh", { reason: "managed_delivery" }),
        redact: (detail) => redactDiagnostic(detail, [servePassword(), resolvedServePassword(), serveAuthHeader ?? ""]),
      })
    void deliveryController
      .tick()
      .catch((error) => recordError(redactDiagnostic((error as Error).message, [servePassword()])))
  }, 1500)
  managedTimer.unref()

  const sharedBridgeDeps = (): import("../orchestrator/bridge.js").BridgeCoreDeps | null => {
    const base = bridgeDepsProvider?.()
    if (!base) return null
    const locked =
      (fn: (body: Record<string, unknown>) => Promise<ApiResult>) => async (body: Record<string, unknown>) => {
        if (!projectDir || !store) return { ok: false, message: "Select a project first." }
        return store.withLock(() => fn(body))
      }
    return {
      ...base,
      withMutation: async (fn) => {
        activeMutations += 1
        try {
          return await fn()
        } finally {
          activeMutations -= 1
        }
      },
      normalizeResult: (result) => {
        const secrets = [
          servePassword(),
          serveAuthHeader ?? "",
          orchestratorStore?.load().trust.owner_confirm_token ?? "",
        ]
        if (serveAuthHeader?.startsWith("Basic "))
          secrets.push(Buffer.from(serveAuthHeader.slice(6), "base64").toString("utf8").split(":").slice(1).join(":"))
        const envelope = result as ApiResult & { error?: { state: string }; code?: string }
        const normalized =
          result.ok || envelope.error
            ? result
            : {
                ...result,
                error: {
                  state:
                    knownFailureState(envelope.code) ??
                    (!projectDir
                      ? "not_configured"
                      : result.message.startsWith("Owner approval")
                        ? "permission_denied"
                        : "execution_failed"),
                  recovery:
                    "Inspect host configuration and Diagnostics; use the operation ID before retrying a mutation.",
                },
              }
        return JSON.parse(
          JSON.stringify(normalized, (_key, value: unknown) =>
            typeof value === "string" ? redactDiagnostic(value, secrets) : value,
          ),
        ) as ApiResult
      },
      guiReads: {
        ...base.guiReads,
        sessions: sessionsPayload,
        sessionMembers: sessionDetailPayload,
        sessionDetail: sessionDetailPayload,
        sessionJoinCommand: (name, host) => joinPayload(name, host),
        capabilities: capabilityPayload,
        integrationsOverview: async () =>
          projectDir
            ? { ok: true, message: "ok", data: await integrationsOverview(projectDir) }
            : { ok: false, message: "Select a project first." },
        integrationBootstrap: async () =>
          projectDir
            ? { ok: true, message: "ok", data: await projectBootstrap(projectDir) }
            : { ok: false, message: "Select a project first." },
      },
      guiWrites: {
        ...base.guiWrites,
        sessionCreate: createGuiSession,
        sessionSave: locked(base.guiWrites.sessionSave),
        sessionResume: locked(base.guiWrites.sessionResume),
        sessionDelete: locked(base.guiWrites.sessionDelete),
        memberRemove: locked(base.guiWrites.memberRemove),
        setSessionPaused: (body, paused) => locked((b) => base.guiWrites.setSessionPaused(b, paused))(body),
        agentCreate: createManagedAgent,
        agentLink: linkManagedAgent,
        emergencyStop,
        taskAssign: (body) =>
          coordinationStopped
            ? Promise.resolve({ ok: false, message: "Resume coordination before assigning tasks." })
            : base.api.assignTask(body),
        taskReassign: (taskId, body) =>
          coordinationStopped
            ? Promise.resolve({ ok: false, message: "Resume coordination before reassigning work." })
            : base.api.reassignTask(taskId, body),
        integrationAction: async (body) => {
          if (!projectDir) return { ok: false, message: "Select a project first." }
          const report = await integrationAction(projectDir, String(body["id"] ?? ""), String(body["action"] ?? ""))
          return {
            ...report,
            message:
              [...report.actions, ...report.warnings].join("; ") ||
              (report.ok ? "Integration action completed." : "Integration action failed."),
          }
        },
      },
    }
  }

  const server: Server = createServer((req, res) => {
    const requestId =
      typeof req.headers["x-opencomms-operation-id"] === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/.test(req.headers["x-opencomms-operation-id"])
        ? req.headers["x-opencomms-operation-id"]
        : randomUUID()
    res.setHeader("X-OpenComms-Request-Id", requestId)
    const rejected = guard(req)
    if (rejected) {
      recordError(`GUI request rejected: ${rejected}`)
      json(res, 403, { ok: false, message: rejected })
      return
    }
    if (MUTATING.has(req.method ?? "GET")) activeMutations += 1
    void handle(req, res)
      .catch((error) => {
        const message = redactDiagnostic((error as Error).message, [servePassword()])
        recordError(`GUI request ${requestId} failed: ${message}`)
        if (!res.headersSent) json(res, (error as { status?: number }).status ?? 500, { ok: false, message })
      })
      .finally(() => {
        if (MUTATING.has(req.method ?? "GET")) activeMutations -= 1
      })
  })

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.port}`)
    const path = url.pathname.replace(/\/+$/, "") || "/"
    const method = req.method ?? "GET"

    if (method === "GET" && path === "/api/capabilities") {
      json(res, 200, capabilityPayload())
      return
    }
    if (method === "POST" && path === "/api/emergency-stop") {
      const result = await emergencyStop(await readBody(req))
      json(res, result.ok ? 200 : 409, result)
      return
    }

    if (method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      res.end(GUI_HTML)
      return
    }
    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" })
      res.write(`event: hello\ndata: {}\n\n`)
      sseClients.add(res)
      // Additive orchestrator topic (contract v0.3 �9): the feed's emit()
      // broadcasts `event: orchestrator` through this same client set;
      // generic `refresh` semantics stay unchanged.
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

    // Orchestrator routes (contract v0.3): dispatch via the in-process API.
    const orchMatch = path.match(/^\/api\/orchestrator(\/.*)?$/)
    if (orchMatch) {
      const activeApi = orchestratorApi
      const activeFeed = feed
      if (!activeApi || !activeFeed || !orchestratorStore) {
        json(res, 409, { ok: false, message: "Select a project before using orchestrator routes." })
        return
      }
      const orchestratorDispatch = async (): Promise<void> => {
        const sub = orchMatch[1] ?? "/"
        if (method === "GET" && sub === "/nodes") {
          json(res, 200, activeApi.listNodes())
          return
        }
        const runtimesMatch = sub.match(/^\/nodes\/([^/]+)\/runtimes$/)
        if (method === "GET" && runtimesMatch) {
          const result = await activeApi.listRuntimes(decodeURIComponent(runtimesMatch[1] ?? ""))
          json(res, result.ok ? 200 : 400, result)
          return
        }
        if (method === "GET" && sub === "/agents") {
          json(res, 200, activeApi.listAgents())
          return
        }
        const agentDetail = sub.match(/^\/agents\/([^/]+)$/)
        if (method === "GET" && agentDetail) {
          json(res, 200, activeApi.getAgent(decodeURIComponent(agentDetail[1] ?? "")))
          return
        }
        if (method === "POST" && sub === "/agents/create") {
          const result = await createManagedAgent(await readBody(req))
          if (result.ok) broadcast("refresh", { reason: "managed_agent_created" })
          json(res, result.ok ? 200 : 400, result)
          return
        }
        if (method === "POST" && sub === "/agents/link") {
          const result = await linkManagedAgent(await readBody(req))
          json(res, result.ok ? 200 : 400, result)
          return
        }
        const taskDetailMatch = sub.match(/^\/tasks\/([^/]+)$/)
        const taskTransitionMatch = sub.match(/^\/tasks\/([^/]+)\/transition$/)
        if (method === "GET" && taskDetailMatch) {
          const result = activeApi.getTask(decodeURIComponent(taskDetailMatch[1]!))
          json(res, result.ok ? 200 : 404, result)
          return
        }
        if (method === "POST" && taskTransitionMatch) {
          const result = await activeApi.transitionTask(
            decodeURIComponent(taskTransitionMatch[1]!),
            await readBody(req),
          )
          if (result.ok) broadcast("refresh", { reason: "task_transition" })
          json(res, result.ok ? 200 : 400, result)
          return
        }
        if (method === "GET" && sub === "/context") {
          json(res, 200, activeApi.listContext(url.searchParams.get("query") ?? ""))
          return
        }
        if (method === "GET" && sub === "/context/handoff") {
          json(res, 200, activeApi.contextHandoff())
          return
        }
        if (method === "POST" && sub === "/context") {
          const result = await activeApi.addContext(await readBody(req))
          json(res, result.ok ? 200 : 400, result)
          return
        }
        if (method === "POST" && sub === "/agents/stop") {
          const body = await readBody(req)
          const result = await activeApi.stopAgent(body)
          if (result.ok) broadcast("refresh", { reason: "orchestrator_agent_stopped" })
          json(res, result.ok ? 200 : 400, result)
          return
        }
        if (method === "POST" && sub === "/agents/restart") {
          const body = await readBody(req)
          const result = await activeApi.restartAgent(body)
          if (result.ok) broadcast("refresh", { reason: "orchestrator_agent_restarted" })
          json(res, result.ok ? 200 : 400, result)
          return
        }
        if (method === "GET" && sub === "/events") {
          const since = Number(url.searchParams.get("since") ?? "0")
          json(res, 200, activeApi.listEvents(Number.isFinite(since) ? since : 0))
          return
        }
        if (method === "GET" && sub === "/trust") {
          json(res, 200, activeApi.trustView())
          return
        }
        if (method === "POST" && sub === "/audit") {
          const body = await readBody(req)
          const result = activeApi.auditLog(body)
          json(res, result.ok ? 200 : result.message.startsWith("Owner approval") ? 403 : 400, result)
          return
        }
        if (method === "GET" && sub === "/tasks") {
          json(res, 200, activeApi.listTasks())
          return
        }
        if (method === "GET" && sub === "/team-templates") {
          json(res, 200, activeApi.listTeamTemplates())
          return
        }
        if (method === "POST" && sub === "/team-templates") {
          const result = await activeApi.saveTeamTemplate(await readBody(req))
          json(res, result.ok ? 200 : 400, result)
          return
        }
        const templateDelete = sub.match(/^\/team-templates\/([^/]+)$/)
        if (method === "DELETE" && templateDelete) {
          const result = await activeApi.deleteTeamTemplate(decodeURIComponent(templateDelete[1]!), await readBody(req))
          json(res, result.ok ? 200 : 400, result)
          return
        }
        const reassignMatch = sub.match(/^\/tasks\/([^/]+)\/reassign$/)
        if (method === "POST" && reassignMatch) {
          const result = coordinationStopped
            ? { ok: false, message: "Resume coordination before reassigning work." }
            : await activeApi.reassignTask(decodeURIComponent(reassignMatch[1]!), {
                ...(await readBody(req)),
                actor_id: "operator",
              })
          if (result.ok) broadcast("refresh", { reason: "task_reassigned" })
          json(res, result.ok ? 200 : 400, result)
          return
        }
        if (method === "POST" && sub === "/tasks/assign") {
          const body = await readBody(req)
          const result = coordinationStopped
            ? { ok: false, message: "Resume coordination before assigning tasks." }
            : await activeApi.assignTask(body)
          if (result.ok) broadcast("refresh", { reason: "orchestrator_task_assigned" })
          json(res, result.ok ? 200 : 400, result)
          return
        }
        if (method === "POST" && (sub === "/nodes/approve" || sub === "/nodes/revoke")) {
          const body = await readBody(req)
          const result = await activeApi.approveOrRevoke(body, sub === "/nodes/approve" ? "approve" : "revoke")
          json(res, result.ok ? 200 : result.message.startsWith("Owner approval") ? 403 : 400, result)
          return
        }
        if (method === "POST" && sub === "/nodes/pairing-code") {
          const body = await readBody(req)
          const result = await activeApi.createPairingCode(body)
          json(res, result.ok ? 200 : result.message.startsWith("Owner approval") ? 403 : 400, result)
          return
        }
        if (method === "POST" && sub === "/nodes/claim-pairing") {
          const body = await readBody(req)
          const result = await activeApi.claimPairingCode(body)
          json(res, result.ok ? 200 : 400, result)
          return
        }
        const permListMatch = sub.match(/^\/agents\/([^/]+)\/permissions$/)
        if (method === "GET" && permListMatch) {
          const result = await activeApi.listPermissions(decodeURIComponent(permListMatch[1] ?? ""))
          json(res, result.ok ? 200 : 400, result)
          return
        }
        const permRespondMatch = sub.match(/^\/agents\/([^/]+)\/permissions\/([^/]+)$/)
        if (method === "POST" && permRespondMatch) {
          const body = await readBody(req)
          const result = await activeApi.respondPermission(
            decodeURIComponent(permRespondMatch[1] ?? ""),
            decodeURIComponent(permRespondMatch[2] ?? ""),
            body,
          )
          json(res, result.ok ? 200 : 400, result)
          return
        }
        json(res, 404, { ok: false, message: `No orchestrator route for ${method} ${sub}` })
      }
      await orchestratorDispatch().catch((error) => {
        recordError(`Orchestrator API failed: ${(error as Error).message}`)
        if (!res.headersSent) json(res, 500, { ok: false, message: `Internal error: ${(error as Error).message}` })
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

    // M3: Integrations surface — backed by the SAME manager as the CLI
    // doctor (no second diagnostics implementation). GET is read-only
    // detection; POST actions are mutating and pass the guard above.
    if (method === "GET" && path === "/api/integrations") {
      if (!projectDir) {
        json(res, 409, { ok: false, message: "Select a project before inspecting integrations." })
        return
      }
      const selected = projectDir
      const overview = await integrationsOverview(selected)
      // Machine-level CLI presence stays separate from project integrations
      // (plan decision #4); detection-only, never off the sync path — all
      // host detections here are filesystem reads.
      json(res, 200, { ok: true, data: overview })
      return
    }

    const bootstrapMatch = path === "/api/integrations/bootstrap"
    if (method === "GET" && bootstrapMatch) {
      if (!projectDir) {
        json(res, 409, { ok: false, message: "Select a project before requesting the bootstrap status." })
        return
      }
      const decision = await projectBootstrap(projectDir)
      json(res, 200, { ok: true, data: decision })
      return
    }

    const integrationActionMatch = path.match(/^\/api\/integrations\/([^/]+)\/([^/]+)$/)
    if (integrationActionMatch && method === "POST") {
      if (!projectDir) {
        json(res, 409, { ok: false, message: "Select a project before changing integrations." })
        return
      }
      const id = decodeURIComponent(integrationActionMatch[1]!)
      const action = decodeURIComponent(integrationActionMatch[2]!)
      const report = await integrationAction(projectDir, id, action)
      if (report.ok) broadcast("refresh", { reason: `integration_${action}` })
      json(res, report.ok ? 200 : 400, report)
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
        const body = await readBody(req)
        const result = await createGuiSession(body)
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
        // Non-live phase: the decided id may be a NAME � resolve it to the
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
      const result = sessionDetailPayload(decodeURIComponent(membersMatch[1]!))
      json(res, result.ok ? 200 : 404, result)
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
      const result = joinPayload(name, host)
      json(res, result.ok ? 200 : 400, result)
      return
    }

    json(res, 404, { ok: false, message: `No GUI route for ${method} ${path}` })
  }

  return new Promise((resolve) => {
    server.listen(deps.port, deps.hostname, () => {
      resolve({
        server,
        port: (server.address() as { port: number }).port,
        bridgeDeps: sharedBridgeDeps,
        close: () =>
          new Promise<void>((resolveClose) => {
            closing = true
            // The refresh timer is unref'd; unwind the stat watchers too.
            if (refreshTimer) clearTimeout(refreshTimer)
            clearInterval(managedTimer)
            deliveryController?.close()
            stopWatchers()
            for (const res of sseClients) res.end()
            sseClients.clear()
            // Managed serve shutdown (ensureServe spec): SIGTERM the shared
            // serve so no orphan survives the GUI process.
            try {
              if (serveChild && !serveChild.killed && serveChild.exitCode === null) {
                serveChild.kill("SIGTERM")
              }
            } catch {
              /* best effort; the child may have already exited */
            }
            serveChild = null
            const runtimesClosed =
              orchestratorApi?.shutdownRuntimes().catch((error) => recordError(String(error))) ?? Promise.resolve()
            server.close(() => {
              void runtimesClosed.then(() => resolveClose())
            })
          }),
      })
    })
  })
}
