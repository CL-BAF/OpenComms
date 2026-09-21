/**
 * ChatGPT adapter (M2): wraps src/adapters/chatgpt/install.ts.
 *
 * Project artifacts (EXPERIMENTAL scaffold):
 *   - <project>/opencomms-chatgpt/mcp-streamable-server.mjs
 *   - <project>/opencomms-chatgpt/README.md
 *
 * Both present -> installed (or outdated via marker); neither -> absent;
 * partial -> broken. Capabilities stay honest: PULL ONLY scaffold,
 * "Platform setup required" — never installable to FULL.
 * ChatGPT Desktop is not directly detectable by design (no documented API);
 * scaffold presence is the project signal.
 */

import { existsSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  scaffoldChatGptIntegration,
  detectChatGptDesktop,
  CHATGPT_CAPABILITIES,
} from "../../adapters/chatgpt/install.js"
import { compareVersions, getInstalledVersion, removeIntegrationMarker, setInstalledVersion } from "../versioning.js"
import type { HostIntegration, IntegrationContext, IntegrationDetection, IntegrationReport } from "../types.js"

export const CHATGPT_SCAFFOLD_DIR = "opencomms-chatgpt"

async function detectChatGpt(ctx: IntegrationContext): Promise<IntegrationDetection> {
  const target = resolve(ctx.projectDir)
  const details: string[] = []
  const issues: string[] = []

  const serverPath = join(target, CHATGPT_SCAFFOLD_DIR, "mcp-streamable-server.mjs")
  const readmePath = join(target, CHATGPT_SCAFFOLD_DIR, "README.md")
  const serverPresent = existsSync(serverPath)
  const readmePresent = existsSync(readmePath)
  details.push(
    `scaffold server ${serverPresent ? "present" : "missing"} (${CHATGPT_SCAFFOLD_DIR}/mcp-streamable-server.mjs)`,
  )
  details.push(`scaffold readme ${readmePresent ? "present" : "missing"} (${CHATGPT_SCAFFOLD_DIR}/README.md)`)

  const desktop = detectChatGptDesktop()
  details.push(
    `ChatGPT Desktop ${desktop.detected ? "detected" : "not directly detectable by design; scaffold status is the project signal"}`,
  )
  details.push("Platform setup required (OAuth 2.1 + PKCE, TLS, public hostname are operator-provided)")

  const marker = getInstalledVersion(target, "chatgpt")
  if (marker) details.push(`marker version ${marker}`)

  if (!serverPresent && !readmePresent) {
    return { status: "absent", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  if (!serverPresent || !readmePresent) {
    if (!serverPresent) issues.push("scaffold server missing (opencomms-chatgpt/mcp-streamable-server.mjs)")
    if (!readmePresent) issues.push("scaffold readme missing (opencomms-chatgpt/README.md)")
    return { status: "broken", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  if (marker && compareVersions(marker, ctx.currentVersion) < 0) {
    issues.push(`outdated marker ${marker} < ${ctx.currentVersion} (update required)`)
    return { status: "outdated", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
  }
  return { status: "installed", installedVersion: marker, currentVersion: ctx.currentVersion, details, issues }
}

function toReport(
  ctx: IntegrationContext,
  native: { ok: boolean; filesWritten: Array<{ path: string }>; warnings: string[] },
  action: string,
): IntegrationReport {
  if (!native.ok) {
    return {
      ok: false,
      actions: [],
      warnings: native.warnings.length > 0 ? native.warnings : [`${action} failed`],
      capabilities: CHATGPT_CAPABILITIES,
      changedFiles: [],
    }
  }
  setInstalledVersion(resolve(ctx.projectDir), "chatgpt", ctx.currentVersion, { via: action })
  return {
    ok: true,
    actions: [`${action}: ${native.filesWritten.map((f) => f.path).join("; ")}`],
    warnings: native.warnings,
    capabilities: CHATGPT_CAPABILITIES,
    changedFiles: native.filesWritten.map((f) => f.path),
  }
}

export const chatgptAdapter: HostIntegration = {
  id: "chatgpt",
  name: "ChatGPT",
  scope: "project",
  detect: detectChatGpt,
  async install(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, scaffoldChatGptIntegration(resolve(ctx.projectDir)), "install")
  },
  async update(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, scaffoldChatGptIntegration(resolve(ctx.projectDir)), "update")
  },
  async repair(ctx: IntegrationContext): Promise<IntegrationReport> {
    return toReport(ctx, scaffoldChatGptIntegration(resolve(ctx.projectDir)), "repair")
  },
  async verify(ctx: IntegrationContext): Promise<IntegrationReport> {
    const detection = await detectChatGpt(ctx)
    if (detection.status === "installed") {
      return {
        ok: true,
        actions: [`verify: scaffold present (${detection.details.join("; ")})`],
        warnings: [],
        capabilities: CHATGPT_CAPABILITIES,
        changedFiles: [],
      }
    }
    return {
      ok: false,
      actions: [],
      warnings: [`verify failed (${detection.status}): ${[...detection.issues, ...detection.details].join("; ")}`],
      capabilities: CHATGPT_CAPABILITIES,
      changedFiles: [],
    }
  },
  async uninstall(ctx: IntegrationContext): Promise<IntegrationReport> {
    // Binding order (Reviewer R2): files first, marker last. Absent => ok:true
    // no-op before touching the marker. The scaffold is inert until deployed,
    // so removing its directory is the complete uninstall (same wording as
    // the CLI).
    const target = resolve(ctx.projectDir)
    const detection = await detectChatGpt(ctx)
    if (detection.status === "absent") {
      return {
        ok: true,
        actions: ["uninstall: nothing to remove (not installed)"],
        warnings: ["NOTE: .opencomms/state.json and pins are shared project state and were NOT removed."],
        capabilities: CHATGPT_CAPABILITIES,
        changedFiles: [],
      }
    }
    const scaffoldDir = join(target, CHATGPT_SCAFFOLD_DIR)
    if (existsSync(scaffoldDir)) {
      try {
        rmSync(scaffoldDir, { recursive: true, force: true })
      } catch (error) {
        return {
          ok: false,
          actions: [],
          warnings: [`could not remove ${CHATGPT_SCAFFOLD_DIR}/: ${(error as Error).message}`],
          capabilities: CHATGPT_CAPABILITIES,
          changedFiles: [],
        }
      }
    }
    removeIntegrationMarker(target, "chatgpt")
    return {
      ok: true,
      actions: [`removed ${CHATGPT_SCAFFOLD_DIR}/ scaffold directory (was inert until deployed)`],
      warnings: ["NOTE: .opencomms/state.json and pins are shared project state and were NOT removed."],
      capabilities: CHATGPT_CAPABILITIES,
      changedFiles: [`${CHATGPT_SCAFFOLD_DIR}/`],
    }
  },
}
