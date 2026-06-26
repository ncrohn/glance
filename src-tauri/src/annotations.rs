use crate::anchor::Annotation;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AnnotationStore {
    #[serde(rename = "docPath")]
    pub doc_path: String,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
}

pub fn sha1_hex(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

fn store_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".glance").join("annotations"))
}

pub fn store_path_for(doc_path: &str) -> Option<PathBuf> {
    store_dir().map(|d| d.join(format!("{}.json", sha1_hex(doc_path))))
}

pub fn read_store(doc_path: &str) -> AnnotationStore {
    let empty = || AnnotationStore {
        doc_path: doc_path.to_string(),
        annotations: Vec::new(),
    };
    let path = match store_path_for(doc_path) {
        Some(p) => p,
        None => return empty(),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| empty()),
        Err(_) => empty(),
    }
}

pub fn write_store(store: &AnnotationStore) -> Result<(), String> {
    let path = store_path_for(&store.doc_path)
        .ok_or_else(|| "Could not determine $HOME for annotation store".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

use crate::anchor::{resolve_anchor, Resolution};

#[tauri::command]
pub fn read_annotations(path: String) -> AnnotationStore {
    read_store(&path)
}

#[tauri::command]
pub fn write_annotations(store: AnnotationStore) -> Result<(), String> {
    write_store(&store)
}

#[tauri::command]
pub fn resolve_anchors(text: String, annotations: Vec<Annotation>) -> Vec<Resolution> {
    annotations.iter().map(|a| resolve_anchor(&text, a)).collect()
}

#[tauri::command]
pub fn annotation_store_path(path: String) -> Option<String> {
    store_path_for(&path).map(|p| p.to_string_lossy().to_string())
}

/// Ensure the store file exists (so the OS file watcher can attach to it) and
/// return its absolute path.
#[tauri::command]
pub fn ensure_annotation_store(path: String) -> Result<String, String> {
    let store_path =
        store_path_for(&path).ok_or_else(|| "Could not determine $HOME".to_string())?;
    if !store_path.exists() {
        write_store(&AnnotationStore {
            doc_path: path.clone(),
            annotations: Vec::new(),
        })?;
    }
    Ok(store_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_is_deterministic_and_hex() {
        let a = sha1_hex("/Users/me/notes.md");
        let b = sha1_hex("/Users/me/notes.md");
        assert_eq!(a, b);
        assert_eq!(a.len(), 40);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn store_path_is_under_glance_annotations() {
        std::env::set_var("HOME", "/tmp/glance-test-home");
        let p = store_path_for("/x/y.md").unwrap();
        let s = p.to_string_lossy();
        assert!(s.contains("/.glance/annotations/"));
        assert!(s.ends_with(".json"));
    }

    #[test]
    fn read_missing_store_returns_empty_with_doc_path() {
        std::env::set_var("HOME", "/tmp/glance-test-home-empty");
        let store = read_store("/no/such/file.md");
        assert_eq!(store.doc_path, "/no/such/file.md");
        assert!(store.annotations.is_empty());
    }
}
