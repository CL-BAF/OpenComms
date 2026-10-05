// OpenComms Tauri Desktop GUI — the owner-facing desktop shell. Owns NO
// business logic and NO policy: it relays Tauri IPC commands to the Node
// coordinator sidecar over a handshake-validated stdio JSON-RPC bridge
// (desktop/README.md; enforcement lives in the TypeScript core).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use serde::Serialize;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender};
use std::time::{Duration, Instant};

mod bridge_io;

/// Coordinator child: process + the two stdio halves the bridge drives.
/// Killed on shell exit via Drop.
struct Coordinator {
    child: Child,
    stdin: SyncSender<bridge_io::WriteRequest>,
    stdout: Receiver<Result<String, String>>,
}

impl Drop for Coordinator {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Explicit operation surface mirrored by src/orchestrator/bridge.ts.
/// Unknown commands and arbitrary URLs are refused; no generic proxy.
const ALLOWED_COMMANDS: &[&str] = &[
    // reads
    "nodes_list",
    "agents_list",
    "tasks_list",
    "events_list",
    "trust_view",
    "sessions_list",
    "session_members",
    "session_detail",
    "session_join_command",
    "capabilities",
    "workspace_state",
    "integrations_list",
    "integrations_overview",
    "diagnostics",
    "runtimes_list",
    "audit_log",
    "task_get",
    "context_list",
    "context_handoff",
    "permissions_list",
    "integration_bootstrap",
    "team_template_list",
    // mutations
    "session_create",
    "session_save",
    "session_resume",
    "session_delete",
    "session_pause",
    "session_unpause",
    "member_remove",
    "agent_create",
    "agent_link",
    "emergency_stop",
    "agent_stop",
    "agent_restart",
    "task_assign",
    "task_transition",
    "task_reassign",
    "team_template_save",
    "team_template_delete",
    "context_add",
    "node_approve",
    "node_revoke",
    "workspace_select",
    "integration_action",
    "permission_respond",
];

/// The sidecar's FIRST stdout line must announce
/// this identity + protocol before ANY command is relayed.
const HANDSHAKE_ID: &str = "opencomms-coordinator";
const PROTOCOL_VERSION: u64 = 1;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Serialize)]
struct BridgeError {
    ok: bool,
    code: &'static str,
    message: String,
    request_id: String,
    operation: String,
    outcome: &'static str,
    error: NativeErrorDetail,
}

#[derive(Debug, Serialize)]
struct NativeErrorDetail {
    state: &'static str,
    recovery: &'static str,
}

impl BridgeError {
    fn new(code: &'static str, message: impl Into<String>, request_id: &str, operation: &str, outcome: &'static str) -> Self {
        let state = match code {
            "unsupported" => "unsupported",
            "temporarily_unavailable" => "temporarily_unavailable",
            _ => "execution_failed",
        };
        let recovery = if outcome == "unknown" {
            "Check persisted operation state before retrying. Use this request ID in Diagnostics."
        } else {
            "Correct the request or repair the coordinator connection. The operation was not executed."
        };
        Self { ok: false, code, message: message.into(), request_id: request_id.into(), operation: operation.into(), outcome,
            error: NativeErrorDetail { state, recovery } }
    }
}

/// Spawn the sidecar (beside this exe) or the dev coordinator (repo node),
/// then read + validate the handshake BEFORE any command can flow. On
/// mismatch or the native deadline the child is killed and reaped. Stdin
/// receives no command until the fixed identity, protocol and operation
/// surface are validated. Each side independently bounds the handshake.

/// Connection diagnostics (stderr is hidden in installed builds). Write failures
/// in per-user app data (installation directories can be read-only), capped
/// to keep the file small. Command BODIES are never logged (requests must
/// never reach a log file); only connection lifecycle events.
fn bridge_log(exe_dir: &std::path::Path, message: &str) {
    use std::io::Write as _;
    let directory = fallback_project_dir(exe_dir).join("logs");
    if std::fs::create_dir_all(&directory).is_err() { return; }
    let path = directory.join("bridge.log");
    let entry = format!(
        "[{}] {}\n",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        message
    );
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    // Keep the last ~50 lines.
    let mut lines: Vec<&str> = existing.lines().collect();
    lines.push(entry.trim_end());
    if lines.len() > 50 {
        let start = lines.len() - 50;
        lines = lines[start..].to_vec();
    }
    if let Ok(mut f) = std::fs::File::create(&path) {
        let _ = writeln!(f, "{}", lines.join("\n"));
    }
}

fn connect_coordinator() -> Result<Coordinator, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("resolve exe: {e}"))?
        .parent()
        .ok_or("no parent dir")?
        .to_path_buf();
    let sidecar = exe_dir.join(if cfg!(windows) { "opencomms-coordinator.exe" } else { "opencomms-coordinator" });
    let seeded_project = installed_project_dir(&exe_dir);
    let bootstrap = seeded_project.is_none();
    let project = seeded_project.unwrap_or_else(|| fallback_project_dir(&exe_dir));

    let mut child = if sidecar.exists() {
        let mut command = Command::new(&sidecar);
        hide_coordinator_window(&mut command);
        command.arg("bridge").arg("--project").arg(&project);
        if bootstrap {
            command.arg("--bootstrap");
        }
        match command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("spawn sidecar failed: {e}");
                bridge_log(&exe_dir, &msg);
                return Err(msg);
            }
        }
    } else {
        bridge_log(&exe_dir, "sidecar not found beside exe (installed context)");
        if !cfg!(debug_assertions) {
            return Err("Bundled coordinator is missing. Repair or reinstall OpenComms.".into());
        }
        // Dev path: repo coordinator (node dist/cli/main.js).
        let root = repo_root();
        let script = root.join("dist").join("cli").join("main.js");
        if !script.exists() {
            let msg = format!("coordinator not found: {}", script.display());
            bridge_log(&exe_dir, &msg);
            return Err(msg);
        }
        let node = if cfg!(windows) { "node.exe" } else { "node" };
        let mut command = Command::new(node);
        hide_coordinator_window(&mut command);
        match command
            .arg(&script)
            .arg("bridge")
            .arg("--project")
            .arg(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("spawn dev coordinator failed: {e}");
                bridge_log(&exe_dir, &msg);
                return Err(msg);
            }
        }
    };

    let pipes = match (child.stdin.take(), child.stdout.take()) {
        (Some(stdin), Some(stdout)) => (stdin, stdout),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("coordinator stdio unavailable".into());
        }
    };
    // Construct the owner BEFORE validation: every failure below drops it,
    // killing and reaping the process. The native deadline is independent
    // of the sidecar timer, including a child that never announces itself.
    let coordinator = Coordinator {
        child,
        stdin: bridge_io::request_writer(pipes.0),
        stdout: bridge_io::response_reader(pipes.1),
    };
    let line = coordinator.stdout.recv_timeout(HANDSHAKE_TIMEOUT)
        .map_err(|_| "coordinator handshake timed out after 10 seconds".to_string())??;
    let hello: Value = serde_json::from_str(line.trim())
        .map_err(|_| "coordinator handshake is not valid JSON".to_string())?;
    if hello.get("hello").and_then(|v| v.as_str()) != Some(HANDSHAKE_ID) {
        let msg = "handshake identity mismatch — not the OpenComms coordinator".to_string();
        bridge_log(&exe_dir, &msg);
        return Err(msg);
    }
    if hello.get("protocol").and_then(|v| v.as_u64()) != Some(PROTOCOL_VERSION) {
        let msg = "handshake protocol version mismatch".to_string();
        bridge_log(&exe_dir, &msg);
        return Err(msg);
    }
    let announced = hello
        .get("api")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "handshake missing api list".to_string())?;
    for cmd in ALLOWED_COMMANDS {
        if !announced.iter().any(|a| a.as_str() == Some(*cmd)) {
            let msg = format!("coordinator missing IPC command: {cmd}");
            bridge_log(&exe_dir, &msg);
            return Err(msg);
        }
    }

    // Handshake ack: the sidecar's bridge WAITS for {"hello_ok":true} before
    // serving ANY command (its pre-ack stdin is dropped without execution).
    // Without this acknowledgement the sidecar exits after its deadline.
    bridge_io::write_frame(&coordinator.stdin, "{\"hello_ok\":true}\n".into(), HANDSHAKE_TIMEOUT)?;

    Ok(coordinator)
}

fn hide_coordinator_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Relay one command. Shape validation only — NO policy decisions here;
/// the TS core enforces trust exactly as it does over HTTP.
fn relay(coordinator: &mut Coordinator, request_id: &str, cmd: &str, args: &Value) -> Result<Value, BridgeError> {
    if !ALLOWED_COMMANDS.contains(&cmd) {
        return Err(BridgeError::new("unsupported", "Native operation is not supported.", request_id, cmd, "not_executed"));
    }
    let request = serde_json::json!({ "id": request_id, "cmd": cmd, "args": args });
    let mut line = serde_json::to_string(&request)
        .map_err(|_| BridgeError::new("invalid_request", "Request could not be encoded.", request_id, cmd, "not_executed"))?;
    line.push('\n');
    if line.len() > bridge_io::MAX_LINE_BYTES || line.encode_utf16().count().saturating_sub(1) > 1_000_000 {
        return Err(BridgeError::new("invalid_request", "Request exceeds the native bridge size limit.", request_id, cmd, "not_executed"));
    }
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    bridge_io::write_frame(&coordinator.stdin, line, COMMAND_TIMEOUT)
        .map_err(|_| BridgeError::new("temporarily_unavailable", "Coordinator connection failed. Check the operation result before retrying.", request_id, cmd, "unknown"))?;
    let response = coordinator.stdout.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| BridgeError::new("temporarily_unavailable", "Coordinator did not respond within 120 seconds. Check the operation result before retrying.", request_id, cmd, "unknown"))?
        .map_err(|message| BridgeError::new("temporarily_unavailable", message, request_id, cmd, "unknown"))?;
    bridge_io::validate_response(&response, request_id)
        .map_err(|message| BridgeError::new("failed", message, request_id, cmd, "unknown"))
}

fn installed_project_dir(install_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    // The installer may seed a project beside the app; else the owner picks
    // one in the GUI and the sidecar remembers it (its own state dir).
    let seeded = install_dir.join(".opencomms");
    if seeded.is_dir() {
        return Some(install_dir.to_path_buf())
    }
    None
}

/// Installed-context fallback when no .opencomms is seeded beside the exe:
/// use the per-user app-data directory (NOT a compile-time repo path, which
/// is meaningless on a clean install).
fn fallback_project_dir(install_dir: &std::path::Path) -> std::path::PathBuf {
    // Keep bootstrap state outside the installation directory. The GUI server
    // treats this as storage-only until the owner chooses a real project, so
    // uninstalling/updating the app cannot become a project-state operation.
    let local_app_data = if cfg!(windows) { std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(std::path::PathBuf::from)
                .map(|profile| profile.join("AppData").join("Local"))
        })
    } else { std::env::var_os("XDG_STATE_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(std::path::PathBuf::from)
            .map(|profile| profile.join(".local").join("state")))
    }.unwrap_or_else(|| std::env::temp_dir());
    let path = local_app_data.join("OpenComms").join("bridge-runtime");
    if path == install_dir {
        std::env::temp_dir().join("OpenComms").join("bridge-runtime")
    } else {
        path
    }
}

/// Open the host-native project directory picker. This is a UI affordance,
/// not a project validator; the TypeScript core validates the returned path
/// when `workspace_select` is relayed over the audited bridge.
#[tauri::command]
async fn pick_project() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose an OpenComms project directory")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    }).await.map_err(|_| "Project picker could not be opened.".to_string())
}

fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf()
}

/// One thin IPC command. Shape-validation + forward — no policy, no logging
/// of bodies (token-bearing requests must never reach a log file).
#[tauri::command]
async fn orchestrator_invoke(
    state: tauri::State<'_, Arc<Mutex<Option<Coordinator>>>>,
    cmd: String,
    args: Value,
) -> Result<Value, BridgeError> {
    let request_id = format!("native-{}-{}", std::process::id(), REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    if !ALLOWED_COMMANDS.contains(&cmd.as_str()) {
        return Err(BridgeError::new("unsupported", "Native operation is not supported.", &request_id, &cmd, "not_executed"));
    }
    if !args.is_object() {
        return Err(BridgeError::new("invalid_request", "Operation arguments must be an object.", &request_id, &cmd, "not_executed"));
    }
    let connection = Arc::clone(state.inner());
    let operation = cmd.clone();
    let id = request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = connection.lock().map_err(|_| BridgeError::new("failed", "Coordinator state is unavailable. Restart OpenComms.", &id, &operation, "not_executed"))?;
        if guard.is_none() {
            *guard = Some(connect_coordinator().map_err(|message| BridgeError::new("temporarily_unavailable", message, &id, &operation, "not_executed"))?);
        }
        let result = relay(guard.as_mut().expect("coordinator connected"), &id, &operation, &args);
        if result.is_err() {
            // Reconnect on the NEXT explicit request. Never automatically
            // replay a mutation whose result could have been committed.
            guard.take();
        }
        result
    }).await.map_err(|_| BridgeError::new("failed", "Native operation worker failed. Check its result before retrying.", &request_id, &cmd, "unknown"))?
}

fn main() {
    // The webview loads BUNDLED assets (frontendDist) — no loopback URL.
    // The bridge connects lazily on the first IPC command.
    tauri::Builder::default()
        .manage(Arc::new(Mutex::<Option<Coordinator>>::new(None)))
        .invoke_handler(tauri::generate_handler![orchestrator_invoke, pick_project])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
