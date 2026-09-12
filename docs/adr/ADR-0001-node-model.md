# ADR-0001 — Node model: local implicit, remote opt-in

Status: Proposed (M0) · Owner: Lead · Input: Backend, Platform, Researcher

## Decision (proposed)
Exactly one implicit **local node** always exists per project; it needs no pairing or approval. **Remote nodes** exist only after explicit owner approval (pairing flow, M3) and are revocable. Node identity is durable across restarts (per-node key file in `.opencomms/`, pattern to be chosen — see Researcher batch-1 report).

## Consequences
- All single-machine features must function with zero remote-node code paths exercised.
- Orchestrator API treats `node_id` as optional on agent create; omitted ⇒ local.
- No auto-discovery of machines ever.

## Open questions
- Exact remote identity scheme (mTLS vs ed25519 keys vs SPIFFE) — M3, parked.
- Whether remote nodes can host Lead-role agents (default: no).