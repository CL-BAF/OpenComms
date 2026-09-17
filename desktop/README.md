# OpenComms Tauri Desktop GUI

The desktop application for OpenComms: a Tauri v2 shell (Windows + Linux)
hosting the orchestrator console. This is **not** a web GUI — the loopback
HTML console served by `opencomms gui` remains the documented CLI/headless
fallback surface; the Tauri app is the owner-facing desktop GUI.

## What it does

1. Spawns the **existing** OpenComms coordinator server as a child process
   (`node dist/cli/main.js gui --port 1455 --server --project <repo root>`
   in dev; the real per-triple Node coordinator sidecar in release builds).
   The child is killed on shell exit via `Drop`.
2. Opens a webview pointed at `http://127.0.0.1:1455/`, rendering the full
   seven-route console: **Overview / Sessions / Team / Tasks / Nodes /
   Activity / Settings** — live orchestrator surfaces (docs/gui-ia.md).
3. Owns **no business logic** — the shell only wraps the server and consumes
   the Orchestrator API (docs/orchestrator-api.md contract v0.3), per the
   Decision Log in `docs/OVERHAUL_PLAN.md`.

## Security posture

- Real CSP pinned to the loopback origin (`default-src`/`connect-src`
  `'self' http://127.0.0.1:1455`, `script-src 'self'`, no `unsafe-eval`).
- Deny-by-default capabilities: the ONLY grant is `shell:allow-spawn` for
  the bundled coordinator sidecar with fixed arg validators.
- Updater wired from M0 (`createUpdaterArtifacts: true`,
  `windows.installMode: "passive"`); signing happens in CI — no key
  material ever lives in this repo.

## Prerequisites (Windows-first)

- Repo built: `npm run build` at the repo root (the shell loads
  `dist/cli/main.js` in dev).
- Node.js available on PATH (`node.exe`).
- Rust toolchain (stable) + Tauri v2 prerequisites:
  - Windows: WebView2 (preinstalled on Win11) + Visual Studio Build Tools (C++).
  - Linux: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`,
    `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.

## Run (dev)

```powershell
cd desktop
npm install
npm run tauri dev
```

The window titled "OpenComms" opens and renders the full orchestrator
console. Diagnostics (under Settings) shows the loopback port when the
server is up.

## Release-readiness state (owner directive)

- [x] Shell wraps the live server; 7 routes render real endpoints.
- [x] CSP + capabilities + updater config (no key material in repo).
- [x] Node/trust-gate token-entry flows (Reviewer-approved posture).
- [x] Real Node coordinator sidecar: `binaries/opencomms-coordinator-<triple>.exe`
      built from the pinned 22.14.0 toolchain (Platform artifact, per-triple
      named; verified serving the full console + orchestrator API standalone).
- [ ] CI-signed release artifacts (tag naming: **OpenComms Tauri Desktop
      GUI**; Reviewer gates the artifact + naming).

## Linux

Prereqs above; config exists in-tree. Bundling verification is scheduled
with the release gates (Platform co-verification).

## Never-stage list (desktop/)

`src-tauri/target/`, `src-tauri/gen/schemas/`, `dist-shell/`,
`node_modules/`, `binaries/*.exe` are gitignored; `binaries/README.md` and
`Cargo.lock` stay tracked.