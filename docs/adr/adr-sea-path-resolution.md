# ADR: SEA CLI path resolution & module format (CJS-stay) — 2026-09-11

**Status:** Accepted (Backend, Lead-approved tasking; Reviewer gate-2 (a)-(e)).
**Scope:** `src/cli/paths.ts` (new), `src/cli/main.ts`, `src/cli/install-opencode.ts` (new), `src/version.ts`, `scripts/build-exe.mjs`.

## Context (reproduced field failure, Debian 13)

1. The SEA CLI bundle is CJS, so `import.meta` is unavailable (esbuild emits
   `var import_meta = {}`); `repoRootForCli()` walked `import.meta.dirname ?? cwd`
   up to the filesystem root and fell back to **CWD**. Running the exe from
   `/tmp` resolved `<cwd>/opencomms` → ENOENT; `install opencode` misparsed a
   repo-relative `install.mjs` path as a subcommand.
2. `install opencode` reached for the repo's `install.mjs` — impossible for a
   standalone binary.
3. Build warning: `"import.meta" is not available with the "cjs" output format`.

## Decision

**STAY CJS** for the SEA CLI bundle; do NOT move the bundle to ESM, do NOT
suppress the warning. Rationale:

- Node's SEA supports only CommonJS as the embedded entry (`sea-config.main`
  runs as CJS). An ESM bundle would require a loader shim or `node:sea`
  workarounds that are experimental and platform-sensitive — strictly worse
  than the CJS-stay fix below for a single-machine tool.
- The real defect was never "CJS" — it was **conflating five locations**
  (executable, packaged resources, source repo, target project, CWD). CWD
  leaked into resource resolution only because `import.meta.dirname ?? cwd`
  made the repo look optional. With the locations separated, the CJS bundle's
  missing `import.meta` is *expected* and harmless: the SEA exe resolves
  nothing from a repo because it IS the resource.
- ESM-move would also touch the plugin bundle contract (OpenCode loads
  `plugin.js` ESM — unrelated) and the MCP `.mjs` shims; none of that needs
  to change for the CLI fix. The esbuild `empty-import-meta` warning now
  appears only on files that PROVABLY guard with try/catch at that exact
  site (see "Resolution rules"); it no longer signals a latent bug.

## Resolution rules (src/cli/paths.ts — the single home for this logic)

| Need | SEA exe | Development (`node dist/…`) |
|---|---|---|
| Executable location | `dirname(process.execPath)` | same |
| Packaged resource (plugin bundle, VERSION stamp) | embedded SEA asset (`getRawAsset`) or beside-exe copy; **never CWD, never repo** | `<repo>/dist/…` via `findSourceRepoRoot(moduleAnchor)`; moduleAnchor = `import.meta.dirname` in ESM dist, `null` in CJS (no repo) |
| Source repo | **not available, by design**; code paths must not require it | package.json ancestor of the module anchor |
| Target project dir | `--project` flag, else CWD (documented default for project commands — unchanged) | same |
| Version | `OPENCOMMS_VERSION` env stamp → beside-exe `VERSION` file → static fallback | env → repo `package.json` → fallback |

`src/version.ts` change (explicitly part of this change set): replaced the
`import.meta.dirname ?? process.cwd()` walk-up with the shared
`findSourceRepoRoot` helper + `OPENCOMMS_VERSION` env stamp + static fallback
(`1.1.0`). WHY: same CWD-leak class as repoRootForCli — under the SEA exe the
old walk-up could read a STRANGER's `package.json` if CWD happened to contain
one (wrong version, potential prompt-injection surface via a crafted file),
and returned `0.0.0`-adjacent garbage when the walk hit root. The static
fallback stays (SEA bundles ship no package.json); the fallback value is
kept in lockstep with package.json.

## De-repo'd install dispatch

`opencomms install opencode` no longer spawns `install.mjs` (Lead's original
repro + Platform's "Unknown command" parse bug). The install logic is
bundled (`src/cli/install-opencode.ts`): plugin contents come from the
embedded SEA asset (build-exe injects `dist/plugin.bundled.js` under the
asset key `opencode-plugin-bundle`) or the repo dist in development;
opencode.json patching is idempotent and identical to the legacy behavior.
A standalone exe without the asset fails EARLY with a clear message
(gate-2 (b)) — never a wrong-path exec.

## Consequences / gate mapping

- (a) `opencomms version` identical from `/`, `$HOME`, `/tmp`, project dirs,
  and the repo root (env-independent resolution; verified by
  scripts/test-cwd-independence.mjs).
- (b) Standalone `install opencode` without embedded assets → clear early
  message.
- (c) No CWD influence on resource/repo/executable resolution (project
  commands keep CWD as the default TARGET).
- (d) No repo requirement for the packaged exe (repo used only under node).
- (e) Repo-root behavior preserved (moduleAnchor finds package.json in dev;
  version + doctor unchanged there).
- Windows regression risk: none — all changes are platform-neutral path
  joins; `process.execPath` semantics are identical on win32.

## Alternatives considered

- **ESM bundle:** rejected (SEA runs CJS; experimental loaders; no benefit).
- **Suppress the esbuild warning:** rejected (hides future real misuses).
- **Ship resources beside the exe only:** rejected as the sole mechanism
  (installer upgrades could desync exe/resources); embedded asset is the
  primary, beside-exe remains the explicit override path.