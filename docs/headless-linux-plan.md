# Headless Linux Plan — M0 Gap Analysis

Owner: Platform (ses_f712a151cffewzD4P4V4aryHlb). Status: M0 draft for Lead
approval. Grounded in source survey 2026-09-11 (file:line refs). Scope:
server-Linux (Debian/Ubuntu/VPS, no display) headless OpenComms operation,
reusing the same core services as the desktop GUI.

## 0. Ground truth (verified in source today)

Already cross-platform, no work needed:

- **Paths**: `appDataRoot()` already branches to `XDG_CONFIG_HOME ||
  ~/.config/OpenComms` on non-win32 (`src/gui/workspace.ts:26-27`).
  `OPENCOMMS_CONFIG_DIR` override exists (`workspace.ts:31`).
- **SEA exe build**: `scripts/build-exe.mjs` is platform-generic —
  `exeName` is `opencomms` (no `.exe`) on Linux (`build-exe.mjs:57`), and the
  smoke check (`build-exe.mjs:76`) runs on any OS.
- **Release pipeline**: `build-release.mjs` skips the Inno Setup installer on
  non-win32 and still emits the exe + SHA-256 (`build-release.mjs:16-23`).
- **GUI server**: loopback-only bind enforced (`src/gui/server.ts:48,83-85`);
  `SIGINT`/`SIGTERM` graceful shutdown already wired (`src/cli/main.ts:544-545`)
  — correct for systemd.
- **Browser open**: `xdg-open` branch exists (`main.ts:519`); headless mode
  must default it off (`--no-open` / `--server` already exist, `main.ts:716`).
- **Core services** (`StateStore`, engine, `ArchiveStore`, MCP identity) are
  pure Node fs/path — no Windows assumptions found.
- **Host capability profiles** (`src/hosts/profiles.ts`) are OS-agnostic.

Windows-only by design (leave as-is, gated correctly): `shouldLaunchWizard`
(`main.ts:584`), `launchWizard` (`main.ts:599`), `runUninstallSelf`
(`main.ts:648`).

## 1. Gaps → work items

| # | Gap | Evidence | M0/M1 plan |
|---|-----|----------|------------|
| G1 | No systemd integration: no unit file, no daemon-mode docs. `opencomms gui` blocks in foreground which *works* under systemd `simple`, but nothing ships it | `main.ts:530-550` | Add `installer/linux/opencomms.service` (systemd **user** unit, `WantedBy=default.target`), `ExecStart=<bin> gui --project %h/<project> --no-open --server`. Document `loginctl enable-linger` for pre-login operation. No forking/Type=notify until M4 |
| G2 | `scripts/install.sh` is referenced but missing | `main.ts:602` error text | Write it: install exe to `~/.local/bin`, optional systemd user unit, `XDG_CONFIG_HOME` respect. Mirror of what the Windows wizard does |
| G3 | No Linux packaging beyond raw exe | `build-release.mjs` | M0: tarball (`opencomms-linux-x64-vX.Y.Z.tar.gz`: exe + README + systemd unit + checksums). M5: `.deb` (per plan §4 M5 "release installers for Win+Linux") |
| G4 | No Linux release smoke test | `scripts/test-windows-release.mjs` is Windows-specific | New `scripts/test-linux-release.mjs` mirroring it: run exe `version`/`doctor` from tarball extraction dir, start `gui --no-open` over loopback, SIGTERM, assert project state untouched |
| G5 | Runtime discovery is file-existence based, Linux PATH conventions unverified on Linux | `fmtDoctor` `main.ts:148-199` | Extend doctor: detect `opencode`/`claude`/`codex` on `PATH` (works both OSes), report `$XDG_DATA_HOME`/`$HOME/.local/bin` conventions, flag when GUI browser-open will fail headless |
| G6 | No daemon/service supervision loop (auto-restart policy) | n/a | M4 per plan (headless daemon mode). M0-M3: systemd `Restart=on-failure` is sufficient |
| G7 | `openGuiUrl` assumes a display on Linux | `main.ts:519` | Already safe (spawn failure is logged, not fatal — `main.ts:523`); only document `--no-open` as the headless default |

## 2. Core services needing Linux-only guards (Lead's direct question)

Audit result — **almost none**:

1. `startGui`/`startGuiServer`: no guard needed; loopback + SIGTERM already
   correct. The only Linux consideration is systemd wanting `--no-open`.
2. `StateStore.withLock`: `.state.lock` exclusive-create works on Linux ext4;
   the 15s stale-break is OS-independent. No guard.
3. `install.mjs` (OpenCode plugin installer): not yet audited for
   Windows-specific path assumptions — flagged for a targeted check in M1
   when I touch install flows.
4. Windows-only code: already gated at call sites; on Linux the wizard/
   uninstall-self commands fail with clear messages (`main.ts:600-604,649-652`).
   Improvement (M1, small): point Linux users at `install.sh` instead of the
   macOS/Linux sentence, since Linux becomes first-class.

Proposed new Linux-only code lives in NEW files I own
(`installer/linux/**`, `scripts/test-linux-release.mjs`, additions under
`scripts/**` for packaging) — no `src/gui/**` or `src/orchestrator/**` edits.

## 3. Runtime discovery on Linux (M1+)

- Node runtime: SEA exe removes the Node requirement on targets (same as
  Windows). `opencomms doctor` reports Node only when running under Node.
- Agent runtimes: PATH lookup for `opencode`, `claude`, `codex` binaries +
  version probe (`--version`), same contract as `detectCodex()`
  (`main.ts:24`). Linux conventions: `~/.local/bin`, `/usr/local/bin`,
  nvm-managed node (`~/.nvm/`) noted as *not* on systemd PATH — doctor must
  warn when a runtime resolves only via nvm/fnm shim dirs.
- Verification honesty: every Linux claim in doctor output must be verified
  by running on Linux (CI job or Frontend's Tauri Linux toolchain), never
  assumed from Windows.

## 4. Packaging decision proposal (needs Lead approval)

- **M0/M1 artifact**: tarball per release (exe + unit + README + sha256).
  Zero new tooling, works on any distro, matches VPS reality.
- **M5 artifact**: `.deb` (Debian/Ubuntu) via `dpkg-deb` from a plain
  staging dir (no external deps): binary to `/usr/lib/opencomms/`,
  symlink `/usr/bin/opencomms`, systemd unit to `/usr/lib/systemd/user/`,
  postinst prints enable instructions (never auto-enables).
- Non-goal: rpm/AUR until asked.

## 5. Verification plan (no Linux box assumed)

1. Unit tests for new pure logic (path resolution, unit-file generation)
   run on Windows CI as today (`node --test`).
2. Linux CI job (Frontend's Tauri Linux toolchain or a plain
   `ubuntu-latest` runner): `npm ci && npm run build:exe && node
   scripts/test-linux-release.mjs`.
3. Manual VPS checklist in this doc once M1 lands: install → doctor → gui
   loopback → agent create (via Backend's API) → SIGTERM → resume.

## 6. Open questions for Lead

1. Approve packaging split (tarball M0/M1, `.deb` M5)?
2. Headless daemon: confirm `opencomms gui --server --no-open` IS the
   daemon mode for M4 (no separate daemon binary), or do you want a
   dedicated `opencomms serve` alias with systemd-specific flags?
3. For `opencomms agent` CLI (my separate deliverable): when Backend's
   Orchestrator API lands, CLI calls the same loopback HTTP API rather than
   importing `src/orchestrator/**` directly — keeps your file-ownership
   rule intact. Confirm.