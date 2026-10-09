// Resolve an Obsidian-style [[target]] to a file on disk. Obsidian looks a bare
// name up anywhere in the vault, so after the document's own folder and the
// vault root we search the vault by file name and take the shortest path.

use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_ENTRIES: usize = 50_000;

fn with_extension(target: &str) -> String {
    let has_ext = Path::new(target)
        .extension()
        .map(|e| !e.is_empty())
        .unwrap_or(false);
    if has_ext { target.to_string() } else { format!("{target}.md") }
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn vault_root(doc_dir: &Path) -> Option<PathBuf> {
    doc_dir
        .ancestors()
        .find(|dir| dir.join(".obsidian").is_dir())
        .map(Path::to_path_buf)
}

/// What a lookup found. `capped` is set when the vault search stopped at its
/// entry limit, so a miss doesn't prove the note is absent.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Lookup {
    pub path: Option<PathBuf>,
    pub capped: bool,
}

fn search(root: &Path, suffix: &Path, limit: usize) -> Lookup {
    let mut best: Option<PathBuf> = None;
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > limit { return Lookup { path: best, capped: true }; }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') || name == "node_modules" { continue; }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(path);
            } else if path.ends_with(suffix) {
                let shorter = best
                    .as_ref()
                    .map(|b| path.components().count() < b.components().count())
                    .unwrap_or(true);
                if shorter { best = Some(path); }
            }
        }
    }
    Lookup { path: best, capped: false }
}

#[cfg(test)]
fn resolve(doc_path: &Path, target: &str) -> Option<PathBuf> {
    lookup(doc_path, target, MAX_ENTRIES).path
}

fn lookup(doc_path: &Path, target: &str, limit: usize) -> Lookup {
    let miss = Lookup { path: None, capped: false };
    let target = target.trim();
    if target.is_empty() { return miss; }
    let rel = PathBuf::from(with_extension(target));
    let Some(doc_dir) = doc_path.parent() else { return miss };
    let root = vault_root(doc_dir);

    let mut candidates = vec![normalize(&doc_dir.join(&rel))];
    if let Some(root) = &root { candidates.push(normalize(&root.join(&rel))); }
    if let Some(hit) = candidates.into_iter().find(|p| p.is_file()) {
        return Lookup { path: Some(hit), capped: false };
    }
    if rel.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return miss;
    }
    search(root.as_deref().unwrap_or(doc_dir), &rel, limit)
}

/// Async so the vault walk runs on a blocking worker, not the main thread
/// (sync commands run on the main thread and would freeze the UI meanwhile).
#[tauri::command]
pub async fn resolve_wikilink(doc_path: String, target: String) -> Result<Lookup, String> {
    tauri::async_runtime::spawn_blocking(move || lookup(Path::new(&doc_path), &target, MAX_ENTRIES))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("glance-wikilink-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for dir in [".obsidian", "projects/a", "projects/b/deep", "meetings"] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in ["projects/a/index.md", "projects/a/decisions.md", "projects/b/deep/notes.md",
                     "notes.md", "meetings/m1.md", "projects/a/pic.png"] {
            fs::write(root.join(file), "x").unwrap();
        }
        root
    }

    #[test]
    fn prefers_a_file_next_to_the_document() {
        let root = vault("sibling");
        let doc = root.join("projects/a/index.md");
        assert_eq!(resolve(&doc, "decisions"), Some(root.join("projects/a/decisions.md")));
        assert_eq!(resolve(&doc, "pic.png"), Some(root.join("projects/a/pic.png")));
    }

    #[test]
    fn follows_relative_and_vault_root_paths() {
        let root = vault("paths");
        let doc = root.join("projects/a/index.md");
        assert_eq!(resolve(&doc, "../b/deep/notes"), Some(root.join("projects/b/deep/notes.md")));
        assert_eq!(resolve(&doc, "meetings/m1"), Some(root.join("meetings/m1.md")));
    }

    #[test]
    fn searches_the_vault_and_takes_the_shortest_path() {
        let root = vault("search");
        let doc = root.join("meetings/m1.md");
        assert_eq!(resolve(&doc, "notes"), Some(root.join("notes.md")));
        assert_eq!(resolve(&doc, "decisions"), Some(root.join("projects/a/decisions.md")));
    }

    #[test]
    fn returns_none_for_missing_notes() {
        let root = vault("missing");
        let doc = root.join("projects/a/index.md");
        assert_eq!(resolve(&doc, "nope"), None);
        assert_eq!(resolve(&doc, "../nope"), None);
        assert_eq!(resolve(&doc, ""), None);
        assert_eq!(lookup(&doc, "nope", MAX_ENTRIES), Lookup { path: None, capped: false });
    }

    #[test]
    fn a_miss_past_the_search_limit_says_the_search_was_capped() {
        let root = vault("capped");
        let doc = root.join("meetings/m1.md");
        // The vault root alone has four entries, so a limit of three stops the
        // walk before it reaches projects/a.
        assert_eq!(lookup(&doc, "decisions", 3), Lookup { path: None, capped: true });
        assert_eq!(lookup(&doc, "decisions", MAX_ENTRIES).path, Some(root.join("projects/a/decisions.md")));
    }
}
