// OpenComms Tauri Desktop GUI — the owner-facing desktop shell. Owns NO
// business logic: it consumes the loopback Orchestrator API (contract v0.3,
// docs/orchestrator-api.md) via the webview, per the Decision Log.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};

struct ServerChild(Child);

impl Drop for ServerChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

/// Launch the OpenComms coordinator (dev mode: `node dist/cli/main.js gui`)
/// as a child process so the webview has its loopback API. Release builds
/// bundle the per-triple coordinator sidecar (binaries/opencomms-coordinator
/// — pinned 22.14.0 SEA build, Platform artifact) and resolve it next to the
/// executable instead.
fn spawn_coordinator() -> Option<ServerChild> {
    let sidecar_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let sidecar = sidecar_dir.join("opencomms-coordinator.exe");
    if sidecar.exists() {
        return match Command::new(&sidecar)
            .arg("gui")
            .arg("--port")
            .arg("1455")
            .arg("--server")
            .arg("--project")
            .arg(repo_root().into_os_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => Some(ServerChild(child)),
            Err(error) => {
                eprintln!("[opencomms-desktop] failed to spawn coordinator sidecar: {error}");
                None
            }
        };
    }
    // Dev path: run from the repo (cargo dev builds resolve dist/cli/main.js).
    let repo_root = repo_root();
    let server_script = repo_root.join("dist").join("cli").join("main.js");
    if !server_script.exists() {
        eprintln!(
            "[opencomms-desktop] {} not found — run `npm run build` in the repo root first.",
            server_script.display()
        );
        return None;
    }
    let node = if cfg!(windows) { "node.exe" } else { "node" };
    match Command::new(node)
        .arg(&server_script)
        .arg("gui")
        .arg("--port")
        .arg("1455")
        .arg("--server")
        .arg("--project")
        .arg(&repo_root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => Some(ServerChild(child)),
        Err(error) => {
            eprintln!("[opencomms-desktop] failed to spawn coordinator (dev): {error}");
            None
        }
    }
}

fn repo_root() -> std::path::PathBuf {
    // desktop/src-tauri -> repo root is two levels up.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf()
}

fn main() {
    // Start the coordinator (dev mode) or the packaged sidecar, then open the
    // webview at its loopback URL (tauri.conf.json window url). The shell
    // owns no business logic.
    let _guard = spawn_coordinator();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}