// Glance MCP server — stdio JSON-RPC. Lets a Claude session read the user's
// anchored annotations on a markdown file: read, reply, resolve (with a note).

use glance_lib::anchor::{resolve_anchor, Annotation, Reply};
use glance_lib::annotations::{apply_reply, mutate_store, now_iso8601, read_store, AnnotationStore};
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
        anchor: r.anchor,
        resolved_by: a.resolved_by.clone(),
        resolved_at: a.resolved_at.clone(),
        replies: a.replies.clone(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use glance_lib::anchor::LineHint;

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
            "description": "Get one annotation by id with its current line range and quoted text.",
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
                Some(a) => Ok(text_result(serde_json::to_value(view_of(a, &text)).unwrap())),
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
