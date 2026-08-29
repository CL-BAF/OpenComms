/**
 * Claude Code hook CLI entrypoint.
 *
 * Claude Code runs: node claude-code-hooks.mjs <subcommand>
 * with the hook JSON on stdin (session_id, cwd, hook_event_name, ...).
 * stdout JSON may inject additionalContext at hook boundaries.
 *
 * Handlers are async (state lock is async); the process stays alive until
 * the work settles — no blocking, no spin (Reviewer Issue 1).
 */

import { hookSessionStart, hookUserPromptSubmit, hookStop, hookSessionEnd } from "./hooks.js"

export async function runHook(sub: string, projectDir?: string): Promise<unknown> {
  switch (sub) {
    case "session-start":
      return await hookSessionStart(projectDir)
    case "user-prompt-submit":
      return await hookUserPromptSubmit(projectDir)
    case "stop":
      return await hookStop(projectDir)
    case "session-end":
      return hookSessionEnd(projectDir)
    default:
      return {}
  }
}

// CLI execution only (not when imported). Match any hook-cli/hook-runner
// filename (dist emits hook-cli.js; the installed copy is claude-code-hooks.mjs).
const invoked = process.argv[1]?.replace(/\\/g, "/") ?? ""
if (/(claude-code-hooks|hook-cli)\.(mjs|js|ts)$/.test(invoked)) {
  void (async () => {
    const sub = process.argv[2] ?? ""
    // Optional explicit project dir (argv[3]); hooks.json passes none —
    // the hook stdin `cwd` (Claude Code's project dir) is the default.
    const projectDir = process.argv[3] && !process.argv[3].startsWith("-") ? process.argv[3] : undefined
    let output: unknown = {}
    try {
      output = await runHook(sub, projectDir)
    } catch {
      output = {}
    }
    process.stdout.write(JSON.stringify(output))
    process.exit(0)
  })()
}
