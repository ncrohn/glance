// Glance MCP server — stdio JSON-RPC. Lets a Claude session read the user's
// anchored annotations on a markdown file: read, reply, resolve (with a note),
// and add its own pointers.

use glance_lib::anchor::{resolve_anchor, Annotation, LineHint, Reply};
use glance_lib::annotations::{
    apply_reply, mutate_store, new_id, now_iso8601, push_annotation, read_store, AnnotationStore,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

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
    let after_to = (end + n).min(lines.len());
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
        id: new_id(&format!("{path}{quote}{note}{now}")),
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
    }
}

fn line_hint_arg(v: Option<&Value>) -> Option<LineHint> {
    let v = v?;
    let start = v.get("start")?.as_u64()? as usize;
    let end = v.get("end").and_then(|e| e.as_u64()).map(|e| e as usize).unwrap_or(start);
    Some(LineHint { start, end })
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
        }
    }

    fn store_of(anns: Vec<Annotation>) -> AnnotationStore {
        AnnotationStore { doc_path: "/d.md".into(), annotations: anns, next_number: 0 }
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
        std::env::set_var("HOME", home);
        std::fs::create_dir_all(home).unwrap();
        let doc = format!("{home}/doc.md");
        std::fs::write(&doc, NINE).unwrap();
        let _ = std::fs::remove_file(glance_lib::annotations::store_path_for(&doc).unwrap());
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
        std::env::set_var("HOME", home);
        std::fs::create_dir_all(home).unwrap();
        let doc = format!("{home}/doc.md");
        std::fs::write(&doc, NINE).unwrap();
        let _ = std::fs::remove_file(glance_lib::annotations::store_path_for(&doc).unwrap());

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

        let store = read_store(&doc);
        assert_eq!(store.annotations.len(), 2);
        assert!(store.annotations.iter().all(|a| a.author == "claude" && a.status == "open"));
        assert_eq!(store.annotations[0].line_hint, LineHint { start: 5, end: 5 });

        // A quote not in the file errors and writes nothing (line hint in range → "drifted").
        let err = call_tool("add_annotation", &json!({ "path": doc, "quote": "NOTINTEXTEVER", "note": "x" })).unwrap_err();
        assert!(err.contains("quote not found"), "{err}");
        assert_eq!(read_store(&doc).annotations.len(), 2);
        // Same with a line hint out of range ("orphaned").
        let err = call_tool("add_annotation", &json!({ "path": doc, "quote": "NOTINTEXTEVER", "note": "x", "lineHint": { "start": 99 } })).unwrap_err();
        assert!(err.contains("quote not found"), "{err}");
        assert_eq!(read_store(&doc).annotations.len(), 2);

        // list_annotations shows both, numbered.
        let out = call_tool("list_annotations", &json!({ "path": doc })).unwrap();
        let list: Value = serde_json::from_str(out["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2);
        assert_eq!(list[1]["number"], 2);
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
}

const PROTOCOL_VERSION: &str = "2024-11-05";

fn tool_schemas() -> Value {
    json!([
        {
            "name": "list_annotations",
            "description": "List the user's review annotations on a markdown file, with line numbers resolved against the file's current contents. Defaults to open annotations.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the markdown file." },
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
                    "path": { "type": "string" },
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
                    "path": { "type": "string" },
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
                    "path": { "type": "string", "description": "Absolute path to the markdown file." },
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
                    "path": { "type": "string" },
                    "id": { "type": "string" },
                    "text": { "type": "string", "description": "Your question or reason, one or two lines." }
                },
                "required": ["path", "id", "text"]
            }
        }
    ])
}

fn read_doc(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn text_result(value: Value) -> Value {
    json!({ "content": [ { "type": "text", "text": value.to_string() } ] })
}

fn call_tool(name: &str, args: &Value) -> Result<Value, String> {
    let path = args.get("path").and_then(|v| v.as_str()).ok_or("missing 'path'")?;
    match name {
        "list_annotations" => {
            let status = args.get("status").and_then(|v| v.as_str());
            let store = read_store(path);
            let views = build_views(&store, &read_doc(path), status);
            Ok(text_result(serde_json::to_value(views).unwrap()))
        }
        "get_annotation" => {
            let id = args.get("id").and_then(|v| v.as_str()).ok_or("missing 'id'")?;
            let store = read_store(path);
            let text = read_doc(path);
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
            let mut a = claude_annotation(path, quote, note, prefix, suffix, line_hint_arg(args.get("lineHint")));
            let text = read_doc(path);
            let r = resolve_anchor(&text, &a);
            // A missing quote resolves to "drifted" when the line hint is in
            // range and "orphaned" otherwise; neither means the text is there.
            if r.anchor == "orphaned" || r.anchor == "drifted" {
                return Err("quote not found in file; pass the exact text".to_string());
            }
            if args.get("lineHint").is_none() {
                if let (Some(s), Some(e)) = (r.start_line, r.end_line) {
                    a.line_hint = LineHint { start: s, end: e };
                }
            }
            let stored = mutate_store(path, |store| {
                push_annotation(store, a.clone());
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
            let path = uri.strip_prefix("glance://annotations/").unwrap_or("");
            let store = read_store(path);
            let views = build_views(&store, &read_doc(path), Some("open"));
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
