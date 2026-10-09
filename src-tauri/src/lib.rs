pub mod anchor;
pub mod annotations;
pub mod reviewed;
mod cli;
mod cli_install;
mod commands;
mod setup;
mod watcher;
mod wikilink;

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// A reload (including the one after a WebContent crash) replaces the page and
/// its listeners, so files must buffer again until the new page drains them.
fn reset_on_page_load(ready: &FrontendReady, event: tauri::webview::PageLoadEvent) {
    if event == tauri::webview::PageLoadEvent::Started {
        ready.0.store(false, Ordering::SeqCst);
    }
}

/// Handle to File → Show in Finder, so the frontend can grey it out when there's
/// no revealable document (HIG: disable, don't silently no-op). Only the
/// frontend knows which tab is active, hence the round trip.
struct ShowInFinderItem(MenuItem<tauri::Wry>);

#[tauri::command]
fn set_show_in_finder_enabled(
    item: tauri::State<ShowInFinderItem>,
    enabled: bool,
) -> Result<(), String> {
    item.0.set_enabled(enabled).map_err(|e| e.to_string())
}

/// Emits straight to the frontend once its listener is live, otherwise buffers
/// for `take_launch_args`. The ready check runs under the buffer's lock, as
/// does the drain, so a path can't land in the buffer just after it was drained
/// (single-instance forwards arrive on a tokio thread, not the main thread).
fn deliver_open_files(app: &tauri::AppHandle, paths: Vec<String>) {
    let buf = app.state::<LaunchArgs>();
    let mut stored = buf.0.lock().unwrap_or_else(|e| e.into_inner());
    if app.state::<FrontendReady>().0.load(Ordering::SeqCst) {
        drop(stored);
        for p in paths {
            let _ = app.emit("open-file", p);
        }
    } else {
        stored.extend(paths);
    }
}

/// Set by `quit_app` once the frontend has dealt with unsaved edits, so the
/// window close that follows isn't held again.
#[derive(Default)]
struct QuitApproved(AtomicBool);

#[derive(Debug, PartialEq)]
enum QuitStep {
    Proceed,
    AskFrontend,
}

/// Cmd+Q and the window's close button go through the frontend, which knows
/// about unsaved edits. Before the frontend is up there is nothing to save
/// and no listener to ask, so quit goes ahead.
fn quit_step(frontend_ready: bool, approved: bool) -> QuitStep {
    if approved || !frontend_ready {
        QuitStep::Proceed
    } else {
        QuitStep::AskFrontend
    }
}

fn current_quit_step(app: &tauri::AppHandle) -> QuitStep {
    quit_step(
        app.state::<FrontendReady>().0.load(Ordering::SeqCst),
        app.state::<QuitApproved>().0.load(Ordering::SeqCst),
    )
}

/// Counts quit requests sent to the frontend and the last one it acknowledged.
/// If the page has crashed or hung, no acknowledgement comes back and quit goes
/// ahead anyway, so Glance never needs a Force Quit.
#[derive(Default)]
struct QuitRequests {
    sent: AtomicU64,
    acked: AtomicU64,
}

const QUIT_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

fn ask_frontend_to_quit(app: &tauri::AppHandle) {
    let seq = app.state::<QuitRequests>().sent.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit("quit-requested", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_ACK_TIMEOUT);
        if app.state::<QuitRequests>().acked.load(Ordering::SeqCst) < seq {
            app.exit(0);
        }
    });
}

/// Sent by the frontend as soon as it receives `quit-requested`, before any
/// unsaved-edits prompt, to show it is alive and handling the quit.
#[tauri::command]
fn quit_ack(requests: tauri::State<QuitRequests>) {
    let sent = requests.sent.load(Ordering::SeqCst);
    requests.acked.fetch_max(sent, Ordering::SeqCst);
}

/// The frontend's go-ahead after `quit-requested`: nothing was dirty, or the
/// user saved or let go of every unsaved doc.
#[tauri::command]
fn quit_app(app: tauri::AppHandle, approved: tauri::State<QuitApproved>) {
    approved.0.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn take_launch_args(
    state: tauri::State<LaunchArgs>,
    ready: tauri::State<FrontendReady>,
) -> Vec<String> {
    let mut paths = state.0.lock().unwrap_or_else(|e| e.into_inner());
    ready.0.store(true, Ordering::SeqCst);
    std::mem::take(&mut *paths)
}

/// The single-instance plugin checks for a running Glance and claims the socket
/// as two separate steps, so a burst of cold launches (an agent calling `mdview`
/// in a loop) all see "none running" and each become a full app. Holding an
/// exclusive lock across the plugin's setup makes that check-and-claim one step:
/// later launches wait, then find the socket and forward their files.
///
/// Any failure launches without the lock (the old behavior) rather than not
/// launching. The wait is bounded so a stuck holder can't block every launch.
#[cfg(target_os = "macos")]
fn acquire_launch_lock(identifier: &str) -> Option<std::fs::File> {
    use fs2::FileExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::time::{Duration, Instant};

    const WAIT: Duration = Duration::from_secs(10);
    let name = identifier.replace(['.', '-'], "_");
    let path = format!("/tmp/{name}_launch.lock");
    // flock works on a read-only fd, so another user can share a lock file
    // the first user created. O_NOFOLLOW refuses a planted symlink.
    let open = |create: bool| {
        let mut opts = std::fs::OpenOptions::new();
        if create {
            opts.write(true).create(true).mode(0o644);
        } else {
            opts.read(true);
        }
        opts.custom_flags(libc::O_NOFOLLOW).open(&path)
    };
    let file = match open(false) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => open(true),
        other => other,
    };
    let file = match file {
        Ok(f) => f,
        Err(e) => {
            eprintln!("glance: can't open {path}, launching without it: {e}");
            return None;
        }
    };
    let contended = fs2::lock_contended_error().raw_os_error();
    let deadline = Instant::now() + WAIT;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Some(file),
            Err(e) if e.raw_os_error() == contended && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                eprintln!("glance: no launch lock on {path}, launching without it: {e}");
                return None;
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn acquire_launch_lock(_identifier: &str) -> Option<std::fs::File> {
    None
}

/// Keeps the window on Glance's own pages. A link the frontend's click handler
/// misses would otherwise replace the whole UI with a web page; web URLs go to
/// the default browser instead, and anything else is refused.
fn navigation_guard() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let own = url.scheme() == "tauri"
                || url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions) && url.host_str() == Some("localhost"));
            if !own && matches!(url.scheme(), "http" | "https" | "mailto") {
                use tauri_plugin_opener::OpenerExt;
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
            }
            own
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let launch_lock = acquire_launch_lock(&context.config().identifier);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // In a cold burst these arrive before the frontend's listener
            // exists, so they go through the same buffer as Finder opens.
            let cwd_path = Path::new(&cwd);
            let paths = cli::md_paths_from_argv(&argv, cwd_path)
                .iter()
                .map(|raw| cli::to_abs(raw, cwd_path))
                .collect();
            deliver_open_files(app, paths);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .manage(watcher::Watchers::default())
        .manage(LaunchArgs::default())
        .manage(FrontendReady::default())
        .manage(QuitApproved::default())
        .manage(QuitRequests::default())
        .on_page_load(|webview, payload| {
            reset_on_page_load(&webview.app_handle().state::<FrontendReady>(), payload.event());
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if current_quit_step(app) == QuitStep::AskFrontend {
                    api.prevent_close();
                    ask_frontend_to_quit(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::resolve_open_target,
            commands::canonicalize_path,
            watcher::watch_file,
            watcher::unwatch_file,
            watcher::watch_annotations,
            annotations::read_annotations,
            annotations::add_annotation,
            annotations::remove_annotation,
            annotations::update_annotation,
            annotations::add_reply,
            annotations::resolve_anchors,
            annotations::ensure_annotation_store,
            reviewed::read_reviewed,
            reviewed::write_reviewed,
            setup::list_integration_targets,
            setup::run_integration,
            set_show_in_finder_enabled,
            take_launch_args,
            quit_app,
            quit_ack,
            wikilink::resolve_wikilink,
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
                "quit" => match current_quit_step(app) {
                    QuitStep::Proceed => app.exit(0),
                    QuitStep::AskFrontend => ask_frontend_to_quit(app),
                },
                "save_file" => {
                    let _ = app.emit("menu-save", ());
                }
                "show_in_finder" => {
                    // The frontend owns which tab is active, so it answers back
                    // with the path via `reveal_in_finder`.
                    let _ = app.emit("show-in-finder", ());
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
                "whats_new" => {
                    let _ = app.emit("show-whats-new", ());
                }
                "check_for_updates" => {
                    let _ = app.emit("check-for-updates", ());
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
            let whats_new_item = MenuItem::with_id(
                handle,
                "whats_new",
                "What's New…",
                true,
                None::<&str>,
            )?;
            let check_updates_item = MenuItem::with_id(
                handle,
                "check_for_updates",
                "Check for Updates…",
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
            // Custom, not PredefinedMenuItem::quit: the predefined item sends
            // terminate: straight to NSApp, which nothing here can intercept,
            // so unsaved edits would be dropped without a prompt.
            let quit_item = MenuItem::with_id(
                handle,
                "quit",
                "Quit Glance",
                true,
                Some("CmdOrCtrl+Q"),
            )?;
            let app_menu = Submenu::with_items(
                handle,
                "Glance",
                true,
                &[
                    &about_item,
                    &whats_new_item,
                    &check_updates_item,
                    &PredefinedMenuItem::separator(handle)?,
                    &install_cli_item,
                    &remove_cli_item,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &quit_item,
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
            // Starts disabled: at launch no tab is open yet. The frontend's
            // render() enables it as soon as there's a doc on disk to reveal.
            let show_in_finder_item = MenuItem::with_id(
                handle,
                "show_in_finder",
                "Show in Finder",
                false,
                Some("CmdOrCtrl+Alt+R"),
            )?;
            app.manage(ShowInFinderItem(show_in_finder_item.clone()));
            let file_menu = Submenu::with_items(
                handle,
                "File",
                true,
                &[
                    &new_item,
                    &open_item,
                    // Grouped with Open — it's a "where does this document live"
                    // command, and the menu's tail is conventionally Print's.
                    &show_in_finder_item,
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
            for raw in cli::md_paths_from_argv(&argv, &cwd) {
                stored.push(cli::to_abs(&raw, &cwd));
            }
            Ok(())
        })
        .build(context)
        .expect("error while running Glance");
    // Plugins initialize inside build(): by now this process has either
    // forwarded its files and exited, or bound the single-instance socket.
    drop(launch_lock);
    app.run(|app, event| {
        // macOS delivers files opened from Finder ("Open With", double-click)
        // as an Apple Event, not argv.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            let paths: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                // As given: the frontend resolves it, and the store needs the
                // old spelling to move comments filed under it.
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            deliver_open_files(app, paths);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_asks_the_frontend_only_once_it_is_up_and_until_it_approves() {
        assert_eq!(quit_step(false, false), QuitStep::Proceed);
        assert_eq!(quit_step(true, false), QuitStep::AskFrontend);
        assert_eq!(quit_step(true, true), QuitStep::Proceed);
    }

    #[test]
    fn a_page_load_makes_open_files_buffer_again() {
        use tauri::webview::PageLoadEvent;
        let ready = FrontendReady(AtomicBool::new(true));
        reset_on_page_load(&ready, PageLoadEvent::Finished);
        assert!(ready.0.load(Ordering::SeqCst));
        reset_on_page_load(&ready, PageLoadEvent::Started);
        assert!(!ready.0.load(Ordering::SeqCst));
    }
}
