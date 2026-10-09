use std::fs;
use std::path::Path;

/// The webview only ever opens and saves markdown documents, so these commands
/// refuse anything else. If script is ever injected into the page, it can't use
/// them to read keys or rewrite a shell profile. The resolved target is checked
/// too, so a `notes.md` symlink to `~/.zshrc` doesn't get through.
fn ensure_markdown(path: &str) -> Result<(), String> {
    let is_md = |p: &Path| {
        p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
    };
    let given = Path::new(path);
    let resolved = fs::canonicalize(given).ok();
    if is_md(given) && resolved.as_deref().map_or(true, is_md) {
        Ok(())
    } else {
        Err(format!("Glance only opens markdown files: {path}"))
    }
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    ensure_markdown(&path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    ensure_markdown(&path)?;
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_markdown_in_any_case() {
        assert!(ensure_markdown("/nonexistent/a.md").is_ok());
        assert!(ensure_markdown("/nonexistent/a.MARKDOWN").is_ok());
    }

    #[test]
    fn refuses_other_files() {
        assert!(ensure_markdown("/Users/x/.zshrc").is_err());
        assert!(ensure_markdown("/Users/x/.ssh/id_ed25519").is_err());
        assert!(ensure_markdown("/Users/x/notes.md.sh").is_err());
    }

    #[test]
    fn refuses_md_symlink_to_other_file() {
        let dir = std::env::temp_dir().join(format!("glance-cmd-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("profile");
        let link = dir.join("notes.md");
        fs::write(&target, "x").unwrap();
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(ensure_markdown(link.to_str().unwrap()).is_err());
        assert!(write_file(link.to_string_lossy().into(), "pwned".into()).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "x");
        fs::remove_dir_all(&dir).unwrap();
    }
}
