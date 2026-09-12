# OpenComms Desktop — SPIKE (M0, disposable)

**Status:** spike, clearly marked per working rule 4. Not production code. Expect
replacement by the real sidecar/packaging decision after M0 review.

## What this proves

A minimal Tauri v2 shell (`desktop/src-tauri`) that:

1. Spawns the **existing** loopback GUI server as a child process
   (`node dist/cli/main.js gui --port 1455 --server --project <repo root>`).
   The child is killed on shell exit via `Drop`.
2. Opens a webview pointed at `http://127.0.0.1:1455/` (see
   `src-tauri/tauri.conf.json`), so the **existing** console UI
   (Sessions / Saved / Integrations / Diagnostics / Settings) renders
   unmodified inside the desktop shell.
3. Owns **no business logic** — the shell only wraps the server, per the
   Decision Log in `docs/OVERHAUL_PLAN.md`.

## Prerequisites (Windows-first)

- Repo built: `npm run build` at the repo root (spike loads `dist/cli/main.js`).
- Node.js available on PATH (`node.exe`).
- Rust toolchain (stable) + Tauri v2 prerequisites:
  - Windows: WebView2 (preinstalled on Win11) + Visual Studio Build Tools (C++).
  - Linux (stubbed here, verified later): `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `libssl-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`.

## Run the spike

```powershell
cd desktop
npm install
npm run tauri dev
```

The window titled "OpenComms" should open and render the existing console.
Diagnostics page will show `Loopback port 1455` when the server is up.

## What is intentionally NOT here yet

- Bundling (`bundle.active = false`) — installer work is M5 / Platform's lane.
- Sidecar packaging of the Node runtime (spike assumes system `node`;
  `binaries/*.exe` is a marked stand-in so `externalBin` validates — gitignored).
- Any Orchestrator API consumption (contract v0 endpoints land with Backend in M1).

## Reviewer M0 conditions (both closed)

1. **`desktop/.gitignore`** added before any `desktop/` commit: `target/`,
   `gen/schemas/`, `dist-shell/`, `node_modules/`, `binaries/*.exe` are
   ignored; `binaries/README.md` + `Cargo.lock` stay tracked. Verified via
   `git status --porcelain --untracked-files=all desktop` (12 source files).
2. **CSP set** in `tauri.conf.json` — `default-src`/`connect-src` pinned to
   `'self' http://127.0.0.1:1455`, `script-src 'self'`, no `unsafe-eval`.
   The webview talks ONLY to the loopback server; no other origins.

## Linux (stubbed, verified later with Platform)

Prereqs: `libwebkit2gtk-4.1-dev build-essential curl wget libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.
Config exists; verification is pending a Linux toolchain.

## Spike teardown checklist (post-M0)

- [ ] Reviewer/Lead verdict on shell-hosts-server approach (sidecar vs managed child)
- [ ] Replace `spawn_gui_server()` heuristic (CARGO_MANIFEST_DIR walk) with real sidecar resolution
- [ ] Decide port strategy (fixed 1455 vs negotiated free port passed to webview)
- [ ] Then, and only then, begin the real IA build-out (docs/gui-ia.md)