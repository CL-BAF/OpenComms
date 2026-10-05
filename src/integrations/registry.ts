import { IntegrationManager } from "./manager.js"
import { opencodeAdapter } from "./adapters/opencode.js"
import { claudeCodeAdapter } from "./adapters/claude-code.js"
import { codexAdapter } from "./adapters/codex.js"
import { claudeDesktopAdapter } from "./adapters/claude-desktop.js"
import { chatgptAdapter } from "./adapters/chatgpt.js"
import { geminiCliAdapter } from "./adapters/gemini-cli.js"

export function createDefaultManager(): IntegrationManager {
  const manager = new IntegrationManager()
  manager.register(opencodeAdapter)
  manager.register(claudeCodeAdapter)
  manager.register(codexAdapter)
  manager.register(claudeDesktopAdapter)
  manager.register(chatgptAdapter)
  manager.register(geminiCliAdapter)
  return manager
}
