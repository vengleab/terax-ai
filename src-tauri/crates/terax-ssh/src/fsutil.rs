use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::{Result, SshError};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn tmp_sibling(path: &Path) -> Result<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| SshError::invalid("path has no parent directory"))?;
    let mut name = path
        .file_name()
        .ok_or_else(|| SshError::invalid("path has no file name"))?
        .to_os_string();
    name.push(format!(
        ".tmp-{}-{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    Ok(parent.join(name))
}

/// Writes `bytes` to a sibling temp file then renames it over `path`.
/// With `private` set the file is created with mode 0600 on Unix.
pub fn atomic_write(path: &Path, bytes: &[u8], private: bool) -> Result<()> {
    let tmp = tmp_sibling(path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let written = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(not(unix))]
        let _ = private;
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(err) = written {
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

pub fn random_hex(byte_len: usize) -> Result<String> {
    let mut bytes = vec![0u8; byte_len];
    getrandom::fill(&mut bytes)
        .map_err(|err| SshError::io(format!("random number generator failed: {err}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_existing_content_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("data.json");
        atomic_write(&path, b"one", false).unwrap();
        atomic_write(&path, b"two", false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from("data.json")]);
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_not_group_or_world_accessible() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret");
        atomic_write(&path, b"x", true).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
    }

    #[test]
    fn random_hex_has_requested_length_and_varies() {
        let a = random_hex(8).unwrap();
        let b = random_hex(8).unwrap();
        assert_eq!(a.len(), 16);
        assert_ne!(a, b);
    }
}
