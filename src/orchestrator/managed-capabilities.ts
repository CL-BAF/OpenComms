/** Capabilities implemented by this build, separate from vendor marketing or catalogues. */
export function managedCapabilities(host: string): Record<string, "supported" | "unsupported" | "unknown"> {
  const common = {
    push: "supported",
    interrupt: "supported",
    permissions: "supported",
    status: "supported",
    identity: "supported",
    isolated_worktree: "supported",
    usage: "unsupported",
    cost: "unsupported",
  } as const
  if (host === "opencode") return { ...common, model_selection: "supported", resume: "supported" }
  if (host === "acp") return { ...common, model_selection: "unsupported", resume: "unknown" }
  return {}
}

export function requiredCapabilityIssue(host: string, required: unknown, isolated: boolean): string | null {
  if (required === undefined) return null
  if (
    !Array.isArray(required) ||
    required.length > 16 ||
    !required.every((item) => typeof item === "string" && /^[a-z][a-z_]{0,31}$/.test(item))
  )
    return "required_capabilities must be a list of at most 16 canonical capability names."
  const implemented = managedCapabilities(host)
  for (const capability of required as string[]) {
    if (implemented[capability] !== "supported")
      return `Managed ${host} capability ${capability} is ${implemented[capability] ?? "unknown"}; creation was not attempted.`
    if (capability === "isolated_worktree" && !isolated)
      return "Required isolated_worktree capability needs isolated_worktree:true."
  }
  return null
}
