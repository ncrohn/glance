use crate::annotations::{sha1_hex, write_atomic};
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
    write_atomic(&path, content.as_bytes())
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

    #[test]
    #[serial]
    fn readers_never_see_a_torn_baseline() {
        let home = std::env::temp_dir().join(format!("glance-test-reviewed-torn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::env::set_var("HOME", &home);
        let doc = "/m/rev.md";
        let (a, b) = ("A".repeat(1_000_000), "B".repeat(1_000_000));
        write_baseline(doc, &a).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let st = stop.clone();
        let reader = std::thread::spawn(move || {
            let mut torn = 0;
            while !st.load(std::sync::atomic::Ordering::Relaxed) {
                match read_baseline(doc) {
                    Some(t) if t.len() == 1_000_000 => {}
                    _ => torn += 1,
                }
            }
            torn
        });
        for i in 0..20 {
            write_baseline(doc, if i % 2 == 0 { &b } else { &a }).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(reader.join().unwrap(), 0);
        let _ = std::fs::remove_dir_all(&home);
    }
}
