// Glance MCP server — stdio JSON-RPC. Lets a Claude session read the user's
// anchored annotations on a markdown file. v1: read + resolve only.

use glance_lib::anchor::{resolve_anchor, Annotation};
use glance_lib::annotations::{read_store, write_store, AnnotationStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

#[derive(Serialize, PartialEq, Debug)]
struct AnnotationView {
    id: String,
    note: String,
    quote: String,
    #[serde(rename = "lineStart")]
    line_start: Option<usize>,
    #[serde(rename = "lineEnd")]
    line_end: Option<usize>,
    status: String,
    anchor: String,
}

fn view_of(a: &Annotation, text: &str) -> AnnotationView {
    let r = resolve_anchor(text, a);
    AnnotationView {
        id: a.id.clone(),
        note: a.note.clone(),
        quote: a.quote.clone(),
        line_start: r.start_line,
        line_end: r.end_line,
        status: a.status.clone(),
        anchor: r.anchor,
    }
}

/// Build the view list, optionally filtered by status (default "open").
///
/// Filtering happens on the resolved view so that `orphaned` (a live anchor
/// state, not a stored status) is meaningful:
///   "all"      → every annotation
///   "open"     → status == "open" AND anchor != "orphaned"
///   "resolved" → status == "resolved"
///   "orphaned" → anchor == "orphaned" (quote absent from current text)
fn build_views(store: &AnnotationStore, text: &str, status_filter: Option<&str>) -> Vec<AnnotationView> {
    let filter = status_filter.unwrap_or("open");
    store
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
        .collect()
}

/// Mark one annotation resolved in-place. Returns true if it was found.
fn apply_resolve(store: &mut AnnotationStore, id: &str) -> bool {
    for a in store.annotations.iter_mut() {
        if a.id == id {
            a.status = "resolved".to_string();
            return true;
        }
    }
    false
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
        }
    }

    fn store_of(anns: Vec<Annotation>) -> AnnotationStore {
        AnnotationStore { doc_path: "/d.md".into(), annotations: anns }
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
    fn apply_resolve_sets_status() {
        let mut store = store_of(vec![ann("a", "hello", "open")]);
        assert!(apply_resolve(&mut store, "a"));
        assert_eq!(store.annotations[0].status, "resolved");
        assert!(!apply_resolve(&mut store, "missing"));
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
            "description": "Mark an annotation resolved after you have applied the requested change.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "id": { "type": "string" }
                },
                "required": ["path", "id"]
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
            let mut store = read_store(path);
            if apply_resolve(&mut store, id) {
                write_store(&store)?;
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
