# ADR-0002 — AgentRuntime abstraction

Status: Proposed (M0) · Owner: Lead · Input: Backend

## Decision (proposed)
Agent lifecycle goes through a per-host **AgentRuntime** interface (`spawn(status) / stop / restart / status / capabilities`), built on the argv discipline already in `src/hosts/spawn-delivery.ts` (argv arrays, no shell, Windows budget checks). First runtime: **opencode** (only host installed on the dev machine). Claude Code/Codex runtimes follow the same interface using their documented resume APIs. Hosts without a headless/resume surface are pull-only members, never spawned.

## Consequences
- Orchestrator core depends only on the interface; host adapters are additive.
- Spawned agents get routable OpenComms session ids and join channels as ordinary members (engine rules unchanged unless the design note proves a required change — changes go through Lead).
- Spikes are disposable; M1 implementation lands in `src/orchestrator/**`.

## Open questions
- `opencode serve`+SDK vs `opencode run` for headless spawn — resolved by Backend's spike (docs/spike-spawn-opencode.md).
- Restart semantics: new host session with adopted identity vs resume of dead session (identity pins exist for claude-code; opencode equivalent TBD).