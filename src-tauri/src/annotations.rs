use crate::anchor::{resolve_anchor, Annotation, Resolution};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AnnotationStore {
    #[serde(rename = "docPath")]
    pub doc_path: String,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    #[serde(default, rename = "nextNumber")]
    pub next_number: u32,
}

pub fn sha1_hex(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

fn store_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".glance").join("annotations"))
}

pub fn store_path_for(doc_path: &str) -> Option<PathBuf> {
    store_dir().map(|d| d.join(format!("{}.json", sha1_hex(doc_path))))
}

pub fn read_store(doc_path: &str) -> AnnotationStore {
    let empty = || AnnotationStore {
        doc_path: doc_path.to_string(),
        annotations: Vec::new(),
        next_number: 0,
    };
    let path = match store_path_for(doc_path) {
        Some(p) => p,
        None => return empty(),
    };
    let mut store = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| empty()),
        Err(_) => empty(),
    };
    backfill_numbers(&mut store);
    store
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
        max += 1;
        store.annotations[i].number = max;
    }
    store.next_number = store.next_number.max(max + 1);
}

pub fn write_store(store: &AnnotationStore) -> Result<(), String> {
    let path = store_path_for(&store.doc_path)
        .ok_or_else(|| "Could not determine $HOME for annotation store".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    // Write to a sibling temp file then rename, so a crash mid-write can't leave
    // a truncated/corrupt store on disk (rename is atomic within the directory).
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Run `f` against the current on-disk store under an exclusive **cross-process**
/// lock, then persist the result. This is the only safe way to mutate a store:
/// both writers — the GUI (`add_annotation`/`remove_annotation` IPC) and the
/// standalone `glance-mcp` subprocess (`resolve_annotation`) — funnel every
/// change through here, so their read-modify-write cycles serialize instead of
/// silently clobbering each other's full-file writes.
pub fn mutate_store<T>(
    doc_path: &str,
    f: impl FnOnce(&mut AnnotationStore) -> T,
) -> Result<T, String> {
    let store_path = store_path_for(doc_path)
        .ok_or_else(|| "Could not determine $HOME for annotation store".to_string())?;
    if let Some(parent) = store_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Lock a stable sibling file (never renamed), so the exclusive lock is held
    // across the read and the temp-file+rename write below. flock on the store
    // file itself wouldn't work: the rename swaps the inode out from under it.
    let lock_path = store_path.with_extension("json.lock");
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false) // only used as a flock handle; never written to
        .open(&lock_path)
        .map_err(|e| e.to_string())?;
    lock_file.lock_exclusive().map_err(|e| e.to_string())?;

    let mut store = read_store(doc_path);
    let out = f(&mut store);
    let write_res = write_store(&store);
    let _ = lock_file.unlock(); // also released when lock_file drops
    write_res.map(|_| out)
}

#[tauri::command]
pub fn read_annotations(path: String) -> AnnotationStore {
    read_store(&path)
}

/// Append one annotation to the store under lock, giving it the store's next
/// number. An annotation that already carries a number (an undo re-add) keeps
/// it. Replaces the old whole-store write so a concurrent `resolve_annotation`
/// from glance-mcp can't be lost.
#[tauri::command]
pub fn add_annotation(doc_path: String, mut annotation: Annotation) -> Result<(), String> {
    mutate_store(&doc_path, move |s| {
        backfill_numbers(s);
        if annotation.number == 0 {
            annotation.number = s.next_number;
        }
        s.next_number = s.next_number.max(annotation.number + 1);
        s.annotations.push(annotation);
    })
}

/// Remove one annotation by id under lock.
#[tauri::command]
pub fn remove_annotation(doc_path: String, id: String) -> Result<(), String> {
    mutate_store(&doc_path, move |s| s.annotations.retain(|a| a.id != id))
}

/// Fields the GUI may change on a stored annotation. Every `Some` is applied;
/// `clear_resolution` drops both resolved fields (a reopen), since a plain
/// `Option` can't express "set to none" over IPC.
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
}

pub fn apply_patch(a: &mut Annotation, patch: &AnnotationPatch) {
    if let Some(note) = &patch.note {
        a.note = note.clone();
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
    let store_path =
        store_path_for(&path).ok_or_else(|| "Could not determine $HOME".to_string())?;
    if !store_path.exists() {
        // Create under the same lock as mutations: a no-op mutate reads the
        // (missing → empty) store and writes it back, so a concurrent first
        // mutation from another process can't be clobbered by this creation.
        mutate_store(&path, |_| {})?;
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
        let store = read_store("/no/such/file.md");
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
        }
    }

    fn store_of(annotations: Vec<Annotation>) -> AnnotationStore {
        AnnotationStore { doc_path: "/d.md".into(), annotations, next_number: 0 }
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
        let store = read_store(doc);
        let nums: Vec<u32> = store.annotations.iter().map(|a| a.number).collect();
        assert_eq!(nums, vec![1, 2, 3]);
        assert_eq!(store.next_number, 4);
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"nextNumber\": 4"), "{on_disk}");
        // A re-add that already carries a number keeps it and only bumps next_number if needed.
        let mut undo = ann("d");
        undo.number = 9;
        add_annotation(doc.into(), undo).unwrap();
        let store = read_store(doc);
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
        let store = read_store(doc);
        assert_eq!(store.annotations[0].number, 2);
        assert_eq!(store.annotations[1].number, 1);
        assert_eq!(store.next_number, 3);
        add_annotation(doc.into(), ann("new")).unwrap();
        let store = read_store(doc);
        let nums: Vec<(String, u32)> = store.annotations.iter().map(|a| (a.id.clone(), a.number)).collect();
        assert_eq!(nums, vec![("late".into(), 2), ("early".into(), 1), ("new".into(), 3)]);
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"nextNumber\": 4"));
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
        let a = &read_store(doc).annotations[0];
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
        let a = &read_store(doc).annotations[0];
        assert_eq!((a.status.as_str(), a.note.as_str()), ("open", "edited"));
        assert_eq!(a.resolved_by, None);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("resolvedBy"));
        let err = update_annotation(doc.into(), "missing".into(), AnnotationPatch::default()).unwrap_err();
        assert!(err.contains("missing"), "{err}");
    }

    #[test]
    #[serial]
    fn mutate_store_round_trips_add_and_remove() {
        std::env::set_var("HOME", "/tmp/glance-test-mutate");
        let doc = "/m/doc.md";
        let _ = std::fs::remove_file(store_path_for(doc).unwrap());
        mutate_store(doc, |s| s.annotations.push(ann("a"))).unwrap();
        mutate_store(doc, |s| s.annotations.push(ann("b"))).unwrap();
        assert_eq!(read_store(doc).annotations.len(), 2);
        mutate_store(doc, |s| s.annotations.retain(|a| a.id != "a")).unwrap();
        let ids: Vec<_> = read_store(doc).annotations.iter().map(|a| a.id.clone()).collect();
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
        assert_eq!(read_store(doc).annotations[0].status, "resolved");
    }
}
