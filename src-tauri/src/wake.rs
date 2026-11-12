//! What a waiting Claude Code session needs from Glance, kept as files under
//! `~/.glance/` so a separate process can read them:
//!
//! - `owners/<sha1(doc_key)>`: the session that last opened the doc with
//!   `mdview` or the auto-open hook.
//! - `events/<session>.jsonl`: one line per save, comment or reply the user made
//!   in Glance on a doc that session owns.
//! - `unsaved/<sha1(doc_key)>`: Glance's pid, while the doc has unsaved edits.
//!   Cleared at launch, so a crash can't leave a doc marked forever.
//! - `events/<session>.cursor`: byte offset of the first event not yet
//!   delivered to the session.
//! - `waiters/<session>`: `<token> <pid>` of the waiter the `Stop` hook started
//!   (`glance-mcp --wait`), or `busy` while a turn runs.
//! - `settings.json`: `{"wakeClaude": bool}`, absent meaning on.
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
    write_atomic(&doc_file(base, "owners", doc), session.as_bytes())?;
    // `mdview` runs from the session's own shell, so the session is mid-turn.
    // Until its first `Stop` starts a waiter, events reach it at turn end.
    if !waiter_path(base, session).exists() {
        let _ = write_waiter_in(base, session, &Waiter::Busy);
    }
    Ok(())
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

/// The pid in the doc's `unsaved/` marker. `None` when there is no marker or
/// it doesn't hold a positive pid.
pub fn unsaved_pid_in(base: &Path, doc: &str) -> Option<u32> {
    let text = std::fs::read_to_string(doc_file(base, "unsaved", doc)).ok()?;
    text.trim().parse::<u32>().ok().filter(|&pid| pid > 0)
}

pub fn clear_unsaved_in(base: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(base.join("unsaved")) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Whether a process with this pid is running. `EPERM` means it exists but
/// belongs to another user, which still counts. Pid 0 and anything that isn't
/// a positive `pid_t` are never alive: `kill(0, 0)` would test our own group.
pub fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks that the pid exists; nothing is sent.
    let found = unsafe { libc::kill(pid, 0) } == 0;
    found || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// `~/.glance/settings.json` `wakeClaude`. Absent, unreadable or not a bool
/// means on.
pub fn wake_enabled_in(base: &Path) -> bool {
    std::fs::read_to_string(base.join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("wakeClaude")?.as_bool())
        .unwrap_or(true)
}

/// Set `wakeClaude`, keeping any other keys. A file that isn't a JSON object
/// is replaced.
pub fn set_wake_enabled_in(base: &Path, on: bool) -> Result<(), String> {
    let path = base.join("settings.json");
    let mut v = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    v["wakeClaude"] = on.into();
    write_atomic(&path, format!("{}\n", serde_json::to_string_pretty(&v).unwrap()).as_bytes())
}

/// What `waiters/<session>` says about the session's waiter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Waiter {
    /// A turn is running: the waiter woke it, or the user typed a prompt.
    /// Events now are delivered when the turn ends.
    Busy,
    /// A waiter started by the `Stop` hook: `<token> <pid>`.
    Waiting { token: String, pid: u32 },
}

const BUSY: &str = "busy";

fn waiter_path(base: &Path, session: &str) -> PathBuf {
    base.join("waiters").join(session)
}

pub fn read_waiter_in(base: &Path, session: &str) -> Option<Waiter> {
    let text = std::fs::read_to_string(waiter_path(base, session)).ok()?;
    let text = text.trim();
    if text == BUSY {
        return Some(Waiter::Busy);
    }
    let (token, pid) = text.split_once(' ')?;
    let pid = pid.trim().parse::<u32>().ok()?;
    (!token.is_empty()).then(|| Waiter::Waiting { token: token.to_string(), pid })
}

pub fn write_waiter_in(base: &Path, session: &str, waiter: &Waiter) -> Result<(), String> {
    if !valid_session_id(session) {
        return Err(format!("invalid session id: {session}"));
    }
    let text = match waiter {
        Waiter::Busy => BUSY.to_string(),
        Waiter::Waiting { token, pid } => format!("{token} {pid}"),
    };
    write_atomic(&waiter_path(base, session), text.as_bytes())
}

/// Whether `token` is still the session's waiter. A newer waiter, or a prompt
/// that marked the session busy, ends it.
pub fn waiter_token_is(base: &Path, session: &str, token: &str) -> bool {
    matches!(read_waiter_in(base, session), Some(Waiter::Waiting { token: t, .. }) if t == token)
}

fn events_path(base: &Path, session: &str) -> PathBuf {
    base.join("events").join(format!("{session}.jsonl"))
}

fn cursor_path(base: &Path, session: &str) -> PathBuf {
    base.join("events").join(format!("{session}.cursor"))
}

/// Byte offset into `events/<session>.jsonl` of the first event not yet
/// delivered. 0 when there is no cursor yet.
fn read_cursor(base: &Path, session: &str) -> u64 {
    std::fs::read_to_string(cursor_path(base, session))
        .ok()
        .and_then(|t| t.trim().parse().ok())
        .unwrap_or(0)
}

/// Whether the session's events file has bytes past its cursor.
pub fn has_unread_in(base: &Path, session: &str) -> bool {
    let len = std::fs::metadata(events_path(base, session)).map(|m| m.len()).unwrap_or(0);
    let cursor = read_cursor(base, session);
    // A file shorter than the cursor was replaced; everything in it is new.
    len > cursor || (len > 0 && len < cursor)
}

/// The session's complete event lines past its cursor, with the cursor moved
/// past them. A trailing line with no newline yet is left for next time.
/// Call it under [`with_session_lock`] so each event is taken once.
pub fn take_unread_in(base: &Path, session: &str) -> Result<Vec<serde_json::Value>, String> {
    let bytes = match std::fs::read(events_path(base, session)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut start = read_cursor(base, session) as usize;
    if start > bytes.len() {
        start = 0;
    }
    let Some(end) = bytes[start..].iter().rposition(|&b| b == b'\n').map(|i| start + i + 1) else {
        return Ok(Vec::new());
    };
    let events = String::from_utf8_lossy(&bytes[start..end])
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    write_atomic(&cursor_path(base, session), end.to_string().as_bytes())?;
    Ok(events)
}

/// Run `f` holding the session's cross-process lock, so the waiter and the
/// pending hook never both take the same events or race on the waiter file.
pub fn with_session_lock<T>(base: &Path, session: &str, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    use fs2::FileExt;
    if !valid_session_id(session) {
        return Err(format!("invalid session id: {session}"));
    }
    let dir = base.join("waiters");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join(format!("{session}.lock")))
        .map_err(|e| e.to_string())?;
    // Holders keep it for milliseconds; give up rather than hang a hook.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let contended = fs2::lock_contended_error().raw_os_error();
    loop {
        match lock.try_lock_exclusive() {
            Ok(()) => break,
            Err(e) if e.raw_os_error() == contended && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = f();
    let _ = lock.unlock();
    out
}

/// Whether any doc's owner file names this session.
pub fn owns_any_doc_in(base: &Path, session: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(base.join("owners")) else { return false };
    entries.flatten().any(|e| std::fs::read_to_string(e.path()).is_ok_and(|s| s.trim() == session))
}

/// Whether a save or comment on a doc will reach Claude now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeStatus {
    /// A waiter is running, or a turn is, so the event is delivered.
    Listening,
    /// The owner's waiter is gone: it timed out, or the app evicted the session.
    NotListening,
    /// No session owns the doc.
    Unowned,
    /// The user turned waking off.
    Off,
}

pub fn wake_status_in(base: &Path, doc: &str, alive: impl Fn(u32) -> bool) -> WakeStatus {
    if !wake_enabled_in(base) {
        return WakeStatus::Off;
    }
    let Some(session) = owner_in(base, doc) else { return WakeStatus::Unowned };
    match read_waiter_in(base, &session) {
        Some(Waiter::Busy) => WakeStatus::Listening,
        Some(Waiter::Waiting { pid, .. }) if alive(pid) => WakeStatus::Listening,
        _ => WakeStatus::NotListening,
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

pub fn wake_enabled() -> bool {
    glance_dir().is_none_or(|b| wake_enabled_in(&b))
}

pub fn set_wake_enabled(on: bool) -> Result<(), String> {
    with_base(|b| set_wake_enabled_in(b, on))
}

pub fn wake_status(doc: &str) -> WakeStatus {
    match glance_dir() {
        Some(b) => wake_status_in(&b, doc, pid_alive),
        None => WakeStatus::Unowned,
    }
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

    #[test]
    fn unsaved_pid_reads_the_marker_under_any_spelling_of_the_doc() {
        let base = scratch("unsaved-pid");
        let doc = base.join("draft.md");
        std::fs::write(&doc, "x").unwrap();
        let doc = doc.to_string_lossy().into_owned();
        assert_eq!(unsaved_pid_in(&base, &doc), None);
        set_unsaved_in(&base, &doc, true).unwrap();
        assert_eq!(unsaved_pid_in(&base, &doc), Some(std::process::id()));
        let dotted = base.join(".").join("draft.md").to_string_lossy().into_owned();
        assert_eq!(unsaved_pid_in(&base, &dotted), Some(std::process::id()));

        let marker = doc_file(&base, "unsaved", &doc);
        for junk in ["0", "-5", "abc", ""] {
            std::fs::write(&marker, junk).unwrap();
            assert_eq!(unsaved_pid_in(&base, &doc), None, "{junk:?}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn settings_default_on_and_keep_other_keys() {
        let base = scratch("settings");
        assert!(wake_enabled_in(&base));
        std::fs::write(base.join("settings.json"), r#"{"other": 1}"#).unwrap();
        assert!(wake_enabled_in(&base));
        set_wake_enabled_in(&base, false).unwrap();
        assert!(!wake_enabled_in(&base));
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(base.join("settings.json")).unwrap()).unwrap();
        assert_eq!(v["other"], 1);
        set_wake_enabled_in(&base, true).unwrap();
        assert!(wake_enabled_in(&base));
        std::fs::write(base.join("settings.json"), "[1]").unwrap();
        assert!(wake_enabled_in(&base), "junk means on");
        set_wake_enabled_in(&base, false).unwrap();
        assert!(!wake_enabled_in(&base));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn waiter_file_round_trips_token_pid_and_busy() {
        let base = scratch("waiter");
        assert_eq!(read_waiter_in(&base, "s1"), None);
        let w = Waiter::Waiting { token: "abc".into(), pid: 42 };
        write_waiter_in(&base, "s1", &w).unwrap();
        assert_eq!(std::fs::read_to_string(base.join("waiters").join("s1")).unwrap(), "abc 42");
        assert_eq!(read_waiter_in(&base, "s1"), Some(w));
        assert!(waiter_token_is(&base, "s1", "abc"));
        assert!(!waiter_token_is(&base, "s1", "abd"));
        write_waiter_in(&base, "s1", &Waiter::Busy).unwrap();
        assert_eq!(read_waiter_in(&base, "s1"), Some(Waiter::Busy));
        assert!(!waiter_token_is(&base, "s1", "abc"));
        assert!(write_waiter_in(&base, "../x", &Waiter::Busy).is_err());
        for junk in ["", "abc", "abc x", " 5"] {
            std::fs::write(base.join("waiters").join("s1"), junk).unwrap();
            assert_eq!(read_waiter_in(&base, "s1"), None, "{junk:?}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn take_unread_delivers_each_complete_event_once() {
        let base = scratch("cursor");
        let doc = base.join("d.md");
        std::fs::write(&doc, "x").unwrap();
        let doc = doc.to_string_lossy().into_owned();
        assert!(!has_unread_in(&base, "s1"));
        assert!(take_unread_in(&base, "s1").unwrap().is_empty());
        record_owner_in(&base, &doc, "s1").unwrap();
        append_event_in(&base, &doc, EventKind::Save, None).unwrap();
        append_event_in(&base, &doc, EventKind::Comment, Some(2)).unwrap();
        assert!(has_unread_in(&base, "s1"));
        let got = take_unread_in(&base, "s1").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[1]["number"], 2);
        assert!(!has_unread_in(&base, "s1"));
        assert!(take_unread_in(&base, "s1").unwrap().is_empty());

        // Added while nobody waits: the next reader gets it.
        append_event_in(&base, &doc, EventKind::Reply, Some(2)).unwrap();
        // A half-written line is left for later.
        let path = base.join("events").join("s1.jsonl");
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"{\"kind\":\"sa").unwrap();
        let got = take_unread_in(&base, "s1").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["kind"], "reply");
        assert!(take_unread_in(&base, "s1").unwrap().is_empty());
        f.write_all(b"ve\"}\n").unwrap();
        assert_eq!(take_unread_in(&base, "s1").unwrap()[0]["kind"], "save");

        // A replaced (shorter) file is read from the start.
        std::fs::write(&path, "{\"kind\":\"comment\"}\n").unwrap();
        assert!(has_unread_in(&base, "s1"));
        assert_eq!(take_unread_in(&base, "s1").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn session_lock_serializes_holders() {
        let base = scratch("lock");
        let held = with_session_lock(&base, "s1", || with_session_lock(&base, "s2", || Ok(7))).unwrap();
        assert_eq!(held, 7);
        assert!(with_session_lock(&base, "../x", || Ok(())).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn mdview_open_marks_a_new_session_busy_but_keeps_a_waiter() {
        let base = scratch("owner-busy");
        let doc = base.join("d.md");
        std::fs::write(&doc, "x").unwrap();
        let doc = doc.to_string_lossy().into_owned();
        assert!(!owns_any_doc_in(&base, "s1"));
        record_owner_in(&base, &doc, "s1").unwrap();
        assert!(owns_any_doc_in(&base, "s1"));
        assert!(!owns_any_doc_in(&base, "s2"));
        assert_eq!(read_waiter_in(&base, "s1"), Some(Waiter::Busy));
        let w = Waiter::Waiting { token: "t".into(), pid: 9 };
        write_waiter_in(&base, "s1", &w).unwrap();
        record_owner_in(&base, &doc, "s1").unwrap();
        assert_eq!(read_waiter_in(&base, "s1"), Some(w));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn wake_status_follows_owner_waiter_and_toggle() {
        let base = scratch("status");
        let doc = base.join("d.md");
        std::fs::write(&doc, "x").unwrap();
        let doc = doc.to_string_lossy().into_owned();
        let alive = |pid: u32| pid == 1;
        assert_eq!(wake_status_in(&base, &doc, alive), WakeStatus::Unowned);
        record_owner_in(&base, &doc, "s1").unwrap();
        assert_eq!(wake_status_in(&base, &doc, alive), WakeStatus::Listening, "busy mid-turn");
        write_waiter_in(&base, "s1", &Waiter::Waiting { token: "t".into(), pid: 1 }).unwrap();
        assert_eq!(wake_status_in(&base, &doc, alive), WakeStatus::Listening);
        write_waiter_in(&base, "s1", &Waiter::Waiting { token: "t".into(), pid: 2 }).unwrap();
        assert_eq!(wake_status_in(&base, &doc, alive), WakeStatus::NotListening, "dead pid");
        std::fs::remove_file(base.join("waiters").join("s1")).unwrap();
        assert_eq!(wake_status_in(&base, &doc, alive), WakeStatus::NotListening, "no waiter file");
        set_wake_enabled_in(&base, false).unwrap();
        assert_eq!(wake_status_in(&base, &doc, alive), WakeStatus::Off);
        let _ = std::fs::remove_dir_all(&base);
    }
}
