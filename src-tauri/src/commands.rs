use std::fs;
use std::path::Path;

const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdx", "txt"];

fn has_extension(p: &Path, allowed: &[&str]) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| allowed.iter().any(|a| e.eq_ignore_ascii_case(a)))
}

/// The webview only ever opens and saves text documents, so these commands
/// refuse anything else. If script is ever injected into the page, it can't use
/// them to read keys or rewrite a shell profile. A symlink is judged by its
/// target, and one whose target doesn't exist yet is refused, since writing
/// through it would create that target.
fn ensure_text_document(path: &str) -> Result<(), String> {
    let given = Path::new(path);
    let refuse = || Err(format!("Glance only opens markdown and text files: {path}"));
    if !has_extension(given, TEXT_EXTENSIONS) {
        return refuse();
    }
    let is_link = fs::symlink_metadata(given).is_ok_and(|m| m.file_type().is_symlink());
    match fs::canonicalize(given) {
        Ok(target) if has_extension(&target, TEXT_EXTENSIONS) => Ok(()),
        Err(_) if !is_link => Ok(()),
        _ => refuse(),
    }
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    ensure_text_document(&path)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    ensure_text_document(&path)?;
    fs::write(&path, contents).map_err(|e| e.to_string())
}

// Documents and media whose default macOS app only displays them. Anything
// else — .command, .app, .terminal, a bare executable, .html — can run code
// when handed to `open`, so a click on it asks first.
const VIEW_ONLY: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "bmp",
    "txt", "csv", "tsv", "json", "yaml", "yml", "toml", "xml", "log", "rtf",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
    "mp3", "m4a", "wav", "mp4", "mov", "m4v",
];

#[derive(serde::Serialize)]
pub struct OpenTarget {
    /// The resolved path to hand to the opener.
    path: String,
    /// True when the file might run code and the user should confirm first.
    confirm: bool,
}

/// Decide how a linked file opens. The decision is made on the resolved target,
/// because macOS opens what a symlink points to: `diagram.pdf` linking to a
/// `.command` file would otherwise slip through as a PDF.
#[tauri::command]
pub fn resolve_open_target(path: String) -> Result<OpenTarget, String> {
    let target = fs::canonicalize(&path).map_err(|e| format!("Couldn't open {path}: {e}"))?;
    let is_file = fs::metadata(&target).is_ok_and(|m| m.is_file());
    let confirm = !(is_file && has_extension(&target, VIEW_ONLY));
    Ok(OpenTarget { path: target.to_string_lossy().into_owned(), confirm })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("glance-cmd-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn allows_text_documents_in_any_case() {
        assert!(ensure_text_document("/nonexistent/a.md").is_ok());
        assert!(ensure_text_document("/nonexistent/a.MARKDOWN").is_ok());
        assert!(ensure_text_document("/nonexistent/notes.txt").is_ok());
    }

    #[test]
    fn refuses_other_files() {
        assert!(ensure_text_document("/Users/x/.zshrc").is_err());
        assert!(ensure_text_document("/Users/x/.ssh/id_ed25519").is_err());
        assert!(ensure_text_document("/Users/x/notes.md.sh").is_err());
    }

    #[test]
    fn refuses_md_symlink_to_other_file() {
        let dir = scratch("link");
        let target = dir.join("profile");
        let link = dir.join("notes.md");
        fs::write(&target, "x").unwrap();
        symlink(&target, &link).unwrap();
        assert!(write_file(link.to_string_lossy().into(), "pwned".into()).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "x");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_dangling_md_symlink() {
        let dir = scratch("dangling");
        let target = dir.join("profile");
        let link = dir.join("notes.md");
        symlink(&target, &link).unwrap();
        assert!(write_file(link.to_string_lossy().into(), "pwned".into()).is_err());
        assert!(!target.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn open_target_asks_before_anything_that_could_run() {
        let dir = scratch("open");
        let script = dir.join("run.command");
        fs::write(&script, "#!/bin/sh\n").unwrap();
        fs::create_dir_all(dir.join("Tool.app")).unwrap();
        fs::write(dir.join("real.pdf"), "%PDF").unwrap();
        symlink(&script, dir.join("diagram.pdf")).unwrap();
        symlink(dir.join("Tool.app"), dir.join("chart.png")).unwrap();
        let ask = |name: &str| resolve_open_target(dir.join(name).to_string_lossy().into()).unwrap();

        assert!(!ask("real.pdf").confirm);
        assert!(ask("run.command").confirm);
        assert!(ask("Tool.app").confirm);
        let disguised = ask("diagram.pdf");
        assert!(disguised.confirm);
        assert!(disguised.path.ends_with("run.command"));
        assert!(ask("chart.png").confirm);
        fs::remove_dir_all(&dir).unwrap();
    }
}
