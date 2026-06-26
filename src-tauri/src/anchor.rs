use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LineHint {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Annotation {
    pub id: String,
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    #[serde(rename = "lineHint")]
    pub line_hint: LineHint,
    pub note: String,
    pub status: String,
    pub author: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Resolution {
    pub id: String,
    #[serde(rename = "startLine")]
    pub start_line: Option<usize>,
    #[serde(rename = "endLine")]
    pub end_line: Option<usize>,
    pub anchor: String,
}

fn offset_to_line(text: &str, byte_offset: usize) -> usize {
    text[..byte_offset].bytes().filter(|&b| b == b'\n').count() + 1
}

fn find_all(text: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0usize;
    while let Some(i) = text[start..].find(needle) {
        let abs = start + i;
        out.push(abs);
        start = abs + needle.len().max(1);
        if start > text.len() {
            break;
        }
    }
    out
}

fn located(a: &Annotation, text: &str, quote_offset: usize, kind: &str) -> Resolution {
    let start = offset_to_line(text, quote_offset);
    let newlines_in_quote = a.quote.bytes().filter(|&b| b == b'\n').count();
    Resolution {
        id: a.id.clone(),
        start_line: Some(start),
        end_line: Some(start + newlines_in_quote),
        anchor: kind.to_string(),
    }
}

fn orphan(a: &Annotation) -> Resolution {
    Resolution {
        id: a.id.clone(),
        start_line: None,
        end_line: None,
        anchor: "orphaned".to_string(),
    }
}

/// Resolve a stored annotation against the document's current text.
/// Tries: exact (prefix+quote+suffix) → unique/nearest quote → line-hint drift → orphan.
pub fn resolve_anchor(text: &str, a: &Annotation) -> Resolution {
    if a.quote.is_empty() {
        return orphan(a);
    }

    let full = format!("{}{}{}", a.prefix, a.quote, a.suffix);
    let full_occurrences = find_all(text, &full);
    if full_occurrences.len() == 1 {
        return located(a, text, full_occurrences[0] + a.prefix.len(), "exact");
    }

    let occurrences = find_all(text, &a.quote);
    match occurrences.len() {
        0 => {
            let total_lines = text.lines().count().max(1);
            if a.line_hint.start >= 1 && a.line_hint.start <= total_lines {
                Resolution {
                    id: a.id.clone(),
                    start_line: Some(a.line_hint.start),
                    end_line: Some(a.line_hint.end),
                    anchor: "drifted".to_string(),
                }
            } else {
                orphan(a)
            }
        }
        1 => located(a, text, occurrences[0], "quote-only"),
        _ => {
            let hint = a.line_hint.start as i64;
            let best = occurrences
                .iter()
                .min_by_key(|&&off| (offset_to_line(text, off) as i64 - hint).abs())
                .copied()
                .unwrap();
            located(a, text, best, "quote-only")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann(quote: &str, prefix: &str, suffix: &str, line: usize) -> Annotation {
        Annotation {
            id: "x".into(),
            quote: quote.into(),
            prefix: prefix.into(),
            suffix: suffix.into(),
            line_hint: LineHint { start: line, end: line },
            note: "n".into(),
            status: "open".into(),
            author: "user".into(),
            created_at: "t".into(),
        }
    }

    #[test]
    fn exact_match_recomputes_lines_after_insertion_above() {
        let a = ann("needle here", "the ", " end", 2);
        let text = "inserted line\nanother inserted\nthe needle here end\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "exact");
        assert_eq!(r.start_line, Some(3));
        assert_eq!(r.end_line, Some(3));
    }

    #[test]
    fn context_changed_but_unique_quote_is_quote_only() {
        let a = ann("unique phrase", "OLD ", " OLD", 1);
        let text = "totally different before unique phrase different after\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "quote-only");
        assert_eq!(r.start_line, Some(1));
    }

    #[test]
    fn duplicate_quote_disambiguated_by_line_hint() {
        let a = ann("dup", "", "", 3);
        let text = "dup\nx\ndup\nx\ndup\n"; // lines 1,3,5
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "quote-only");
        assert_eq!(r.start_line, Some(3)); // nearest to hint 3
    }

    #[test]
    fn quote_gone_line_in_range_is_drifted() {
        let a = ann("vanished", "", "", 2);
        let text = "still here\nand here\nthird line\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "drifted");
        assert_eq!(r.start_line, Some(2));
    }

    #[test]
    fn quote_gone_line_out_of_range_is_orphaned() {
        let a = ann("vanished", "", "", 99);
        let text = "one\ntwo\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "orphaned");
        assert_eq!(r.start_line, None);
    }

    #[test]
    fn multiline_quote_spans_lines() {
        let a = ann("line two\nline three", "", "", 2);
        let text = "line one\nline two\nline three\nline four\n";
        let r = resolve_anchor(text, &a);
        assert_eq!(r.anchor, "exact");
        assert_eq!(r.start_line, Some(2));
        assert_eq!(r.end_line, Some(3));
    }
}
