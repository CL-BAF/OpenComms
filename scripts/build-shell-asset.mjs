#!/usr/bin/env node
// Build the actual offline Tauri frontend from the shared console, with no
// inline JavaScript (the native CSP intentionally disallows it).
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Script } from "node:vm"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const compiler = join(root, "node_modules", "typescript", "bin", "tsc")
const compiled = spawnSync(process.execPath, [compiler, "-p", join(root, "tsconfig.build.json")], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
})
if (compiled.error || compiled.status !== 0) {
  process.stderr.write(
    "Native frontend compilation failed. Install root dependencies with npm ci and correct TypeScript diagnostics.\n",
  )
  process.exit(compiled.status ?? 1)
}

// Successful tsc emission replaces standalone entries with ordinary modules.
// Restore their bundles before a native asset build can affect installations.
const bundled = spawnSync(process.execPath, [join(root, "scripts", "build-bundles.mjs")], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
})
if (bundled.error || bundled.status !== 0) {
  process.stderr.write("Standalone adapter bundling failed; native assets were not replaced.\n")
  process.exit(bundled.status ?? 1)
}

const { GUI_HTML } = await import(pathToFileURL(join(root, "dist", "gui", "ui.js")).href)
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const scripts = [...GUI_HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
if (scripts.length !== 1 || /<script\b[^>]*\bsrc\s*=/i.test(GUI_HTML)) {
  throw new Error("Shared console script structure changed; review native extraction before packaging.")
}
const javascript = scripts[0][1]
// Fail before replacing assets if interpolation produced invalid JavaScript.
new Script(javascript, { filename: "app.js" })
const html = GUI_HTML.replace(scripts[0][0], '<script src="./app.js" defer></script>')
if (/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(html) || /\bon[a-z]+\s*=/i.test(html)) {
  throw new Error("Native frontend contains inline JavaScript forbidden by its CSP.")
}
const output = join(root, "desktop", "dist-shell")
mkdirSync(output, { recursive: true })
writeFileSync(join(output, "app.js"), javascript, "utf8")
writeFileSync(join(output, "index.html"), html, "utf8")
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      version: packageJson.version,
      transport: "allowlisted-stdio",
      script_sha256: createHash("sha256").update(javascript).digest("hex"),
      html_sha256: createHash("sha256").update(html).digest("hex"),
    },
    null,
    2,
  ) + "\n",
  "utf8",
)
process.stdout.write(`Native frontend generated: ${output}\n`)
