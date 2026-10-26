// With an app manifest, Tauri refuses any of the app's own commands that a
// capability doesn't grant. Every command in `generate_handler!` belongs here
// and in capabilities/default.json.
const COMMANDS: &[&str] = &[
    "read_file",
    "write_file",
    "resolve_open_target",
    "canonicalize_path",
    "watch_file",
    "unwatch_file",
    "watch_annotations",
    "read_annotations",
    "add_annotation",
    "remove_annotation",
    "update_annotation",
    "add_reply",
    "resolve_anchors",
    "ensure_annotation_store",
    "read_reviewed",
    "write_reviewed",
    "list_integration_targets",
    "run_integration",
    "set_show_in_finder_enabled",
    "take_launch_args",
    "quit_app",
    "quit_ack",
    "resolve_wikilink",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
