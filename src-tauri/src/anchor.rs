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
    /// Stable per-document number, assigned once when the store adds it.
    /// 0 means not yet assigned (a pre-numbers store, or an add in flight).
    #[serde(default)]
    pub number: u32,
    /// Who resolved it ("user" or "claude") and when (ISO 8601). Both absent
    /// while the annotation is open.
    #[serde(default, rename = "resolvedBy", skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    #[serde(default, rename = "resolvedAt", skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    /// Thread under the note: Claude's resolution notes and questions, the
    /// user's answers. Absent from stores written before replies existed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replies: Vec<Reply>,
    /// Fields this version doesn't know (written by a newer or older Glance),
    /// kept so a rewrite doesn't drop them.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// One message in an annotation's reply thread. `author` is "user" or "claude".
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Reply {
    pub author: String,
    pub text: String,
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

/// Byte offsets of every `\n` in a text, built once so each match's line
/// number is a binary search rather than a rescan of the text before it.
struct LineIndex(Vec<usize>);

impl LineIndex {
    fn new(text: &str) -> Self {
        LineIndex(
            text.bytes()
                .enumerate()
                .filter(|&(_, b)| b == b'\n')
                .map(|(i, _)| i)
                .collect(),
        )
    }

    /// 1-based line of `byte_offset`: one more than the newlines before it.
    fn line_of(&self, byte_offset: usize) -> usize {
        self.0.partition_point(|&nl| nl < byte_offset) + 1
    }

    /// Lines as `line_of` numbers them: the empty line after a trailing
    /// newline is a line too.
    fn line_count(&self) -> usize {
        self.0.len() + 1
    }
}

/// Every byte offset where `needle` starts, overlapping matches included, so
/// `"x\nx"` in `"x\nx\nx"` is found on lines 1 and 2.
fn find_all(text: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0usize;
    while let Some(i) = text[start..].find(needle) {
        let abs = start + i;
        out.push(abs);
        start = abs + text[abs..].chars().next().map_or(1, char::len_utf8);
        if start >= text.len() {
            break;
        }
    }
    out
}

fn located(a: &Annotation, lines: &LineIndex, quote_offset: usize, kind: &str) -> Resolution {
    let start = lines.line_of(quote_offset);
    // A trailing newline ends the quote's last line; it doesn't start another.
    let body = a.quote.strip_suffix('\n').unwrap_or(&a.quote);
    let newlines_in_quote = body.bytes().filter(|&b| b == b'\n').count();
    Resolution {
        id: a.id.clone(),
        start_line: Some(start),
        end_line: Some(start.saturating_add(newlines_in_quote)),
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
    resolve_with(text, &LineIndex::new(text), a)
}

/// `resolve_anchor` for many annotations on one text, indexing its lines once.
pub fn resolve_all(text: &str, annotations: &[Annotation]) -> Vec<Resolution> {
    let lines = LineIndex::new(text);
    annotations.iter().map(|a| resolve_with(text, &lines, a)).collect()
}

fn resolve_with(text: &str, lines: &LineIndex, a: &Annotation) -> Resolution {
    if a.quote.is_empty() {
        return orphan(a);
    }

    let full = format!("{}{}{}", a.prefix, a.quote, a.suffix);
    let full_occurrences = find_all(text, &full);
    if full_occurrences.len() == 1 {
        return located(a, lines, full_occurrences[0] + a.prefix.len(), "exact");
    }

    let occurrences = find_all(text, &a.quote);
    match occurrences.len() {
        0 => {
            let total_lines = lines.line_count();
            let start = a.line_hint.start;
            if start >= 1 && start <= total_lines {
                Resolution {
                    id: a.id.clone(),
                    start_line: Some(start),
                    end_line: Some(a.line_hint.end.clamp(start, total_lines)),
                    anchor: "drifted".to_string(),
                }
            } else {
                orphan(a)
            }
        }
        1 => located(a, lines, occurrences[0], "quote-only"),
        _ => {
            let hint = a.line_hint.start;
            let best = occurrences
                .iter()
                .min_by_key(|&&off| lines.line_of(off).abs_diff(hint))
                .copied()
                .unwrap();
            located(a, lines, best, "quote-only")
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
            number: 0,
            resolved_by: None,
            resolved_at: None,
            replies: Vec::new(),
            extra: Default::default(),
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

    #[test]
    fn overlapping_repeats_are_all_candidates() {
        // "x\nx" starts on line 1 and, overlapping, on line 2; the hint picks line 2.
        let r = resolve_anchor("x\nx\nx\n", &ann("x\nx", "", "", 2));
        assert_eq!(r.anchor, "quote-only");
        assert_eq!(r.start_line, Some(2));
        assert_eq!(r.end_line, Some(3));
        assert_eq!(find_all("aaa", "aa"), vec![0, 1]);
        assert_eq!(find_all("éé", "é"), vec![0, 2]);
    }

    #[test]
    fn quote_ending_in_newline_ends_on_its_own_line() {
        let r = resolve_anchor("a\nb\nc\n", &ann("c\n", "", "", 1));
        assert_eq!((r.start_line, r.end_line), (Some(3), Some(3)));
        let r = resolve_anchor("a\nb\nc\n", &ann("b\nc\n", "", "", 1));
        assert_eq!((r.start_line, r.end_line), (Some(2), Some(3)));
    }

    #[test]
    fn hint_on_the_line_after_a_trailing_newline_is_in_range() {
        // line_of calls the spot after the last "\n" line 4, so a hint there drifts.
        let r = resolve_anchor("a\nb\nc\n", &ann("gone", "", "", 4));
        assert_eq!(r.anchor, "drifted");
        assert_eq!(resolve_anchor("a\nb\nc\n", &ann("gone", "", "", 5)).anchor, "orphaned");
    }

    #[test]
    fn drifted_end_is_clamped_to_the_file_and_never_before_start() {
        let mut a = ann("gone", "", "", 2);
        a.line_hint.end = usize::MAX;
        let r = resolve_anchor("a\nb\nc", &a);
        assert_eq!((r.start_line, r.end_line), (Some(2), Some(3)));
        a.line_hint.end = 1;
        let r = resolve_anchor("a\nb\nc", &a);
        assert_eq!((r.start_line, r.end_line), (Some(2), Some(2)));
    }

    #[test]
    fn huge_hint_start_with_repeated_quote_does_not_overflow() {
        let a = ann("dup", "", "", usize::MAX);
        let r = resolve_anchor("dup\nx\ndup\n", &a);
        assert_eq!(r.start_line, Some(3)); // nearest to the (huge) hint
        let a = ann("dup", "", "", (i64::MAX as usize) + 1);
        assert_eq!(resolve_anchor("dup\nx\ndup\n", &a).start_line, Some(3));
    }

    #[test]
    fn line_index_matches_a_prefix_newline_count() {
        let text = "\nab\n\ncé\nd";
        let lines = LineIndex::new(text);
        for off in 0..=text.len() {
            let want = text.as_bytes()[..off].iter().filter(|&&b| b == b'\n').count() + 1;
            assert_eq!(lines.line_of(off), want, "offset {off}");
        }
        assert_eq!(lines.line_count(), 5);
    }

    #[test]
    fn large_doc_with_many_occurrences_resolves_to_the_hinted_copy() {
        // ~1 MB of one-word repeats: a context-edited "the" picks the copy
        // nearest its hint from tens of thousands of candidates.
        let text: String = (1..=40_000).map(|i| format!("the line {i} of the doc\n")).collect();
        assert!(text.len() > 900_000);
        let r = resolve_anchor(&text, &ann("the", "EDITED ", " EDITED", 31_337));
        assert_eq!(r.anchor, "quote-only");
        assert_eq!((r.start_line, r.end_line), (Some(31_337), Some(31_337)));

        let batch = vec![
            ann("the", "EDITED ", " EDITED", 7),
            ann("line 39999 of", "the ", " the", 1),
            ann("gone", "", "", 40_001),
        ];
        let rs = resolve_all(&text, &batch);
        assert_eq!(rs, batch.iter().map(|a| resolve_anchor(&text, a)).collect::<Vec<_>>());
        assert_eq!((rs[0].start_line, rs[0].anchor.as_str()), (Some(7), "quote-only"));
        assert_eq!((rs[1].start_line, rs[1].anchor.as_str()), (Some(39_999), "exact"));
        assert_eq!((rs[2].start_line, rs[2].anchor.as_str()), (Some(40_001), "drifted"));
    }

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        let text = r#"{"id":"a","quote":"q","prefix":"","suffix":"","lineHint":{"start":1,"end":1},"note":"n","status":"open","author":"user","createdAt":"t","number":1,"tags":["x"],"severity":"high"}"#;
        let a: Annotation = serde_json::from_str(text).unwrap();
        assert_eq!(a.extra.get("severity"), Some(&serde_json::json!("high")));
        assert!(!a.extra.contains_key("quote"));
        let back = serde_json::to_value(&a).unwrap();
        assert_eq!(back["tags"], serde_json::json!(["x"]));
        assert_eq!(back["severity"], "high");
        // Nothing extra is written for an annotation without unknown fields.
        assert_eq!(serde_json::to_value(ann("q", "", "", 1)).unwrap().as_object().unwrap().len(), 10);
    }
}
