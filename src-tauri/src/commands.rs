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
    write_atomic(Path::new(&path), contents.as_bytes()).map_err(|e| e.to_string())
}

/// The path the frontend keys tabs on: see `cli::canonical`.
#[tauri::command]
pub fn canonicalize_path(path: String) -> String {
    crate::cli::canonical(Path::new(&path))
}

/// Replace a file's contents so a crash or a full disk leaves either the old
/// text or the new, never a truncated file: write a temp file beside the
/// target, fsync it, then rename it over. A symlink is followed first so the
/// link itself survives. The new inode takes the old file's permissions, but
/// a hard link to the old file keeps the old text, and owner and extended
/// attributes come from the writer, as with any editor's safe save.
fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let existing = fs::metadata(&target).ok();
    // A rename would replace a read-only file the in-place write was refused.
    if existing.as_ref().is_some_and(|m| m.permissions().readonly()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} is read-only", target.display()),
        ));
    }
    let name = target
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a file path"))?;
    let dir = target.parent().unwrap_or(Path::new("/"));
    let tmp = dir.join(format!(
        ".{}.{}-{}.glance-tmp",
        name.to_string_lossy(),
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        if existing.is_some() {
            // Private until it has the target's permissions.
            std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        }
        let mut file = opts.open(&tmp)?;
        file.write_all(contents)?;
        if let Some(meta) = &existing {
            file.set_permissions(meta.permissions())?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, &target)?;
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
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
    fn write_replaces_the_file_whole_and_keeps_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("atomic");
        let doc = dir.join("doc.md");
        fs::write(&doc, "old").unwrap();
        fs::set_permissions(&doc, fs::Permissions::from_mode(0o640)).unwrap();
        write_file(doc.to_string_lossy().into(), "new text".into()).unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "new text");
        assert_eq!(fs::metadata(&doc).unwrap().permissions().mode() & 0o777, 0o640);
        // No temp file is left behind.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        // A new file can still be created.
        write_file(dir.join("new.md").to_string_lossy().into(), "x".into()).unwrap();
        assert_eq!(fs::read_to_string(dir.join("new.md")).unwrap(), "x");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_through_a_symlink_keeps_the_link() {
        let dir = scratch("atomic-link");
        let target = dir.join("real.md");
        let link = dir.join("link.md");
        fs::write(&target, "old").unwrap();
        symlink(&target, &link).unwrap();
        write_file(link.to_string_lossy().into(), "new".into()).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_refuses_a_read_only_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("atomic-ro");
        let doc = dir.join("doc.md");
        fs::write(&doc, "old").unwrap();
        fs::set_permissions(&doc, fs::Permissions::from_mode(0o444)).unwrap();
        assert!(write_file(doc.to_string_lossy().into(), "new".into()).is_err());
        assert_eq!(fs::read_to_string(&doc).unwrap(), "old");
        fs::set_permissions(&doc, fs::Permissions::from_mode(0o644)).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_write_leaves_the_old_file_and_no_temp() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("atomic-fail");
        let doc = dir.join("doc.md");
        fs::write(&doc, "old").unwrap();
        // A read-only directory refuses the temp file.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        assert!(write_file(doc.to_string_lossy().into(), "new".into()).is_err());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "old");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
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
