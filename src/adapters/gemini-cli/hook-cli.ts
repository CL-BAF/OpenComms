/** Documented Gemini SessionStart/BeforeAgent context injection. */
import { readFileSync } from "node:fs"
import { hookFromInput, type ClaudeHookInput } from "../claude-code/hooks.js"

export async function runGeminiHook(input: ClaudeHookInput): Promise<unknown> {
  // AfterAgent feedback starts another model turn; leave mail queued until
  // BeforeAgent or MCP pull instead of manufacturing an autonomous retry.
  if (!["SessionStart", "BeforeAgent", "SessionEnd"].includes(input.hook_event_name ?? "")) return {}
  return hookFromInput(input, "gemini-cli")
}

const invoked = process.argv[1]?.replace(/\\/g, "/") ?? ""
if (/(gemini-cli-hooks|gemini-cli\/hook-cli)\.(mjs|js|ts)$/.test(invoked)) {
  let input: ClaudeHookInput = {}
  try {
    input = JSON.parse(readFileSync(0, "utf8")) as ClaudeHookInput
  } catch {
    /* fail open */
  }
  void runGeminiHook(input)
    .then((output) => process.stdout.write(JSON.stringify(output)))
    .catch(() => process.stdout.write("{}"))
}
