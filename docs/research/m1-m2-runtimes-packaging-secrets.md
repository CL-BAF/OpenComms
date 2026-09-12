# Research — M1/M2 Priority Report (re-scoped per Lead)

Researcher (ses_f7129973bffeWivFk3Zs9Qe1oj) · 2026-09-11 · Channel: `opencommupdate`
Re-scope per Lead tasking (ocm_d7cc44a955334762a0ffb02a9d326eb3): priority = (1) agent runtime headless/resume surfaces with **exact argv/SDK calls**, (2) Tauri v2 packaging, (3) OS-level secret storage. M3 topics parked (stubs at bottom). Full-context report for background: `docs/research/research-batch-1.md`.

All evidence from official docs fetched live 2026-09-11 unless marked *local*. Recommendations marked **[REC]**.

---

## PRIORITY 1 — Agent runtime headless/resume surfaces (unblocks Backend spawn spike)

### 1A. OpenCode — recommended M1 target

**Official CLI doc:** https://opencode.ai/docs/cli/ · **Server doc:** https://opencode.ai/docs/server/ · **SDK doc:** https://opencode.ai/docs/sdk/

Headless paths (three, all first-class):

**Path A — `opencode run` (per-invocation, no server):**
```
opencode run [message..] [-s <sessionID>] [--continue] [--fork] \
  --agent <agentName> -m <provider/model> --format json --title <t> \
  --dir <path> [--attach http://localhost:4096 -p <password>]
```
- `-s/--session <ID>` continue a specific session; `--continue` most recent; `--fork` fork when continuing.
- `--format json` → raw JSON events on stdout (machine-parseable stream).
- `--auto` → auto-approve permissions not explicitly denied.
- `--attach <url>` → run against an existing `opencode serve` instance; the docs explicitly cite this to avoid MCP server cold boot per run.

**Path B — `opencode serve` + HTTP/SDK (recommended for orchestration):**
```
opencode serve [--port <n>] [--hostname 127.0.0.1]
```
- Basic auth via env `OPENCODE_SERVER_PASSWORD` (username default `opencode`, override `OPENCODE_SERVER_USERNAME`).
- OpenAPI 3.1 spec at `GET /doc`; SSE event stream at `/event`.

SDK (npm `@opencode-ai/sdk`), exact calls:
```js
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })

// create agent session
const s = await client.session.create({ body: { title: "Backend" } })

// send prompt (sync; await response)
await client.session.prompt({ path: { id: s.data.id },
  body: { parts: [{ type: "text", text: "<role prompt + task>" }],
          // optional: model: { providerID, modelID }, noReply: true (inject context only)
          // optional: outputFormat: { type: "json_schema", schema: {...} } → validated structured output
} })

// async fire-and-forget prompt: POST /session/:id/prompt_async (server doc)
// abort: await client.session.abort({ path: { id } })
// permissions: postSessionByIdPermissionsByPermissionId(
//   { path: { id, permissionID }, body: { response, remember } })
// stream: await client.event.subscribe()  // SSE, for-await over events.stream
// messages: await client.session.messages({ path: { id } })
```
- Structured output is built-in: `session.prompt` body `format.type: "json_schema"` returns validated JSON in `result.data.info.structured_output` (SDK doc §Structured Output).

**Path C — config/identity injection without files (local-relevant env vars):**
- `OPENCODE_CONFIG_CONTENT` — inline JSON config content.
- `OPENCODE_PERMISSION` — inline permissions config.
- `OPENCODE_MODELS_URL`, `OPENCODE_CLIENT`, `--log-level`, `--print-logs` global flags.
- Credentials live at `~/.local/share/opencode/auth.json` (`opencode auth login`).
Source: https://opencode.ai/docs/cli/ (Environment variables section).

**Agent definition, non-interactive:** `opencode agent create` becomes non-interactive when `--path`, `--description`, `--mode`, `--permissions` are all passed (also `--model`). `--permissions` takes a comma-separated allowlist (`bash,read,edit,glob,grep,webfetch,task,...`); anything omitted is **denied** (deny-by-default agent permissions).

### 1B. Claude Code

**Official CLI reference:** https://code.claude.com/docs/en/claude-code/cli-reference

Headless create (exact argv):
```
claude -p "<prompt>" \
  --output-format json | stream-json \
  --permission-prompts none \
  --allowedTools "Bash(git log *)" "Read" \
  --append-system-prompt-file ./role-prompt.txt \
  [--bare] [--model <model>] [--tools "Bash,Edit,Read"]
```
- `-p/--print` = headless SDK mode; `--output-format json|stream-json` machine-readable; `--input-format stream-json` for streaming input; `--include-partial-messages` requires `-p` + `stream-json`.
- `--permission-prompts none` (v2.1.259+): unattended runs **deny** prompts instead of hanging — the correct orchestrator default.
- `--permission-prompt-tool <mcp_tool>`: designated MCP tool answers permission prompts (alternative when you want structured allow/deny decisions).
- `--allowedTools` allowlist vs `--tools "Bash,Edit,Read"` restrict-set; `--disallowedTools "mcp__*"` denies MCP tools.
- `--bare`: skips auto-discovery of hooks/skills/plugins/CLAUDE.md for fast scripted starts.
- `--session-id <uuid>`: **orchestrator-chosen deterministic session ID** at creation.
- `--fork-session`: on resume, get a NEW session ID instead of reusing (use with `--resume`/`--continue`).

Resume (exact argv):
```
claude --resume <sessionID|name> [-p "<prompt>"] [--fork-session]
claude --continue -p "<prompt>"     # documented combination: claude -p --continue
```
- `--resume` accepts session ID, name, or absolute path to a `.jsonl` transcript file.
- *local:* OpenComms `AGENTS.md` documents `claude --resume <id> --print` as the proven spawn-push resume path (npm `.cmd` shim caveat on Windows; `OPENCODE_CLAUDE_BIN`-style override env if needed). `--resume` combined with `-p` is our existing usage; the docs table explicitly confirms `-p` combines with `--continue`, and `--resume` is documented with a follow-up query in interactive form.

Background/supervision (already-running pattern):
- `claude --bg "<task>"` → returns session ID + management commands.
- `claude attach <id>` / `claude logs <id>` / `claude stop <id>` / `claude respawn <id>` (restart with conversation intact).
- `claude daemon status` / `claude daemon stop --any --keep-workers` (supervisor; workers outlive supervisor restarts).
- `claude agents --json` → machine-readable active-session list.
- Auth: `claude auth status --text`, `claude setup-token` (prints long-lived token to stdout, not saved to disk).

### 1C. Codex

**Official reference:** https://developers.openai.com/codex/cli/reference/

Headless create (exact argv):
```
codex exec [--json] [-C <workspaceRoot>] [-s read-only|workspace-write|danger-full-access] \
  [-a on-request|never] [-o <last-message-file>] [--output-schema <schema.json>] \
  [--skip-git-repo-check] [-c key=value ...] "PROMPT"     # or: echo prompt | codex exec -
```
- `--json` → newline-delimited JSON events (one per state change) on stdout.
- `-o/--output-last-message <path>` → assistant's final message written to a file (downstream scripting).
- `--output-schema <path>` → JSON Schema; Codex validates final response against it.
- `--ephemeral` → run WITHOUT persisting session rollout files (**do not use for orchestrator-managed agents** — we need resume).
- `--skip-git-repo-check` for non-repo dirs.
- `--ignore-user-config` → don't load `$CODEX_HOME/config.toml` (auth still uses CODEX_HOME) — clean-spawn isolation option.

Resume (exact argv):
```
codex exec resume [SESSION_ID] [--last] [--all] "follow-up prompt"   # non-interactive resume
codex resume [SESSION_ID]                                            # interactive resume
codex fork [SESSION_ID]                                              # branch transcript, keep original
```
- `--last` scopes to current working directory unless `--all`.
- `codex archive/unarchive <session>`, `codex delete <session>` — lifecycle ops.

Unattended safety:
- `-a never` (--ask-for-approval never) + `-s workspace-write` is the least-privilege unattended combo; **avoid** `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) — docs say "only use inside an isolated runner."
- Remote attach precedent: `codex --remote wss://... --remote-auth-token-env VAR` (M3 note).

### 1D. Comparison + [REC]

| Capability | OpenCode | Claude Code | Codex |
|---|---|---|---|
| Headless create | `run` or serve+HTTP | `claude -p` | `codex exec` |
| Machine-readable output | `--format json` (events) | `--output-format json/stream-json` | `--json` (JSONL events) |
| Resume specific session | `-s <ID>` / `--continue` | `--resume <id> [--fork-session]` | `exec resume <ID>` / `--last` |
| Structured final output | SDK `json_schema` format | `--output-format json` | `--output-schema` + `-o` |
| Permission control (headless) | `--auto`, inline `OPENCODE_PERMISSION` | `--permission-prompts none`, `--allowedTools` | `-a never`, `-s <policy>` |
| Deterministic ID at create | API returns ID | `--session-id <uuid>` | ID in JSONL events |
| Abort/stop | `session.abort` API | `claude stop <id>` | (exec ends; `codex` has no remote stop for exec) |

**[REC] for the M1 spike (Backend):**
1. OpenCode runtime = `opencode serve` + SDK (`createOpencodeClient`) — one server per spawned agent instance is *not* needed: `opencode run --attach` and the server API both attach to a shared serve instance; but simplest deterministic v1: one `opencode serve` per agent with a pinned `--port` + per-agent basic-auth env, session created via `session.create`.
2. Role prompt injection: OpenCode — `OPENCODE_CONFIG_CONTENT` inline config / agent-create `--permissions` allowlist; Claude — `--append-system-prompt-file`; Codex — prompt via stdin (`codex exec -`).
3. Unattended defaults: never use `--yolo`/`bypassPermissions`/`danger-full-access`; use per-host least privilege (table above).
4. Parse machine output: OpenCode `--format json` or SDK events; Claude `--output-format stream-json`; Codex `--json` JSONL. Record session ID at creation for all three (Claude even lets us pick it).
5. All three runtimes support create→resume→(stop) so the `AgentRuntime` interface from batch-1 §7 holds unchanged.

---

## PRIORITY 2 — Tauri v2 packaging (unblocks Frontend scaffold)

**Sidecar (official):** https://v2.tauri.app/develop/sidecar/
- Bundle config: `bundle.externalBin: ["binaries/coordinator"]` — requires a per-target-triple file on disk: `binaries/coordinator-<rustc --print host-tuple>[-.exe]`.
- Spawn (Rust): `app.shell().sidecar("coordinator")` (name only, no path). (JS: `Command.sidecar('binaries/coordinator')`.)
- **Capability gate (deny-by-default):** sidecar spawn requires explicit permission in `src-tauri/capabilities/default.json`, e.g. `{"identifier": "shell:allow-execute", "allow": [{"name": "binaries/coordinator", "sidecar": true, "args": [...static args..., {"validator": "\\S+"}]}]}`. `shell:allow-spawn` for `spawn()`. Argument validators are regex-scoped.
- Official Node.js sidecar guide: https://v2.tauri.app/learn/sidecar-nodejs/

**Updater (official):** https://v2.tauri.app/plugin/updater/
- Signature mandatory: `pubkey` in `tauri.conf.json` (public key content, not path); private key only via env `TAURI_SIGNING_PRIVATE_KEY` (+ optional `..._PASSWORD`) at build time; `bundle.createUpdaterArtifacts: true`.
- Endpoints: array; TLS enforced in production (`dangerousInsecureTransportProtocol` exists but must stay false); `{{target}}`/`{{arch}}`/`{{current_version}}` interpolation; static JSON (S3/GitHub Releases via tauri-action) or dynamic server (204 = up-to-date).
- Windows: `plugins.updater.windows.installMode: "passive"` (recommended) | `basicUi` | `quiet`; **Windows auto-exits before install** (documented limitation) — `on_before_exit` hook; `version_comparator` enables downgrade path.
- Platform support table: windows/linux/macos (desktop).

**Signing docs (official paths, nav-verified):** Windows Authenticode: https://v2.tauri.app/distribute/sign/windows/ · Linux: https://v2.tauri.app/distribute/sign/linux/ · Bundles: Windows Installer (NSIS/MSI) https://v2.tauri.app/distribute/windows-installer/ , Debian https://v2.tauri.app/distribute/debian/ , AppImage https://v2.tauri.app/distribute/appimage/ . (Deep content not fetched in this pass; sidecar/updater pages were fetched in full.)

**[REC] for Frontend scaffold:**
1. `src-tauri/` with `externalBin: ["binaries/opencomms-coordinator"]` + build step that renames the Node coordinator bundle per target triple (official Node-sidecar guide covers the pattern).
2. Capabilities: grant ONLY `shell:allow-spawn` for the coordinator binary with a fixed arg validator (`serve --port <validator>`) — nothing else.
3. Wire the updater in M0 scaffold even if releases start empty: `createUpdaterArtifacts: true`, static-JSON endpoint on GitHub Releases (tauri-action generates `latest.json`), `passive` Windows install mode. Sign in CI; key = CI secret (custody risk flagged in batch-1 §risks).
4. Keep all business logic in the Node coordinator (Decision Log: "Tauri app owns no business logic"); Tauri = shell + IPC to loopback server the sidecar runs.

---

## PRIORITY 3 — OS-level secret storage (needed for node pairing later)

**Windows DPAPI (official API ref):** https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- `CryptProtectData(DATA_BLOB*, descr, optionalEntropy, NULL, NULL, dwFlags, DATA_BLOB* out)` in `Crypt32.dll`.
- Default scope = current **user** logon credential; same machine required (roaming-profile exception). `CRYPTPROTECT_LOCAL_MACHINE` = any local user can decrypt — avoid for per-user secrets.
- Built-in MAC integrity; `CRYPTPROTECT_UI_FORBIDDEN` for service/headless contexts.
- **Deprecation: prompt-struct flow removed Feb 2027** — always pass `NULL` promptstruct now (non-interactive path).
- Optional entropy (`pOptionalEntropy`) is the right hook to bind an app-specific salt.

**Linux libsecret (official):** https://gnome.pages.gitlab.gnome.org/libsecret/
- Secret Service D-Bus client lib: `password_store/password_store_binary`, `password_lookup` (+ `_nonpageable` variants), `password_clear`, `password_wipe`.
- Session collection (`COLLECTION_SESSION`) auto-cleared at session end; default collection persists.
- Headless gap + options: TPM2-backed file backend documented ("Extending file backend to use a TPM" in docs); docs index lists it at https://gnome.pages.gitlab.gnome.org/libsecret/libsecret-tpm2.html (path from docs nav).
- On headless servers GNOME keyring is typically absent → fallback required.

**[REC] (unchanged from batch-1 §6, now concrete):**
1. Tier 1: DPAPI user-scope (Windows) / libsecret default collection (Linux). Store: node pairing tokens, provider API keys.
2. Tier 2 (keyring unavailable): encrypted file with machine-bound key — DPAPI `CRYPTPROTECT_LOCAL_MACHINE` + `UI_FORBIDDEN` on Windows; on Linux, age-style file encryption with a TPM2/TPM-backed or generated machine key.
3. Never plaintext; `file+chmod 600` only as loud-warned dev fallback.
4. DPAPI call notes for Backend/Platform: pass optional app entropy, always `UI_FORBIDDEN`, never `LOCAL_MACHINE` for user-class secrets; prompt-struct must be NULL (Feb 2027 removal).

---

## PARKED until M3 planning (one-paragraph stubs; full context in batch-1 report)

- **Node identity schemes (batch-1 §1):** parked because M1/M2 are same-machine only; identity schemes matter at the first remote-node pairing. Decision needed then: Noise XX + pinned statics vs owner-CA mTLS, with short-lived rotating credentials (SPIFFE pattern). No further research cycles now.
- **Cross-network transport (batch-1 §2):** parked; the only durable conclusion to carry forward is "outbound-only WSS node→coordinator, bearer over wss only" (Buildkite + Codex precedent). Nothing M1/M2 depends on.
- **Durable queues at scale (batch-1 §3):** parked; current embedded store-and-forward + two-phase commit is sufficient for single-machine M1/M2. The JetStream cursor idea returns when multi-node replay/resume is designed.
- **Remote supervision runner patterns (batch-1 §4):** parked; Buildkite/JIT-runner/supervisor separation conclusions are recorded and only apply once remote agents exist (M3+).

---

## ADDENDUM — opencode serve basic-auth & concurrent-instance behavior (Lead tasking ocm_e6b54777e74042daab3d0df31c876cfc)

Evidence below is from **opencode source @ dev branch** (fetched 2026-09-11), cross-checked against docs. File references are paths in https://github.com/anomalyco/opencode.

### A1. Credentials: per-server, fixed at listener boot

- `packages/opencode/src/server/auth.ts`: credentials come from a single env-backed config — `OPENCODE_SERVER_PASSWORD` (optional) + `OPENCODE_SERVER_USERNAME` (default `"opencode"`). Exactly **one username/password pair per server instance**; `authorized()` does a plain string compare. There is no per-client credential store, no token table, no rotation API.
- `packages/opencode/src/server/server.ts` (`listenerLayer`): a **fresh `ConfigProvider` is installed per listener** — source comment: *"Install a fresh `ConfigProvider` per listener so `Config.string(...)` reads reflect the current `process.env`. Effect's default `ConfigProvider` snapshots `process.env` on first read and caches the result"* — and the auth layer resolves `ServerAuth.Config` once when the layer builds. Net: **credentials are fixed at listener/process boot; rotation mid-life requires restarting the process.** Each separate `Server.listen()` (i.e. each serve process) takes its own env snapshot, so two processes started at different times can hold different passwords.

### A2. Multiple concurrent serve instances on one host: supported, no code-level warnings

- `server.ts` `startWithPortFallback()`: an explicit non-zero `--port` binds **exactly that port** (bind failure → listener error, scope closed — loud failure, no silent fallback). Only port `0` triggers the legacy "prefer 4096, else any free port" behavior.
- Each `Server.listen()` builds an independent Node server + scope (own `createServer()`, own `closeAll`, own env snapshot). The module-level `export let url` global is per-process, so separate processes don't collide.
- **No warning exists in code or docs against multiple instances.** Caveats to verify in the spike (not documented): (a) separate processes share global state — `~/.local/share/opencode/auth.json` (provider credentials) and the project session store (`Storage`/`Database` services) — so concurrent serve instances on the **same project directory** both read/write shared storage; contention behavior is the one thing the spike must observe; (b) mDNS publish is skipped for loopback hostnames (irrelevant for our loopback-only usage).
- Kill semantics (already in spike guidance): `Listener.stop(close)` force-closes all HTTP sockets + websockets for that listener; `POST /instance/dispose` disposes the instance — killing one shared-serve process kills **all** sessions on it (this is the accepted shared-server tradeoff; per-sensitivity isolation = second instance, per Lead decision).

### A3. SSE `/event`: single credential, directory-scoped — NOT session-scoped

- Auth on `/event`: the route group carries the same `Authorization` middleware (`groups/event.ts` → `middleware/authorization.ts`) — the **same single server password** gates SSE. One transport detail: credentials may be supplied either as the `Authorization: Basic` header **or via `?auth_token=` query param** (`credentialFromURL` decodes it as `base64(user:pass)`) — the query-param path exists for EventSource/SSE clients that cannot set headers. Minor consideration: that token is just the server password and will appear in proxy/access logs if the connection is ever non-loopback (our usage is loopback-only, so acceptable).
- Event scoping (`handlers/event.ts`, `eventResponse()`): each subscriber registers a global event listener, then the stream is **filtered by** `event.location?.directory === instance.directory && (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID)`. I.e. a subscriber gets **all events for the requested directory, across all sessions** — there is **no per-session event filtering**. First event is `server.connected`; 10s heartbeat; stream ends on `server.instance.disposed`.
- Route context: `/event` accepts `?directory=` (and `?workspace=`), defaulting to the server process cwd (`middleware/workspace-routing.ts`, `defaultDirectory`). Remote-workspace requests are proxied to the workspace's target server.
- **Decision impact:** on ONE shared serve instance, an authenticated orchestrator tap necessarily receives every agent's events for the shared project directory — which is what we want — but per-agent event isolation is **impossible on a shared instance** (all agents share one directory). Any future "dedicated event tap" or per-agent event isolation requires a dedicated serve instance (or directory separation), consistent with the per-sensitivity-tier fallback design.

### Sources
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/auth.ts (raw fetched)
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/server.ts (raw fetched)
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/middleware/authorization.ts (raw fetched)
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts (raw fetched)
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/groups/event.ts (raw fetched)
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts + workspace-routing.ts (raw fetched)

1. Should `AgentRuntime` standardize on **per-agent server instance** (OpenCode) vs **shared server + multiple sessions**? Evidence supports shared-server (one `serve`, many sessions) as cheaper, but per-agent isolation is simpler to supervise/kill; decide in M1 spike.
2. Claude Code `--session-id` lets the orchestrator pre-allocate agent IDs — worth adopting as the canonical agent/session key across runtimes?
3. Confirm Tauri sidecar naming/capabilities spike is assigned to Frontend (batch-1 §5 has the exact config).