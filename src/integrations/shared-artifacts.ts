import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Keep the shared stdio bundle whenever another project integration refers to it. */
export function sharedMcpBundleInUse(projectDir: string, removingHost: string): boolean {
  for (const [host, path] of [
    ["claude-code", ".mcp.json"],
    ["codex", ".codex/config.toml"],
    ["gemini-cli", ".gemini/settings.json"],
  ]) {
    if (host === removingHost || !existsSync(join(projectDir, path!))) continue
    try {
      const source = readFileSync(join(projectDir, path!), "utf8")
      if (host === "codex") {
        if (/^\s*\[mcp_servers\.opencomms(?:\.env)?\]\s*$/m.test(source)) return true
      } else {
        const parsed: unknown = JSON.parse(source)
        if (typeof parsed === "object" && parsed !== null && "mcpServers" in parsed) {
          const servers = parsed.mcpServers
          if (typeof servers === "object" && servers !== null && "opencomms" in servers) return true
        }
      }
    } catch {
      return true
    } // malformed other configuration: preserve its recovery artifact
  }
  return false
}
