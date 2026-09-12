# ADR-0003 — Trust & approvals

Status: Proposed (M0) · Owner: Lead · Input: Reviewer

## Decision (proposed)
Three approval classes, enforced server-side (orchestrator core), not in the GUI:
1. **Owner** — approves/revokes remote nodes, changes trust policy. The human only.
2. **Lead** — creates/stops agents, assigns tasks on approved nodes (local always; remote only if approved).
3. **Agents** — can message, spawn nothing.

Lead cannot self-approve remote nodes. Approval state is persisted in `.opencomms/` and auditable (append-only log, M5 hardening). Revocation stops remote agents gracefully or marks them lost; no orphaned processes.

## Consequences
- Every mutating orchestrator API carries the acting principal; `403 trust_denied` otherwise.
- Spawned agents never inherit owner credentials; they get scoped identities (Reviewer checks this).
- GUI renders trust state but never grants it outside the API's owner-gated paths.

## Open questions
- Whether owner approval is in-GUI confirm or OS keyring-protected passphrase — Researcher topic (6).
- Audit log location/format — M5.