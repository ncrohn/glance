//! What a waiting Claude Code session needs from Glance, kept as files under
//! `~/.glance/` so a separate process can read them:
//!
//! - `owners/<sha1(doc_key)>`: the session that last opened the doc with
//!   `mdview` or the auto-open hook.
//! - `events/<session>.jsonl`: one line per save, comment or reply the user made
//!   in Glance on a doc that session owns.
//! - `unsaved/<sha1(doc_key)>`: Glance's pid, while the doc has unsaved edits.
//!   Cleared at launch, so a crash can't leave a doc marked forever.
//!
//! Every write here is best effort: callers ignore errors, so a failure never
//! fails the save or comment that triggered it.

use crate::annotations::{doc_key, now_iso8601, sha1_hex, write_atomic};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    Save,
    Comment,
    Reply,
}

impl EventKind {
    fn as_str(self) -> &'static str {
        match self {
            EventKind::Save => "save",
            EventKind::Comment => "comment",
            EventKind::Reply => "reply",
        }
    }
}

pub fn glance_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".glance"))
}

/// Ids come from argv and name files, so only `[A-Za-z0-9-]{1,64}` is accepted.
pub fn valid_session_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn doc_file(base: &Path, sub: &str, doc: &str) -> PathBuf {
    base.join(sub).join(sha1_hex(&doc_key(doc)))
}

pub fn record_owner_in(base: &Path, doc: &str, session: &str) -> Result<(), String> {
    if !valid_session_id(session) {
        return Err(format!("invalid session id: {session}"));
    }
    write_atomic(&doc_file(base, "owners", doc), session.as_bytes())
}

pub fn clear_owner_in(base: &Path, doc: &str) -> Result<(), String> {
    match std::fs::remove_file(doc_file(base, "owners", doc)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

pub fn owner_in(base: &Path, doc: &str) -> Option<String> {
    let id = std::fs::read_to_string(doc_file(base, "owners", doc)).ok()?;
    let id = id.trim();
    valid_session_id(id).then(|| id.to_string())
}

/// Append one event for the doc's owner. `Ok(false)` when the doc has no owner.
pub fn append_event_in(base: &Path, doc: &str, kind: EventKind, number: Option<u32>) -> Result<bool, String> {
    let Some(session) = owner_in(base, doc) else {
        return Ok(false);
    };
    let mut event = serde_json::json!({ "ts": now_iso8601(), "doc": doc_key(doc), "kind": kind.as_str() });
    if let Some(n) = number {
        event["number"] = n.into();
    }
    let dir = base.join("events");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // One write of a short line to an O_APPEND file, so a reader never sees half
    // of it and concurrent appends don't interleave.
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{session}.jsonl")))
        .map_err(|e| e.to_string())?;
    f.write_all(format!("{event}\n").as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn set_unsaved_in(base: &Path, doc: &str, unsaved: bool) -> Result<(), String> {
    let path = doc_file(base, "unsaved", doc);
    if unsaved {
        // Sent on the typing path, so no fsync: a marker only matters while
        // this process is alive.
        std::fs::create_dir_all(base.join("unsaved")).map_err(|e| e.to_string())?;
        std::fs::write(&path, std::process::id().to_string()).map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

pub fn clear_unsaved_in(base: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(base.join("unsaved")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn with_base<T>(f: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    f(&glance_dir().ok_or_else(|| "Could not determine $HOME".to_string())?)
}

pub fn record_owner(doc: &str, session: &str) -> Result<(), String> {
    with_base(|b| record_owner_in(b, doc, session))
}

pub fn clear_owner(doc: &str) {
    let _ = with_base(|b| clear_owner_in(b, doc));
}

/// Record the user's action for the doc's owning session, if it has one.
/// Failures are dropped: they must never fail the save or comment.
pub fn note_event(doc: &str, kind: EventKind, number: Option<u32>) {
    let _ = with_base(|b| append_event_in(b, doc, kind, number));
}

pub fn set_unsaved(doc: &str, unsaved: bool) -> Result<(), String> {
    with_base(|b| set_unsaved_in(b, doc, unsaved))
}

pub fn clear_unsaved() {
    let _ = with_base(clear_unsaved_in);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glance-wake-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    fn events(base: &Path, session: &str) -> Vec<serde_json::Value> {
        std::fs::read_to_string(base.join("events").join(format!("{session}.jsonl")))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn session_ids_are_short_and_plain() {
        assert!(valid_session_id("e7f913ff-81f3-48c7-a3f1-d0fd8a50cd38"));
        assert!(valid_session_id(&"a".repeat(64)));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id(&"a".repeat(65)));
        assert!(!valid_session_id("../x"));
        assert!(!valid_session_id("a b"));
        assert!(!valid_session_id("a_b"));
    }

    #[test]
    fn owner_is_keyed_by_doc_and_the_last_opener_wins() {
        let base = scratch("owner");
        let doc = base.join("notes.md");
        std::fs::write(&doc, "x").unwrap();
        let doc = doc.to_string_lossy().into_owned();
        assert_eq!(owner_in(&base, &doc), None);
        record_owner_in(&base, &doc, "one").unwrap();
        assert_eq!(owner_in(&base, &doc).as_deref(), Some("one"));
        // Another spelling of the same file shares the owner.
        let alias = format!("{}/./notes.md", base.display());
        record_owner_in(&base, &alias, "two").unwrap();
        assert_eq!(owner_in(&base, &doc).as_deref(), Some("two"));
        assert!(record_owner_in(&base, &doc, "../evil").is_err());
        assert_eq!(owner_in(&base, &doc).as_deref(), Some("two"));
        // Opened by hand: no owner.
        clear_owner_in(&base, &doc).unwrap();
        assert_eq!(owner_in(&base, &doc), None);
        clear_owner_in(&base, &doc).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn events_go_to_the_owner_and_unowned_docs_record_nothing() {
        let base = scratch("events");
        let owned = base.join("owned.md");
        let other = base.join("other.md");
        std::fs::write(&owned, "x").unwrap();
        std::fs::write(&other, "x").unwrap();
        let (owned, other) = (owned.to_string_lossy().into_owned(), other.to_string_lossy().into_owned());
        record_owner_in(&base, &owned, "sess-1").unwrap();

        assert!(append_event_in(&base, &owned, EventKind::Save, None).unwrap());
        assert!(append_event_in(&base, &owned, EventKind::Comment, Some(3)).unwrap());
        assert!(append_event_in(&base, &owned, EventKind::Reply, Some(1)).unwrap());
        assert!(!append_event_in(&base, &other, EventKind::Save, None).unwrap());

        let got = events(&base, "sess-1");
        assert_eq!(got.len(), 3);
        assert_eq!(got[0]["kind"], "save");
        assert_eq!(got[0]["doc"], owned.as_str());
        assert!(got[0].get("number").is_none());
        assert_eq!(got[0]["ts"].as_str().unwrap().len(), 20);
        assert_eq!((got[1]["kind"].as_str(), got[1]["number"].as_u64()), (Some("comment"), Some(3)));
        assert_eq!((got[2]["kind"].as_str(), got[2]["number"].as_u64()), (Some("reply"), Some(1)));
        assert_eq!(std::fs::read_dir(base.join("events")).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unsaved_marker_holds_the_pid_and_clears() {
        let base = scratch("unsaved");
        let doc = base.join("draft.md");
        std::fs::write(&doc, "x").unwrap();
        let doc = doc.to_string_lossy().into_owned();
        let marker = doc_file(&base, "unsaved", &doc);
        set_unsaved_in(&base, &doc, true).unwrap();
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), std::process::id().to_string());
        set_unsaved_in(&base, &doc, false).unwrap();
        assert!(!marker.exists());
        set_unsaved_in(&base, &doc, false).unwrap();

        set_unsaved_in(&base, &doc, true).unwrap();
        clear_unsaved_in(&base).unwrap();
        assert!(!base.join("unsaved").exists());
        clear_unsaved_in(&base).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }
}
