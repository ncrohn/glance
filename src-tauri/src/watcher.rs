use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Watchers(pub Mutex<HashMap<String, RecommendedWatcher>>);

#[derive(Clone, serde::Serialize)]
struct FileChanged {
    path: String,
    contents: String,
}

#[derive(Clone, serde::Serialize)]
struct FileError {
    path: String,
    message: String,
}

// One save reaches notify as several events (FSEvents coalesces flags, and an
// atomic save is a create plus a rename). Wait for this much quiet before
// looking at the file, but never longer than MAX_WAIT while writes keep coming.
const SETTLE: Duration = Duration::from_millis(75);
const MAX_WAIT: Duration = Duration::from_millis(500);

/// Returns a sender whose pings are collapsed into one call of `action`, made
/// once the pings settle. The worker thread ends when the sender is dropped
/// (the watcher holding it was unwatched), without a final call.
fn debounced(settle: Duration, max_wait: Duration, action: impl Fn() + Send + 'static) -> mpsc::Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            let first = Instant::now();
            loop {
                let left = max_wait.saturating_sub(first.elapsed());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(settle.min(left)) {
                    Ok(()) => {}
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            action();
        }
    });
    tx
}

/// What a watched document looks like once its events settle.
#[derive(Debug, PartialEq)]
enum DiskState {
    Text(String),
    /// Deleted, or moved, renamed or trashed away. FSEvents reports a move as
    /// a rename (Create/Modify(Name)), never a Remove, so absence is judged by
    /// reading, not by the event kind.
    Missing,
    /// Present but not readable as text: not UTF-8, or no permission.
    Unreadable(String),
}

fn disk_state(path: &Path) -> DiskState {
    match std::fs::read(path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => DiskState::Text(text),
            Err(_) => DiskState::Unreadable("it is no longer valid UTF-8 text".into()),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DiskState::Missing,
        Err(e) => DiskState::Unreadable(e.to_string()),
    }
}

/// Watch `path` and report its settled state after each burst of changes.
/// Delete-then-recreate ends in `Text`, since only the final state is read.
fn watch_document(
    path: PathBuf,
    report: impl Fn(DiskState) + Send + 'static,
) -> notify::Result<RecommendedWatcher> {
    let target = path.clone();
    let ping = debounced(SETTLE, MAX_WAIT, move || report(disk_state(&target)));
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if !matches!(event.kind, EventKind::Access(_)) {
                let _ = ping.send(());
            }
        }
    })?;
    watcher.watch(&path, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

fn watch_store(path: &Path, changed: impl Fn() + Send + 'static) -> notify::Result<RecommendedWatcher> {
    let ping = debounced(SETTLE, MAX_WAIT, changed);
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                let _ = ping.send(());
            }
        }
    })?;
    watcher.watch(path, RecursiveMode::NonRecursive)?;
    Ok(watcher)
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
    let path2 = path.clone();
    let watcher = watch_document(PathBuf::from(&path), move |state| {
        let path = path2.clone();
        let _ = match state {
            DiskState::Text(contents) => app.emit("file-changed", FileChanged { path, contents }),
            DiskState::Missing => app.emit("file-removed", path),
            DiskState::Unreadable(message) => app.emit("file-error", FileError { path, message }),
        };
    })
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

#[tauri::command]
pub fn watch_annotations(
    store_path: String,
    doc_path: String,
    app: AppHandle,
    watchers: State<Watchers>,
) -> Result<(), String> {
    let mut map = watchers.0.lock().map_err(|e| e.to_string())?;
    if map.contains_key(&store_path) {
        return Ok(());
    }
    let watcher = watch_store(Path::new(&store_path), move || {
        let _ = app.emit("annotations-changed", doc_path.clone());
    })
    .map_err(|e| e.to_string())?;
    map.insert(store_path, watcher);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn a_burst_of_pings_runs_the_action_once() {
        let count = Arc::new(Mutex::new(0));
        let c = count.clone();
        let tx = debounced(Duration::from_millis(40), Duration::from_secs(5), move || *c.lock().unwrap() += 1);
        for _ in 0..20 {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(*count.lock().unwrap(), 1);
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(*count.lock().unwrap(), 2);
    }

    #[test]
    fn steady_pings_still_run_the_action_by_the_max_wait() {
        let count = Arc::new(Mutex::new(0));
        let c = count.clone();
        let tx = debounced(Duration::from_millis(50), Duration::from_millis(150), move || *c.lock().unwrap() += 1);
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(400) {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(*count.lock().unwrap() >= 2);
    }

    #[test]
    fn dropping_the_sender_cancels_a_pending_action() {
        let count = Arc::new(Mutex::new(0));
        let c = count.clone();
        let tx = debounced(Duration::from_millis(50), Duration::from_secs(5), move || *c.lock().unwrap() += 1);
        tx.send(()).unwrap();
        drop(tx);
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(*count.lock().unwrap(), 0);
    }

    #[test]
    fn disk_state_tells_text_missing_and_unreadable_apart() {
        let dir = scratch("state");
        let f = dir.join("doc.md");
        std::fs::write(&f, "hi").unwrap();
        assert_eq!(disk_state(&f), DiskState::Text("hi".into()));
        std::fs::write(&f, [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(disk_state(&f), DiskState::Unreadable(_)));
        std::fs::remove_file(&f).unwrap();
        assert_eq!(disk_state(&f), DiskState::Missing);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glance-watch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    type Log = Arc<Mutex<Vec<DiskState>>>;

    // Real FSEvents round trips, as in the audit's notify harness.
    fn watched(name: &str) -> (PathBuf, PathBuf, Log, RecommendedWatcher) {
        let dir = scratch(name);
        let f = dir.join("doc.md");
        std::fs::write(&f, "old\n").unwrap();
        // Let the creation's own events age out of FSEvents' history.
        std::thread::sleep(Duration::from_millis(1200));
        let log: Log = Arc::default();
        let l = log.clone();
        let w = watch_document(f.clone(), move |s| l.lock().unwrap().push(s)).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        log.lock().unwrap().clear();
        (dir, f, log, w)
    }

    fn settle() {
        std::thread::sleep(Duration::from_millis(1500));
    }

    #[test]
    fn a_moved_file_is_reported_missing() {
        let (dir, f, log, _w) = watched("moved");
        std::fs::rename(&f, dir.join("moved.md")).unwrap();
        settle();
        assert_eq!(log.lock().unwrap().last(), Some(&DiskState::Missing));
        std::fs::rename(dir.join("moved.md"), &f).unwrap();
        settle();
        assert_eq!(log.lock().unwrap().last(), Some(&DiskState::Text("old\n".into())));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn delete_then_recreate_ends_changed() {
        let (dir, f, log, _w) = watched("recreate");
        std::fs::remove_file(&f).unwrap();
        std::fs::write(&f, "new\n").unwrap();
        settle();
        assert_eq!(log.lock().unwrap().last(), Some(&DiskState::Text("new\n".into())));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn back_to_back_writes_report_once_with_the_final_text() {
        let (dir, f, log, _w) = watched("burst");
        for i in 0..10 {
            std::fs::write(&f, format!("burst {i}\n")).unwrap();
        }
        settle();
        assert_eq!(*log.lock().unwrap(), vec![DiskState::Text("burst 9\n".into())]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_that_stops_being_utf8_is_reported() {
        let (dir, f, log, _w) = watched("binary");
        std::fs::write(&f, [0xff, 0xfe, 0x00, 0x41]).unwrap();
        settle();
        assert!(matches!(log.lock().unwrap().last(), Some(DiskState::Unreadable(_))));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
