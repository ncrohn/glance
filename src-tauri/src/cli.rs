use std::path::{Path, PathBuf};

pub fn to_abs(path: &str, cwd: &Path) -> String {
    let p = Path::new(path);
    let joined = if p.is_absolute() { p.to_path_buf() } else { cwd.join(p) };
    normalize(&joined)
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

pub fn md_paths_from_argv(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .cloned()
        .collect()
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
        assert_eq!(md_paths_from_argv(&argv), vec!["/a.md", "b.md"]);
    }
}
