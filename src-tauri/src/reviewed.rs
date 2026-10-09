use crate::annotations::{doc_key, legacy_keys, sha1_hex, write_atomic};
use std::path::{Path, PathBuf};

fn store_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".glance").join("reviewed"))
}

fn baseline_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.md", sha1_hex(key)))
}

pub fn store_path_for(doc_path: &str) -> Option<PathBuf> {
    store_dir().map(|d| baseline_file(&d, &doc_key(doc_path)))
}

/// Move a baseline filed under a legacy key (the raw spelling 0.8.5 used) to
/// the doc's normalized key. When both exist, the newer one wins.
fn migrate_legacy(dir: &Path, doc_path: &str, key: &str) {
    let path = baseline_file(dir, key);
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    for legacy in legacy_keys(doc_path, key) {
        let old = baseline_file(dir, &legacy);
        let Some(old_time) = modified(&old) else { continue };
        if modified(&path).map_or(true, |new_time| old_time > new_time) {
            let _ = std::fs::rename(&old, &path);
        } else {
            let _ = std::fs::remove_file(&old);
        }
    }
}

pub fn read_baseline(doc_path: &str) -> Option<String> {
    let dir = store_dir()?;
    let key = doc_key(doc_path);
    migrate_legacy(&dir, doc_path, &key);
    std::fs::read_to_string(baseline_file(&dir, &key)).ok()
}

pub fn write_baseline(doc_path: &str, content: &str) -> Result<(), String> {
    let dir = store_dir().ok_or_else(|| "Could not determine $HOME for reviewed store".to_string())?;
    let key = doc_key(doc_path);
    migrate_legacy(&dir, doc_path, &key);
    write_atomic(&baseline_file(&dir, &key), content.as_bytes())
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

    fn fresh_home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("glance-test-reviewed-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        home
    }

    /// `home/link/Plan.md` through a symlinked dir, and its canonical path.
    fn linked_doc(home: &Path) -> (String, String) {
        let real = home.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("Plan.md"), "x").unwrap();
        std::os::unix::fs::symlink(&real, home.join("link")).unwrap();
        let canonical = std::fs::canonicalize(real.join("Plan.md")).unwrap();
        (home.join("link/Plan.md").to_string_lossy().into_owned(), canonical.to_string_lossy().into_owned())
    }

    fn write_legacy(raw: &str, content: &str) -> PathBuf {
        let p = store_dir().unwrap().join(format!("{}.md", sha1_hex(raw)));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    #[serial]
    fn every_spelling_shares_one_baseline() {
        let home = fresh_home("spellings");
        let (via_link, canonical) = linked_doc(&home);
        write_baseline(&via_link, "reviewed").unwrap();
        assert_eq!(read_baseline(&canonical).as_deref(), Some("reviewed"));
        assert_eq!(read_baseline(&via_link.replace("/link/", "/link//")).as_deref(), Some("reviewed"));
    }

    #[test]
    #[serial]
    fn upgrade_moves_a_baseline_filed_under_the_old_raw_key() {
        let home = fresh_home("migrate");
        let (via_link, canonical) = linked_doc(&home);
        let old = write_legacy(&via_link, "old baseline");
        assert_eq!(read_baseline(&via_link).as_deref(), Some("old baseline"));
        assert!(!old.exists());
        assert_eq!(read_baseline(&canonical).as_deref(), Some("old baseline"));
    }

    #[test]
    #[serial]
    fn upgrade_keeps_the_newer_of_two_baselines() {
        let home = fresh_home("migrate-both");
        let (via_link, canonical) = linked_doc(&home);
        write_baseline(&canonical, "current").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let old = write_legacy(&via_link, "newer legacy");
        assert_eq!(read_baseline(&via_link).as_deref(), Some("newer legacy"));
        assert!(!old.exists());
        // An older legacy file loses to the current one and is removed.
        let stale = write_legacy(&via_link, "stale");
        std::fs::File::options().write(true).open(&stale).unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(read_baseline(&via_link).as_deref(), Some("newer legacy"));
        assert!(!stale.exists());
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
