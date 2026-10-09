use crate::anchor::{resolve_anchor, Annotation, LineHint, Reply, Resolution};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AnnotationStore {
    #[serde(rename = "docPath")]
    pub doc_path: String,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    #[serde(default, rename = "nextNumber")]
    pub next_number: u32,
    /// Top-level fields this version doesn't know, kept across rewrites.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub fn sha1_hex(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn store_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".glance").join("annotations"))
}

/// The spelling a doc's store is keyed by, so every spelling of one file shares
/// one store: a symlink, `/tmp` vs `/private/tmp`, a case variant, `./`, `//`.
/// An existing file is keyed by its canonical path. A missing one is keyed by
/// its lexically normalized absolute path with the deepest existing ancestor
/// canonicalized, which is the key it gets once it is created.
pub fn doc_key(doc_path: &str) -> String {
    if let Ok(c) = std::fs::canonicalize(doc_path) {
        return c.to_string_lossy().into_owned();
    }
    let lexical = PathBuf::from(crate::cli::to_abs(doc_path, &cwd()));
    let mut missing = Vec::new();
    let mut cur = lexical.as_path();
    loop {
        if let Ok(mut c) = std::fs::canonicalize(cur) {
            for name in missing.iter().rev() {
                c.push(name);
            }
            return c.to_string_lossy().into_owned();
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name);
                cur = parent;
            }
            _ => return lexical.to_string_lossy().into_owned(),
        }
    }
}

fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

/// Keys a doc's data was filed under before `doc_key`: the caller's raw
/// spelling, and the lexically normalized absolute path the app always passed.
pub(crate) fn legacy_keys(doc_path: &str, key: &str) -> Vec<String> {
    let mut out = vec![doc_path.to_string()];
    let abs = crate::cli::to_abs(doc_path, &cwd());
    if abs != doc_path {
        out.push(abs);
    }
    out.retain(|k| k != key);
    out
}

fn store_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.json", sha1_hex(key)))
}

pub fn store_path_for(doc_path: &str) -> Option<PathBuf> {
    store_dir().map(|d| store_file(&d, &doc_key(doc_path)))
}

fn has_legacy_store(dir: &Path, doc_path: &str, key: &str) -> bool {
    legacy_keys(doc_path, key).iter().any(|k| store_file(dir, k).exists())
}

/// Fold any store filed under a legacy key into the doc's store, holding both
/// locks; the caller already holds the lock on the doc's store. A legacy store
/// moves over whole when the doc has none yet. Otherwise its annotations are
/// merged in, skipping ids already present and renumbering any whose number is
/// taken. The legacy file is removed only after the merged store is written,
/// and a damaged legacy store is an error that leaves both files alone.
fn migrate_legacy(dir: &Path, doc_path: &str, key: &str) -> Result<(), String> {
    let path = store_file(dir, key);
    for legacy in legacy_keys(doc_path, key) {
        let old = store_file(dir, &legacy);
        if !old.exists() {
            continue;
        }
        with_store_lock(&old, || {
            if !old.exists() {
                return Ok(());
            }
            let from = read_store_file(&old, key)?;
            let merged = if path.exists() {
                let mut into = read_store_file(&path, key)?;
                merge_store(&mut into, from);
                into
            } else {
                from
            };
            write_store_at(&path, &merged)?;
            std::fs::remove_file(&old)
                .map_err(|e| format!("Couldn't remove the old annotation store {}: {e}", old.display()))
        })?;
    }
    Ok(())
}

fn merge_store(into: &mut AnnotationStore, from: AnnotationStore) {
    for mut a in from.annotations {
        if into.annotations.iter().any(|b| b.id == a.id) {
            continue;
        }
        if into.annotations.iter().any(|b| b.number == a.number) {
            a.number = 0;
        }
        push_annotation(into, a);
    }
    into.next_number = into.next_number.max(from.next_number);
    for (k, v) in from.extra {
        into.extra.entry(k).or_insert(v);
    }
}

/// Load a doc's store. A store that doesn't exist yet is empty. One that exists
/// but can't be read or parsed is an error, never an empty store: a caller that
/// took it for "no comments" would show nothing, and a mutation would write the
/// empty store over every comment in the file.
pub fn read_store(doc_path: &str) -> Result<AnnotationStore, String> {
    let key = doc_key(doc_path);
    let Some(dir) = store_dir() else {
        return Ok(AnnotationStore { doc_path: key, ..Default::default() });
    };
    let path = store_file(&dir, &key);
    if has_legacy_store(&dir, doc_path, &key) {
        with_store_lock(&path, || migrate_legacy(&dir, doc_path, &key))?;
    }
    read_store_file(&path, &key)
}

/// Parse the store at `path`, reporting `key` as its doc path whatever spelling
/// the file recorded.
fn read_store_file(path: &Path, key: &str) -> Result<AnnotationStore, String> {
    let empty = || AnnotationStore { doc_path: key.to_string(), ..Default::default() };
    let mut store = match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => empty(),
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            format!(
                "The annotation store {} is damaged ({e}). Glance won't change it until it is fixed or moved aside.",
                path.display()
            )
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => empty(),
        Err(e) => return Err(format!("Couldn't read the annotation store {}: {e}", path.display())),
    };
    store.doc_path = key.to_string();
    backfill_numbers(&mut store);
    Ok(store)
}

/// Give every unnumbered annotation a permanent number and push `next_number`
/// past everything in use. Idempotent, so it runs on every read: stores written
/// before numbers existed pick them up in creation order, and the file gains
/// `nextNumber` on its next mutation.
pub fn backfill_numbers(store: &mut AnnotationStore) {
    let mut max = store.annotations.iter().map(|a| a.number).max().unwrap_or(0);
    let mut unnumbered: Vec<usize> = (0..store.annotations.len())
        .filter(|&i| store.annotations[i].number == 0)
        .collect();
    unnumbered.sort_by(|&x, &y| {
        let (a, b) = (&store.annotations[x], &store.annotations[y]);
        (&a.created_at, &a.id).cmp(&(&b.created_at, &b.id))
    });
    for i in unnumbered {
        max = max.saturating_add(1);
        store.annotations[i].number = max;
    }
    store.next_number = store.next_number.max(max.saturating_add(1));
}

pub fn write_store(store: &AnnotationStore) -> Result<(), String> {
    let path = store_path_for(&store.doc_path)
        .ok_or_else(|| "Could not determine $HOME for annotation store".to_string())?;
    write_store_at(&path, store)
}

fn write_store_at(path: &Path, store: &AnnotationStore) -> Result<(), String> {
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    write_atomic(path, json.as_bytes())
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A suffix no other call in any process will produce: pid, nanos, counter.
fn unique_suffix() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{}.{nanos}.{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Replace `path` with `bytes` so a reader or a crash sees the old file or the
/// new one, never a torn one: write a temp file in the same directory, fsync
/// it, rename it over `path`, then fsync the directory so the rename sticks.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", unique_suffix()));
    let written = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn't write {}: {e}", path.display()));
    }
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// Run `f` against the current on-disk store under an exclusive **cross-process**
/// lock, then persist the result. This is the only safe way to mutate a store:
/// both writers — the GUI (`add_annotation`/`remove_annotation` IPC) and the
/// standalone `glance-mcp` subprocess (`resolve_annotation`) — funnel every
/// change through here, so their read-modify-write cycles serialize instead of
/// silently clobbering each other's full-file writes.
///
/// A store that fails to parse is an error and is left untouched. A mutation
/// that changes nothing (an unknown id) writes nothing, and on a doc with no
/// store yet it creates no store or lock file either: `f` is first tried on
/// the empty store without the lock, and only runs again under the lock if it
/// changed something.
pub fn mutate_store<T>(
    doc_path: &str,
    mut f: impl FnMut(&mut AnnotationStore) -> T,
) -> Result<T, String> {
    let dir = store_dir().ok_or_else(|| "Could not determine $HOME for annotation store".to_string())?;
    let key = doc_key(doc_path);
    let store_path = store_file(&dir, &key);
    if !store_path.exists() && !has_legacy_store(&dir, doc_path, &key) {
        let mut probe = read_store_file(&store_path, &key)?;
        let before = probe.clone();
        let out = f(&mut probe);
        if probe == before {
            return Ok(out);
        }
    }
    with_store_lock(&store_path, || {
        migrate_legacy(&dir, doc_path, &key)?;
        let mut store = read_store_file(&store_path, &key)?;
        let before = store.clone();
        let out = f(&mut store);
        if store != before {
            write_store_at(&store_path, &store)?;
        }
        Ok(out)
    })
}

/// Run `f` holding the store's exclusive cross-process lock. The lock is on a
/// stable sibling file (never renamed), so it is held across a read and the
/// temp-file+rename write. flock on the store file itself wouldn't work: the
/// rename swaps the inode out from under it.
fn with_store_lock<T>(store_path: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    with_store_lock_within(store_path, LOCK_WAIT, f)
}

/// How long a mutation waits for another process to release a store's lock
/// before giving up. Holders keep it for milliseconds; one that keeps it
/// longer is stuck, and waiting forever would hang the caller with it.
const LOCK_WAIT: Duration = Duration::from_secs(5);

fn with_store_lock_within<T>(
    store_path: &Path,
    wait: Duration,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if let Some(parent) = store_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let lock_path = store_path.with_extension("json.lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false) // only used as a flock handle; never written to
        .open(&lock_path)
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + wait;
    let contended = fs2::lock_contended_error().raw_os_error();
    loop {
        match lock_file.try_lock_exclusive() {
            Ok(()) => break,
            Err(e) if e.raw_os_error() == contended && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) if e.raw_os_error() == contended => {
                return Err(format!(
                    "The annotation store {} is locked by another process. Try again in a moment.",
                    store_path.display()
                ));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = f();
    let _ = lock_file.unlock(); // also released when lock_file drops
    out
}

#[tauri::command]
pub fn read_annotations(path: String) -> Result<AnnotationStore, String> {
    read_store(&path)
}

/// Append one annotation to the store under lock, giving it the store's next
/// number. An annotation that already carries a number (an undo re-add) keeps
/// it. Replaces the old whole-store write so a concurrent `resolve_annotation`
/// from glance-mcp can't be lost.
#[tauri::command]
pub fn add_annotation(doc_path: String, annotation: Annotation) -> Result<(), String> {
    mutate_store(&doc_path, move |s| push_annotation(s, annotation.clone()))
}

/// Body of `add_annotation`, shared with glance-mcp: backfill, assign the
/// store's next number when the annotation has none, bump `next_number`, push.
pub fn push_annotation(store: &mut AnnotationStore, mut a: Annotation) {
    backfill_numbers(store);
    if a.number == 0 {
        a.number = store.next_number;
    }
    store.next_number = store.next_number.max(a.number.saturating_add(1));
    store.annotations.push(a);
}

/// Short annotation id: the first 8 hex chars of `sha1_hex(seed)`.
pub fn new_id(seed: &str) -> String {
    sha1_hex(seed)[..8].to_string()
}

/// A short id that differs on every call, even for the same seed in the same
/// second: the seed is mixed with the pid, nanoseconds and a counter.
pub fn unique_id(seed: &str) -> String {
    new_id(&format!("{seed}\0{}", unique_suffix()))
}

/// Remove one annotation by id under lock.
#[tauri::command]
pub fn remove_annotation(doc_path: String, id: String) -> Result<(), String> {
    mutate_store(&doc_path, |s| s.annotations.retain(|a| a.id != id))
}

/// Fields the GUI may change on a stored annotation. Every `Some` is applied;
/// `clear_resolution` drops both resolved fields (a reopen), since a plain
/// `Option` can't express "set to none" over IPC. The anchor fields (`quote`,
/// `prefix`, `suffix`, `line_hint`) are what a re-anchor rewrites.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct AnnotationPatch {
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "resolvedBy")]
    pub resolved_by: Option<String>,
    #[serde(default, rename = "resolvedAt")]
    pub resolved_at: Option<String>,
    #[serde(default, rename = "clearResolution")]
    pub clear_resolution: bool,
    #[serde(default)]
    pub quote: Option<String>,
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub suffix: Option<String>,
    #[serde(default, rename = "lineHint")]
    pub line_hint: Option<LineHint>,
}

pub fn apply_patch(a: &mut Annotation, patch: &AnnotationPatch) {
    if let Some(note) = &patch.note {
        a.note = note.clone();
    }
    if let Some(quote) = &patch.quote {
        a.quote = quote.clone();
    }
    if let Some(prefix) = &patch.prefix {
        a.prefix = prefix.clone();
    }
    if let Some(suffix) = &patch.suffix {
        a.suffix = suffix.clone();
    }
    if let Some(hint) = &patch.line_hint {
        a.line_hint = hint.clone();
    }
    if let Some(status) = &patch.status {
        a.status = status.clone();
    }
    if let Some(by) = &patch.resolved_by {
        a.resolved_by = Some(by.clone());
    }
    if let Some(at) = &patch.resolved_at {
        a.resolved_at = Some(at.clone());
    }
    if patch.clear_resolution {
        a.resolved_by = None;
        a.resolved_at = None;
    }
}

/// Patch one annotation by id under lock. Errors when the id is not in the store.
#[tauri::command]
pub fn update_annotation(doc_path: String, id: String, patch: AnnotationPatch) -> Result<(), String> {
    let found = mutate_store(&doc_path, |s| match s.annotations.iter_mut().find(|a| a.id == id) {
        Some(a) => {
            apply_patch(a, &patch);
            true
        }
        None => false,
    })?;
    if found {
        Ok(())
    } else {
        Err(format!("no annotation '{id}'"))
    }
}

/// Append one reply to an annotation's thread. Status is untouched.
pub fn apply_reply(a: &mut Annotation, author: &str, text: &str, at: &str) {
    a.replies.push(Reply { author: author.into(), text: text.into(), created_at: at.into() });
}

/// Append a user reply to one annotation by id under lock. Errors when the id
/// is not in the store.
#[tauri::command]
pub fn add_reply(doc_path: String, id: String, text: String) -> Result<(), String> {
    let now = now_iso8601();
    let found = mutate_store(&doc_path, |s| match s.annotations.iter_mut().find(|a| a.id == id) {
        Some(a) => {
            apply_reply(a, "user", &text, &now);
            true
        }
        None => false,
    })?;
    if found {
        Ok(())
    } else {
        Err(format!("no annotation '{id}'"))
    }
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SSZ`, without a date crate.
pub fn now_iso8601() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso8601_from_epoch(secs)
}

/// Epoch seconds → `YYYY-MM-DDTHH:MM:SSZ` (proleptic Gregorian, civil-from-days).
pub fn iso8601_from_epoch(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if mo <= 2 { 1 } else { 0 };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[tauri::command]
pub fn resolve_anchors(text: String, annotations: Vec<Annotation>) -> Vec<Resolution> {
    annotations.iter().map(|a| resolve_anchor(&text, a)).collect()
}

/// Ensure the store file exists (so the OS file watcher can attach to it) and
/// return its absolute path.
#[tauri::command]
pub fn ensure_annotation_store(path: String) -> Result<String, String> {
    let dir = store_dir().ok_or_else(|| "Could not determine $HOME".to_string())?;
    let key = doc_key(&path);
    let store_path = store_file(&dir, &key);
    if !store_path.exists() || has_legacy_store(&dir, &path, &key) {
        // Create under the same lock as mutations and re-check inside it, so a
        // concurrent first mutation from another process can't be clobbered.
        with_store_lock(&store_path, || {
            migrate_legacy(&dir, &path, &key)?;
            if store_path.exists() {
                return Ok(());
            }
            write_store_at(&store_path, &read_store_file(&store_path, &key)?)
        })?;
    }
    Ok(store_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn sha1_is_deterministic_and_hex() {
        let a = sha1_hex("/Users/me/notes.md");
        let b = sha1_hex("/Users/me/notes.md");
        assert_eq!(a, b);
        assert_eq!(a.len(), 40);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    #[serial]
    fn store_path_is_under_glance_annotations() {
        std::env::set_var("HOME", "/tmp/glance-test-home");
        let p = store_path_for("/x/y.md").unwrap();
        let s = p.to_string_lossy();
        assert!(s.contains("/.glance/annotations/"));
        assert!(s.ends_with(".json"));
    }

    #[test]
    #[serial]
    fn read_missing_store_returns_empty_with_doc_path() {
        std::env::set_var("HOME", "/tmp/glance-test-home-empty");
        let store = read_store("/no/such/file.md").unwrap();
        assert_eq!(store.doc_path, "/no/such/file.md");
        assert!(store.annotations.is_empty());
    }

    fn ann(id: &str) -> Annotation {
        ann_at(id, "t")
    }

    fn ann_at(id: &str, created_at: &str) -> Annotation {
        Annotation {
            id: id.into(),
            quote: "q".into(),
            prefix: "".into(),
            suffix: "".into(),
            line_hint: crate::anchor::LineHint { start: 1, end: 1 },
            note: "n".into(),
            status: "open".into(),
            author: "user".into(),
            created_at: created_at.into(),
            number: 0,
            resolved_by: None,
            resolved_at: None,
            replies: Vec::new(),
            extra: Default::default(),
        }
    }

    fn store_of(annotations: Vec<Annotation>) -> AnnotationStore {
        AnnotationStore { doc_path: "/d.md".into(), annotations, ..Default::default() }
    }

    #[test]
    fn backfill_numbers_in_created_order_and_sets_next() {
        let mut store = store_of(vec![ann_at("b", "2026-02"), ann_at("a", "2026-01"), ann_at("c", "2026-03")]);
        backfill_numbers(&mut store);
        let nums: Vec<(String, u32)> = store.annotations.iter().map(|a| (a.id.clone(), a.number)).collect();
        assert_eq!(nums, vec![("b".into(), 2), ("a".into(), 1), ("c".into(), 3)]);
        assert_eq!(store.next_number, 4);
    }

    #[test]
    fn backfill_numbers_leaves_existing_numbers_alone() {
        let mut numbered = ann_at("old", "2026-09");
        numbered.number = 5;
        let mut store = store_of(vec![numbered, ann_at("new", "2026-01")]);
        backfill_numbers(&mut store);
        assert_eq!(store.annotations[0].number, 5);
        assert_eq!(store.annotations[1].number, 6); // after the max, despite the earlier created_at
        assert_eq!(store.next_number, 7);
        let before = store.clone();
        backfill_numbers(&mut store);
        assert_eq!(store.annotations, before.annotations);
        assert_eq!(store.next_number, 7);
    }

    #[test]
    #[serial]
    fn add_annotation_assigns_sequential_numbers_and_persists_next() {
        std::env::set_var("HOME", "/tmp/glance-test-numbers");
        let doc = "/m/numbers.md";
        let path = store_path_for(doc).unwrap();
        let _ = std::fs::remove_file(&path);
        for id in ["a", "b", "c"] {
            add_annotation(doc.into(), ann(id)).unwrap();
        }
        let store = read_store(doc).unwrap();
        let nums: Vec<u32> = store.annotations.iter().map(|a| a.number).collect();
        assert_eq!(nums, vec![1, 2, 3]);
        assert_eq!(store.next_number, 4);
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"nextNumber\": 4"), "{on_disk}");
        // A re-add that already carries a number keeps it and only bumps next_number if needed.
        let mut undo = ann("d");
        undo.number = 9;
        add_annotation(doc.into(), undo).unwrap();
        let store = read_store(doc).unwrap();
        assert_eq!(store.annotations[3].number, 9);
        assert_eq!(store.next_number, 10);
    }

    #[test]
    #[serial]
    fn old_store_without_numbers_backfills_on_read_and_keeps_them_on_add() {
        std::env::set_var("HOME", "/tmp/glance-test-backfill");
        let doc = "/m/old.md";
        let path = store_path_for(doc).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"docPath":"/m/old.md","annotations":[
            {"id":"late","quote":"q","prefix":"","suffix":"","lineHint":{"start":1,"end":1},"note":"n","status":"open","author":"user","createdAt":"2026-02"},
            {"id":"early","quote":"q","prefix":"","suffix":"","lineHint":{"start":1,"end":1},"note":"n","status":"open","author":"user","createdAt":"2026-01"}]}"#).unwrap();
        let store = read_store(doc).unwrap();
        assert_eq!(store.annotations[0].number, 2);
        assert_eq!(store.annotations[1].number, 1);
        assert_eq!(store.next_number, 3);
        add_annotation(doc.into(), ann("new")).unwrap();
        let store = read_store(doc).unwrap();
        let nums: Vec<(String, u32)> = store.annotations.iter().map(|a| (a.id.clone(), a.number)).collect();
        assert_eq!(nums, vec![("late".into(), 2), ("early".into(), 1), ("new".into(), 3)]);
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"nextNumber\": 4"));
    }

    #[test]
    fn push_annotation_numbers_in_order_and_keeps_carried_numbers() {
        let mut store = store_of(vec![]);
        push_annotation(&mut store, ann("a"));
        push_annotation(&mut store, ann("b"));
        let mut carried = ann("c");
        carried.number = 7;
        push_annotation(&mut store, carried);
        push_annotation(&mut store, ann("d"));
        let nums: Vec<u32> = store.annotations.iter().map(|a| a.number).collect();
        assert_eq!(nums, vec![1, 2, 7, 8]);
        assert_eq!(store.next_number, 9);
    }

    #[test]
    fn new_id_is_eight_hex_chars_and_seed_dependent() {
        let a = new_id("/d.md quote note 2026-09-01T00:00:00Z");
        let b = new_id("/d.md quote note 2026-09-01T00:00:01Z");
        assert_eq!(a.len(), 8);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert_eq!(a, new_id("/d.md quote note 2026-09-01T00:00:00Z"));
    }

    #[test]
    fn unique_id_differs_for_the_same_seed() {
        let ids: std::collections::HashSet<String> = (0..200).map(|_| unique_id("/d.md same note")).collect();
        assert_eq!(ids.len(), 200);
        assert!(ids.iter().all(|id| id.len() == 8 && id.chars().all(|c| c.is_ascii_hexdigit())));
    }

    #[test]
    fn iso8601_from_fixed_epoch() {
        assert_eq!(iso8601_from_epoch(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso8601_from_epoch(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_from_epoch(951_782_400), "2000-02-29T00:00:00Z"); // leap day
        assert_eq!(now_iso8601().len(), 20);
    }

    #[test]
    fn apply_patch_changes_note_only() {
        let mut a = ann("a");
        apply_patch(&mut a, &AnnotationPatch { note: Some("edited".into()), ..Default::default() });
        assert_eq!(a.note, "edited");
        assert_eq!(a.status, "open");
        assert_eq!(a.resolved_by, None);
    }

    #[test]
    fn apply_patch_resolve_sets_status_by_and_at() {
        let mut a = ann("a");
        apply_patch(&mut a, &AnnotationPatch {
            status: Some("resolved".into()),
            resolved_by: Some("user".into()),
            resolved_at: Some("2026-09-01T00:00:00Z".into()),
            ..Default::default()
        });
        assert_eq!(a.status, "resolved");
        assert_eq!(a.resolved_by.as_deref(), Some("user"));
        assert_eq!(a.resolved_at.as_deref(), Some("2026-09-01T00:00:00Z"));
        assert_eq!(a.note, "n");
    }

    #[test]
    fn apply_patch_reopen_clears_resolution() {
        let mut a = ann("a");
        a.status = "resolved".into();
        a.resolved_by = Some("claude".into());
        a.resolved_at = Some("t".into());
        apply_patch(&mut a, &AnnotationPatch {
            status: Some("open".into()),
            clear_resolution: true,
            ..Default::default()
        });
        assert_eq!(a.status, "open");
        assert_eq!(a.resolved_by, None);
        assert_eq!(a.resolved_at, None);
    }

    #[test]
    fn apply_patch_reanchor_sets_anchor_fields_and_leaves_the_rest() {
        let mut a = ann("a");
        a.number = 7;
        a.replies.push(Reply { author: "claude".into(), text: "r".into(), created_at: "t".into() });
        apply_patch(&mut a, &AnnotationPatch {
            quote: Some("new quote".into()),
            prefix: Some("before ".into()),
            suffix: Some(" after".into()),
            line_hint: Some(LineHint { start: 12, end: 13 }),
            status: Some("open".into()),
            ..Default::default()
        });
        assert_eq!(a.quote, "new quote");
        assert_eq!(a.prefix, "before ");
        assert_eq!(a.suffix, " after");
        assert_eq!(a.line_hint, LineHint { start: 12, end: 13 });
        assert_eq!(a.status, "open");
        assert_eq!(a.id, "a");
        assert_eq!(a.number, 7);
        assert_eq!(a.note, "n");
        assert_eq!(a.replies.len(), 1);
    }

    #[test]
    fn annotation_patch_deserializes_anchor_fields() {
        let p: AnnotationPatch = serde_json::from_str(
            r#"{"quote":"q2","prefix":"p","suffix":"s","lineHint":{"start":3,"end":4}}"#,
        )
        .unwrap();
        assert_eq!(p.quote.as_deref(), Some("q2"));
        assert_eq!(p.prefix.as_deref(), Some("p"));
        assert_eq!(p.suffix.as_deref(), Some("s"));
        assert_eq!(p.line_hint, Some(LineHint { start: 3, end: 4 }));
        assert_eq!(p.note, None);
    }

    #[test]
    fn annotation_patch_deserializes_camel_case() {
        let p: AnnotationPatch =
            serde_json::from_str(r#"{"status":"open","clearResolution":true}"#).unwrap();
        assert_eq!(p.status.as_deref(), Some("open"));
        assert!(p.clear_resolution);
        let p: AnnotationPatch = serde_json::from_str(r#"{"resolvedBy":"user","resolvedAt":"x"}"#).unwrap();
        assert_eq!(p.resolved_by.as_deref(), Some("user"));
        assert_eq!(p.resolved_at.as_deref(), Some("x"));
        assert!(!p.clear_resolution);
    }

    #[test]
    #[serial]
    fn update_annotation_round_trips_and_errors_on_missing_id() {
        std::env::set_var("HOME", "/tmp/glance-test-update");
        let doc = "/m/update.md";
        let path = store_path_for(doc).unwrap();
        let _ = std::fs::remove_file(&path);
        add_annotation(doc.into(), ann("a")).unwrap();
        update_annotation(doc.into(), "a".into(), AnnotationPatch {
            status: Some("resolved".into()),
            resolved_by: Some("user".into()),
            resolved_at: Some("2026-09-01T00:00:00Z".into()),
            ..Default::default()
        })
        .unwrap();
        let a = &read_store(doc).unwrap().annotations[0];
        assert_eq!(a.status, "resolved");
        assert_eq!(a.resolved_by.as_deref(), Some("user"));
        assert_eq!(a.number, 1);
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"resolvedBy\": \"user\""), "{on_disk}");
        update_annotation(doc.into(), "a".into(), AnnotationPatch {
            status: Some("open".into()),
            note: Some("edited".into()),
            clear_resolution: true,
            ..Default::default()
        })
        .unwrap();
        let a = &read_store(doc).unwrap().annotations[0];
        assert_eq!((a.status.as_str(), a.note.as_str()), ("open", "edited"));
        assert_eq!(a.resolved_by, None);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("resolvedBy"));
        let err = update_annotation(doc.into(), "missing".into(), AnnotationPatch::default()).unwrap_err();
        assert!(err.contains("missing"), "{err}");
    }

    #[test]
    fn apply_reply_pushes_onto_thread_and_leaves_status() {
        let mut a = ann("a");
        apply_reply(&mut a, "claude", "Cut the cap to 5 min", "2026-09-01T00:00:00Z");
        apply_reply(&mut a, "user", "Thanks", "2026-09-01T00:01:00Z");
        assert_eq!(a.replies.len(), 2);
        assert_eq!(a.replies[0], Reply { author: "claude".into(), text: "Cut the cap to 5 min".into(), created_at: "2026-09-01T00:00:00Z".into() });
        assert_eq!(a.replies[1].author, "user");
        assert_eq!(a.status, "open");
    }

    #[test]
    #[serial]
    fn add_reply_round_trips_and_errors_on_missing_id() {
        std::env::set_var("HOME", "/tmp/glance-test-reply");
        let doc = "/m/reply.md";
        let path = store_path_for(doc).unwrap();
        let _ = std::fs::remove_file(&path);
        add_annotation(doc.into(), ann("a")).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("replies"));
        add_reply(doc.into(), "a".into(), "what did you mean?".into()).unwrap();
        let a = &read_store(doc).unwrap().annotations[0];
        assert_eq!(a.replies.len(), 1);
        assert_eq!(a.replies[0].author, "user");
        assert_eq!(a.replies[0].text, "what did you mean?");
        assert_eq!(a.replies[0].created_at.len(), 20);
        assert_eq!(a.status, "open");
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"replies\""), "{on_disk}");
        assert!(on_disk.contains("\"createdAt\""), "{on_disk}");
        let err = add_reply(doc.into(), "missing".into(), "x".into()).unwrap_err();
        assert!(err.contains("missing"), "{err}");
    }

    #[test]
    #[serial]
    fn old_store_without_replies_deserializes_with_empty_thread() {
        std::env::set_var("HOME", "/tmp/glance-test-no-replies");
        let doc = "/m/noreplies.md";
        let path = store_path_for(doc).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"docPath":"/m/noreplies.md","annotations":[
            {"id":"a","quote":"q","prefix":"","suffix":"","lineHint":{"start":1,"end":1},"note":"n","status":"open","author":"user","createdAt":"2026-01","number":1}],"nextNumber":2}"#).unwrap();
        let store = read_store(doc).unwrap();
        assert_eq!(store.annotations.len(), 1);
        assert!(store.annotations[0].replies.is_empty());
    }

    #[test]
    #[serial]
    fn mutate_store_round_trips_add_and_remove() {
        std::env::set_var("HOME", "/tmp/glance-test-mutate");
        let doc = "/m/doc.md";
        let _ = std::fs::remove_file(store_path_for(doc).unwrap());
        mutate_store(doc, |s| s.annotations.push(ann("a"))).unwrap();
        mutate_store(doc, |s| s.annotations.push(ann("b"))).unwrap();
        assert_eq!(read_store(doc).unwrap().annotations.len(), 2);
        mutate_store(doc, |s| s.annotations.retain(|a| a.id != "a")).unwrap();
        let ids: Vec<_> = read_store(doc).unwrap().annotations.iter().map(|a| a.id.clone()).collect();
        assert_eq!(ids, vec!["b"]);
    }

    #[test]
    #[serial]
    fn mutate_store_returns_closure_value() {
        std::env::set_var("HOME", "/tmp/glance-test-mutate-ret");
        let doc = "/m/ret.md";
        let _ = std::fs::remove_file(store_path_for(doc).unwrap());
        mutate_store(doc, |s| s.annotations.push(ann("x"))).unwrap();
        // A resolve-style closure can report whether it found its target.
        let found = mutate_store(doc, |s| {
            let mut hit = false;
            for a in &mut s.annotations {
                if a.id == "x" { a.status = "resolved".into(); hit = true; }
            }
            hit
        })
        .unwrap();
        assert!(found);
        assert_eq!(read_store(doc).unwrap().annotations[0].status, "resolved");
    }

    fn fresh_home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join("glance-test-dataloss").join(name);
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        home
    }

    #[test]
    #[serial]
    fn store_that_fails_to_parse_is_an_error_and_is_never_overwritten() {
        fresh_home("corrupt");
        let doc = "/m/corrupt.md";
        for id in ["a", "b", "c"] {
            add_annotation(doc.into(), ann(id)).unwrap();
        }
        let path = store_path_for(doc).unwrap();
        let broken = std::fs::read_to_string(&path).unwrap().replacen("\"number\": 2", "\"number\": -2", 1);
        std::fs::write(&path, &broken).unwrap();

        let err = read_store(doc).unwrap_err();
        assert!(err.contains("damaged") && err.contains(&path.display().to_string()), "{err}");
        assert!(read_annotations(doc.into()).is_err());
        assert!(add_annotation(doc.into(), ann("d")).is_err());
        assert!(remove_annotation(doc.into(), "a".into()).is_err());
        assert!(add_reply(doc.into(), "a".into(), "x".into()).is_err());
        assert!(update_annotation(doc.into(), "a".into(), AnnotationPatch::default()).is_err());
        assert!(ensure_annotation_store(doc.into()).is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), broken);
    }

    #[test]
    #[serial]
    fn one_annotation_missing_a_field_keeps_the_whole_store() {
        fresh_home("missing-field");
        let doc = "/m/missing.md";
        let path = store_path_for(doc).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = r#"{"docPath":"/m/missing.md","nextNumber":3,"annotations":[
            {"id":"a","quote":"q","prefix":"","suffix":"","lineHint":{"start":1,"end":1},"note":"keep me","status":"open","author":"user","createdAt":"t","number":1},
            {"id":"b","quote":"q","lineHint":{"start":1,"end":1},"note":"no prefix/suffix","status":"open","author":"claude","createdAt":"t","number":2}]}"#;
        std::fs::write(&path, text).unwrap();
        let res = mutate_store(doc, |s| s.annotations.retain(|a| a.id != "a"));
        assert!(res.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    #[serial]
    fn missing_or_blank_store_is_empty_not_an_error() {
        fresh_home("blank");
        let doc = "/m/blank.md";
        assert!(read_store(doc).unwrap().annotations.is_empty());
        let path = store_path_for(doc).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "").unwrap();
        assert!(read_store(doc).unwrap().annotations.is_empty());
        add_annotation(doc.into(), ann("a")).unwrap();
        assert_eq!(read_store(doc).unwrap().annotations.len(), 1);
    }

    #[test]
    #[serial]
    fn mutation_that_changes_nothing_writes_nothing() {
        fresh_home("noop");
        let doc = "/m/noop.md";
        let path = store_path_for(doc).unwrap();
        // Unknown doc + unknown id: no store file, lock file, or store dir is created.
        assert!(update_annotation(doc.into(), "zzz".into(), AnnotationPatch::default()).is_err());
        assert!(add_reply(doc.into(), "zzz".into(), "x".into()).is_err());
        remove_annotation(doc.into(), "zzz".into()).unwrap();
        assert!(!path.exists());
        assert!(!path.with_extension("json.lock").exists());
        assert!(!path.parent().unwrap().exists());
        // Existing store: an unknown id leaves the file byte-for-byte alone.
        add_annotation(doc.into(), ann("a")).unwrap();
        let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        remove_annotation(doc.into(), "zzz".into()).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), mtime);
    }

    /// A real file reached through a symlinked dir. The temp dir is itself
    /// under a symlink on macOS (/var -> /private/var), so even `real` isn't canonical.
    fn linked_doc(home: &Path) -> (String, String) {
        let real = home.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("Plan.md"), "x\n").unwrap();
        std::os::unix::fs::symlink(&real, home.join("link")).unwrap();
        let via_link = home.join("link/Plan.md").to_string_lossy().into_owned();
        let canonical = std::fs::canonicalize(real.join("Plan.md")).unwrap().to_string_lossy().into_owned();
        assert_ne!(via_link, canonical);
        (via_link, canonical)
    }

    fn write_legacy(raw: &str, json: &str) -> PathBuf {
        let p = store_dir().unwrap().join(format!("{}.json", sha1_hex(raw)));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, json).unwrap();
        p
    }

    fn legacy_json(doc: &str, anns: &[(&str, u32)]) -> String {
        let list: Vec<String> = anns.iter().map(|(id, n)| format!(
            r#"{{"id":"{id}","quote":"q","prefix":"","suffix":"","lineHint":{{"start":1,"end":1}},"note":"old {id}","status":"open","author":"user","createdAt":"t","number":{n}}}"#
        )).collect();
        format!(r#"{{"docPath":"{doc}","nextNumber":{},"legacyExtra":true,"annotations":[{}]}}"#, anns.len() + 1, list.join(","))
    }

    fn numbered(store: &AnnotationStore) -> Vec<(String, u32)> {
        store.annotations.iter().map(|a| (a.id.clone(), a.number)).collect()
    }

    fn pairs(v: &[(&str, u32)]) -> Vec<(String, u32)> {
        v.iter().map(|(id, n)| (id.to_string(), *n)).collect()
    }

    #[test]
    #[serial]
    fn every_spelling_of_a_file_shares_one_store() {
        let home = fresh_home("spellings");
        let (via_link, canonical) = linked_doc(&home);
        let real = home.join("real");
        let mut variants = vec![
            via_link.clone(),
            canonical.clone(),
            real.join("Plan.md").to_string_lossy().into_owned(),
            format!("{}/./Plan.md", real.display()),
            format!("{}//Plan.md", real.display()),
            format!("{}/../real/Plan.md", real.display()),
        ];
        if real.join("plan.md").exists() {
            variants.push(real.join("plan.md").to_string_lossy().into_owned()); // case-insensitive volume
        }
        for v in &variants {
            assert_eq!(doc_key(v), canonical, "{v}");
        }
        add_annotation(via_link.clone(), ann("a")).unwrap();
        for v in &variants {
            assert_eq!(read_store(v).unwrap().annotations.len(), 1, "{v}");
        }
        assert_eq!(read_store(&via_link).unwrap().doc_path, canonical);
        let expected = store_path_for(&canonical).unwrap().to_string_lossy().into_owned();
        assert_eq!(ensure_annotation_store(variants[3].clone()).unwrap(), expected);
        assert_eq!(doc_key("/tmp/glance-no-such-doc.md"), "/private/tmp/glance-no-such-doc.md");
    }

    #[test]
    #[serial]
    fn a_missing_file_gets_the_key_it_will_have_once_created() {
        let home = fresh_home("missing-key");
        linked_doc(&home);
        let new_doc = home.join("link/New.md");
        let before = doc_key(&new_doc.to_string_lossy());
        assert!(!before.contains("/link/"), "{before}");
        assert_eq!(doc_key(&format!("{}/link/./sub/../New.md", home.display())), before);
        std::fs::write(&new_doc, "x").unwrap();
        assert_eq!(doc_key(&new_doc.to_string_lossy()), before);
    }

    #[test]
    #[serial]
    fn upgrade_moves_a_store_filed_under_the_old_raw_key() {
        let home = fresh_home("migrate-move");
        let (via_link, canonical) = linked_doc(&home);
        // 0.8.5 keyed the store by sha1 of the exact string the app passed.
        let old = write_legacy(&via_link, &legacy_json(&via_link, &[("a", 1), ("b", 2)]));
        let store = read_store(&via_link).unwrap();
        assert_eq!(numbered(&store), pairs(&[("a", 1), ("b", 2)]));
        assert!(!old.exists());
        let new = store_path_for(&canonical).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&new).unwrap()).unwrap();
        assert_eq!(v["docPath"], canonical.as_str());
        assert_eq!(v["nextNumber"], 3);
        assert_eq!(v["legacyExtra"], true);
        assert_eq!(v["annotations"][1]["note"], "old b");
        // Any spelling now reads the migrated store.
        assert_eq!(read_store(&canonical).unwrap().annotations.len(), 2);
    }

    #[test]
    #[serial]
    fn upgrade_merges_a_legacy_store_into_an_existing_one() {
        let home = fresh_home("migrate-merge");
        let (via_link, canonical) = linked_doc(&home);
        add_annotation(canonical.clone(), ann("a")).unwrap();
        add_annotation(canonical.clone(), ann("b")).unwrap();
        // glance-mcp wrote under the canonical spelling while the app used the link.
        let old = write_legacy(&via_link, &legacy_json(&via_link, &[("a", 1), ("c", 2)]));
        // A mutation migrates under the lock before applying itself.
        add_reply(via_link.clone(), "c".into(), "still here?".into()).unwrap();
        assert!(!old.exists());
        let store = read_store(&canonical).unwrap();
        assert_eq!(numbered(&store), pairs(&[("a", 1), ("b", 2), ("c", 3)]));
        assert_eq!(store.annotations[0].note, "n"); // the existing copy of a duplicate id wins
        assert_eq!(store.annotations[2].replies[0].text, "still here?");
        assert_eq!(store.next_number, 4);
        assert_eq!(store.extra.get("legacyExtra"), Some(&serde_json::json!(true)));
    }

    #[test]
    #[serial]
    fn upgrade_finds_the_apps_spelling_from_a_dotted_variant() {
        let home = fresh_home("migrate-dotted");
        let (via_link, canonical) = linked_doc(&home);
        let old = write_legacy(&via_link, &legacy_json(&via_link, &[("a", 1)]));
        let dotted = via_link.replace("/link/", "/link/./");
        let expected = store_path_for(&canonical).unwrap().to_string_lossy().into_owned();
        assert_eq!(ensure_annotation_store(dotted).unwrap(), expected);
        assert!(!old.exists());
        assert_eq!(read_store(&canonical).unwrap().annotations.len(), 1);
    }

    #[test]
    #[serial]
    fn a_damaged_legacy_store_blocks_and_is_left_alone() {
        let home = fresh_home("migrate-damaged");
        let (via_link, canonical) = linked_doc(&home);
        let old = write_legacy(&via_link, "{not json");
        assert!(read_store(&via_link).unwrap_err().contains("damaged"));
        assert!(add_annotation(via_link.clone(), ann("x")).is_err());
        assert!(ensure_annotation_store(via_link.clone()).is_err());
        assert_eq!(std::fs::read_to_string(&old).unwrap(), "{not json");
        assert!(!store_path_for(&canonical).unwrap().exists());
    }

    #[test]
    #[serial]
    fn a_held_lock_times_out_with_a_clear_error() {
        fresh_home("locked");
        let doc = "/m/locked.md";
        add_annotation(doc.into(), ann("a")).unwrap();
        let store_path = store_path_for(doc).unwrap();
        // flock is per open file, so a second handle in this process contends like another process.
        let holder = std::fs::File::open(store_path.with_extension("json.lock")).unwrap();
        holder.lock_exclusive().unwrap();
        let started = Instant::now();
        let err = with_store_lock_within(&store_path, Duration::from_millis(150), || Ok(())).unwrap_err();
        assert!(err.contains("locked by another process"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(2));
        holder.unlock().unwrap();
        with_store_lock_within(&store_path, Duration::from_millis(150), || Ok(())).unwrap();
    }

    #[test]
    #[serial]
    fn numbers_at_u32_max_saturate_instead_of_overflowing() {
        fresh_home("overflow");
        let doc = "/m/of.md";
        let path = store_path_for(doc).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"docPath":"/m/of.md","annotations":[
            {"id":"a","quote":"q","prefix":"","suffix":"","lineHint":{"start":1,"end":1},"note":"n","status":"open","author":"user","createdAt":"t","number":4294967295},
            {"id":"b","quote":"q","prefix":"","suffix":"","lineHint":{"start":1,"end":1},"note":"n","status":"open","author":"user","createdAt":"t"}]}"#).unwrap();
        let store = read_store(doc).unwrap();
        assert_eq!(store.next_number, u32::MAX);
        assert_eq!(store.annotations[1].number, u32::MAX);
        let mut carried = ann("c");
        carried.number = u32::MAX;
        add_annotation(doc.into(), carried).unwrap();
        assert_eq!(read_store(doc).unwrap().annotations.len(), 3);
    }

    #[test]
    #[serial]
    fn store_writes_leave_no_temp_files_behind() {
        let home = fresh_home("atomic");
        let doc = "/m/atomic.md";
        for id in ["a", "b"] {
            add_annotation(doc.into(), ann(id)).unwrap();
        }
        let names: Vec<String> = std::fs::read_dir(home.join(".glance/annotations")).unwrap()
            .flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
        assert_eq!(read_store(doc).unwrap().annotations.len(), 2);
    }

    #[test]
    fn write_atomic_replaces_content_and_reports_failure() {
        let dir = std::env::temp_dir().join(format!("glance-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("f.json");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
        // Renaming over a directory fails; the temp file is cleaned up.
        std::fs::create_dir_all(dir.join("sub.json")).unwrap();
        assert!(write_atomic(&dir.join("sub.json"), b"x").is_err());
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 2, "{left:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[serial]
    fn unknown_store_and_annotation_fields_survive_a_mutation() {
        fresh_home("unknown");
        let doc = "/m/unknown.md";
        let path = store_path_for(doc).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"docPath":"/m/unknown.md","nextNumber":2,"schemaVersion":2,"annotations":[
            {"id":"a","quote":"q","prefix":"","suffix":"","lineHint":{"start":1,"end":1},"note":"n","status":"open","author":"user","createdAt":"t","number":1,"tags":["x"],"severity":"high"}]}"#).unwrap();
        add_reply(doc.into(), "a".into(), "hi".into()).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["schemaVersion"], 2);
        assert_eq!(v["annotations"][0]["severity"], "high");
        assert_eq!(v["annotations"][0]["tags"], serde_json::json!(["x"]));
        assert_eq!(v["annotations"][0]["replies"][0]["text"], "hi");
        assert!(v.get("extra").is_none());
    }

    #[test]
    #[serial]
    fn ensure_annotation_store_creates_an_empty_store_once() {
        fresh_home("ensure");
        let doc = "/m/ensure.md";
        let path = ensure_annotation_store(doc.into()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"docPath\": \"/m/ensure.md\""), "{text}");
        add_annotation(doc.into(), ann("a")).unwrap();
        ensure_annotation_store(doc.into()).unwrap();
        assert_eq!(read_store(doc).unwrap().annotations.len(), 1);
    }
}
