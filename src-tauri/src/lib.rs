mod cli;
mod commands;
mod watcher;

use std::path::Path;
use tauri::{Emitter, Manager};

fn emit_open_files(app: &tauri::AppHandle, argv: &[String], cwd: &Path) {
    for raw in cli::md_paths_from_argv(argv) {
        let abs = cli::to_abs(&raw, cwd);
        let _ = app.emit("open-file", abs);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let cwd_path = Path::new(&cwd);
            emit_open_files(app, &argv, cwd_path);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(watcher::Watchers::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            watcher::watch_file,
            watcher::unwatch_file,
        ])
        .setup(|app| {
            let argv: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
            emit_open_files(&app.handle(), &argv, &cwd);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Glance");
}
