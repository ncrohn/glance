use std::path::{Path, PathBuf};

pub fn to_abs(path: &str, cwd: &Path) -> String {
    let p = Path::new(path);
    let joined = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    canonical(&joined)
}

/// One spelling per file, so a symlink, `/tmp` vs `/private/tmp`, `x/../` or
/// different letter case can't open the same document twice. A file that
/// exists is resolved by the filesystem (which also follows a symlinked
/// directory before any `..` after it); one that doesn't is cleaned up
/// lexically. The annotation store keys documents the same way.
pub fn canonical(path: &Path) -> String {
    match std::fs::canonicalize(path) {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(_) => normalize(path),
    }
}

fn normalize(p: &Path) -> String {
    use std::path::Component::*;
    let mut out: Vec<std::ffi::OsString> = Vec::new();
    let root = std::path::Component::RootDir.as_os_str();
    for comp in p.components() {
        match comp {
            CurDir => {}
            ParentDir => {
                // Never pop past the filesystem root: `..` at or above root is a
                // no-op (so e.g. `/a/../../x` clamps to `/x`, not a relative `x`).
                if out.last().map(|c| c.as_os_str()) != Some(root) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str().to_os_string()),
        }
    }
    let mut pb = PathBuf::new();
    for c in out {
        pb.push(c);
    }
    pb.to_string_lossy().to_string()
}

/// The document paths in a launch's argv (relative ones resolve against
/// `cwd`). A leading `-` marks a flag unless the argument names an existing
/// file or comes after `--`. Empty arguments and directories are dropped.
pub fn md_paths_from_argv(argv: &[String], cwd: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    let mut only_paths = false;
    for arg in argv.iter().skip(1) {
        if arg == "--" && !only_paths {
            only_paths = true;
            continue;
        }
        if arg.is_empty() {
            continue;
        }
        let meta = std::fs::metadata(cwd.join(arg)).ok();
        if meta.as_ref().is_some_and(|m| m.is_dir()) {
            continue;
        }
        if arg.starts_with('-') && !only_paths && !meta.is_some_and(|m| m.is_file()) {
            continue;
        }
        paths.push(arg.clone());
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn absolute_path_passes_through_normalized() {
        assert_eq!(to_abs("/a/b/notes.md", Path::new("/cwd")), "/a/b/notes.md");
    }

    #[test]
    fn relative_path_joins_cwd() {
        assert_eq!(to_abs("notes.md", Path::new("/home/x")), "/home/x/notes.md");
    }

    #[test]
    fn dot_and_dotdot_collapse() {
        assert_eq!(to_abs("./a/../b/c.md", Path::new("/root")), "/root/b/c.md");
    }

    #[test]
    fn dotdot_past_root_clamps_to_root() {
        // Excess `..` must not strip the root and yield a relative path.
        assert_eq!(to_abs("../../../notes.md", Path::new("/Users/nick")), "/notes.md");
    }

    #[test]
    fn argv_drops_program_and_flags() {
        let argv = vec![
            "glance".to_string(),
            "--flag".to_string(),
            "/a.md".to_string(),
            "b.md".to_string(),
        ];
        assert_eq!(md_paths_from_argv(&argv, Path::new("/nonexistent")), vec!["/a.md", "b.md"]);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glance-cli-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn argv_honors_double_dash_and_dash_named_files() {
        let dir = scratch("argv");
        std::fs::write(dir.join("-notes.md"), "x").unwrap();
        std::fs::create_dir_all(dir.join("some-dir")).unwrap();
        let argv: Vec<String> = [
            "glance", "-psn_0_12345", "-notes.md", "", "some-dir", "a.md", "--", "--weird.md", "--", "",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(md_paths_from_argv(&argv, &dir), vec!["-notes.md", "a.md", "--weird.md", "--"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn existing_files_resolve_to_one_spelling() {
        use std::os::unix::fs::symlink;
        let dir = scratch("canon");
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::fs::write(dir.join("real/Notes.md"), "x").unwrap();
        symlink(dir.join("real"), dir.join("link")).unwrap();
        let want = dir.join("real/Notes.md").to_string_lossy().into_owned();
        assert_eq!(to_abs("link/Notes.md", &dir), want);
        assert_eq!(to_abs("./real/../link/Notes.md", &dir), want);
        // APFS and HFS+ are case-insensitive by default; realpath returns the
        // on-disk case there.
        if dir.join("real/notes.md").exists() {
            assert_eq!(to_abs("real/notes.md", &dir), want);
        }
        // A file that doesn't exist yet still gets a clean absolute path.
        assert_eq!(
            to_abs("real/./new.md", &dir),
            dir.join("real/new.md").to_string_lossy().into_owned()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
