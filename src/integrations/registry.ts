/**
 * Canonical host-integration registry (M2).
 *
 * Single backend shared by the CLI doctor (`src/cli/doctor.ts`) and the
 * GUI Integrations surface (M3): both build their manager here, so
 * there is never a second diagnostics implementation to drift.
 *
 * `src/integrations/index.ts` is a thin back-compat facade over this
 * registry (createDefaultManager + named adapter exports); there are no
 * in-repo consumers of the facade — new code imports THIS module.
 */

import { IntegrationManager } from "./manager.js"
import { opencodeAdapter } from "./adapters/opencode.js"
import { claudeCodeAdapter } from "./adapters/claude-code.js"
import { codexAdapter } from "./adapters/codex.js"
import { claudeDesktopAdapter } from "./adapters/claude-desktop.js"
import { chatgptAdapter } from "./adapters/chatgpt.js"

export function createDefaultManager(): IntegrationManager {
  const manager = new IntegrationManager()
  manager.register(opencodeAdapter)
  manager.register(claudeCodeAdapter)
  manager.register(codexAdapter)
  manager.register(claudeDesktopAdapter)
  manager.register(chatgptAdapter)
  return manager
}
