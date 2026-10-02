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

fn search(root: &Path, suffix: &Path) -> Option<PathBuf> {
    let mut best: Option<PathBuf> = None;
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_ENTRIES { return best; }
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
    best
}

pub fn resolve(doc_path: &Path, target: &str) -> Option<PathBuf> {
    let target = target.trim();
    if target.is_empty() { return None; }
    let rel = PathBuf::from(with_extension(target));
    let doc_dir = doc_path.parent()?;
    let root = vault_root(doc_dir);

    let mut candidates = vec![normalize(&doc_dir.join(&rel))];
    if let Some(root) = &root { candidates.push(normalize(&root.join(&rel))); }
    if let Some(hit) = candidates.into_iter().find(|p| p.is_file()) {
        return Some(hit);
    }
    if rel.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return None;
    }
    search(root.as_deref().unwrap_or(doc_dir), &rel)
}

#[tauri::command]
pub fn resolve_wikilink(doc_path: String, target: String) -> Option<String> {
    resolve(Path::new(&doc_path), &target).map(|p| p.to_string_lossy().into_owned())
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
    }
}
