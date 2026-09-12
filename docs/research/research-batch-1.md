# Research Batch 1 — Distributed Orchestration Architecture

Researcher (ses_f7129973bffeWivFk3Zs9Qe1oj) · 2026-09-11 · Channel: `opencommupdate`
Scope: evidence-with-URLs on the highest-architecture-risk topics for the overhaul (docs/OVERHAUL_PLAN.md). Recommendations are marked **[REC]** and are clearly separated from evidence. Primary/official sources preferred; vendor engineering blogs flagged where applicable.

---

## 1. Node identity & pairing

### Evidence
- **Noise Protocol Framework** (official spec, rev 34): handshake patterns `XX` (mutual auth, statics transmitted under encryption), `KK` (pre-known statics, enables 0-RTT), `IK`; per-message payload security grades incl. KCI-resistance; built-in channel binding (handshake hash `h`, §11.2), rekey (§11.3), PSK modifiers; messages capped at 65535 bytes; transport = AEAD (ChaChaPoly/AESGCM).
  https://noiseprotocol.org/noise.html
- **SPIFFE** (official docs): workload identity = URI `spiffe://trust-domain/path`; SVIDs are X.509 or JWT; X.509 preferred (JWT susceptible to replay); trust bundles rotate frequently; private keys short-lived, rotated automatically via the Workload API.
  https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/
- **Tailscale** (engineering blog, vendor primary): control plane is a "key dropbox" (coordination server exchanges public keys only); private keys never leave the node; user identity delegated to external IdP (OAuth2/OIDC/SAML); machine certs bind identity to device; ACL policy stored centrally but **enforced at every node** at decryption time.
  https://tailscale.com/blog/how-tailscale-works
- **Codex `remote-control`**: short-lived pairing codes for connecting a client to a local app-server (pairing UX precedent).
  https://developers.openai.com/codex/cli/reference/

### Comparison
- mTLS with a self-managed CA: mature, standard revocation (CRL/OCSP), but you operate CA + cert lifecycle.
- Noise XX + pinned ed25519 statics: no CA; pairing = owner approves node fingerprint once (TOFU + pin, SSH known_hosts model); identity hiding built in; channel binding detects MITM; revocation = manual pin removal, no standard expiry.
- SPIFFE-style short-lived SVIDs: revocation solved by expiry (certs die in hours); SPIRE itself is heavy infra, but the *pattern* (short-lived, auto-rotating) is portable.

### [REC] Two credible paths
1. Noise XX with pinned static keys + short-lived session certs derived at pairing, or
2. mTLS with an owner-rooted CA issuing short-lived node certs.

The SPIFFE pattern (short-lived, auto-rotating credentials) is the right shape regardless of mechanism; long-lived static keys make revocation the hard problem. Pairing UX should follow the Tailscale/Codex model: private key never leaves the node; owner approves via a short-lived pairing code + fingerprint confirmation.

---

## 2. Cross-network transport

### Evidence
- **Buildkite agent** (official docs): outbound-only HTTPS polling to control plane; "no need to forward ports or provide incoming firewall access"; queue-based job routing; agents ordered by most-recent-success for cache warmth.
  https://buildkite.com/docs/agent/v3
- **Tailscale**: data plane = WireGuard mesh (point-to-point); **DERP** = HTTPS-based TCP relay fallback for UDP-blocked networks; DERP relays cannot decrypt (keys stay end-to-end); relay server code is open source and simple.
  https://tailscale.com/blog/how-tailscale-works · https://github.com/tailscale/tailscale/tree/main/derp
- **Codex app-server `--remote`**: supports `ws:// | wss:// | unix://` with bearer token from an env var; tokens are only sent over `wss://` or local-only `ws://` — evidence that bare WS+token is deemed acceptable only loopback, TLS required across networks.
  https://developers.openai.com/codex/cli/reference/

### Comparison
Outbound-poll / long-lived WSS from node → hub (Buildkite model) vs mesh VPN underlay (Tailscale/WireGuard) with app traffic riding on top vs gRPC bidirectional streaming vs QUIC/WebTransport.

### [REC]
Outbound-only WSS node→coordinator (Buildkite model) as the baseline: zero port-forwarding, survives NAT, firewall-friendly on both sides, trivially TLS-terminable. Do **not** build a mesh (WireGuard/DERP) in v1 — treat Tailscale as an optional user-managed underlay, not a dependency. gRPC adds little over WSS at this message volume. Keep the framing format identical local vs remote (one protocol surface, as Codex app-server does across stdio/WS/Unix socket).

---

## 3. Reconnect/resume & durable queues

### Evidence
- **NATS JetStream** (official docs): stream (server-side store) + consumer (server-tracked cursor) + explicit ack = at-least-once; unacked messages redelivered; durable consumers survive client restarts; consumers can start at beginning / latest / sequence / time.
  https://docs.nats.io/nats-concepts/jetstream
- **River** (Go/Postgres job queue): transactional enqueueing (job committed iff tx commits — eliminates a class of distributed bugs), unique jobs, maintenance services, graceful shutdown.
  https://github.com/riverqueue/river
- **OpenComms current design** (local evidence): `state.json` queues + in-flight two-phase commit + `sweepInFlight` + `MAX_DELIVERY_ATTEMPTS=5` dead-letter already matches at-least-once semantics of JetStream/River (AGENTS.md §Delivery invariants).

### Comparison
External broker (NATS) vs Postgres-backed queue (River) vs embedded store-and-forward (current design). Broker/DB add an always-on dependency and ops burden for a single-user desktop tool.

### [REC]
Keep embedded store-and-forward for v1, but adopt two JetStream ideas:
1. **Server-tracked consumer cursors** — replace boolean `delivered_to` arrays with per-recipient sequence cursors so a reconnecting node can request "everything after seq N" instead of replaying/re-acking.
2. **Remote-ack delivery** — ack only after the remote node confirms receipt, not merely after local prompt success. The existing two-phase commit is right for same-host; cross-node delivery must use the remote ack.

---

## 4. Remote process supervision

### Evidence
- **Buildkite agent lifecycle**: register → poll → accept job → execute → stream output → report exit status; hooks for secrets/setup; persistent or ephemeral agents; documented signal handling.
  https://buildkite.com/docs/agent/v3
- **GitHub Actions runner hardening** (official): self-hosted runners are persistently compromisable (no ephemeral guarantee); mitigations = JIT runners (at most one job, auto-removed, started via `./run.sh --jitconfig`), runner groups to bound blast radius, treat runner machines as untrusted environments.
  https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- **Claude Code supervisor model** (official CLI reference): `claude daemon status|stop` (background-session supervisor: socket directory, worker count), `claude respawn <id>` (restart with conversation intact), `claude attach/logs <id>`, `--keep-workers` to outlive supervisor restarts.
  https://code.claude.com/docs/en/claude-code/cli-reference
- **systemd** (man-pages): prefer `Type=notify` / `notify-reload` over forking; watchdog via `sd_notify` `WATCHDOG=1` + `WatchdogSec=`; `Restart=on-failure` with `RestartSteps=`/`RestartMaxDelaySec=` exponential backoff; `ExecStopPost=` cleanup.
  https://man7.org/linux/man-pages/man5/systemd.service.5.html

### [REC]
Node daemon = Buildkite-shaped: outbound registration with pairing token, heartbeat, job pull, output streaming, hooks. Run under systemd (`Type=notify`, watchdog, exponential restart backoff) on Linux; Windows service (or scheduled task) on Windows. Support an **ephemeral node mode** (JIT-runner style: accept N jobs then deregister) as a trust-tier option for less-trusted machines. Adopt the Claude Code supervisor separation: node daemon (owns sockets/registration) distinct from agent workers (resumable, killable).

---

## 5. Tauri v2 packaging

### Evidence
- **Sidecar** (official docs): `bundle.externalBin` requires per-target-triple binary names (`my-sidecar-<triple>[-.exe]`); runtime via `app.shell().sidecar(name)` (Rust) or `Command.sidecar()` (JS); sidecar spawn requires explicit `shell:allow-execute` / `shell:allow-spawn` capability grants with whitelisted binary names + optional arg validators (regex) in `capabilities/default.json` — deny-by-default IPC.
  https://v2.tauri.app/develop/sidecar/
- **Updater** (official docs): mandatory signature verification (`pubkey` in `tauri.conf.json`, private key via `TAURI_SIGNING_PRIVATE_KEY`); TLS enforced in production; endpoints array with `{{target}}` / `{{arch}}` / `{{current_version}}`; static JSON or dynamic server (HTTP 204 = no update); Windows install modes `passive` / `basicUi` / `quiet`; Windows auto-exits before install (documented limitation, `on_before_exit` hook); `version_comparator` enables downgrades.
  https://v2.tauri.app/plugin/updater/
- **Node.js as a sidecar** — official guide exists: https://v2.tauri.app/learn/sidecar-nodejs/ (keeps one business-logic implementation in Node).

### [REC]
Ship the Node coordinator as a Tauri sidecar binary (per-triple names, capability-scoped spawn); GUI = pure view, zero business logic (consistent with the Decision Log). Keep the loopback HTTP server as the only API surface (Tauri → loopback), preserving CLI/headless parity and the "shapes identical" contract rule. Adopt the updater now: static-JSON endpoints (GitHub Releases via tauri-action) + sign artifacts in CI; Windows: `passive` installMode; do not rely on `quiet` (admin-privilege caveats). Flagged risk: sidecar = Node binary in the bundle (~40–80 MB). Alternatives exist (pkg/Bun single-binary) but Node sidecar is the officially documented, cheapest proven path.

---

## 6. OS-level secret storage

### Evidence
- **Windows DPAPI** `CryptProtectData` (official): user-scope (default) vs machine-scope (`CRYPTPROTECT_LOCAL_MACHINE` — *any* local user can decrypt; avoid); adds a MAC for integrity; decryption bound to same user + machine (roaming-profile exception); `CRYPTPROTECT_UI_FORBIDDEN` for services; the prompt-based flow is being removed Feb 2027 — use the non-interactive path.
  https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- **libsecret** (Linux, GNOME official): Secret Service D-Bus client library; `password_store/lookup/clear` plus nonpageable variants; session collection auto-cleared at session end; TPM2-backed file backend documented (headless option).
  https://gnome.pages.gitlab.gnome.org/libsecret/
- **GitHub Actions secrets doctrine** (official, transferable): least privilege, mask + rotate on exposure, never store structured blobs as secrets, register all transformed values.
  https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions

### Comparison
OS keyring (DPAPI / libsecret) vs encrypted-file-with-key-in-keyring vs plain file + chmod.

### [REC]
Tiered strategy:
1. **OS keyring first** — DPAPI user-scope on Windows, libsecret (freedesktop Secret Service) on Linux.
2. **Encrypted-file fallback** when keyring is unavailable (headless servers: GNOME keyring absent — libsecret TPM2-backed file backend or age-style file encryption with a machine key).
3. **Never plain-text** pairing tokens or provider API keys; file+chmod is a last-resort dev mode that must warn loudly.

Secret classes: node pairing tokens and provider API keys — both belong in tier 1/2 only.

---

## 7. Agent runtime surfaces (spawn/resume)

### Evidence — OpenCode (official server docs)
`opencode serve`: headless HTTP server, OpenAPI 3.1 spec at `/doc`; random port unless `--port`/`--hostname`; basic-auth via `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`; SSE `/event` + `/global/event`; `POST /session` create; `POST /session/:id/message` (sync), `/prompt_async`, `/command`, `/shell`; `/session/:id/abort`; permission responses via `POST /session/:id/permissions/:permissionID`; `/tui/*` endpoints drive the TUI programmatically.
https://opencode.ai/docs/server/
Implication: OpenCode is fully orchestratable headlessly — spawn = launch `opencode serve` + HTTP, not just TUI prompt injection.

### Evidence — Claude Code (official CLI reference)
`claude -p "query"` (SDK/headless then exit); `claude -r <session> "query"` (resume by ID/name); `-c` continue; background agents: `claude --bg`, `claude attach/logs/stop/respawn <id>`; `claude daemon status|stop --any --keep-workers` (supervisor); `claude agents --json` (scripting); `--bare` (fast-start headless); `--allowedTools`; `--permission-mode`; `claude self-hosted-runner` (registers a machine as a runner hosting cloud sessions — direct precedent for the node-daemon concept).
https://code.claude.com/docs/en/claude-code/cli-reference

### Evidence — Codex (official reference)
`codex exec` (non-interactive, stdout/JSONL streaming, can resume previous sessions); `codex resume` (stable); `codex fork` (fork transcript into new chat); `codex archive/unarchive`; `codex app-server` (stdio/WS/Unix socket, experimental); `--sandbox read-only|workspace-write|danger-full-access`; `--ask-for-approval on-request|never`; `--remote wss://... --remote-auth-token-env` (bearer only over wss or local ws).
https://developers.openai.com/codex/cli/reference/

### [REC]
The `AgentRuntime` interface needs exactly these operations per host: **create** (quiet, with role prompt), **resume** (sessionRef, prompt), **abort/stop**, **status**, **permissions-drain** (permission-prompt handling differs per host: OpenCode HTTP endpoint; Claude `--permission-mode`; Codex `--ask-for-approval`), **output-stream**. All three CLIs support headless spawn + resume, so the abstraction holds. For OpenCode specifically, prefer `opencode serve` + HTTP API over TUI `/tui/*` injection for orchestration (structured, spec'd, has basic-auth); keep spawn-push resume for already-running TUI sessions (existing behavior).

---

## 8. Git / worktree coordination

### Evidence (git-scm.com official, current through 2.54)
- `git worktree add` defaults: refuses a branch already checked out elsewhere (`-f` overrides); `list --porcelain [-z]` is a stable machine format; `lock --reason` prevents pruning of unmounted/network worktrees; `prune --expire`; `remove` refuses unclean trees unless `--force` (locked trees need `--force` twice); `repair` re-establishes links after manual moves; per-worktree config via `extensions.worktreeConfig` (with explicit rules: `core.worktree` never shared).
- Refs shared except `HEAD`, `refs/bisect`, `refs/worktree`, `refs/rewritten` → N agents in N worktrees can commit to **different branches concurrently with zero coordination**; conflicts appear only at merge (Reviewer/Lead domain).
  https://git-scm.com/docs/git-worktree
- Precedent: Claude Code and Codex both ship dedicated worktree environments for agent work.
  https://code.claude.com/docs/en/claude-code/cli-reference · https://developers.openai.com/codex/cli/reference

### [REC]
One worktree per spawned agent working the same repo. Enforce: agent gets its own linked worktree via `git worktree add`; record the worktree path in the agent record; stop = leave the worktree intact; cleanup = `git worktree remove` only after an unpushed-commit check (mirroring Claude Code's `--discard-unpushed` refusal pattern). Never share one checkout between two concurrent agents. Parse with `list --porcelain -z` (paths may contain spaces/newlines).

---

## 9. Capability-based scheduling (brief)

### Evidence
- Orchestrator API v0 (docs/orchestrator-api.md) node capabilities shape `{ max_agents, runtimes[], headless }`.
- Buildkite queue routing (recency-ordered for cache warmth) and GitHub runner groups (blast-radius bounding) as production precedents.
  https://buildkite.com/docs/agent/v3 · https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions

### [REC]
Keep the v0 shape; make per-node `capabilities` a closed vocabulary (runtimes enum, headless, max_agents). Scheduling = filter nodes by capability, then pick by load/warmth. Do not invent a DSL. The trust gate (approved node list) is the scheduler's hard boundary: an agent can only be scheduled onto a node whose grants cover the requested operation.

---

## Key risks (evidence-based, for the Decision Log)

1. **DPAPI prompt-flow removal (Feb 2027)** — if any legacy path uses `CryptProtectData` prompts, plan the non-interactive path now.
2. **Self-hosted runner compromise class** (GitHub's own guidance) — remote nodes running untrusted repo code are the same threat; JIT/ephemeral node mode should be a design option from M3, not an afterthought.
3. **Tauri updater private key loss** = permanent inability to update shipped installs — key custody must be a documented CI secret, not a dev-machine file.
4. **Codex `--remote` token rule** (wss-only across networks) is the security floor for our node WSS transport: bearer token over wss only, never ws across networks.

---

## Batch-2 candidates (proposed, awaiting Lead tasking)

- mDNS/zeroconf discovery for LAN nodes (and why auto-discovery may conflict with the trust gate)
- systemd hardening profiles (`ProtectSystem`, `ProtectHome`, `PrivateTmp`, `DynamicUser`)
- gRPC vs WSS benchmark data for message volumes
- Secretless-broker / OIDC workload-identity patterns for node identity