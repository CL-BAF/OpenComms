// SPIKE (M0, disposable): Tauri v2 shell wrapping the existing OpenComms
// loopback GUI server. Owns NO business logic — it consumes the loopback
// HTTP API (docs/orchestrator-api.md contract v0) via the webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};

struct ServerChild(Child);

impl Drop for ServerChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

/// SPIKE: launch the existing CLI (`opencomms gui --server --port 1455`)
/// as a child process. The real sidecar/packaging decision lands after M0;
/// this spike requires the repo to have been built (`npm run build`) and
/// resolves dist/cli/main.js relative to the repo root (cargo manifest dir).
fn spawn_gui_server() -> Option<ServerChild> {
    // desktop/src-tauri -> repo root is two levels up.
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)?
        .to_path_buf();
    let server_script = repo_root.join("dist").join("cli").join("main.js");
    if !server_script.exists() {
        eprintln!(
            "[opencomms-desktop SPIKE] {} not found — run `npm run build` in the repo root first.",
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
            eprintln!("[opencomms-desktop SPIKE] failed to spawn GUI server: {error}");
            None
        }
    }
}

fn main() {
    // SPIKE: start the existing loopback server, then open the webview at it
    // (tauri.conf.json window url = http://127.0.0.1:1455/). The webview
    // renders the existing console UI; the shell owns no business logic.
    let _guard = spawn_gui_server();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}