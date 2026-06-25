use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Watchers(pub Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Clone, serde::Serialize)]
struct FileChanged {
    path: String,
    contents: String,
}

#[tauri::command]
pub fn watch_file(
    path: String,
    app: AppHandle,
    watchers: State<Watchers>,
) -> Result<(), String> {
    let mut map = watchers.0.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&path) {
        return Ok(());
    }
    let app2 = app.clone();
    let path2 = path.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                if let Ok(contents) = std::fs::read_to_string(&path2) {
                    let _ = app2.emit(
                        "file-changed",
                        FileChanged {
                            path: path2.clone(),
                            contents,
                        },
                    );
                }
            }
            if matches!(event.kind, EventKind::Remove(_)) {
                let _ = app2.emit("file-removed", path2.clone());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    map.insert(path, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_file(path: String, watchers: State<Watchers>) -> Result<(), String> {
    let mut map = watchers.0.lock().map_err(|e| e.to_string())?;
    map.remove(&path); // dropping the watcher unwatches it
    Ok(())
}
