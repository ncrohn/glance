use crate::annotations::sha1_hex;
use std::path::PathBuf;

fn store_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".glance").join("reviewed"))
}

pub fn store_path_for(doc_path: &str) -> Option<PathBuf> {
    store_dir().map(|d| d.join(format!("{}.md", sha1_hex(doc_path))))
}

pub fn read_baseline(doc_path: &str) -> Option<String> {
    let path = store_path_for(doc_path)?;
    std::fs::read_to_string(&path).ok()
}

pub fn write_baseline(doc_path: &str, content: &str) -> Result<(), String> {
    let path = store_path_for(doc_path)
        .ok_or_else(|| "Could not determine $HOME for reviewed store".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_reviewed(path: String) -> Option<String> {
    read_baseline(&path)
}

#[tauri::command]
pub fn write_reviewed(path: String, content: String) -> Result<(), String> {
    write_baseline(&path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn store_path_is_under_glance_reviewed() {
        std::env::set_var("HOME", "/tmp/glance-test-reviewed");
        let p = store_path_for("/x/y.md").unwrap();
        let s = p.to_string_lossy();
        assert!(s.contains("/.glance/reviewed/"));
        assert!(s.ends_with(".md"));
    }

    #[test]
    #[serial]
    fn read_missing_baseline_returns_none() {
        std::env::set_var("HOME", "/tmp/glance-test-reviewed-missing");
        assert!(read_baseline("/no/such/file.md").is_none());
    }

    #[test]
    #[serial]
    fn write_then_read_round_trips() {
        std::env::set_var("HOME", "/tmp/glance-test-reviewed-rt");
        let doc = "/a/b/round-trip.md";
        write_baseline(doc, "hello\nworld").unwrap();
        assert_eq!(read_baseline(doc).as_deref(), Some("hello\nworld"));
    }
}
