pub mod anchor;
pub mod annotations;
mod cli;
mod cli_install;
mod commands;
mod setup;
mod watcher;

use std::path::Path;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct LaunchArgs(std::sync::Mutex<Vec<String>>);

fn emit_open_files(app: &tauri::AppHandle, argv: &[String], cwd: &Path) {
    for raw in cli::md_paths_from_argv(argv) {
        let abs = cli::to_abs(&raw, cwd);
        let _ = app.emit("open-file", abs);
    }
}

#[tauri::command]
fn take_launch_args(state: tauri::State<LaunchArgs>) -> Vec<String> {
    let mut paths = state.0.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *paths)
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
        .manage(LaunchArgs::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            watcher::watch_file,
            watcher::unwatch_file,
            watcher::watch_annotations,
            annotations::read_annotations,
            annotations::write_annotations,
            annotations::resolve_anchors,
            annotations::ensure_annotation_store,
            take_launch_args,
        ])
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "setup_integration" {
                let results = setup::setup_claude_integration();
                let _ = app.emit("setup-result", results);
            }
        })
        .setup(|app| {
            let handle = app.handle();

            let install_cli_item = MenuItem::with_id(
                handle,
                "setup_integration",
                "Set up Claude Integration…",
                true,
                None::<&str>,
            )?;
            let app_menu = Submenu::with_items(
                handle,
                "Glance",
                true,
                &[
                    &install_cli_item,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?;
            let edit_menu = Submenu::with_items(
                handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(handle, None)?,
                    &PredefinedMenuItem::redo(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::cut(handle, None)?,
                    &PredefinedMenuItem::copy(handle, None)?,
                    &PredefinedMenuItem::paste(handle, None)?,
                    &PredefinedMenuItem::select_all(handle, None)?,
                ],
            )?;
            let menu = Menu::with_items(handle, &[&app_menu, &edit_menu])?;
            app.set_menu(menu)?;

            let argv: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
            let launch_args = app.state::<LaunchArgs>();
            let mut stored = launch_args.0.lock().unwrap_or_else(|e| e.into_inner());
            for raw in cli::md_paths_from_argv(&argv) {
                stored.push(cli::to_abs(&raw, &cwd));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Glance");
}
