# GUI action audit — 2026-10-05

The browser and offline native document use `src/gui/contracts.ts` to resolve exact method/path pairs into named actions. Native Rust and TypeScript command allowlists are checked by regression tests. Native IPC cannot forward arbitrary HTTP paths. The tested native UI transport is an emulated Tauri seam with the real persisted backend; Rust/WebView/installer execution remains a separate unverified gate.

| Visible control / surface | Named backend operation(s) | Result and authority | Verification |
| --- | --- | --- | --- |
| Project selector / Open project | workspace_state, workspace_select | Validates an existing project; blocks switching during mutations/owned runtime use | Persisted backend tests; browser selection fixture |
| Browse | Native pick_project or Windows HTTP picker | Candidate path is still backend-validated; unsupported browser platforms disable Browse with paste-path recovery | Capability regression/browser; real OS/native picker interaction unverified |
| New session | session_create | Locked durable channel creation; no linked host launch | HTTP + native-seam browser persisted create |
| Active/saved tabs, session cards, Back | sessions_list, session_members | Exact lifecycle/roster; keyboard access and refresh selection preserved | Browser/seam workflow |
| Join host / role / Copy | session_join_command | Exact host/role query; copyable instructions, no fabricated host identity | Unit query routing + browser/seam |
| Member Remove | member_remove | Removes exact endpoint from channel, retains host process/session | Routing/backend + persisted browser/seam |
| Pause / Resume delivery | session_pause, session_unpause | Locked channel state; emergency stop restricts ordinary resume | Backend tests; emergency browser/seam |
| Save / Resume as new / Delete | session_save, session_resume, session_delete | Archive preserved; new channel references archive; destructive delete confirmation | Lifecycle tests; browser/seam save/resume |
| Team list / status | agents_list | Host/mode/model/status/task and honest unknown telemetry; mail queued is not working | Backend/status tests; browser fixtures |
| Create Agent / model / runtime / isolated worktree | agent_create, capabilities | Explicit managed mode; no catalogue disables submit; ACP keeps configured model; isolation disabled outside Git roots | HTTP/runtime/create safety tests; browser/seam capability/disabled states; vendor creation unverified |
| Link managed endpoint | agent_link | Existing identity retained; exact project/worktree matches channel | Backend tests; team apply UI |
| Stop / Restart | agent_stop, agent_restart | Local supported managed runtime; ordinary lead-stop protected; exact identity lookup, replacement requires explicit authorization | Native command parity + real protocol fixtures; real vendor/native UI unverified |
| Host approvals / Allow once / Reject | permissions_list, permission_respond | Correct local active host authority; unknown/unsupported errors visible; remote controls refused before runtime access | Real HTTP/ACP fixtures + boundary regressions; real vendor approvals unverified |
| Assign task | task_assign | Targeted durable queue with operation ID; owner/dependency/criteria/ownership/budget validation | Persisted tests + three-member browser/seam assignment |
| Task filter / Open / Refresh | tasks_list, task_get | Filter/detail survives refresh; combines assignment, delivery, execution, related messages and evidence | Browser/seam persisted workflow |
| Task transitions / evidence / review | task_transition | Revision/owner/dependency gates; operator completion requires covered criteria and independent accepted review | Backend unit/integration; browser/seam rejects premature completion then accepts supplied evidence |
| Reassign task | task_reassign | Explicit owner-stopped confirmation and reason; no uncertain in-flight retry or silent discard | Persisted backend/CLI tests; visible modal uses same named operation |
| Save / Edit / Delete team template | team_template_list/save/delete | Project-local revisioned plan; no agent launch on save/delete | Backend + browser/seam |
| Apply team entry | session_create, session_join_command, agent_create | Explicit link/launch choice; required capabilities checked before creation; existing channel budgets not silently overwritten | Backend tests + browser/seam link preparation/budgets |
| Project context search / Add / Compact handoff | context_list/add/handoff | Project-local records distinguish proposals/accepted/verified/rejected; bounded compact references | Backend + search-refresh browser/seam |
| Activity / Load next | events_list | Advancing cursor, deduplication and bounded retained feed | Full pagination unit tests + browser/seam refresh |
| Audit log | audit_log | Bounded persisted coordinator audit view, not a host transcript | API/bridge tests |
| Nodes / runtimes / pending requests | nodes_list, runtimes_list, trust_view | Actual registry records and advertised capabilities; remote dispatch explicitly unavailable | Trust/API tests; remote live enrollment unverified |
| Approve / Revoke remote node | node_approve, node_revoke | Explicit typed owner token; actual certificate/trust change; does not claim unsupported remote interruption | Trust/security regressions; live remote transport unverified |
| Integrations Install / Update / Repair / Check configuration / Uninstall | integrations_overview/bootstrap, integration_action | Safe manager actions preserve unrelated configuration; four onboarding stages never infer a vendor roundtrip from files | Real temp-config/install subprocess tests; copied SEA/npm package smoke; browser onboarding |
| Diagnostics / Copy | diagnostics | Actual bounded/redacted output; request IDs and recovery for failure | Backend/bridge tests + browser/seam navigation |
| Settings Updates | capabilities.updates | Visibly unavailable in GUI with CLI recovery; no enabled fake updater; native signing unconfigured | Browser/seam settings assertion + native asset/config checks |
| Emergency Stop / Resume coordination | emergency_stop | Durable project stop; queued delivery paused; optional supported managed interruption including lead; linked host keeps running | Persisted restart/project-switch tests + browser/seam pause |

Mutation dialogs prevent duplicate submission, preserve an operation ID, show terminal results and keep the modal open after known failure. Uncertain mutations require inspection before retry. Only supported cancellation is offered. Focus is trapped in dialogs and restored on close; live refresh defers while editing. Read failures retain the last view and expose the error.

The complete local regression evidence and remaining gates are in [UPGRADE_HANDOFF.md](UPGRADE_HANDOFF.md). Passing a read endpoint is not used as permission for an unrelated mutation.
