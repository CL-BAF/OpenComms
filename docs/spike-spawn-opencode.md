# SPIKE ÔÇö Same-Machine Agent Spawn (OpenCode) ÔÇö M0

> **STATUS: DISPOSABLE SPIKE (M0).** Evidence-only document. The probe scripts live in
> `%TEMP%\opencode\spike\` (launch-serve.mjs, lifecycle.mjs, lifecycle2.mjs, probe-*.mjs,
> lifecycle-final.mjs) and are deliberately NOT integrated into `src/`. No `src/**` files
> were modified for this spike. Date: 2026-09-11. Machine: Windows 11, opencode 1.18.25,
> node v24.19.0, SDK @opencode-ai/sdk 1.18.23 (already in node_modules).

## Goal (from Lead tasking)

Prove programmatically, on ONE machine: spawn a headless OpenCode agent, get a routable
session id, deliver one framed message to it, capture exit/status ÔÇö reusing the argv
discipline from `src/hosts/spawn-delivery.ts` (no shell, argv array, Windows budget).

## Result: PASS

All steps below were executed for real (multiple runs; final run reproduced twice with
identical shape). Evidence is the JSON printed by `lifecycle-final.mjs`.

## Test A ÔÇö serve launch (argv discipline + env-only auth)

Launch method: `spawn()` (Node child_process, `shell:false`, argv array, `windowsHide:true`).

```text
argv = ["C:\Users\Cameron\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe",
        "serve", "--port", "4222", "--hostname", "127.0.0.1"]
env  = { ...process.env,
         OPENCODE_SERVER_PASSWORD: <random per-run>,
         OPENCODE_SERVER_USERNAME: "orchestrator-spike" }
cwd  = <project dir>          # session storage scopes to the project directory
```

- **Password handoff is env-only** (Reviewer gate): the password never appears on the
  command line, so it is not visible in process listings (`Win32_Process.CommandLine`
  shows only the argv above ÔÇö verified). The random password was generated in the
  parent process env and passed via the child `env` block.
- **Windows binary resolution (recorded for M1):** bare `"opencode"` fails with
  `spawn opencode ENOENT` ÔÇö npm installs only a `.ps1`/`.cmd` shim, and Node refuses to
  spawn `.cmd`/`.bat` shims without a shell (same class of problem already solved in
  OpenComms via `OPENCOMMS_CLAUDE_BIN`/`OPENCOMMS_CODEX_BIN` overrides). The orchestrator
  must resolve the native binary `...\npm\node_modules\opencode-ai\bin\opencode.exe`
  (or accept an override env) before execFile-spawning. Exact command observed working:
  `opencode serve --port <n> --hostname 127.0.0.1`.
- **Port capture:** the child's stdout prints
  `opencode server listening on http://127.0.0.1:4222` ÔÇö deterministic signal for
  readiness (polled, ~1ÔÇô2 s cold start).
- With a password set, unauthenticated requests fail; authenticated requests (Basic auth
  header from the SDK) succeed. One credential pair per server, fixed at boot (matches
  Researcher addendum A1: rotation = restart ÔÇö acceptable for M1).

## Test B/C ÔÇö full lifecycle on ONE shared serve (single-instance behavior)

Final run (identical shape reproduced 3├ù):

```json
{
  "argv": ["...opencode.exe", "serve", "--port", "4222", "--hostname", "127.0.0.1"],
  "auth_handoff": "env-only (OPENCODE_SERVER_PASSWORD), username orchestrator-spike",
  "serve_url": "opencode server listening on http://127.0.0.1:4222",
  "agent_session_id": "ses_f7022305bffeLe32nfB0vRg7mb",
  "agent_directory": "C:\\Users\\Cameron\\Desktop\\OpenComms",
  "turn1": { "wall_ms": 13022, "assistant_text": "ACK",     "completed": true, "error": null },
  "turn2": { "wall_ms":  9328, "assistant_text": "RECEIVED","completed": true, "error": null },
  "abort_on_idle": "ok (no error)",
  "serve_alive_after_abort": true,
  "serve_after_sigterm": { "exitCode": null, "killed": true },
  "result": "PASS"
}
```

Exact SDK call sequence (all against the single serve instance):

1. `client.event.subscribe()` ÔÇö SSE tap opened FIRST (before create), single
   credential; receives ALL events for the project directory (see Single-instance
   section below). Observed event types during one turn: `session.created`,
   `session.updated`, `message.updated`, `message.part.updated`(+`message.part.delta`),
   `session.status`, `session.diff`, `session.idle`, `server.heartbeat`, plus
   `plugin.added`/`catalog.updated` noise. `message.part.delta` carried the final
   assistant text (`"ACK"` / `"RECEIVED"`).
2. `client.session.create({ body: { title: "spike-worker-final" } })` ÔåÆ
   `{ data: { id: "ses_*", title, directory } }` ÔÇö **routable OpenComms-compatible
   session id** (same `ses_*` namespace the channel engine routes by).
3. `client.session.prompt({ path: { id }, body: { parts: [{ type: "text",
   text: framedMessage }], model: { providerID: "opencode", modelID: "big-pickle" } } })`
   ÔÇö synchronous turn; resolved when the turn completed (~13ÔÇô18 s wall).
4. `client.session.promptAsync(...)` ÔÇö fire-and-forget second push while the agent was
   idle; assistant replied `RECEIVED` (~5ÔÇô9 s wall). Proves repeated framed delivery to
   a resident agent, which is exactly the orchestrator's push path.
5. `client.session.messages({ path: { id } })` ÔÇö rows are `{ info, parts }`;
   `info.role === "assistant"`, `info.time.completed` marks turn end,
   `info.error.data.message` carries provider errors (see Failures observed),
   assistant text lives in `parts[].text` where `parts[].type === "text"`.
6. `client.session.abort({ path: { id } })` on an IDLE session ÔÇö no error, serve stays
   alive. (Abort semantics observed only for idle; mid-turn abort is the M2 use.)
7. `child.kill("SIGTERM")` on the serve process ÔÇö killed within ~1.5 s (Node marks the
   process killed; Windows does not report a meaningful exit code ÔÇö `exitCode: null`).
   **Killing the shared serve kills ALL sessions on it** (expected shared-instance
   tradeoff; recorded as the accepted M1 kill story).

Framing: both deliveries used the exact OpenComms untrusted framing
(`<<<UNTRUSTED_PEER_MESSAGE>>> ... <<<END_UNTRUSTED_PEER_MESSAGE>>>`) with provenance
lines ÔÇö no new message shape was introduced (per Lead: reuse MessageEnvelope framing;
the envelope layer stays in OpenComms core, the runtime just moves its `content`).

## Single-instance behavior (explicit Lead-required observation section)

- ONE serve process per project directory was launched per run. Every probe that
  created sessions left them in the shared project-visible session store ÔÇö
  `opencode session list` (a DIFFERENT process) listed every spike session
  (`spike-worker-final`, `spike-probe*`), confirming **shared session storage across
  processes/instances**. All spike sessions were deleted afterwards
  (`opencode session delete <id>` ├ù18; re-list shows 0).
- Under one serve process, concurrent sessions are isolated by session id only:
  `session.create` twice returned distinct `ses_*` ids, both immediately routable
  (`prompt`/`promptAsync`/`messages` addressed either at will). No cross-session
  bleed was observed in `session.messages` (each turn's assistant row stayed in its
  own session).
- **`client.session.status()` returned `{}` in our builds even while a turn was
  running** ÔÇö it is NOT a reliable busy oracle on this build. The SSE
  `session.status`/`session.idle` events ARE reliable (observed idle transitions after
  each completed turn). Orchestration status should therefore be event-driven, not
  `GET /session/status`-driven.
- No contention anomalies observed with 1 serve + 1 SSE tap + sequential sessions.
  (Two concurrent serve instances on one directory was deliberately NOT exercised ÔÇö
  Lead's binding rule: one instance per project in the spike; multi-instance sharing
  global state remains an open M3 question.)

## Env/permission/least-privilege notes (M1 design inputs)

- Role prompt was passed inline as the first prompt text in this spike. For M1, the
  same inline-env path exists: `OPENCODE_CONFIG_CONTENT` (inline JSON config) and
  `OPENCODE_PERMISSION` (inline permissions config) ÔÇö no agent-visible files, no disk
  writes (per Lead constraint 6). Deny-by-default permission allowlist to be chosen at
  M1 implementation (e.g. read-only + gated bash), never `--auto`/bypassPermissions
  (not used in the spike).
- Model selection is per-prompt (`body.model = { providerID, modelID }`) ÔÇö observed:
  server default resolved to `openai/gpt-5.6-terra-pro` and FAILED with
  `Cannot connect to API: Unable to connect` (no reachable provider backing that model
  on this machine); explicitly pinning `opencode/big-pickle` worked reliably (turns
  completed, real text, tokens counted: e.g. `{ input: 16770, output: 16 }`).
  `opencode-go/glm-5.3-flash` hung with zero output tokens (no error, no completion)
  for 5ÔÇô10 min. **Conclusion for M1: the orchestrator must ALWAYS pin an explicit,
  verified model at spawn; never rely on server defaults.**
- Password hygiene: `OPENCODE_SERVER_PASSWORD` never printed, never logged, never
  written to disk; process listings show argv only (env not exposed). The `?auth_token=`
  SSE query-param path exists but was NOT used ÔÇö the SDK tap sends the Basic header.

## Kill semantics observed (Lead-required record)

| Action | Observed behavior |
|---|---|
| `session.abort` on IDLE session | resolves `ok`, no side effects, serve stays up |
| `SIGTERM` serve process | process killed Ôëñ1.5 s; ALL sessions on the instance stop being servable (accepted shared-instance tradeoff) |
| Serve killed while session exists | session row persists in project storage (visible to later `session list`); NOT auto-resumed anywhere ÔÇö nothing else owns it |
| Serve crash mid-turn | NOT observed in spike (turns were short); the orchestrator must treat this like the existing `in_flight` sweep problem ÔÇö M1 design: spawned-agent records carry `last_seen_at` and are marked `stale` when the SSE tap notices `server.instance.disposed`/disconnect |

## Failure modes observed (for the ledger)

1. Server-default model selection ÔåÆ hard connect error (see above): spawn must pin a
   verified model or the first turn fails opaquely.
2. Some provider models hang without error or completion (`opencode-go/glm-5.3-flash`
   produced 0 tokens for minutes with no error row). Orchestrator turn-wait must be
   timeout-based (poll `info.time.completed` / `info.error`), never open-ended.
3. `client.session.status()` returning `{}` mid-turn ÔÇö cannot be used for busy/idle
   decisions; use SSE events.
4. Node assertion crash at teardown (`win/async.c` assertion on process.exit after
   child kill) ÔÇö benign, probe-only, not an orchestrator path (real orchestrator keeps
   the serve running as a managed child).

## THE one open question that would block M1

**Session id namespace collision between orchestrator-spawned sessions and
user-created TUI sessions.** `session.create` returns `ses_*` ids in the SAME global
namespace the OpenComms channel engine routes by (our spike ids were listed by
`opencode session list` alongside team sessions, and would be linkable by
`opencomms_join` like any root session). This is GOOD for delivery (existing engine
just works ÔÇö a spawned agent can `opencomms_join` a channel with zero engine changes,
since join keys on `ctx.sessionID`), but it means M1 must decide how the orchestrator
Distinguishes "managed" sessions from user sessions in `state.json` (or accepts that
any session can be orchestrated). Proposal recorded in
`docs/orchestrator-design.md` ┬º7 (agent record keyed `agt_*`, `host_session_id`
attribute, `managed: true` marker) ÔÇö needs Lead sign-off, no engine change required
for the spike-proven path.

## Secondary observation (non-blocking)

- The desktop app (`@opencode-aidesktop`) runs its own opencode processes on this
  machine; our serve instances were independent and unaffected (no port conflicts at
  the 4210ÔÇô4230 probe range; only loopback binds used).
