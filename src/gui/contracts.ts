/** Named, bounded actions shared by the browser and native transport. */
export const ACTION_ROUTES = [
  { method: "GET", path: "/api/capabilities", command: "capabilities" },
  { method: "GET", path: "/api/workspace", command: "workspace_state" },
  { method: "POST", path: "/api/workspace", command: "workspace_select" },
  { method: "GET", path: "/api/sessions", command: "sessions_list" },
  { method: "POST", path: "/api/sessions", command: "session_create" },
  { method: "GET", path: "/api/sessions/:name/members", command: "session_members" },
  { method: "GET", path: "/api/sessions/:name/join-command", command: "session_join_command" },
  { method: "POST", path: "/api/sessions/:name/members/remove", command: "member_remove" },
  { method: "POST", path: "/api/sessions/:name/save", command: "session_save" },
  { method: "POST", path: "/api/sessions/:name/resume", command: "session_resume" },
  { method: "POST", path: "/api/sessions/:name/pause", command: "session_pause" },
  { method: "POST", path: "/api/sessions/:name/unpause", command: "session_unpause" },
  { method: "DELETE", path: "/api/sessions/:name", command: "session_delete" },
  { method: "GET", path: "/api/orchestrator/agents", command: "agents_list" },
  { method: "POST", path: "/api/orchestrator/agents/create", command: "agent_create" },
  { method: "POST", path: "/api/orchestrator/agents/stop", command: "agent_stop" },
  { method: "POST", path: "/api/orchestrator/agents/restart", command: "agent_restart" },
  { method: "POST", path: "/api/orchestrator/agents/link", command: "agent_link" },
  { method: "GET", path: "/api/orchestrator/agents/:agent_id/permissions", command: "permissions_list" },
  {
    method: "POST",
    path: "/api/orchestrator/agents/:agent_id/permissions/:permission_id",
    command: "permission_respond",
  },
  { method: "GET", path: "/api/orchestrator/tasks", command: "tasks_list" },
  { method: "POST", path: "/api/orchestrator/tasks/assign", command: "task_assign" },
  { method: "GET", path: "/api/orchestrator/tasks/:task_id", command: "task_get" },
  { method: "POST", path: "/api/orchestrator/tasks/:task_id/transition", command: "task_transition" },
  { method: "POST", path: "/api/orchestrator/tasks/:task_id/reassign", command: "task_reassign" },
  { method: "GET", path: "/api/orchestrator/team-templates", command: "team_template_list" },
  { method: "POST", path: "/api/orchestrator/team-templates", command: "team_template_save" },
  { method: "DELETE", path: "/api/orchestrator/team-templates/:template_id", command: "team_template_delete" },
  { method: "GET", path: "/api/orchestrator/context", command: "context_list" },
  { method: "POST", path: "/api/orchestrator/context", command: "context_add" },
  { method: "GET", path: "/api/orchestrator/context/handoff", command: "context_handoff" },
  { method: "GET", path: "/api/orchestrator/events", command: "events_list" },
  { method: "GET", path: "/api/orchestrator/nodes", command: "nodes_list" },
  { method: "GET", path: "/api/orchestrator/nodes/:node_id/runtimes", command: "runtimes_list" },
  { method: "GET", path: "/api/orchestrator/trust", command: "trust_view" },
  { method: "POST", path: "/api/orchestrator/nodes/approve", command: "node_approve" },
  { method: "POST", path: "/api/orchestrator/nodes/revoke", command: "node_revoke" },
  { method: "POST", path: "/api/orchestrator/audit", command: "audit_log" },
  { method: "GET", path: "/api/integrations", command: "integrations_overview" },
  { method: "GET", path: "/api/integrations/bootstrap", command: "integration_bootstrap" },
  { method: "POST", path: "/api/integrations/:id/:action", command: "integration_action" },
  { method: "GET", path: "/api/diagnostics", command: "diagnostics" },
  { method: "POST", path: "/api/emergency-stop", command: "emergency_stop" },
] as const

export type ActionCommand = (typeof ACTION_ROUTES)[number]["command"]
export type CapabilityState =
  | "supported"
  | "unsupported"
  | "not_configured"
  | "authentication_required"
  | "permission_denied"
  | "temporarily_unavailable"
  | "execution_failed"

export interface ActionCapability {
  state: CapabilityState
  reason?: string
  recovery?: string
}

/** Preserve backend capability failures across both transport envelopes. */
export function knownFailureState(value: unknown): Exclude<CapabilityState, "supported"> | null {
  if (
    value === "unsupported" ||
    value === "not_configured" ||
    value === "authentication_required" ||
    value === "permission_denied" ||
    value === "temporarily_unavailable" ||
    value === "execution_failed"
  )
    return value
  return null
}

/** Pure resolver; its source is embedded in the offline document too. No arbitrary IPC proxy. */
export function resolveAction(
  path: string,
  method: string,
  body: Record<string, unknown>,
  routes: readonly { method: string; path: string; command: string }[] = ACTION_ROUTES,
): { command: string; args: Record<string, unknown> } | null {
  const url = new URL(path, "http://localhost")
  const parts = url.pathname.split("/")
  for (const route of routes) {
    if (route.method !== method) continue
    const expected = route.path.split("/")
    if (expected.length !== parts.length) continue
    const args = { ...body }
    let match = true
    for (let i = 0; i < expected.length; i++) {
      const segment = expected[i]!
      if (segment.startsWith(":")) args[segment.slice(1)] = decodeURIComponent(parts[i]!)
      else if (segment !== parts[i]) {
        match = false
        break
      }
    }
    if (!match) continue
    for (const key of ["host", "role", "query"]) {
      if (url.searchParams.has(key)) args[key] = url.searchParams.get(key)
    }
    if (url.searchParams.has("since")) args["since"] = Number(url.searchParams.get("since"))
    return { command: route.command, args }
  }
  return null
}

export function redactDiagnostic(message: string, secrets: string[] = []): string {
  let result = message
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]")
  return result
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9+/=_-]+/gi, "$1 [REDACTED]")
    .replace(/((?:password|token|api[_-]?key|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
}
