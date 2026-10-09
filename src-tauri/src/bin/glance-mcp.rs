// Glance MCP server — stdio JSON-RPC. Lets a Claude session read the user's
// anchored annotations on a markdown file: read, reply, resolve (with a note),
// and add its own pointers.

use glance_lib::anchor::{resolve_anchor, Annotation, LineHint, Reply};
use glance_lib::annotations::{
    apply_reply, mutate_store, now_iso8601, push_annotation, read_store, store_dir, unique_id, AnnotationStore,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

#[derive(Serialize, PartialEq, Debug)]
struct AnnotationView {
    id: String,
    number: u32,
    note: String,
    quote: String,
    #[serde(rename = "lineStart")]
    line_start: Option<usize>,
    #[serde(rename = "lineEnd")]
    line_end: Option<usize>,
    status: String,
    author: String,
    anchor: String,
    #[serde(rename = "resolvedBy", skip_serializing_if = "Option::is_none")]
    resolved_by: Option<String>,
    #[serde(rename = "resolvedAt", skip_serializing_if = "Option::is_none")]
    resolved_at: Option<String>,
    replies: Vec<Reply>,
}

fn view_of(a: &Annotation, text: &str) -> AnnotationView {
    let r = resolve_anchor(text, a);
    AnnotationView {
        id: a.id.clone(),
        number: a.number,
        note: a.note.clone(),
        quote: a.quote.clone(),
        line_start: r.start_line,
        line_end: r.end_line,
        status: a.status.clone(),
        author: a.author.clone(),
        anchor: r.anchor,
        resolved_by: a.resolved_by.clone(),
        resolved_at: a.resolved_at.clone(),
        replies: a.replies.clone(),
    }
}

#[derive(Serialize, PartialEq, Debug)]
struct Context {
    before: Vec<String>,
    after: Vec<String>,
}

/// `get_annotation` payload: the list view plus the lines around the range.
/// `context` is `None` when the annotation is orphaned (no current lines).
#[derive(Serialize)]
struct AnnotationDetail {
    #[serde(flatten)]
    view: AnnotationView,
    context: Option<Context>,
}

const CONTEXT_LINES: usize = 3;

/// Up to `n` lines on each side of the 1-indexed inclusive range
/// `start..=end`, clamped at the file edges.
fn context_around(text: &str, start: usize, end: usize, n: usize) -> Context {
    let lines: Vec<&str> = text.lines().collect();
    let before_to = start.saturating_sub(1).min(lines.len());
    let before_from = before_to.saturating_sub(n);
    let after_from = end.min(lines.len());
    let after_to = end.saturating_add(n).min(lines.len());
    Context {
        before: lines[before_from..before_to].iter().map(|l| l.to_string()).collect(),
        after: lines[after_from..after_to].iter().map(|l| l.to_string()).collect(),
    }
}

fn detail_of(a: &Annotation, text: &str) -> AnnotationDetail {
    let view = view_of(a, text);
    let context = match (view.line_start, view.line_end) {
        (Some(s), Some(e)) => Some(context_around(text, s, e, CONTEXT_LINES)),
        _ => None,
    };
    AnnotationDetail { view, context }
}

/// Build the view list, sorted by number, optionally filtered by status (default "open").
///
/// Filtering happens on the resolved view so that `orphaned` (a live anchor
/// state, not a stored status) is meaningful:
///   "all"      → every annotation
///   "open"     → status == "open" AND anchor != "orphaned"
///   "resolved" → status == "resolved"
///   "orphaned" → anchor == "orphaned" (quote absent from current text)
fn build_views(store: &AnnotationStore, text: &str, status_filter: Option<&str>) -> Vec<AnnotationView> {
    let filter = status_filter.unwrap_or("open");
    let mut views: Vec<AnnotationView> = store
        .annotations
        .iter()
        .map(|a| view_of(a, text))
        .filter(|v| match filter {
            "all" => true,
            "open" => v.status == "open" && v.anchor != "orphaned",
            "resolved" => v.status == "resolved",
            "orphaned" => v.anchor == "orphaned",
            _ => false,
        })
        .collect();
    views.sort_by_key(|v| v.number);
    views
}

/// Mark one annotation resolved in-place, recording that Claude did it and
/// when. A non-empty `note` is appended to the thread as a Claude reply first,
/// so the card shows what changed. Returns true if it was found.
fn apply_resolve(store: &mut AnnotationStore, id: &str, note: Option<&str>) -> bool {
    for a in store.annotations.iter_mut() {
        if a.id == id {
            let now = now_iso8601();
            if let Some(n) = note.map(str::trim).filter(|n| !n.is_empty()) {
                apply_reply(a, "claude", n, &now);
            }
            a.status = "resolved".to_string();
            a.resolved_by = Some("claude".to_string());
            a.resolved_at = Some(now);
            return true;
        }
    }
    false
}

/// Append a Claude reply to one annotation in-place, leaving its status alone.
/// Returns true if it was found.
fn apply_claude_reply(store: &mut AnnotationStore, id: &str, text: &str) -> bool {
    match store.annotations.iter_mut().find(|a| a.id == id) {
        Some(a) => {
            apply_reply(a, "claude", text, &now_iso8601());
            true
        }
        None => false,
    }
}

/// Build a Claude-authored annotation for `add_annotation`. `line_hint` falls
/// back to the resolved location (filled in by the caller) so a later drift
/// lands near the pointer rather than on line 1.
fn claude_annotation(path: &str, quote: &str, note: &str, prefix: &str, suffix: &str, line_hint: Option<LineHint>) -> Annotation {
    let now = now_iso8601();
    Annotation {
        id: unique_id(&format!("{path}{quote}{note}{now}")),
        quote: quote.to_string(),
        prefix: prefix.to_string(),
        suffix: suffix.to_string(),
        line_hint: line_hint.unwrap_or(LineHint { start: 1, end: 1 }),
        note: note.to_string(),
        status: "open".to_string(),
        author: "claude".to_string(),
        created_at: now,
        number: 0,
        resolved_by: None,
        resolved_at: None,
        replies: Vec::new(),
        extra: Default::default(),
    }
}

/// Parse `add_annotation`'s optional `lineHint` against a doc of `total_lines`
/// lines (numbered as the anchor resolver numbers them). Anything but whole
/// numbers with 1 <= start <= end <= total_lines is an error, so no stored hint
/// can be negative, inverted, or large enough to overflow later arithmetic.
fn line_hint_arg(v: Option<&Value>, total_lines: usize) -> Result<Option<LineHint>, String> {
    let Some(v) = v.filter(|v| !v.is_null()) else { return Ok(None) };
    let bad = || format!("'lineHint' must be {{\"start\": n, \"end\": m}} with 1 <= start <= end <= {total_lines}, the file's line count");
    let obj = v.as_object().ok_or_else(bad)?;
    let line = |key: &str| match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(n) => n.as_u64().filter(|&n| n >= 1 && n <= total_lines as u64).map(|n| Some(n as usize)).ok_or_else(bad),
    };
    let start = line("start")?.ok_or_else(bad)?;
    let end = line("end")?.unwrap_or(start);
    if end < start {
        return Err(bad());
    }
    Ok(Some(LineHint { start, end }))
}

fn line_count(text: &str) -> usize {
    text.bytes().filter(|&b| b == b'\n').count() + 1
}

/// Most docs a `--pending` run will mention. Keeps the injected context short.
const PENDING_MAX_DOCS: usize = 5;

/// One context line per project doc with open comments, for the
/// `UserPromptSubmit` hook. `stores` are `(store file, parsed store)` pairs;
/// `read_doc` returns the doc text or `None` if the doc is gone. Only docs
/// under `cwd` count; a doc with zero open (non-orphaned) comments is skipped.
/// Newest store file first, capped at [`PENDING_MAX_DOCS`]. Prints nothing
/// when there is nothing to say.
fn pending_lines(
    cwd: &Path,
    stores: Vec<(PathBuf, AnnotationStore)>,
    read_doc: impl Fn(&str) -> Option<String>,
) -> Vec<String> {
    // Stores record the doc's canonical path (older ones the app's spelling),
    // so match the cwd as given and canonicalized.
    let prefix_of = |p: &Path| format!("{}/", p.to_string_lossy().trim_end_matches('/'));
    let mut prefixes = vec![prefix_of(cwd)];
    if let Ok(canonical) = std::fs::canonicalize(cwd) {
        prefixes.push(prefix_of(&canonical));
    }
    let mut found: Vec<(std::time::SystemTime, String)> = Vec::new();
    for (store_path, store) in stores {
        let Some(rel) = prefixes.iter().find_map(|p| store.doc_path.strip_prefix(p.as_str())) else { continue };
        let Some(text) = read_doc(&store.doc_path) else { continue };
        let n = build_views(&store, &text, Some("open")).len();
        if n == 0 {
            continue;
        }
        let noun = if n == 1 { "comment" } else { "comments" };
        let mtime = std::fs::metadata(&store_path)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        found.push((
            mtime,
            format!("Glance: {n} open review {noun} on {rel}. Read them with list_annotations before continuing."),
        ));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().take(PENDING_MAX_DOCS).map(|(_, line)| line).collect()
}

/// Every parseable `~/.glance/annotations/*.json` store. Lock files and
/// unreadable stores are skipped; a missing dir yields nothing.
fn load_stores() -> Vec<(PathBuf, AnnotationStore)> {
    let Some(dir) = store_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            let store: AnnotationStore = serde_json::from_str(&text).ok()?;
            Some((p, store))
        })
        .collect()
}

/// `glance-mcp --pending [cwd]`: print the pending-comment context lines and
/// exit 0 whatever happens. `cwd` comes from argv, else the hook event JSON on
/// stdin, else the process cwd. stdin is only read when argv lacks a cwd, so a
/// manual `--pending /path` never waits on a terminal.
fn run_pending(argv: &[String]) {
    let cwd = match argv.get(2) {
        Some(c) => Some(PathBuf::from(c)),
        None => {
            let mut input = String::new();
            let _ = std::io::stdin().read_to_string(&mut input);
            serde_json::from_str::<Value>(&input)
                .ok()
                .and_then(|v| v.get("cwd")?.as_str().map(PathBuf::from))
                .or_else(|| std::env::current_dir().ok())
        }
    };
    let Some(cwd) = cwd else { return };
    let mut stdout = std::io::stdout();
    for line in pending_lines(&cwd, load_stores(), |p| std::fs::read_to_string(p).ok()) {
        let _ = writeln!(stdout, "{line}");
    }
    let _ = stdout.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann(id: &str, quote: &str, status: &str) -> Annotation {
        Annotation {
            id: id.into(),
            quote: quote.into(),
            prefix: "".into(),
            suffix: "".into(),
            line_hint: LineHint { start: 1, end: 1 },
            note: "note".into(),
            status: status.into(),
            author: "user".into(),
            created_at: "t".into(),
            number: 0,
            resolved_by: None,
            resolved_at: None,
            replies: Vec::new(),
            extra: Default::default(),
        }
    }

    fn store_of(anns: Vec<Annotation>) -> AnnotationStore {
        AnnotationStore { doc_path: "/d.md".into(), annotations: anns, ..Default::default() }
    }

    #[test]
    fn build_views_defaults_to_open_only_and_resolves_lines() {
        let store = store_of(vec![ann("a", "hello", "open"), ann("b", "x", "resolved")]);
        let views = build_views(&store, "hello world\n", None);
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].id, "a");
        assert_eq!(views[0].line_start, Some(1));
        assert_eq!(views[0].anchor, "exact"); // prefix="" suffix="" → full==quote → exact match
    }

    #[test]
    fn build_views_all_includes_resolved() {
        let store = store_of(vec![ann("a", "hello", "open"), ann("b", "x", "resolved")]);
        let views = build_views(&store, "hello x\n", Some("all"));
        assert_eq!(views.len(), 2);
    }

    #[test]
    fn build_views_carries_number_and_sorts_by_it() {
        let mut second = ann("b", "hello", "open");
        second.number = 2;
        let mut first = ann("a", "hello", "open");
        first.number = 1;
        let store = store_of(vec![second, first]);
        let views = build_views(&store, "hello world\n", None);
        let nums: Vec<u32> = views.iter().map(|v| v.number).collect();
        assert_eq!(nums, vec![1, 2]);
        assert_eq!(views[0].id, "a");
        let json = serde_json::to_value(&views[0]).unwrap();
        assert_eq!(json["number"], 1);
    }

    #[test]
    fn apply_resolve_sets_status_and_records_claude() {
        let mut store = store_of(vec![ann("a", "hello", "open")]);
        assert!(apply_resolve(&mut store, "a", None));
        let a = &store.annotations[0];
        assert_eq!(a.status, "resolved");
        assert_eq!(a.resolved_by.as_deref(), Some("claude"));
        assert_eq!(a.resolved_at.as_ref().map(|t| t.len()), Some(20));
        assert!(a.resolved_at.as_deref().unwrap().ends_with('Z'));
        assert!(a.replies.is_empty());
        assert!(!apply_resolve(&mut store, "missing", None));
    }

    #[test]
    fn apply_resolve_with_note_appends_claude_reply_then_resolves() {
        let mut store = store_of(vec![ann("a", "hello", "open")]);
        assert!(apply_resolve(&mut store, "a", Some("Cut the cap to 5 min; batch keeps 10")));
        let a = &store.annotations[0];
        assert_eq!(a.status, "resolved");
        assert_eq!(a.replies.len(), 1);
        assert_eq!(a.replies[0].author, "claude");
        assert_eq!(a.replies[0].text, "Cut the cap to 5 min; batch keeps 10");
        assert_eq!(a.replies[0].created_at, a.resolved_at.clone().unwrap());
        // An empty or whitespace note is not a reply.
        let mut store = store_of(vec![ann("b", "hello", "open")]);
        assert!(apply_resolve(&mut store, "b", Some("   ")));
        assert!(store.annotations[0].replies.is_empty());
    }

    #[test]
    fn apply_claude_reply_appends_and_leaves_status_open() {
        let mut store = store_of(vec![ann("a", "hello", "open")]);
        assert!(apply_claude_reply(&mut store, "a", "Which section did you mean?"));
        let a = &store.annotations[0];
        assert_eq!(a.status, "open");
        assert_eq!(a.resolved_by, None);
        assert_eq!(a.replies.len(), 1);
        assert_eq!(a.replies[0].author, "claude");
        assert_eq!(a.replies[0].text, "Which section did you mean?");
        assert!(!apply_claude_reply(&mut store, "missing", "x"));
    }

    #[test]
    fn view_json_includes_replies() {
        let open = ann("a", "hello", "open");
        let json = serde_json::to_value(view_of(&open, "hello\n")).unwrap();
        assert_eq!(json["replies"], json!([]));
        let mut threaded = ann("b", "hello", "open");
        threaded.replies.push(Reply { author: "claude".into(), text: "why?".into(), created_at: "2026-09-01T00:00:00Z".into() });
        let json = serde_json::to_value(view_of(&threaded, "hello\n")).unwrap();
        assert_eq!(json["replies"], json!([{ "author": "claude", "text": "why?", "createdAt": "2026-09-01T00:00:00Z" }]));
    }

    #[test]
    fn tool_schemas_list_reply_and_resolve_note() {
        let schemas = tool_schemas();
        let names: Vec<&str> = schemas.as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"reply_annotation"));
        let resolve = schemas.as_array().unwrap().iter().find(|t| t["name"] == "resolve_annotation").unwrap();
        assert_eq!(resolve["inputSchema"]["properties"]["note"]["type"], "string");
        assert_eq!(resolve["inputSchema"]["required"], json!(["path", "id"]));
        let reply = schemas.as_array().unwrap().iter().find(|t| t["name"] == "reply_annotation").unwrap();
        assert_eq!(reply["inputSchema"]["required"], json!(["path", "id", "text"]));
    }

    #[test]
    fn view_carries_resolution_fields_only_when_present() {
        let open = ann("a", "hello", "open");
        let json = serde_json::to_value(view_of(&open, "hello\n")).unwrap();
        assert!(json.get("resolvedBy").is_none());
        let mut done = ann("b", "hello", "resolved");
        done.resolved_by = Some("claude".into());
        done.resolved_at = Some("2026-09-01T00:00:00Z".into());
        let json = serde_json::to_value(view_of(&done, "hello\n")).unwrap();
        assert_eq!(json["resolvedBy"], "claude");
        assert_eq!(json["resolvedAt"], "2026-09-01T00:00:00Z");
    }

    #[test]
    fn handle_ping_returns_empty_ok() {
        let result = handle("ping", &json!({}));
        assert!(matches!(result, Some(Ok(_))), "ping must return Some(Ok(_))");
        if let Some(Ok(v)) = result {
            assert_eq!(v, json!({}));
        }
    }

    const NINE: &str = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn context_around_middle_of_file() {
        let c = context_around(NINE, 5, 5, 3);
        assert_eq!(c.before, strs(&["l2", "l3", "l4"]));
        assert_eq!(c.after, strs(&["l6", "l7", "l8"]));
        // Multi-line range: context hugs both ends.
        let c = context_around(NINE, 4, 6, 3);
        assert_eq!(c.before, strs(&["l1", "l2", "l3"]));
        assert_eq!(c.after, strs(&["l7", "l8", "l9"]));
    }

    #[test]
    fn context_around_first_line_has_nothing_before() {
        let c = context_around(NINE, 1, 1, 3);
        assert!(c.before.is_empty());
        assert_eq!(c.after, strs(&["l2", "l3", "l4"]));
        let c = context_around(NINE, 2, 2, 3);
        assert_eq!(c.before, strs(&["l1"]));
    }

    #[test]
    fn context_around_last_line_has_nothing_after() {
        let c = context_around(NINE, 9, 9, 3);
        assert_eq!(c.before, strs(&["l6", "l7", "l8"]));
        assert!(c.after.is_empty());
        let c = context_around(NINE, 8, 8, 3);
        assert_eq!(c.after, strs(&["l9"]));
    }

    #[test]
    fn context_around_short_file_clamps_both_sides() {
        let c = context_around("a\nb\n", 1, 1, 3);
        assert!(c.before.is_empty());
        assert_eq!(c.after, strs(&["b"]));
        let c = context_around("a\nb\n", 2, 2, 3);
        assert_eq!(c.before, strs(&["a"]));
        assert!(c.after.is_empty());
        // Range past the end of the file must not panic.
        let c = context_around("a\n", 7, 9, 3);
        assert_eq!(c.before, strs(&["a"]));
        assert!(c.after.is_empty());
    }

    #[test]
    fn context_around_huge_end_does_not_overflow() {
        let c = context_around(NINE, 5, usize::MAX, 3);
        assert_eq!(c.before, strs(&["l2", "l3", "l4"]));
        assert!(c.after.is_empty());
        let c = context_around(NINE, usize::MAX, usize::MAX, 3);
        assert_eq!(c.before, strs(&["l7", "l8", "l9"]));
    }

    #[test]
    fn line_hint_arg_accepts_only_sane_ranges() {
        let parse = |v: Value| line_hint_arg(Some(&v), 9);
        assert_eq!(parse(json!({ "start": 2 })), Ok(Some(LineHint { start: 2, end: 2 })));
        assert_eq!(parse(json!({ "start": 2, "end": 9 })), Ok(Some(LineHint { start: 2, end: 9 })));
        assert_eq!(parse(Value::Null), Ok(None));
        assert_eq!(line_hint_arg(None, 9), Ok(None));
        for bad in [
            json!({ "start": -3 }),
            json!({ "start": 0 }),
            json!({ "start": 7, "end": 2 }),
            json!({ "start": 2, "end": 10 }),
            json!({ "start": 2, "end": 18446744073709551615u64 }),
            json!({ "start": 9223372036854775808u64 }),
            json!({ "start": 2.5 }),
            json!({ "start": "2" }),
            json!({ "end": 3 }),
            json!(3),
        ] {
            let err = parse(bad.clone()).unwrap_err();
            assert!(err.contains("lineHint"), "{bad}: {err}");
        }
    }

    #[test]
    #[serial_test::serial]
    fn get_annotation_survives_a_stored_hint_end_near_u64_max() {
        let home = fresh_home("huge-hint");
        let doc = home.join("doc.md").to_string_lossy().into_owned();
        std::fs::write(&doc, NINE).unwrap();
        let mut a = ann("big", "GONE", "open");
        a.line_hint = LineHint { start: 2, end: usize::MAX };
        mutate_store(&doc, |s| s.annotations.push(a.clone())).unwrap();
        let out = call_tool("get_annotation", &json!({ "path": doc, "id": "big" })).unwrap();
        let detail = tool_json(&out);
        assert_eq!(detail["anchor"], "drifted");
        assert_eq!((detail["lineStart"].as_u64(), detail["lineEnd"].as_u64()), (Some(2), Some(10)));
        assert_eq!(detail["context"]["before"], json!(["l1"]));
    }

    #[test]
    fn detail_of_orphaned_has_no_context() {
        let mut a = ann("a", "NOTINTEXTEVER", "open");
        a.line_hint = LineHint { start: 99, end: 99 };
        let json = serde_json::to_value(detail_of(&a, "hello world\n")).unwrap();
        assert_eq!(json["anchor"], "orphaned");
        assert_eq!(json["context"], Value::Null);
        // Anchored: the view's fields are flattened next to `context`.
        let json = serde_json::to_value(detail_of(&ann("b", "l5", "open"), NINE)).unwrap();
        assert_eq!(json["id"], "b");
        assert_eq!(json["lineStart"], 5);
        assert_eq!(json["context"]["before"], json!(["l2", "l3", "l4"]));
        assert_eq!(json["context"]["after"], json!(["l6", "l7", "l8"]));
    }

    #[test]
    #[serial_test::serial]
    fn get_annotation_tool_returns_context_from_disk() {
        let home = "/tmp/glance-test-mcp-context";
        let _ = std::fs::remove_dir_all(home);
        std::env::set_var("HOME", home);
        std::fs::create_dir_all(home).unwrap();
        let doc = format!("{home}/doc.md");
        std::fs::write(&doc, NINE).unwrap();
        mutate_store(&doc, |s| s.annotations.push(ann("mid", "l5", "open"))).unwrap();

        let out = call_tool("get_annotation", &json!({ "path": doc, "id": "mid" })).unwrap();
        let payload: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(payload["id"], "mid");
        assert_eq!(payload["lineStart"], 5);
        assert_eq!(payload["lineEnd"], 5);
        assert_eq!(payload["context"]["before"], json!(["l2", "l3", "l4"]));
        assert_eq!(payload["context"]["after"], json!(["l6", "l7", "l8"]));

        // list_annotations is unchanged: no context field.
        let out = call_tool("list_annotations", &json!({ "path": doc })).unwrap();
        let list: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(list[0].get("context").is_none());
    }

    #[test]
    #[serial_test::serial]
    fn add_annotation_tool_creates_claude_pointers_and_rejects_missing_quotes() {
        let home = "/tmp/glance-test-mcp-add";
        let _ = std::fs::remove_dir_all(home);
        std::env::set_var("HOME", home);
        std::fs::create_dir_all(home).unwrap();
        let doc = format!("{home}/doc.md");
        std::fs::write(&doc, NINE).unwrap();

        let out = call_tool("add_annotation", &json!({ "path": doc, "quote": "l5", "note": "see here" })).unwrap();
        let first: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(first["number"], 1);
        assert_eq!(first["author"], "claude");
        assert_eq!(first["note"], "see here");
        assert_eq!(first["quote"], "l5");
        assert_eq!(first["lineStart"], 5);
        assert_eq!(first["anchor"], "exact");
        assert_eq!(first["id"].as_str().unwrap().len(), 8);

        let out = call_tool("add_annotation", &json!({ "path": doc, "quote": "l7", "note": "and here" })).unwrap();
        let second: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(second["number"], 2);
        assert_ne!(second["id"], first["id"]);

        // The same quote and note twice in one second (a retry) still gets two ids.
        let out = call_tool("add_annotation", &json!({ "path": doc, "quote": "l7", "note": "and here" })).unwrap();
        let retry: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_ne!(retry["id"], second["id"]);
        mutate_store(&doc, |s| s.annotations.retain(|a| a.id != retry["id"].as_str().unwrap())).unwrap();

        let store = read_store(&doc).unwrap();
        assert_eq!(store.annotations.len(), 2);
        assert!(store.annotations.iter().all(|a| a.author == "claude" && a.status == "open"));
        assert_eq!(store.annotations[0].line_hint, LineHint { start: 5, end: 5 });

        // A quote not in the file errors and writes nothing (line hint in range → "drifted").
        let err = call_tool("add_annotation", &json!({ "path": doc, "quote": "NOTINTEXTEVER", "note": "x" })).unwrap_err();
        assert!(err.contains("quote not found"), "{err}");
        assert_eq!(read_store(&doc).unwrap().annotations.len(), 2);
        // A line hint past the end of the file is refused before anything is written.
        let err = call_tool("add_annotation", &json!({ "path": doc, "quote": "NOTINTEXTEVER", "note": "x", "lineHint": { "start": 99 } })).unwrap_err();
        assert!(err.contains("lineHint"), "{err}");
        assert_eq!(read_store(&doc).unwrap().annotations.len(), 2);

        // list_annotations shows both, numbered.
        let out = call_tool("list_annotations", &json!({ "path": doc })).unwrap();
        let list: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2);
        assert_eq!(list[1]["number"], 2);
    }

    #[test]
    #[serial_test::serial]
    fn damaged_store_errors_on_every_tool_and_is_left_alone() {
        let home = std::env::temp_dir().join("glance-test-mcp-damaged");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        let doc = home.join("doc.md").to_string_lossy().to_string();
        std::fs::write(&doc, NINE).unwrap();
        mutate_store(&doc, |s| s.annotations.push(ann("mid", "l5", "open"))).unwrap();
        let store_path = glance_lib::annotations::store_path_for(&doc).unwrap();
        let damaged = std::fs::read_to_string(&store_path).unwrap().replacen("\"prefix\"", "\"prefx\"", 1);
        std::fs::write(&store_path, &damaged).unwrap();

        for (tool, extra) in [
            ("list_annotations", json!({})),
            ("get_annotation", json!({ "id": "mid" })),
            ("resolve_annotation", json!({ "id": "mid", "note": "done" })),
            ("reply_annotation", json!({ "id": "mid", "text": "why?" })),
            ("add_annotation", json!({ "quote": "l7", "note": "x" })),
        ] {
            let mut args = extra;
            args["path"] = json!(doc);
            let err = call_tool(tool, &args).unwrap_err();
            assert!(err.contains("damaged"), "{tool}: {err}");
        }
        let uri = format!("glance://annotations/{doc}");
        assert!(matches!(handle("resources/read", &json!({ "uri": uri })), Some(Err(_))));
        assert_eq!(std::fs::read_to_string(&store_path).unwrap(), damaged);
    }

    fn fresh_home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("glance-test-mcp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        home
    }

    fn tool_json(out: &Value) -> Value {
        serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    #[test]
    #[serial_test::serial]
    fn tools_only_touch_existing_markdown_and_text_files() {
        let home = fresh_home("paths");
        let doc = home.join("doc.md");
        std::fs::write(&doc, NINE).unwrap();
        std::fs::write(home.join("secret.env"), "password=hunter2\n").unwrap();
        std::fs::write(home.join("profile"), "password=hunter2\n").unwrap();
        std::os::unix::fs::symlink(home.join("profile"), home.join("notes.md")).unwrap();
        std::fs::create_dir_all(home.join("dir.md")).unwrap();
        let p = |name: &str| home.join(name).to_string_lossy().into_owned();
        let cases = [
            (p("secret.env"), "only annotates markdown and text"),
            (p("notes.md"), "only annotates markdown and text"), // judged by the symlink's target
            (p("dir.md"), "not a file"),
            (p("missing.md"), "no such file"),
            ("doc.md".to_string(), "must be absolute"),
            ("~/missing.md".to_string(), "no such file"),
        ];
        for (path, want) in &cases {
            for tool in ["list_annotations", "get_annotation", "add_annotation", "resolve_annotation", "reply_annotation"] {
                let args = json!({ "path": path, "id": "x", "quote": "password", "note": "n", "text": "t" });
                let err = call_tool(tool, &args).unwrap_err();
                assert!(err.contains(want), "{tool} {path}: {err}");
            }
        }
        assert!(!home.join(".glance").exists(), "a refused path must not create a store");

        // A symlink to a doc, `~/`, `./` and `//` all reach the one store.
        std::os::unix::fs::symlink(&doc, home.join("alias.md")).unwrap();
        call_tool("add_annotation", &json!({ "path": p("alias.md"), "quote": "l2", "note": "n" })).unwrap();
        for spelling in ["~/doc.md".to_string(), p("./doc.md"), format!("{}//doc.md", home.display()), p("doc.md")] {
            let out = call_tool("list_annotations", &json!({ "path": spelling })).unwrap();
            assert_eq!(tool_json(&out).as_array().unwrap().len(), 1, "{spelling}");
        }
    }

    #[test]
    #[serial_test::serial]
    fn failed_resolve_or_reply_on_an_existing_doc_creates_nothing() {
        let home = fresh_home("noop");
        let doc = home.join("doc.md").to_string_lossy().into_owned();
        std::fs::write(&doc, NINE).unwrap();
        assert!(call_tool("resolve_annotation", &json!({ "path": doc, "id": "zzz" })).unwrap_err().contains("no annotation"));
        assert!(call_tool("reply_annotation", &json!({ "path": doc, "id": "zzz", "text": "hi" })).unwrap_err().contains("no annotation"));
        assert!(call_tool("get_annotation", &json!({ "path": doc, "id": "zzz" })).is_err());
        assert!(!home.join(".glance").exists());
    }

    #[test]
    fn build_views_orphaned_filter_returns_unresolvable() {
        // Quote absent from text AND line_hint out of range → resolve_anchor returns "orphaned".
        // (If line_hint were in range the fallback would be "drifted", not "orphaned".)
        let a = Annotation {
            id: "a".into(),
            quote: "NOTINTEXTEVER".into(),
            prefix: "".into(),
            suffix: "".into(),
            line_hint: LineHint { start: 99, end: 99 },
            note: "note".into(),
            status: "open".into(),
            author: "user".into(),
            created_at: "t".into(),
            number: 0,
            resolved_by: None,
            resolved_at: None,
            replies: Vec::new(),
            extra: Default::default(),
        };
        let store = store_of(vec![a]);
        let text = "hello world\n"; // 1 line only, so line_hint 99 is out of range → orphaned
        let orphaned = build_views(&store, text, Some("orphaned"));
        assert_eq!(orphaned.len(), 1, "orphaned filter must include unresolvable annotation");
        assert_eq!(orphaned[0].id, "a");
        assert_eq!(orphaned[0].anchor, "orphaned");
        let open = build_views(&store, text, Some("open"));
        assert_eq!(open.len(), 0, "open filter must exclude orphaned annotations");
    }

    // --- pending ----------------------------------------------------------

    fn store_at(doc_path: &str, anns: Vec<Annotation>) -> (PathBuf, AnnotationStore) {
        (
            PathBuf::from(format!("/nonexistent/{}.json", doc_path.replace('/', "_"))),
            AnnotationStore { doc_path: doc_path.into(), annotations: anns, ..Default::default() },
        )
    }

    // Every doc reads as "hello world\n" so a quote of "hello" anchors exactly.
    fn any_doc(_: &str) -> Option<String> {
        Some("hello world\n".into())
    }

    #[test]
    fn pending_lines_excludes_docs_outside_cwd() {
        let stores = vec![
            store_at("/proj/docs/plan.md", vec![ann("a", "hello", "open")]),
            store_at("/other/notes.md", vec![ann("b", "hello", "open")]),
            store_at("/projects/x.md", vec![ann("c", "hello", "open")]), // prefix match, not a child
        ];
        let lines = pending_lines(Path::new("/proj"), stores, any_doc);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("docs/plan.md"), "{}", lines[0]);
    }

    #[test]
    fn pending_lines_skips_zero_open_and_missing_docs() {
        let mut orphan = ann("o", "NOTINTEXTEVER", "open");
        orphan.line_hint = LineHint { start: 99, end: 99 }; // quote gone + hint out of range → orphaned
        let stores = vec![
            store_at("/proj/resolved.md", vec![ann("a", "hello", "resolved")]),
            store_at("/proj/orphaned.md", vec![orphan]),
            store_at("/proj/drifted.md", vec![ann("b", "NOTINTEXT", "open")]), // hint in range → drifted, still open
            store_at("/proj/gone.md", vec![ann("c", "hello", "open")]),
            store_at("/proj/empty.md", vec![]),
        ];
        let lines = pending_lines(Path::new("/proj"), stores, |p| if p.ends_with("gone.md") { None } else { any_doc(p) });
        // resolved/orphaned → 0 open; gone → doc missing; empty → nothing; drifted stays open.
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("drifted.md"));
        // trailing slash on cwd is tolerated
        let stores = vec![store_at("/proj/a.md", vec![ann("a", "hello", "open")])];
        assert_eq!(pending_lines(Path::new("/proj/"), stores, any_doc).len(), 1);
    }

    #[test]
    fn pending_lines_wording_and_relative_path() {
        let one = vec![store_at("/proj/docs/plan.md", vec![ann("a", "hello", "open")])];
        assert_eq!(
            pending_lines(Path::new("/proj"), one, any_doc),
            vec!["Glance: 1 open review comment on docs/plan.md. Read them with list_annotations before continuing."]
        );
        let three = vec![store_at(
            "/proj/docs/plan.md",
            vec![ann("a", "hello", "open"), ann("b", "world", "open"), ann("c", "hello", "open"), ann("d", "x", "resolved")],
        )];
        assert_eq!(
            pending_lines(Path::new("/proj"), three, any_doc),
            vec!["Glance: 3 open review comments on docs/plan.md. Read them with list_annotations before continuing."]
        );
    }

    #[test]
    fn pending_lines_matches_a_symlinked_cwd_against_canonical_doc_paths() {
        let dir = Path::new("/tmp").join(format!("glance-test-pending-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = std::fs::canonicalize(&dir).unwrap();
        assert_ne!(canonical, dir); // /tmp -> /private/tmp
        let stores = vec![
            store_at(&format!("{}/new.md", canonical.display()), vec![ann("a", "hello", "open")]),
            store_at(&format!("{}/old.md", dir.display()), vec![ann("b", "hello", "open")]),
        ];
        let lines = pending_lines(&dir, stores, any_doc);
        assert_eq!(lines.len(), 2, "{lines:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pending_lines_caps_at_five() {
        let stores = (0..8).map(|i| store_at(&format!("/proj/d{i}.md"), vec![ann("a", "hello", "open")])).collect();
        assert_eq!(pending_lines(Path::new("/proj"), stores, any_doc).len(), PENDING_MAX_DOCS);
    }
}

const PROTOCOL_VERSION: &str = "2024-11-05";

const PATH_DESC: &str = "Absolute path (or ~/...) to an existing markdown or text file.";

fn tool_schemas() -> Value {
    json!([
        {
            "name": "list_annotations",
            "description": "List the user's review annotations on a markdown file, with line numbers resolved against the file's current contents. Defaults to open annotations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": PATH_DESC },
                    "status": { "type": "string", "enum": ["open", "resolved", "orphaned", "all"], "description": "Filter (default: open)." }
                },
                "required": ["path"]
            }
        },
        {
            "name": "get_annotation",
            "description": "Get one annotation by id with its current line range, quoted text, replies, and three lines of context before and after.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": PATH_DESC },
                    "id": { "type": "string" }
                },
                "required": ["path", "id"]
            }
        },
        {
            "name": "resolve_annotation",
            "description": "Mark an annotation resolved after you have applied the requested change. Pass `note` so the user sees what changed on the card.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": PATH_DESC },
                    "id": { "type": "string" },
                    "note": { "type": "string", "description": "One line saying what you changed. Appended to the comment's thread as your reply." }
                },
                "required": ["path", "id"]
            }
        },
        {
            "name": "add_annotation",
            "description": "Leave a pointer of your own on the file: a short note attached to a verbatim quote, shown in Glance as a Claude card. Use it for a 'look here' the user should see in the document; do not restate what you already said in chat.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": PATH_DESC },
                    "quote": { "type": "string", "description": "Text copied verbatim from the file. The call fails if it is not found." },
                    "note": { "type": "string", "description": "One line saying what to look at and why." },
                    "prefix": { "type": "string", "description": "Optional text immediately before the quote, to disambiguate repeated phrases." },
                    "suffix": { "type": "string", "description": "Optional text immediately after the quote." },
                    "lineHint": {
                        "type": "object",
                        "description": "Optional 1-based line range the quote sits on; defaults to where the quote resolves.",
                        "properties": { "start": { "type": "integer" }, "end": { "type": "integer" } },
                        "required": ["start"]
                    }
                },
                "required": ["path", "quote", "note"]
            }
        },
        {
            "name": "reply_annotation",
            "description": "Reply on an annotation without resolving it: ask what a drifted or orphaned comment meant, or say why you are not making the change. The comment stays open until the user answers.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": PATH_DESC },
                    "id": { "type": "string" },
                    "text": { "type": "string", "description": "Your question or reason, one or two lines." }
                },
                "required": ["path", "id", "text"]
            }
        }
    ])
}

/// Same list as `TEXT_EXTENSIONS` in commands.rs: the files the app opens.
const DOC_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdx", "txt"];

/// Resolve a tool's `path` to the doc's canonical path, which is also its
/// store key. `~/` expands to $HOME. A relative path is refused: this server's
/// cwd isn't necessarily the caller's. Only an existing regular file whose
/// real target (symlinks followed) has a markdown or text extension is
/// accepted, so the tools can't be used to read any other file.
fn resolve_doc_path(raw: &str) -> Result<String, String> {
    let expanded = match raw.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            let home = std::env::var_os("HOME").ok_or("can't expand '~': $HOME is not set")?;
            PathBuf::from(home).join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(raw),
    };
    if !expanded.is_absolute() {
        return Err(format!("'path' must be absolute (or start with ~/): {raw}"));
    }
    let target = std::fs::canonicalize(&expanded).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("no such file: {raw}"),
        _ => format!("can't open {raw}: {e}"),
    })?;
    if !target.is_file() {
        return Err(format!("not a file: {raw}"));
    }
    let is_doc = target
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| DOC_EXTENSIONS.iter().any(|d| e.eq_ignore_ascii_case(d)));
    if !is_doc {
        return Err(format!("Glance only annotates markdown and text files: {raw}"));
    }
    Ok(target.to_string_lossy().into_owned())
}

fn read_doc(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("can't read {path}: {e}"))
}

fn text_result(value: Value) -> Value {
    json!({ "content": [ { "type": "text", "text": value.to_string() } ] })
}

fn call_tool(name: &str, args: &Value) -> Result<Value, String> {
    let raw_path = args.get("path").and_then(|v| v.as_str()).ok_or("missing 'path'")?;
    let path = resolve_doc_path(raw_path)?;
    let path = path.as_str();
    match name {
        "list_annotations" => {
            let status = args.get("status").and_then(|v| v.as_str());
            let text = read_doc(path)?;
            let store = read_store(path)?;
            let views = build_views(&store, &text, status);
            Ok(text_result(serde_json::to_value(views).unwrap()))
        }
        "get_annotation" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing 'id'")?;
            let text = read_doc(path)?;
            let store = read_store(path)?;
            match store.annotations.iter().find(|a| a.id == id) {
                Some(a) => Ok(text_result(serde_json::to_value(detail_of(a, &text)).unwrap())),
                None => Err(format!("no annotation '{id}'")),
            }
        }
        "resolve_annotation" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing 'id'")?;
            let note = args.get("note").and_then(|v| v.as_str());
            // Read-modify-write under the shared cross-process lock so a
            // concurrent add/remove from the GUI isn't clobbered.
            if mutate_store(path, |store| apply_resolve(store, id, note))? {
                Ok(text_result(json!({ "ok": true, "id": id })))
            } else {
                Err(format!("no annotation '{id}'"))
            }
        }
        "add_annotation" => {
            let quote = args.get("quote").and_then(|v| v.as_str()).filter(|q| !q.is_empty()).ok_or("missing 'quote'")?;
            let note = args.get("note").and_then(|v| v.as_str()).map(str::trim).filter(|n| !n.is_empty()).ok_or("missing 'note'")?;
            let prefix = args.get("prefix").and_then(|v| v.as_str()).unwrap_or("");
            let suffix = args.get("suffix").and_then(|v| v.as_str()).unwrap_or("");
            let text = read_doc(path)?;
            let hint = line_hint_arg(args.get("lineHint"), line_count(&text))?;
            let has_hint = hint.is_some();
            let mut a = claude_annotation(path, quote, note, prefix, suffix, hint);
            let r = resolve_anchor(&text, &a);
            // A missing quote resolves to "drifted" when the line hint is in
            // range and "orphaned" otherwise; neither means the text is there.
            if r.anchor == "orphaned" || r.anchor == "drifted" {
                return Err("quote not found in file; pass the exact text".to_string());
            }
            if !has_hint {
                if let (Some(s), Some(e)) = (r.start_line, r.end_line) {
                    a.line_hint = LineHint { start: s, end: e };
                }
            }
            let stored = mutate_store(path, |store| {
                let mut a = a.clone();
                while store.annotations.iter().any(|b| b.id == a.id) {
                    a.id = unique_id(&a.id);
                }
                push_annotation(store, a);
                store.annotations.last().cloned().unwrap()
            })?;
            Ok(text_result(serde_json::to_value(view_of(&stored, &text)).unwrap()))
        }
        "reply_annotation" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing 'id'")?;
            let text = args.get("text").and_then(|v| v.as_str()).map(str::trim).filter(|t| !t.is_empty()).ok_or("missing 'text'")?;
            if mutate_store(path, |store| apply_claude_reply(store, id, text))? {
                Ok(text_result(json!({ "ok": true, "id": id })))
            } else {
                Err(format!("no annotation '{id}'"))
            }
        }
        other => Err(format!("unknown tool '{other}'")),
    }
}

fn handle(method: &str, params: &Value) -> Option<Result<Value, (i64, String)>> {
    match method {
        "initialize" => Some(Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {}, "resources": {} },
            "serverInfo": { "name": "glance", "version": env!("CARGO_PKG_VERSION") }
        }))),
        "tools/list" => Some(Ok(json!({ "tools": tool_schemas() }))),
        "tools/call" => {
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let empty = json!({});
            let args = params.get("arguments").unwrap_or(&empty);
            Some(call_tool(name, args).map_err(|e| (-32000, e)))
        }
        "resources/list" => Some(Ok(json!({ "resources": [] }))),
        "resources/templates/list" => Some(Ok(json!({
            "resourceTemplates": [ {
                "uriTemplate": "glance://annotations/{path}",
                "name": "Glance annotations",
                "description": "Open annotations for a markdown file.",
                "mimeType": "application/json"
            } ]
        }))),
        "resources/read" => {
            let uri = params.get("uri").and_then(|v| v.as_str()).unwrap_or("");
            let raw = uri.strip_prefix("glance://annotations/").unwrap_or("");
            let views = match resolve_doc_path(raw).and_then(|path| {
                let text = read_doc(&path)?;
                Ok(build_views(&read_store(&path)?, &text, Some("open")))
            }) {
                Ok(v) => v,
                Err(e) => return Some(Err((-32000, e))),
            };
            Some(Ok(json!({
                "contents": [ {
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": serde_json::to_string(&views).unwrap()
                } ]
            })))
        }
        "ping" => Some(Ok(json!({}))),
        _ => None, // JSON-RPC notifications (no id): stay silent; unknown requests handled in main
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some("--pending") {
        run_pending(&argv);
        return;
    }
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            Ok(_) => continue,
            Err(_) => break,
        };
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let empty = json!({});
        let params = msg.get("params").unwrap_or(&empty);

        let response = match handle(method, params) {
            Some(Ok(result)) => id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": result })),
            Some(Err((code, message))) => {
                id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
            }
            // Notification (no id): stay silent. Unknown method WITH id: return -32601.
            None => id.map(|id| json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            })),
        };

        if let Some(resp) = response {
            let _ = writeln!(stdout, "{}", resp);
            let _ = stdout.flush();
        }
    }
}
