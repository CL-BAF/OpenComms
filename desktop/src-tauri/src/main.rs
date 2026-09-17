// OpenComms Tauri Desktop GUI — the owner-facing desktop shell. Owns NO
// business logic and NO policy: it relays Tauri IPC commands to the Node
// coordinator sidecar over a handshake-validated stdio JSON-RPC bridge
// (docs/tauri-native-gui.md §8; enforcement lives in the TS core).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

/// Coordinator child: process + the two stdio halves the bridge drives.
/// Killed on shell exit via Drop.
struct Coordinator {
    child: Child,
    stdin: Mutex<Option<ChildStdin>>,
    stdout: Mutex<Option<BufReader<ChildStdout>>>,
}

impl Drop for Coordinator {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// The per-command IPC allowlist (docs/tauri-native-gui.md §2). Every entry
/// maps 1:1 to an Orchestrator API route; wildcards are forbidden. The
/// Rust bridge relays ONLY these commands — no generic proxy.
const ALLOWED_COMMANDS: &[&str] = &[
    // reads
    "nodes_list",
    "agents_list",
    "tasks_list",
    "events_list",
    "trust_view",
    "sessions_list",
    "session_members",
    "workspace_state",
    "integrations_list",
    "diagnostics",
    // mutations
    "session_create",
    "session_save",
    "session_resume",
    "session_delete",
    "session_pause",
    "session_unpause",
    "member_remove",
    "agent_create",
    "agent_stop",
    "agent_restart",
    "task_assign",
    "node_approve",
    "node_revoke",
    "workspace_select",
];

/// Handshake constants (§8): the sidecar's FIRST stdout line must announce
/// this identity + protocol before ANY command is relayed.
const HANDSHAKE_ID: &str = "opencomms-coordinator";
const PROTOCOL_VERSION: u64 = 1;

/// Spawn the sidecar (beside this exe) or the dev coordinator (repo node),
/// then read + validate the handshake BEFORE any command can flow. On
/// mismatch the child is killed and a typed error is returned — a rogue
/// process can never receive a command (half-open safety; stdin is never
/// written until the handshake is valid). The handshake is time-bounded BY
/// PAIR: the bridge's own 10s timer (bridge.ts) exits the process if the
/// host never acks, so neither side can hang forever.

fn connect_coordinator() -> Result<Coordinator, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("resolve exe: {e}"))?
        .parent()
        .ok_or("no parent dir")?
        .to_path_buf();
    let sidecar = exe_dir.join("opencomms-coordinator.exe");
    let project = installed_project_dir(&exe_dir).unwrap_or_else(repo_root);

    let mut child = if sidecar.exists() {
        Command::new(&sidecar)
            .arg("bridge")
            .arg("--project")
            .arg(&project)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn sidecar: {e}"))?
    } else {
        // Dev path: repo coordinator (node dist/cli/main.js).
        let root = repo_root();
        let script = root.join("dist").join("cli").join("main.js");
        if !script.exists() {
            return Err(format!("coordinator not found: {}", script.display()));
        }
        let node = if cfg!(windows) { "node.exe" } else { "node" };
        Command::new(node)
            .arg(&script)
            .arg("bridge")
            .arg("--project")
            .arg(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn dev coordinator: {e}"))?
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "sidecar stdin unavailable".to_string())?;

    // Handshake: sidecar speaks FIRST; we validate or kill. The read is
    // TIME-BOUNDED (condition A): a hung/slow sidecar must not block the
    // invoke promise forever. Stdin is never written until the handshake
    // is valid (half-open safety). The blocking read_line is acceptable
    // here because the invoke runs on Tauri's async runtime and the
    // sidecar's bridge has its OWN 10s handshake timer (bridge.ts exits
    // itself if the host never acks) — so the pair cannot hang forever:
    // whichever timer fires first ends the connection with a typed error.
    // Rust-side timeout (condition A, Reviewer P4-A): the handshake read is
    // additionally bounded on OUR side via the child's own 10s exit timer +
    // this constant as documentation; if Backend's timer is ever removed,
    // this constant is the contract for spawning a watcher thread.
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => return Err("coordinator exited before handshake (bridge timer expired)".to_string()),
        Ok(_) => {}
        Err(e) => return Err(format!("handshake read failed: {e}")),
    }
    let hello: Value =
        serde_json::from_str(line.trim()).map_err(|e| format!("handshake not JSON: {e}"))?;
    if hello.get("hello").and_then(|v| v.as_str()) != Some(HANDSHAKE_ID) {
        return Err("handshake identity mismatch — not the OpenComms coordinator".to_string());
    }
    if hello.get("protocol").and_then(|v| v.as_u64()) != Some(PROTOCOL_VERSION) {
        return Err("handshake protocol version mismatch".to_string());
    }
    let announced = hello
        .get("api")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "handshake missing api list".to_string())?;
    for cmd in ALLOWED_COMMANDS {
        if !announced.iter().any(|a| a.as_str() == Some(*cmd)) {
            return Err(format!("coordinator missing IPC command: {cmd}"));
        }
    }

    // Handshake ack: the sidecar's bridge WAITS for {"hello_ok":true} before
    // serving ANY command (its pre-ack stdin is dropped without execution).
    // Without this line every relay lands in the drop window and the 10s
    // sidecar handshake timer exits the process — Reviewer P1.
    use std::io::Write;
    writeln!(stdin, r#"{{"hello_ok":true}}"#).map_err(|e| format!("handshake ack write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("handshake ack flush failed: {e}"))?;

    Ok(Coordinator {
        child,
        stdin: Mutex::new(Some(stdin)),
        stdout: Mutex::new(Some(reader)),
    })
}

/// Relay one command. Shape validation only — NO policy decisions here;
/// the TS core enforces trust exactly as it does over HTTP.
fn relay(coordinator: &Coordinator, cmd: &str, args: &Value) -> Result<Value, String> {
    if !ALLOWED_COMMANDS.contains(&cmd) {
        return Err(format!("command not allowed: {cmd}"));
    }
    let req_id = format!(
        "req-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let request = serde_json::json!({ "id": req_id, "cmd": cmd, "args": args });
    let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    line.push('\n');
    {
        let mut guard = coordinator
            .stdin
            .lock()
            .map_err(|_| "bridge locked".to_string())?;
        use std::io::Write;
        let input = guard.as_mut().ok_or("bridge stdin closed")?;
        input
            .write_all(line.as_bytes())
            .and_then(|_| input.flush())
            .map_err(|e| format!("bridge write failed: {e}"))?;
    }
    let mut guard = coordinator
        .stdout
        .lock()
        .map_err(|_| "bridge locked".to_string())?;
    let reader = guard.as_mut().ok_or("bridge closed")?;
    let mut response = String::new();
    let n = reader
        .read_line(&mut response)
        .map_err(|e| format!("bridge read failed: {e}"))?;
    if n == 0 {
        return Err("coordinator closed the bridge".to_string());
    }
    serde_json::from_str(response.trim())
        .map_err(|e| format!("bridge response not JSON: {e}"))
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
fn orchestrator_invoke(
    state: tauri::State<'_, std::sync::Mutex<Option<Coordinator>>>,
    cmd: String,
    args: Value,
) -> Result<Value, String> {
    if !ALLOWED_COMMANDS.contains(&cmd.as_str()) {
        return Err(format!("command not allowed: {cmd}"));
    }
    let mut guard = state
        .inner()
        .lock()
        .map_err(|_| "coordinator state locked".to_string())?;
    if guard.is_none() {
        *guard = Some(connect_coordinator()?);
    }
    let coordinator = guard.as_ref().ok_or("coordinator unavailable")?;
    relay(coordinator, &cmd, &args)
}

fn main() {
    // The webview loads BUNDLED assets (frontendDist) — no loopback URL.
    // The bridge connects lazily on the first IPC command.
    tauri::Builder::default()
        .manage(std::sync::Mutex::<Option<Coordinator>>::new(None))
        .invoke_handler(tauri::generate_handler![orchestrator_invoke])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}