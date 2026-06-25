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

/// Symlink the currently-running Glance binary to `~/.local/bin/mdview`.
///
/// Pointing at `current_exe()` (rather than a hardcoded /Applications path or a
/// source-checkout wrapper) makes the CLI independent of where the repo lives
/// and keeps it valid across app updates: it always resolves to the live binary
/// inside whatever Glance.app is running.
pub fn install_cli_tool() -> CliInstallResult {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return err(format!("Could not locate the Glance binary: {e}")),
    };

    // A quarantined/translocated copy lives at a randomized read-only path; a
    // symlink to it would break once the OS cleans it up. Tell the user to move
    // the app into place first.
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
    // Replace any existing file or symlink at the target.
    let _ = std::fs::remove_file(&target);
    if let Err(e) = std::os::unix::fs::symlink(&exe, &target) {
        return err(format!(
            "Could not create the symlink at {}: {e}",
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
