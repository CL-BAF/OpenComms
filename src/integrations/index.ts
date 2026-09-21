/**
 * Integrations entry point (M3 reconciled).
 *
 * Canonical factory lives in `./registry.js` (all five hosts; shared by the
 * CLI doctor and the future GUI Integrations surface). This module is the
 * back-compat facade: same named adapter exports plus the canonical
 * `createDefaultManager` re-exported, so M1-era consumers keep working with
 * zero drift between the two paths.
 */
export * from "./types.js"
export * from "./versioning.js"
export * from "./manager.js"
export { createDefaultManager } from "./registry.js"
export { opencodeAdapter } from "./adapters/opencode.js"
export { claudeCodeAdapter } from "./adapters/claude-code.js"
export { codexAdapter } from "./adapters/codex.js"
export { claudeDesktopAdapter } from "./adapters/claude-desktop.js"
export { chatgptAdapter } from "./adapters/chatgpt.js"
