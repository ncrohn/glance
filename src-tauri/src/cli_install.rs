use crate::setup::{atomic_write, replace_file, sh_quote};
use std::path::{Path, PathBuf};

#[derive(Clone, serde::Serialize)]
pub struct CliInstallResult {
    pub ok: bool,
    pub message: String,
}

fn err(message: impl Into<String>) -> CliInstallResult {
    CliInstallResult {
        ok: false,
        message: message.into(),
    }
}

/// Refuse to record `exe` (the running GUI binary) in any config unless the
/// app runs from a stable install location: a `.app` bundle under
/// `/Applications` or `~/Applications`. A DMG mount, a build dir, a download
/// staging copy or an App Translocation path would leave every config pointing
/// at something that disappears.
pub(crate) fn check_install_location(exe: &Path, home: &Path) -> Result<(), String> {
    let s = exe.to_string_lossy();
    if s.contains("/AppTranslocation/") {
        return Err("Glance is running from a quarantined copy. Move Glance.app to /Applications, reopen it, then try again.".to_string());
    }
    let bundle = exe
        .parent()
        .filter(|d| d.ends_with("Contents/MacOS"))
        .and_then(|d| d.parent()?.parent())
        .filter(|b| b.extension().is_some_and(|e| e == "app"));
    let stable = bundle.is_some_and(|b| b.starts_with("/Applications") || b.starts_with(home.join("Applications")));
    if stable {
        return Ok(());
    }
    let shown = bundle.unwrap_or(exe);
    Err(format!(
        "Glance is running from {}. Setup records this path in your AI tools' configs, so it must not move: put Glance.app in /Applications (or ~/Applications), open it from there, then try again.",
        shown.display()
    ))
}

/// The `mdview` wrapper for the Glance binary at `app_bin`.
///
/// It backgrounds the binary (`… "$@" & `) so the CLI returns immediately even
/// on a cold start — without it, the first `mdview <file>` of a session would
/// *become* the GUI process and block the calling terminal until Glance quit.
/// A missing binary (Glance moved or deleted) is reported on stderr with a
/// non-zero exit instead of failing silently in the background.
pub fn mdview_script(app_bin: &str) -> String {
    format!(
        "#!/bin/sh\n\
         # Glance CLI: launch/forward to Glance detached so the terminal returns\n\
         # immediately even on a cold start (when this invocation becomes the app).\n\
         GLANCE_APP={}\n\
         if [ ! -x \"$GLANCE_APP\" ]; then\n\
         \x20 echo \"mdview: Glance not found at $GLANCE_APP. Reinstall Glance, then run its AI integration setup again.\" >&2\n\
         \x20 exit 1\n\
         fi\n\
         \"$GLANCE_APP\" \"$@\" >/dev/null 2>&1 &\n",
        sh_quote(app_bin)
    )
}

/// Whether `bytes` is an mdview wrapper some Glance version wrote.
fn is_glance_wrapper(bytes: &[u8]) -> bool {
    bytes.starts_with(b"#!/bin/sh\n# Glance CLI:")
}

/// Whether symlink `link` points at a Glance app binary — how Glance before
/// the wrapper (≤ June 2026) installed mdview. Such a link must be replaced,
/// never written through: that would overwrite the app itself.
fn is_legacy_app_link(link: &Path) -> bool {
    std::fs::read_link(link).is_ok_and(|t| {
        let t = t.to_string_lossy();
        t.contains(".app/Contents/MacOS/") && t.ends_with("/glance")
    })
}

/// Install `~/.local/bin/mdview`, a wrapper that launches the Glance binary at
/// `app_bin` detached (see [`mdview_script`]). The caller has already checked
/// `app_bin` with [`check_install_location`].
///
/// A wrapper from an earlier install is updated in place: through a symlink
/// (dotfiles) when it is one, else atomically, so a failure never leaves
/// mdview missing. A legacy symlink to the app binary is atomically replaced
/// by the wrapper. Anything else at that path is the user's own and is left
/// alone with an error.
pub fn install_cli_tool(home: &Path, app_bin: &Path) -> CliInstallResult {
    let bindir = home.join(".local").join("bin");
    if let Err(e) = std::fs::create_dir_all(&bindir) {
        return err(format!("Could not create {}: {e}", bindir.display()));
    }
    let target: PathBuf = bindir.join("mdview");
    let script = mdview_script(&app_bin.to_string_lossy());
    let not_ours = || {
        err(format!(
            "{} already exists and isn't Glance's mdview wrapper, so it was left alone. Move or delete it, then try again.",
            target.display()
        ))
    };

    let res = match std::fs::symlink_metadata(&target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => replace_file(&target, script.as_bytes(), Some(0o755)),
        Err(e) => return err(format!("Could not inspect {}: {e}", target.display())),
        Ok(m) if m.file_type().is_symlink() => {
            if std::fs::read(&target).is_ok_and(|b| is_glance_wrapper(&b)) {
                atomic_write(&target, &script, Some(0o755))
            } else if is_legacy_app_link(&target) {
                replace_file(&target, script.as_bytes(), Some(0o755))
            } else {
                return not_ours();
            }
        }
        Ok(m) if m.is_file() => {
            if std::fs::read(&target).is_ok_and(|b| is_glance_wrapper(&b)) {
                replace_file(&target, script.as_bytes(), Some(0o755))
            } else {
                return not_ours();
            }
        }
        Ok(_) => return not_ours(),
    };
    if let Err(e) = res {
        return err(format!("Could not write {}: {e}", target.display()));
    }

    CliInstallResult {
        ok: true,
        message: format!(
            "Installed mdview → {}. Make sure ~/.local/bin is on your shell PATH, then run: mdview <file.md>",
            target.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("glance-cli-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn location_check_allows_only_applications() {
        let home = Path::new("/Users/me");
        let ok = |p: &str| check_install_location(Path::new(p), home).is_ok();
        assert!(ok("/Applications/Glance.app/Contents/MacOS/glance"));
        assert!(ok("/Applications/Tools/Glance.app/Contents/MacOS/glance"));
        assert!(ok("/Users/me/Applications/Glance.app/Contents/MacOS/glance"));
        assert!(!ok("/Volumes/Glance/Glance.app/Contents/MacOS/glance"));
        assert!(!ok("/Users/me/dev/glance/src-tauri/target/release/bundle/macos/Glance.app/Contents/MacOS/glance"));
        assert!(!ok("/Users/me/Downloads/Glance.app/Contents/MacOS/glance"));
        assert!(!ok("/Users/me/dev/glance/src-tauri/target/debug/glance"));
        assert!(!ok("/private/var/folders/x/AppTranslocation/ABC/d/Glance.app/Contents/MacOS/glance"));
        assert!(!ok("/Applications-old/Glance.app/Contents/MacOS/glance"));
        assert!(check_install_location(Path::new("/Volumes/G/Glance.app/Contents/MacOS/glance"), home)
            .unwrap_err()
            .contains("/Volumes/G/Glance.app"));
    }

    #[test]
    fn wrapper_quotes_the_app_path_and_fails_loudly_when_missing() {
        let dir = scratch("wrapper");
        let odd = dir.join("we ird $HOME `id` \"q\" it's");
        std::fs::create_dir_all(&odd).unwrap();
        let marker = dir.join("argv");
        let app = odd.join("glance");
        std::fs::write(&app, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o755)).unwrap();
        let wrapper = dir.join("mdview");
        std::fs::write(&wrapper, mdview_script(&app.to_string_lossy())).unwrap();
        let out = std::process::Command::new("sh").arg(&wrapper).arg("a b.md").output().unwrap();
        assert!(out.status.success());
        for _ in 0..40 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "a b.md\n");

        std::fs::write(&wrapper, mdview_script(&dir.join("gone").join("glance").to_string_lossy())).unwrap();
        let out = std::process::Command::new("sh").arg(&wrapper).arg("x.md").output().unwrap();
        assert_eq!(out.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&out.stderr).contains("Glance not found"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_writes_through_a_wrapper_symlink_and_replaces_a_legacy_app_link() {
        let home = scratch("install");
        let app = Path::new("/Applications/Glance.app/Contents/MacOS/glance");
        let bin = home.join(".local").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let mdview = bin.join("mdview");

        // fresh install
        assert!(install_cli_tool(&home, app).ok);
        let mode = std::fs::metadata(&mdview).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
        assert!(std::fs::read_to_string(&mdview).unwrap().contains("GLANCE_APP='/Applications/Glance.app/Contents/MacOS/glance'"));

        // dotfiles-managed wrapper: written through, link kept
        let dot = home.join("dotfiles").join("mdview");
        std::fs::create_dir_all(dot.parent().unwrap()).unwrap();
        std::fs::write(&dot, "#!/bin/sh\n# Glance CLI: old\n\"/old\" \"$@\" &\n").unwrap();
        std::fs::remove_file(&mdview).unwrap();
        std::os::unix::fs::symlink(&dot, &mdview).unwrap();
        assert!(install_cli_tool(&home, app).ok);
        assert!(std::fs::symlink_metadata(&mdview).unwrap().file_type().is_symlink());
        assert!(std::fs::read_to_string(&dot).unwrap().contains("GLANCE_APP="));

        // legacy symlink to the app binary: the link is replaced, its target untouched
        let fake_app = home.join("Old.app").join("Contents").join("MacOS").join("glance");
        std::fs::create_dir_all(fake_app.parent().unwrap()).unwrap();
        std::fs::write(&fake_app, "BINARY").unwrap();
        std::fs::remove_file(&mdview).unwrap();
        std::os::unix::fs::symlink(&fake_app, &mdview).unwrap();
        assert!(install_cli_tool(&home, app).ok);
        assert!(!std::fs::symlink_metadata(&mdview).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read_to_string(&fake_app).unwrap(), "BINARY");

        // someone else's mdview (file or link) is refused and kept
        std::fs::write(&dot, "#!/bin/sh\necho my own mdview\n").unwrap();
        std::fs::remove_file(&mdview).unwrap();
        std::os::unix::fs::symlink(&dot, &mdview).unwrap();
        let r = install_cli_tool(&home, app);
        assert!(!r.ok, "{}", r.message);
        assert_eq!(std::fs::read_to_string(&dot).unwrap(), "#!/bin/sh\necho my own mdview\n");
        std::fs::remove_file(&mdview).unwrap();
        std::fs::write(&mdview, "#!/bin/sh\necho other tool\n").unwrap();
        assert!(!install_cli_tool(&home, app).ok);
        assert_eq!(std::fs::read_to_string(&mdview).unwrap(), "#!/bin/sh\necho other tool\n");
        let _ = std::fs::remove_dir_all(&home);
    }
}
