fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["orchestrator_invoke", "pick_project"]),
        ),
    )
    .expect("Tauri manifest generation failed")
}
