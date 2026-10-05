# GUI, native and CLI operation parity

Current build: 1.4.0, 2026-10-05. [GUI_ACTION_AUDIT.md](GUI_ACTION_AUDIT.md) records each visible control, actual backend action, authority and verification level. Historical milestone assertions do not establish parity.

The browser and native UI use the exact named routes in `src/gui/contracts.ts`; Rust permits a bounded command set matching `src/orchestrator/bridge.ts`. CLI commands call those backend operations directly or use the loopback API for managed work. There is no unrestricted native HTTP proxy.

| Surface | CLI / backend path | Limits |
| --- | --- | --- |
| Sessions | `session list/get/create/save/delete/resume`; `members [remove]`; `join-command` | Create makes an OpenComms channel, never silently creates a linked host session |
| Managed agents | `agent list/create/stop/restart/status`; API agent_link | Requires running coordinator and supported runtime; remote managed dispatch unavailable |
| Task work | `task list/assign/show/transition/reassign` | Revision, owner, dependencies, evidence/review enforced at backend; no automatic scheduling/fallback |
| Project context | `task context list/add/handoff` | Selected project only; bounded summaries |
| Team templates | Named API list/save/delete and explicit UI apply | No dedicated template CLI verb; saving a plan does not launch a team |
| Permissions | Named API list/respond | Active local host only; no dedicated CLI inbox |
| Integrations | `install/uninstall/doctor`; manager API actions; `mcp-profile` | Configuration checks are separate from authentication and real model execution |
| Nodes/trust | `nodes`, `trust view/approve/revoke`; corresponding API | Owner-token authority; registry/trust does not imply remote runtime control |
| Activity/audit | Named events_list/audit_log API | Cursor snapshots; no dedicated CLI event stream |
| Emergency stop | Named emergency_stop API/UI | Delivery-only for linked sessions; explicit supported managed interruption |
| Project selection | `--project` or validated workspace_select | Native folder picker is UI-only; unsupported HTTP picker offers typed path |
| Updates | `update --check` / `update` | GUI unavailable; Windows installer pointer, Linux self-update; target review required |
| Diagnostics | `doctor`; diagnostics API/UI | Actual redacted outcomes; does not prove vendor interoperability |

Native routing, allowlist parity and the real packaged coordinator handshake are testable without a WebView. The browser/native-seam workflows cover persisted local operations. Rust compilation and packaged native UI/installer smoke are still mandatory, unverified acceptance gates in this environment.
