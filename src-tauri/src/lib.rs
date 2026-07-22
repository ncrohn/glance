pub mod anchor;
pub mod annotations;
pub mod reviewed;
mod cli;
mod cli_install;
mod commands;
mod setup;
mod watcher;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct LaunchArgs(std::sync::Mutex<Vec<String>>);

/// Set once the frontend has drained the launch args (i.e. its `open-file`
/// listener is live). Files handed to us by macOS before this — a cold Finder
/// "Open With" — are buffered into `LaunchArgs` instead of emitted (an emit
/// would be lost with no listener yet).
#[derive(Default)]
struct FrontendReady(AtomicBool);

fn emit_open_files(app: &tauri::AppHandle, argv: &[String], cwd: &Path) {
    for raw in cli::md_paths_from_argv(argv) {
        let abs = cli::to_abs(&raw, cwd);
        let _ = app.emit("open-file", abs);
    }
}

#[tauri::command]
fn take_launch_args(
    state: tauri::State<LaunchArgs>,
    ready: tauri::State<FrontendReady>,
) -> Vec<String> {
    ready.0.store(true, Ordering::SeqCst);
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
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher::Watchers::default())
        .manage(LaunchArgs::default())
        .manage(FrontendReady::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            watcher::watch_file,
            watcher::unwatch_file,
            watcher::watch_annotations,
            annotations::read_annotations,
            annotations::add_annotation,
            annotations::remove_annotation,
            annotations::resolve_anchors,
            annotations::ensure_annotation_store,
            reviewed::read_reviewed,
            reviewed::write_reviewed,
            setup::list_integration_targets,
            setup::run_integration,
            take_launch_args,
        ])
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "new_file" => {
                    use tauri_plugin_dialog::DialogExt;
                    let app2 = app.clone();
                    app.dialog()
                        .file()
                        .add_filter("Markdown", &["md", "markdown"])
                        .set_file_name("Untitled.md")
                        .save_file(move |path| {
                            if let Some(path) = path {
                                let p = path.to_string();
                                // Create the empty file so the open flow (which reads
                                // from disk) has something to open, then reuse it.
                                if std::fs::write(&p, "").is_ok() {
                                    let _ = app2.emit("open-file", p);
                                }
                            }
                        });
                }
                "open_file" => {
                    use tauri_plugin_dialog::DialogExt;
                    let app2 = app.clone();
                    app.dialog()
                        .file()
                        .add_filter("Markdown", &["md", "markdown"])
                        .pick_file(move |path| {
                            if let Some(path) = path {
                                // Reuse the existing open-file flow (onOpenFile → openPath).
                                let _ = app2.emit("open-file", path.to_string());
                            }
                        });
                }
                "close_tab" => {
                    let _ = app.emit("close-active-tab", ());
                }
                "save_file" => {
                    let _ = app.emit("menu-save", ());
                }
                "select_all" => {
                    let _ = app.emit("menu-select-all", ());
                }
                "setup_integration" => {
                    let _ = app.emit("show-integration-picker", "setup");
                }
                "remove_integration" => {
                    let _ = app.emit("show-integration-picker", "remove");
                }
                "about_glance" => {
                    let _ = app.emit("show-about", ());
                }
                "open_theme" => {
                    let _ = app.emit("show-theme", ());
                }
                _ => {}
            }
        })
        .setup(|app| {
            let handle = app.handle();

            let about_item = MenuItem::with_id(
                handle,
                "about_glance",
                "About Glance",
                true,
                None::<&str>,
            )?;
            let install_cli_item = MenuItem::with_id(
                handle,
                "setup_integration",
                "Set up AI Integration…",
                true,
                None::<&str>,
            )?;
            let remove_cli_item = MenuItem::with_id(
                handle,
                "remove_integration",
                "Remove AI Integration…",
                true,
                None::<&str>,
            )?;
            let app_menu = Submenu::with_items(
                handle,
                "Glance",
                true,
                &[
                    &about_item,
                    &PredefinedMenuItem::separator(handle)?,
                    &install_cli_item,
                    &remove_cli_item,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?;
            let new_item = MenuItem::with_id(
                handle,
                "new_file",
                "New…",
                true,
                Some("CmdOrCtrl+N"),
            )?;
            let open_item = MenuItem::with_id(
                handle,
                "open_file",
                "Open…",
                true,
                Some("CmdOrCtrl+O"),
            )?;
            let save_item = MenuItem::with_id(
                handle,
                "save_file",
                "Save",
                true,
                Some("CmdOrCtrl+S"),
            )?;
            let close_tab_item = MenuItem::with_id(
                handle,
                "close_tab",
                "Close Tab",
                true,
                Some("CmdOrCtrl+W"),
            )?;
            let file_menu = Submenu::with_items(
                handle,
                "File",
                true,
                &[
                    &new_item,
                    &open_item,
                    &PredefinedMenuItem::separator(handle)?,
                    &close_tab_item,
                    &save_item,
                ],
            )?;
            // Select All is a custom item (not the predefined one) so Cmd+A is
            // routed to the frontend. The native selectAll: acts on the focused
            // view's DOM, which for the source-mode editor (CodeMirror) is only
            // the virtualized/visible lines — so it would select just what's on
            // screen. The frontend handler instead runs CodeMirror's full-document
            // select-all, and selects the whole rendered view in read mode.
            let select_all_item = MenuItem::with_id(
                handle,
                "select_all",
                "Select All",
                true,
                Some("CmdOrCtrl+A"),
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
                    &select_all_item,
                ],
            )?;
            let theme_item = MenuItem::with_id(
                handle,
                "open_theme",
                "Theme…",
                true,
                None::<&str>,
            )?;
            let view_menu = Submenu::with_items(handle, "View", true, &[&theme_item])?;
            let menu = Menu::with_items(handle, &[&app_menu, &file_menu, &edit_menu, &view_menu])?;
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
        .build(tauri::generate_context!())
        .expect("error while running Glance")
        .run(|app, event| {
            // macOS delivers files opened from Finder ("Open With", double-click)
            // as an Apple Event, not argv. If the frontend is already listening,
            // emit straight to it; otherwise (cold launch) buffer into LaunchArgs
            // so the frontend picks them up when it drains launch args on start.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                if app.state::<FrontendReady>().0.load(Ordering::SeqCst) {
                    for p in paths {
                        let _ = app.emit("open-file", p);
                    }
                } else {
                    let buf = app.state::<LaunchArgs>();
                    let mut stored = buf.0.lock().unwrap_or_else(|e| e.into_inner());
                    stored.extend(paths);
                }
            }
        });
}
