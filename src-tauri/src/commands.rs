use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

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

/// Documents the page has opened this session, keyed like the annotation store
/// (`doc_key`), so a symlink or other spelling of an open file matches it. A
/// path enters when `read_file` succeeds on it, and only those can be saved or
/// watched: script injected into the page can't create a new file or watch one
/// it never opened. It can still overwrite an existing document by reading it
/// first.
#[derive(Default)]
pub struct OpenDocs(Mutex<HashSet<String>>);

impl OpenDocs {
    fn add(&self, path: &str) {
        let key = crate::annotations::doc_key(path);
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(key);
    }

    fn contains(&self, path: &str) -> bool {
        let key = crate::annotations::doc_key(path);
        self.0.lock().unwrap_or_else(|e| e.into_inner()).contains(&key)
    }
}

fn read_document(docs: &OpenDocs, path: &str) -> Result<String, String> {
    ensure_text_document(path)?;
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    docs.add(path);
    Ok(text)
}

fn write_document(docs: &OpenDocs, path: &str, contents: &str) -> Result<(), String> {
    ensure_text_document(path)?;
    if !docs.contains(path) {
        return Err(format!("Glance can only save documents it has open: {path}"));
    }
    write_atomic(Path::new(path), contents.as_bytes()).map_err(|e| e.to_string())
}

pub fn ensure_watchable(docs: &OpenDocs, path: &str) -> Result<(), String> {
    ensure_text_document(path)?;
    if !docs.contains(path) {
        return Err(format!("Glance can only watch documents it has open: {path}"));
    }
    Ok(())
}

/// Annotation watches share the `Watchers` map with document watches, so a
/// store path must be the store of an open document and nothing else. Store
/// paths end in `.json`, which no document can, so the two never share a key.
pub fn ensure_store_watchable(
    docs: &OpenDocs,
    dir: Option<&Path>,
    store_path: &str,
    doc_path: &str,
) -> Result<(), String> {
    ensure_watchable(docs, doc_path)?;
    let dir = dir.ok_or_else(|| "Could not determine $HOME".to_string())?;
    if !crate::annotations::is_store_of(dir, store_path, doc_path) {
        return Err(format!("Not the annotation store for {doc_path}: {store_path}"));
    }
    Ok(())
}

#[tauri::command]
pub fn read_file(path: String, docs: tauri::State<OpenDocs>) -> Result<String, String> {
    read_document(&docs, &path)
}

#[tauri::command]
pub fn write_file(
    path: String,
    contents: String,
    docs: tauri::State<OpenDocs>,
) -> Result<(), String> {
    write_document(&docs, &path, &contents)
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
/// Carry Finder tags and other extended attributes, plus ACLs, over to the file
/// that replaces `from`. Best effort: a failure here shouldn't block a save.
#[cfg(target_os = "macos")]
fn copy_metadata(from: &Path, to: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let (Ok(src), Ok(dst)) = (
        CString::new(from.as_os_str().as_bytes()),
        CString::new(to.as_os_str().as_bytes()),
    ) else {
        return;
    };
    unsafe {
        libc::copyfile(
            src.as_ptr(),
            dst.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_XATTR | libc::COPYFILE_ACL,
        );
    }
}

fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let target = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let existing = fs::metadata(&target).ok();
    // A rename only needs the directory to be writable, so it would replace a
    // file the user can't write (read-only, or owned by root). Ask the file.
    if existing.is_some() {
        fs::OpenOptions::new().write(true).open(&target)?;
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
        let mut file = match opts.open(&tmp) {
            Ok(f) => f,
            // The folder isn't writable but the file is: save in place, as
            // before atomic saves, rather than refuse a save that used to work.
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && existing.is_some() => {
                return fs::write(&target, contents);
            }
            Err(e) => return Err(e),
        };
        file.write_all(contents)?;
        if let Some(meta) = &existing {
            file.set_permissions(meta.permissions())?;
        }
        file.sync_all()?;
        drop(file);
        #[cfg(target_os = "macos")]
        if existing.is_some() {
            copy_metadata(&target, &tmp);
        }
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

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    /// The set after the page has read `path`, as opening a tab does.
    fn opened(path: &Path) -> OpenDocs {
        let docs = OpenDocs::default();
        read_document(&docs, s(path)).unwrap();
        docs
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
        // Refused even when its spelling is in the open set.
        let docs = OpenDocs::default();
        docs.add(s(&link));
        assert!(write_document(&docs, s(&link), "pwned").is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "x");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_dangling_md_symlink() {
        let dir = scratch("dangling");
        let target = dir.join("profile");
        let link = dir.join("notes.md");
        symlink(&target, &link).unwrap();
        let docs = OpenDocs::default();
        docs.add(s(&link));
        assert!(write_document(&docs, s(&link), "pwned").is_err());
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
        write_document(&opened(&doc), s(&doc), "new text").unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "new text");
        assert_eq!(fs::metadata(&doc).unwrap().permissions().mode() & 0o777, 0o640);
        // No temp file is left behind.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_through_a_symlink_keeps_the_link() {
        let dir = scratch("atomic-link");
        let target = dir.join("real.md");
        let link = dir.join("link.md");
        fs::write(&target, "old").unwrap();
        symlink(&target, &link).unwrap();
        write_document(&opened(&link), s(&link), "new").unwrap();
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
        assert!(write_document(&opened(&doc), s(&doc), "new").is_err());
        assert_eq!(fs::read_to_string(&doc).unwrap(), "old");
        fs::set_permissions(&doc, fs::Permissions::from_mode(0o644)).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_read_only_folder_still_saves_a_writable_file_in_place() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("atomic-rodir");
        let doc = dir.join("doc.md");
        fs::write(&doc, "old").unwrap();
        let docs = opened(&doc);
        // The folder refuses the temp file; the file itself is writable.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let res = write_document(&docs, s(&doc), "new");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        res.unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "new");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_save_keeps_extended_attributes() {
        let dir = scratch("atomic-xattr");
        let doc = dir.join("doc.md");
        fs::write(&doc, "old").unwrap();
        let set = std::process::Command::new("xattr")
            .args(["-w", "com.glance.test", "tagged"])
            .arg(&doc)
            .status()
            .unwrap();
        assert!(set.success());
        write_document(&opened(&doc), s(&doc), "new").unwrap();
        let out = std::process::Command::new("xattr")
            .args(["-p", "com.glance.test"])
            .arg(&doc)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "tagged");
        assert_eq!(fs::read_to_string(&doc).unwrap(), "new");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_save_needs_the_doc_to_have_been_read() {
        let dir = scratch("open-set");
        let doc = dir.join("doc.md");
        let new = dir.join("SKILL.md");
        fs::write(&doc, "old").unwrap();
        let docs = OpenDocs::default();

        let err = write_document(&docs, s(&doc), "pwned").unwrap_err();
        assert_eq!(err, format!("Glance can only save documents it has open: {}", s(&doc)));
        assert_eq!(fs::read_to_string(&doc).unwrap(), "old");
        assert!(write_document(&docs, s(&new), "pwned").is_err());
        assert!(!new.exists());
        // A failed read doesn't open it either.
        assert!(read_document(&docs, s(&new)).is_err());
        assert!(write_document(&docs, s(&new), "pwned").is_err());
        assert!(!new.exists());

        assert_eq!(read_document(&docs, s(&doc)).unwrap(), "old");
        write_document(&docs, s(&doc), "new").unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "new");
        // Deleted while open, a save puts it back.
        fs::remove_file(&doc).unwrap();
        write_document(&docs, s(&doc), "again").unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "again");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn any_spelling_of_an_open_doc_can_be_saved() {
        let dir = scratch("open-spelling");
        let real = dir.join("real.md");
        let link = dir.join("link.md");
        fs::write(&real, "old").unwrap();
        symlink(&real, &link).unwrap();
        let docs = opened(&real);
        write_document(&docs, s(&link), "via link").unwrap();
        assert_eq!(fs::read_to_string(&real).unwrap(), "via link");
        let dotted = dir.join(".").join("real.md");
        write_document(&docs, s(&dotted), "dotted").unwrap();
        assert_eq!(fs::read_to_string(&real).unwrap(), "dotted");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_open_text_documents_can_be_watched() {
        let dir = scratch("watchable");
        let doc = dir.join("doc.md");
        let other = dir.join("other.md");
        let key = dir.join("id_ed25519");
        fs::write(&doc, "x").unwrap();
        fs::write(&other, "x").unwrap();
        fs::write(&key, "secret").unwrap();
        let docs = opened(&doc);
        // In the set but not a document, as if it had got there some other way.
        docs.add(s(&key));

        ensure_watchable(&docs, s(&doc)).unwrap();
        assert!(ensure_watchable(&docs, s(&key)).is_err());
        assert!(ensure_watchable(&docs, "/etc/hosts").is_err());
        assert_eq!(
            ensure_watchable(&docs, s(&other)).unwrap_err(),
            format!("Glance can only watch documents it has open: {}", s(&other))
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_store_of_an_open_doc_can_be_watched() {
        let dir = scratch("store-watch");
        let stores = dir.join("annotations");
        let doc = dir.join("doc.md");
        let other = dir.join("other.md");
        let closed = dir.join("closed.md");
        let key = dir.join("id_ed25519");
        for f in [&doc, &other, &closed, &key] {
            fs::write(f, "x").unwrap();
        }
        let docs = opened(&doc);
        read_document(&docs, s(&other)).unwrap();
        let store_of = |p: &Path| {
            let key = crate::annotations::doc_key(s(p));
            s(&stores.join(format!("{}.json", crate::annotations::sha1_hex(&key)))).to_string()
        };
        let check = |store: &str, doc: &Path| ensure_store_watchable(&docs, Some(&stores), store, s(doc));

        check(&store_of(&doc), &doc).unwrap();
        assert_eq!(
            check(s(&key), &doc).unwrap_err(),
            format!("Not the annotation store for {}: {}", s(&doc), s(&key))
        );
        assert!(check(s(&doc), &doc).is_err());
        assert!(check(&store_of(&other), &doc).is_err());
        assert!(check(&store_of(&closed), &closed).is_err());
        assert!(ensure_store_watchable(&docs, None, &store_of(&doc), s(&doc)).is_err());
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
