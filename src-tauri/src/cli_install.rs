use std::path::PathBuf;

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

/// Install a `~/.local/bin/mdview` wrapper that launches the currently-running
/// Glance binary detached.
///
/// The wrapper backgrounds the binary (`… "$@" & `) so the CLI returns
/// immediately even on a cold start — without it, the first `mdview <file>` of a
/// session would *become* the GUI process and block the calling terminal until
/// Glance quit. It targets `current_exe()` (not a hardcoded path or a
/// source-checkout script), so it's independent of where the repo lives and
/// stays valid across app updates.
pub fn install_cli_tool() -> CliInstallResult {
    use std::os::unix::fs::PermissionsExt;

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return err(format!("Could not locate the Glance binary: {e}")),
    };

    // A quarantined/translocated copy lives at a randomized read-only path that
    // the OS later cleans up, so a wrapper pointing at it would break. Tell the
    // user to move the app into place first.
    if exe.to_string_lossy().contains("AppTranslocation") {
        return err(
            "Glance is running from a quarantined copy. Move Glance.app to /Applications, reopen it, then try again.",
        );
    }

    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return err("Could not determine your home directory ($HOME)."),
    };
    let bindir = home.join(".local").join("bin");
    if let Err(e) = std::fs::create_dir_all(&bindir) {
        return err(format!("Could not create {}: {e}", bindir.display()));
    }

    let target = bindir.join("mdview");
    let script = format!(
        "#!/bin/sh\n\
         # Glance CLI: launch/forward to Glance detached so the terminal returns\n\
         # immediately even on a cold start (when this invocation becomes the app).\n\
         \"{}\" \"$@\" >/dev/null 2>&1 &\n",
        exe.display()
    );
    // Replace any existing file or symlink at the target.
    let _ = std::fs::remove_file(&target);
    if let Err(e) = std::fs::write(&target, script) {
        return err(format!("Could not write {}: {e}", target.display()));
    }
    if let Err(e) = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)) {
        return err(format!(
            "Could not make {} executable: {e}",
            target.display()
        ));
    }

    CliInstallResult {
        ok: true,
        message: format!(
            "Installed mdview → {}. Make sure ~/.local/bin is on your shell PATH, then run: mdview <file.md>",
            target.display()
        ),
    }
}
