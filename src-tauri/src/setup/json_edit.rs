//! Format-preserving edits to the JSON config files setup touches
//! (`~/.claude.json`, `~/.claude/settings.json`, `~/.codex/hooks.json`,
//! `~/.cursor/mcp.json`).
//!
//! Only the containers on the path being edited (root → `mcpServers` → entry,
//! root → `hooks` → event → entry) are parsed. Every other value stays as its
//! original JSON text, byte for byte: key order, numbers too large or precise
//! for f64, string escapes, nested formatting and even duplicate keys inside
//! untouched subtrees survive. Parsed containers are re-emitted in the file's
//! own indentation (tabs or N spaces, or compact), and the trailing newline is
//! kept. A duplicate key inside a container we would rewrite is refused
//! rather than collapsed.

use serde::de::{self, Deserialize, Deserializer, MapAccess, Visitor};
use serde_json::value::RawValue;

#[derive(Debug)]
pub enum Node {
    Obj(Vec<(String, Node)>),
    Arr(Vec<Node>),
    /// Untouched JSON text.
    Raw(String),
}

struct Members(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for Members {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Members;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Members, A::Error> {
                let mut out: Vec<(String, Box<RawValue>)> = Vec::new();
                while let Some(k) = m.next_key::<String>()? {
                    if out.iter().any(|(e, _)| *e == k) {
                        return Err(de::Error::custom(format!("the key \"{k}\" appears twice")));
                    }
                    out.push((k, m.next_value()?));
                }
                Ok(Members(out))
            }
        }
        d.deserialize_map(V)
    }
}

impl Node {
    /// Parse one level of `raw`: an object or array becomes a container whose
    /// children stay raw; anything else stays raw.
    fn expand(raw: &str) -> Result<Node, String> {
        match raw.trim_start().as_bytes().first() {
            Some(b'{') => {
                let m: Members = serde_json::from_str(raw).map_err(|e| e.to_string())?;
                Ok(Node::Obj(m.0.into_iter().map(|(k, v)| (k, Node::Raw(v.get().to_string()))).collect()))
            }
            Some(b'[') => {
                let a: Vec<Box<RawValue>> = serde_json::from_str(raw).map_err(|e| e.to_string())?;
                Ok(Node::Arr(a.into_iter().map(|v| Node::Raw(v.get().to_string())).collect()))
            }
            _ => Ok(Node::Raw(raw.to_string())),
        }
    }

    /// A JSON string literal.
    pub fn string(s: &str) -> Node {
        Node::Raw(serde_json::to_string(s).unwrap())
    }

    /// The value as a `serde_json::Value`, for read-only inspection.
    pub fn value(&self) -> Option<serde_json::Value> {
        match self {
            Node::Raw(s) => serde_json::from_str(s).ok(),
            other => {
                let mut out = String::new();
                other.emit(&Style { indent: None, trailing_newline: false }, 0, &mut out);
                serde_json::from_str(&out).ok()
            }
        }
    }

    /// This node as an object, parsing it if still raw. `Ok(None)` when it is
    /// some other JSON type; `Err` when it holds a duplicate key.
    pub fn obj(&mut self) -> Result<Option<&mut Vec<(String, Node)>>, String> {
        if let Node::Raw(s) = self {
            if s.trim_start().starts_with('{') {
                *self = Node::expand(s)?;
            }
        }
        Ok(match self {
            Node::Obj(m) => Some(m),
            _ => None,
        })
    }

    /// This node as an array, parsing it if still raw.
    pub fn arr(&mut self) -> Result<Option<&mut Vec<Node>>, String> {
        if let Node::Raw(s) = self {
            if s.trim_start().starts_with('[') {
                *self = Node::expand(s)?;
            }
        }
        Ok(match self {
            Node::Arr(a) => Some(a),
            _ => None,
        })
    }

    fn emit(&self, style: &Style, depth: usize, out: &mut String) {
        match self {
            Node::Raw(s) => out.push_str(s),
            Node::Obj(m) => emit_container('{', '}', m.iter().map(|(k, v)| (Some(k.as_str()), v)).collect(), style, depth, out),
            Node::Arr(a) => emit_container('[', ']', a.iter().map(|v| (None, v)).collect(), style, depth, out),
        }
    }
}

fn emit_container(open: char, close: char, items: Vec<(Option<&str>, &Node)>, style: &Style, depth: usize, out: &mut String) {
    out.push(open);
    if items.is_empty() {
        out.push(close);
        return;
    }
    let n = items.len();
    for (i, (key, v)) in items.into_iter().enumerate() {
        if let Some(ind) = &style.indent {
            out.push('\n');
            out.push_str(&ind.repeat(depth + 1));
        }
        if let Some(k) = key {
            out.push_str(&serde_json::to_string(k).unwrap());
            out.push_str(if style.indent.is_some() { ": " } else { ":" });
        }
        v.emit(style, depth + 1, out);
        if i + 1 < n {
            out.push(',');
        }
    }
    if let Some(ind) = &style.indent {
        out.push('\n');
        out.push_str(&ind.repeat(depth));
    }
    out.push(close);
}

/// Look up `key` in an object's members.
pub fn get<'a>(members: &'a mut [(String, Node)], key: &str) -> Option<&'a mut Node> {
    members.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// Set `key` in place (keeping its position) or append it.
pub fn set(members: &mut Vec<(String, Node)>, key: &str, value: Node) {
    match get(members, key) {
        Some(v) => *v = value,
        None => members.push((key.to_string(), value)),
    }
}

/// Remove `key`, keeping the order of the rest.
pub fn remove(members: &mut Vec<(String, Node)>, key: &str) -> bool {
    let before = members.len();
    members.retain(|(k, _)| k != key);
    members.len() != before
}

#[derive(Debug)]
struct Style {
    /// One level of indentation, or `None` for a single-line file.
    indent: Option<String>,
    trailing_newline: bool,
}

impl Style {
    fn detect(text: &str) -> Style {
        let body = text.trim_end();
        let indent = if !body.contains('\n') {
            None
        } else {
            // The first indented line sits one level deep.
            let unit = body
                .lines()
                .skip(1)
                .map(|l| &l[..l.len() - l.trim_start_matches([' ', '\t']).len()])
                .find(|ws| !ws.is_empty())
                .map(|ws| if ws.starts_with('\t') { "\t".to_string() } else { ws.to_string() });
            Some(unit.unwrap_or_else(|| "  ".to_string()))
        };
        Style { indent, trailing_newline: text.ends_with('\n') }
    }
}

/// A JSON config file whose root is an object.
#[derive(Debug)]
pub struct Doc {
    pub root: Vec<(String, Node)>,
    style: Style,
}

impl Doc {
    /// Parse a config. Empty/whitespace starts a fresh `{}` (two-space indent,
    /// trailing newline). Invalid JSON, a non-object root or a duplicate root
    /// key is an error: callers must not overwrite the file then.
    pub fn parse(text: &str, file: &str) -> Result<Doc, String> {
        if text.trim().is_empty() {
            return Ok(Doc { root: Vec::new(), style: Style { indent: Some("  ".to_string()), trailing_newline: true } });
        }
        let refuse = |why: String| format!("{file} {why}; refusing to overwrite it. Fix or remove the file, then retry.");
        // Validate the whole document first so a syntax error is reported as
        // such, not as a shape problem.
        let raw: Box<RawValue> = serde_json::from_str(text).map_err(|e| refuse(format!("is not valid JSON ({e})")))?;
        let root = match Node::expand(raw.get()).map_err(|e| refuse(format!("cannot be edited safely: {e}")))? {
            Node::Obj(m) => m,
            _ => return Err(format!("{file} is not a JSON object; refusing to overwrite it.")),
        };
        Ok(Doc { root, style: Style::detect(text) })
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        emit_container('{', '}', self.root.iter().map(|(k, v)| (Some(k.as_str()), v)).collect(), &self.style, 0, &mut out);
        if self.style.trailing_newline {
            out.push('\n');
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untouched_round_trip_is_byte_exact() {
        for src in [
            "{\n\t\"zeta\": 1,\n\t\"alpha\": {\"y\": 1, \"b\": 2}\n}\n",
            "{\n    \"big\": 123456789012345678901234567890,\n    \"precise\": 0.30000000000000004441,\n    \"f\": 1.0,\n    \"s\": \"caf\\u00e9\"\n}",
            "{\"a\":1,\"b\":[1,2]}",
        ] {
            assert_eq!(Doc::parse(src, "f").unwrap().render(), src);
        }
    }

    #[test]
    fn refuses_duplicate_root_keys_and_bad_input() {
        assert!(Doc::parse("{\"a\":1,\"a\":2}", "f").unwrap_err().contains("twice"));
        assert!(Doc::parse("{bad", "f").unwrap_err().contains("not valid JSON"));
        assert!(Doc::parse("[1]", "f").unwrap_err().contains("not a JSON object"));
        assert!(Doc::parse("{\"a\":1} trailing", "f").is_err());
        // duplicates inside an untouched subtree are kept verbatim, not collapsed
        let src = "{\"x\":{\"d\":1,\"d\":2},\"y\":1}";
        assert_eq!(Doc::parse(src, "f").unwrap().render(), src);
    }

    #[test]
    fn edits_reemit_in_the_files_indent() {
        let src = "{\n\t\"a\": 1,\n\t\"m\": {\"k\": true}\n}\n";
        let mut doc = Doc::parse(src, "f").unwrap();
        let m = get(&mut doc.root, "m").unwrap().obj().unwrap().unwrap();
        set(m, "n", Node::string("v"));
        assert_eq!(doc.render(), "{\n\t\"a\": 1,\n\t\"m\": {\n\t\t\"k\": true,\n\t\t\"n\": \"v\"\n\t}\n}\n");
    }
}
