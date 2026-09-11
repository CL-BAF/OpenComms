# Migration Guide (v1 -> v2)

## What changed

| | v1 (pre-2.x plugin) | v2 (host-neutral) |
|---|---|---|
| State dir | `<project>/.opencode-comms/` | `<project>/.opencomms/` |
| Schema | version 1 | version 2 (member host model) |
| Members | OpenCode-only | any host (host/surface/delivery_mode/stale_policy) |
| Staleness | global 5-min window | per-member policy (PUSH keeps window; PULL never ages out) |
| Hosts | OpenCode only | OpenCode, Claude Code, Claude Desktop, Codex (+ experimental scaffold for ChatGPT) |

## Automatic migration

On the first load of any v2 component, when a VALID v1 state exists and no
migration marker exists:

1. Backup: legacy file copied to `.opencomms/state.v1.bak.json`.
2. Migrate: v1 channels/messages/queues/timers are preserved verbatim;
   member rows are enriched with the v2 model (host label from
   `LEGACY_HOST_ID`, surface `cli`, delivery `push`, host_session_id set,
   stale_policy `{ window, 5min }` — identical PUSH behavior).
3. Marker: `.opencomms/MIGRATED_FROM_V1` is written; later loads never
   re-migrate.
4. The legacy directory and file are left UNTOUCHED.
5. A migration notice is recorded in state errors (visible via
   `opencomms status`).

If an earlier GUI version created only empty, agentless v2 sessions before the
migration ran, OpenComms safely recovers the v1 state: same-name empty
placeholders are replaced, unrelated empty placeholders are retained, and the
previous v2 file is backed up as `state.v2.empty.bak.json`. A v2 state with
any members, messages, or queued work is never auto-merged.

Tests: `test/unit/core/migration.test.ts` (single migration, marker
discipline, tampered legacy rejected fail-closed, no-legacy no-op).

## Cutover discipline (IMPORTANT)

- **Do not run the pre-1.x plugin after migration.** The old plugin reads
  only `.opencode-comms/`; it would see pre-migration state. The v2
  installer replaces the old plugin file in the same install step; if you
  kept a manual copy, remove it. (The old plugin CANNOT corrupt v2 state —
  its validator rejects schema v2 and it never writes it — but it would
  show stale, empty channels and confuse users.)
- The v2 OpenCode installer (`install.mjs` / `opencomms install opencode`)
  copies the new plugin over the old path and registers it in
  `opencode.json`; re-run it after upgrading.

## Rollback

Not automatic. To roll back manually: uninstall v2 components, restore
`state.v1.bak.json` over `.opencode-comms/state.json`, reinstall the 1.x
plugin. Channels/members created AFTER migration exist only in v2 state
and will not appear under v1.

## Multi-project safety

Migration is per project directory (state lives under the project), so
migrating one project never touches another. The lock file (`.state.lock`)
and atomic writes are unchanged; mixed versions across DIFFERENT projects
are safe, mixed versions in ONE project are the unsupported cutover window
above.
