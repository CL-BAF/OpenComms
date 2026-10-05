import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { ICON_ICO_BASE64, iconIcoBytes } from "../../../src/cli/icon-base64.js"

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".."))

test("compressed embedded installer icon preserves the packaged ICO bytes", () => {
  const packagedIcon = readFileSync(join(repoRoot, "assets", "opencomms.ico"))
  assert.deepEqual(Buffer.from(iconIcoBytes()), packagedIcon)
  assert.deepEqual(Buffer.from(ICON_ICO_BASE64, "base64"), packagedIcon)
})

test("Windows installer definition is per-user, GUI-safe, and project-state preserving", () => {
  const iss = readFileSync(join(repoRoot, "installer", "OpenComms.iss"), "utf8")
  assert.match(iss, /PrivilegesRequired=lowest/)
  assert.match(iss, /DefaultDirName=\{localappdata\}\\Programs\\OpenComms/)
  assert.match(iss, /OutputBaseFilename=OpenComms-Setup-\{#AppVersion\}/)
  assert.match(iss, /Name: "\{autodesktop\}\\OpenComms".*Tasks: desktopicon/)
  assert.match(iss, /Filename: "\{sys\}\\wscript\.exe"/)
  assert.match(iss, /Parameters: "\{code:Quote\|\{app\}\\OpenComms\.vbs\} gui"/)
  assert.match(iss, /Type: filesandordirs; Name: "\{app\}"/)
  assert.doesNotMatch(iss, /UninstallDelete[\s\S]*\.opencomms/)

  const launcher = readFileSync(join(repoRoot, "installer", "OpenComms.vbs"), "utf8")
  assert.match(launcher, /CurrentDirectory/)
  assert.match(launcher, /shell\.Run[\s\S]*, 0, False/)
  assert.match(launcher, /opencomms\.exe/)
})
