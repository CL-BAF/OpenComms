#!/usr/bin/env node
// Static packaged-frontend checks; this does not start a Tauri webview.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Script } from "node:vm"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const output = join(root, "desktop", "dist-shell")
const html = readFileSync(join(output, "index.html"), "utf8")
const javascript = readFileSync(join(output, "app.js"), "utf8")
const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"))
const configuration = JSON.parse(readFileSync(join(root, "desktop", "src-tauri", "tauri.conf.json"), "utf8"))
assert.equal(manifest.version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version)
assert.equal(manifest.script_sha256, createHash("sha256").update(javascript).digest("hex"))
assert.equal(manifest.html_sha256, createHash("sha256").update(html).digest("hex"))
assert.equal([...html.matchAll(/<script\b/gi)].length, 1)
assert.match(html, /<script src="\.\/app\.js" defer><\/script>/)
assert.doesNotMatch(html, /\bon[a-z]+\s*=/i)
assert.equal(configuration.app.security.csp["script-src"], "'self'")
assert.doesNotMatch(configuration.app.security.csp["connect-src"], /127\.0\.0\.1/)
assert.match(javascript, /orchestrator_invoke/)
assert.match(javascript, /session_join_command/)
assert.match(javascript, /member_remove/)
new Script(javascript, { filename: "app.js" })
process.stdout.write("Native bundled assets: version, hashes, CSP, script syntax and named IPC references passed.\n")
