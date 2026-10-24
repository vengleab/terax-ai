//! Editing a remote file in the local editor.
//!
//! The file is downloaded into a private cache folder under its original name, so the editor and
//! its safeguards treat it like any other file. When the local copy is saved, `sync_up` uploads it,
//! unless the remote file changed since the download, in which case the caller must decide.

use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{ErrorCode, Result, SshError};
use crate::fs::{EntryKind, Fs};
use crate::fsutil::random_hex;
use crate::transfer::safety::{check_component, part_name};

pub const MAX_EDIT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Baseline {
    mtime: Option<i64>,
    size: u64,
    mode: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LocalStamp {
    mtime: Option<i64>,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditInfo {
    pub id: String,
    pub remote_path: String,
    pub local_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncOutcome {
    #[serde(rename_all = "camelCase")]
    Uploaded { size: u64 },
    Unchanged,
    #[serde(rename_all = "camelCase")]
    Conflict {
        remote_mtime: Option<i64>,
        remote_size: u64,
        baseline_mtime: Option<i64>,
        baseline_size: u64,
    },
}

pub struct EditSession {
    pub id: String,
    remote: Fs,
    pub remote_path: String,
    pub local_path: PathBuf,
    baseline: Baseline,
    synced: LocalStamp,
}

fn canonical_local(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.into_owned()
    }
}

fn stamp(meta: &std::fs::Metadata) -> LocalStamp {
    LocalStamp {
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| i64::try_from(d.as_secs()).ok()),
        size: meta.len(),
    }
}

async fn download(remote: &Fs, remote_path: &str, local: &Path) -> Result<()> {
    let mut reader = remote.open_read(remote_path, 0).await?;
    let mut file = tokio::fs::File::create(local).await?;
    let mut buf = vec![0u8; 128 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_EDIT_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(local).await;
            return Err(SshError::invalid("the file is too large to edit remotely"));
        }
        file.write_all(buf.get(..n).unwrap_or_default()).await?;
    }
    file.flush().await?;
    Ok(())
}

impl EditSession {
    /// Downloads `remote_path` into a fresh folder under `cache_root`.
    pub async fn open(remote: Fs, remote_path: &str, cache_root: &Path) -> Result<EditSession> {
        let stat = remote.stat(remote_path, true).await?;
        if stat.kind != EntryKind::File {
            return Err(SshError::invalid("only regular files can be edited"));
        }
        if stat.size > MAX_EDIT_BYTES {
            return Err(SshError::invalid("the file is too large to edit remotely (limit 50 MB)"));
        }
        let name = remote.file_name(remote_path);
        check_component(&name, cfg!(windows)).map_err(|reason| SshError::invalid(format!("cannot edit this file: {reason}")))?;

        let id = random_hex(6)?;
        let dir = cache_root.join(&id);
        tokio::fs::create_dir_all(&dir).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).await?;
        }
        let local_path = dir.join(&name);
        if let Err(err) = download(&remote, remote_path, &local_path).await {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(err);
        }
        let meta = tokio::fs::metadata(&local_path).await?;
        Ok(EditSession {
            id,
            remote,
            remote_path: remote_path.to_string(),
            local_path,
            baseline: Baseline { mtime: stat.mtime, size: stat.size, mode: stat.mode },
            synced: stamp(&meta),
        })
    }

    pub fn info(&self) -> EditInfo {
        EditInfo {
            id: self.id.clone(),
            remote_path: self.remote_path.clone(),
            local_path: canonical_local(&self.local_path),
        }
    }

    /// Uploads the local copy. Without `force`, a remote file that changed since the download is a conflict.
    pub async fn sync_up(&mut self, force: bool) -> Result<SyncOutcome> {
        let local_meta = tokio::fs::metadata(&self.local_path).await?;
        let local = stamp(&local_meta);
        if local == self.synced && !force {
            return Ok(SyncOutcome::Unchanged);
        }
        if local.size > MAX_EDIT_BYTES {
            return Err(SshError::invalid("the file is too large to upload from the editor"));
        }

        let remote_stat = self.remote.stat(&self.remote_path, true).await?;
        if !force && (remote_stat.mtime != self.baseline.mtime || remote_stat.size != self.baseline.size) {
            return Ok(SyncOutcome::Conflict {
                remote_mtime: remote_stat.mtime,
                remote_size: remote_stat.size,
                baseline_mtime: self.baseline.mtime,
                baseline_size: self.baseline.size,
            });
        }

        self.upload().await?;
        let after = self.remote.stat(&self.remote_path, true).await?;
        self.baseline = Baseline { mtime: after.mtime, size: after.size, mode: self.baseline.mode };
        self.synced = local;
        Ok(SyncOutcome::Uploaded { size: local.size })
    }

    async fn upload(&self) -> Result<()> {
        let dir = self.remote.parent(&self.remote_path);
        let part = self.remote.join(&dir, &part_name(&self.remote.file_name(&self.remote_path)));
        match self.write_remote(&part).await {
            Ok(()) => {
                self.remote.rename_over(&part, &self.remote_path).await?;
                if self.baseline.mode.is_some() {
                    self.remote.set_times_and_mode(&self.remote_path, None, self.baseline.mode).await;
                }
                Ok(())
            }
            Err(err) if err.code == ErrorCode::PermissionDenied => {
                let _ = self.remote.remove_file(&part).await;
                self.write_remote(&self.remote_path).await
            }
            Err(err) => {
                let _ = self.remote.remove_file(&part).await;
                Err(err)
            }
        }
    }

    async fn write_remote(&self, path: &str) -> Result<()> {
        let mut source = tokio::fs::File::open(&self.local_path).await?;
        let mut writer = self.remote.open_write(path, None).await?;
        let mut buf = vec![0u8; 128 * 1024];
        loop {
            let n = source.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            writer.write_all(buf.get(..n).unwrap_or_default()).await?;
        }
        writer.shutdown().await?;
        Ok(())
    }

    /// Discards local changes and downloads the current remote content again.
    pub async fn reload(&mut self) -> Result<()> {
        let stat = self.remote.stat(&self.remote_path, true).await?;
        if stat.size > MAX_EDIT_BYTES {
            return Err(SshError::invalid("the file is too large to edit remotely (limit 50 MB)"));
        }
        download(&self.remote, &self.remote_path, &self.local_path).await?;
        let meta = tokio::fs::metadata(&self.local_path).await?;
        self.baseline = Baseline { mtime: stat.mtime, size: stat.size, mode: stat.mode };
        self.synced = stamp(&meta);
        Ok(())
    }

    pub async fn cleanup(&self) {
        if let Some(dir) = self.local_path.parent() {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
    }
}

/// All open edit sessions. Lookups by local path let a save event find its session.
#[derive(Default)]
pub struct Edits {
    sessions: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<EditSession>>>>,
    paths: std::sync::Mutex<HashMap<String, String>>,
}

impl Edits {
    pub async fn open(&self, remote: Fs, remote_path: &str, cache_root: &Path) -> Result<EditInfo> {
        let session = EditSession::open(remote, remote_path, cache_root).await?;
        let info = session.info();
        if let (Ok(mut sessions), Ok(mut paths)) = (self.sessions.lock(), self.paths.lock()) {
            paths.insert(info.local_path.clone(), info.id.clone());
            sessions.insert(info.id.clone(), Arc::new(tokio::sync::Mutex::new(session)));
        }
        Ok(info)
    }

    pub fn id_for_local_path(&self, local_path: &str) -> Option<String> {
        let normalized = if cfg!(windows) { local_path.replace('\\', "/") } else { local_path.to_string() };
        self.paths.lock().ok()?.get(&normalized).cloned()
    }

    fn get(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<EditSession>>> {
        self.sessions
            .lock()
            .ok()
            .and_then(|s| s.get(id).cloned())
            .ok_or_else(|| SshError::not_found("this remote edit session no longer exists"))
    }

    pub async fn sync(&self, id: &str, force: bool) -> Result<SyncOutcome> {
        self.get(id)?.lock().await.sync_up(force).await
    }

    pub async fn reload(&self, id: &str) -> Result<()> {
        self.get(id)?.lock().await.reload().await
    }

    pub async fn close(&self, id: &str) -> Result<()> {
        let session = self.get(id)?;
        let guard = session.lock().await;
        guard.cleanup().await;
        let local = guard.info().local_path;
        drop(guard);
        if let (Ok(mut sessions), Ok(mut paths)) = (self.sessions.lock(), self.paths.lock()) {
            sessions.remove(id);
            paths.remove(&local);
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<EditInfo> {
        let sessions: Vec<_> = self.sessions.lock().map(|s| s.values().cloned().collect()).unwrap_or_default();
        sessions
            .into_iter()
            .filter_map(|s| s.try_lock().ok().map(|g| g.info()))
            .collect()
    }

    /// Removes every cached edit folder, for startup and exit.
    pub async fn clear_cache(&self, cache_root: &Path) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.clear();
        }
        if let Ok(mut paths) = self.paths.lock() {
            paths.clear();
        }
        let _ = tokio::fs::remove_dir_all(cache_root).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SshSession;
    use crate::testing::{context, password_spec, trust, Opts, TestServer};
    use std::fs;

    async fn remote() -> (TestServer, Fs, Arc<SshSession>, tempfile::TempDir) {
        let server = TestServer::start(Opts {
            users: vec![("alice".to_string(), "secret".to_string())],
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        trust(&ctx, &server);
        let session = SshSession::connect(&ctx, &password_spec(&server, "alice", "secret"), None).await.unwrap();
        let sftp = session.open_sftp().await.unwrap();
        (server, Fs::Remote(Arc::new(sftp)), session, dir)
    }

    fn bump_mtime(path: &Path, secs: u64) {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(when).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn open_downloads_under_the_original_name() {
        let (server, fs_remote, _session, _keep) = remote().await;
        fs::create_dir(server.root.path().join("etc")).unwrap();
        fs::write(server.root.path().join("etc/app.conf"), b"key=value\n").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let session = EditSession::open(fs_remote, "/etc/app.conf", cache.path()).await.unwrap();
        assert_eq!(session.local_path.file_name().unwrap(), "app.conf");
        assert!(session.local_path.starts_with(cache.path()));
        assert_eq!(fs::read(&session.local_path).unwrap(), b"key=value\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(session.local_path.parent().unwrap()).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "the cache folder is private");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_up_uploads_changes_and_ignores_repeats() {
        let (server, fs_remote, _session, _keep) = remote().await;
        fs::write(server.root.path().join("a.txt"), b"one").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let mut session = EditSession::open(fs_remote, "/a.txt", cache.path()).await.unwrap();

        assert_eq!(session.sync_up(false).await.unwrap(), SyncOutcome::Unchanged);
        fs::write(&session.local_path, b"two plus").unwrap();
        bump_mtime(&session.local_path, 1_700_000_100);
        assert_eq!(session.sync_up(false).await.unwrap(), SyncOutcome::Uploaded { size: 8 });
        assert_eq!(fs::read(server.root.path().join("a.txt")).unwrap(), b"two plus");
        assert_eq!(session.sync_up(false).await.unwrap(), SyncOutcome::Unchanged);

        fs::write(&session.local_path, b"three").unwrap();
        bump_mtime(&session.local_path, 1_700_000_200);
        assert_eq!(session.sync_up(false).await.unwrap(), SyncOutcome::Uploaded { size: 5 });
        assert_eq!(fs::read(server.root.path().join("a.txt")).unwrap(), b"three");
        let leftovers: Vec<_> = fs::read_dir(server.root.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers.len(), 1, "no temp files left behind: {leftovers:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_remote_change_since_download_is_a_conflict_until_forced() {
        let (server, fs_remote, _session, _keep) = remote().await;
        let remote_file = server.root.path().join("shared.txt");
        fs::write(&remote_file, b"original").unwrap();
        bump_mtime(&remote_file, 1_700_000_000);
        let cache = tempfile::tempdir().unwrap();
        let mut session = EditSession::open(fs_remote, "/shared.txt", cache.path()).await.unwrap();

        fs::write(&remote_file, b"someone else was here").unwrap();
        bump_mtime(&remote_file, 1_700_000_500);
        fs::write(&session.local_path, b"my edit").unwrap();
        bump_mtime(&session.local_path, 1_700_000_900);

        match session.sync_up(false).await.unwrap() {
            SyncOutcome::Conflict { remote_size, baseline_size, .. } => {
                assert_eq!(remote_size, 21);
                assert_eq!(baseline_size, 8);
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
        assert_eq!(fs::read(&remote_file).unwrap(), b"someone else was here", "nothing was overwritten");

        assert_eq!(session.sync_up(true).await.unwrap(), SyncOutcome::Uploaded { size: 7 });
        assert_eq!(fs::read(&remote_file).unwrap(), b"my edit");
        fs::write(&session.local_path, b"later").unwrap();
        bump_mtime(&session.local_path, 1_700_001_000);
        assert_eq!(session.sync_up(false).await.unwrap(), SyncOutcome::Uploaded { size: 5 }, "baseline moved forward after the forced upload");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reload_discards_local_changes_and_resets_the_baseline() {
        let (server, fs_remote, _session, _keep) = remote().await;
        let remote_file = server.root.path().join("r.txt");
        fs::write(&remote_file, b"v1").unwrap();
        bump_mtime(&remote_file, 1_700_000_000);
        let cache = tempfile::tempdir().unwrap();
        let mut session = EditSession::open(fs_remote, "/r.txt", cache.path()).await.unwrap();
        fs::write(&remote_file, b"v2-longer").unwrap();
        bump_mtime(&remote_file, 1_700_000_600);
        fs::write(&session.local_path, b"local junk").unwrap();
        session.reload().await.unwrap();
        assert_eq!(fs::read(&session.local_path).unwrap(), b"v2-longer");
        assert_eq!(session.sync_up(false).await.unwrap(), SyncOutcome::Unchanged);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_upload_keeps_the_remote_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (server, fs_remote, _session, _keep) = remote().await;
        let remote_file = server.root.path().join("run.sh");
        fs::write(&remote_file, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(&remote_file, fs::Permissions::from_mode(0o750)).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let mut session = EditSession::open(fs_remote, "/run.sh", cache.path()).await.unwrap();
        fs::write(&session.local_path, b"#!/bin/sh\necho hi\n").unwrap();
        bump_mtime(&session.local_path, 1_700_000_300);
        session.sync_up(false).await.unwrap();
        assert_eq!(fs::metadata(&remote_file).unwrap().permissions().mode() & 0o777, 0o750);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_reasonable_regular_files_can_be_opened() {
        let (server, fs_remote, _session, _keep) = remote().await;
        fs::create_dir(server.root.path().join("dir")).unwrap();
        let cache = tempfile::tempdir().unwrap();
        let err = EditSession::open(fs_remote.clone(), "/dir", cache.path()).await.err().unwrap();
        assert_eq!(err.code, ErrorCode::Invalid);
        let err = EditSession::open(fs_remote.clone(), "/missing.txt", cache.path()).await.err().unwrap();
        assert_eq!(err.code, ErrorCode::NotFound);
        let big = server.root.path().join("big.bin");
        let file = fs::File::create(&big).unwrap();
        file.set_len(MAX_EDIT_BYTES + 1).unwrap();
        let err = EditSession::open(fs_remote, "/big.bin", cache.path()).await.err().unwrap();
        assert!(err.message.contains("too large"));
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 0, "failed opens leave nothing behind");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_registry_maps_saved_paths_to_sessions_and_cleans_up() {
        let (server, fs_remote, _session, _keep) = remote().await;
        fs::write(server.root.path().join("note.md"), b"# hi").unwrap();
        let cache = tempfile::tempdir().unwrap();
        let edits = Edits::default();
        let info = edits.open(fs_remote, "/note.md", cache.path()).await.unwrap();
        assert_eq!(edits.id_for_local_path(&info.local_path), Some(info.id.clone()));
        assert_eq!(edits.id_for_local_path("/somewhere/else.md"), None);
        assert_eq!(edits.list().len(), 1);

        fs::write(&info.local_path, b"# changed").unwrap();
        bump_mtime(Path::new(&info.local_path), 1_700_000_777);
        assert_eq!(edits.sync(&info.id, false).await.unwrap(), SyncOutcome::Uploaded { size: 9 });

        edits.close(&info.id).await.unwrap();
        assert!(!Path::new(&info.local_path).exists());
        assert_eq!(edits.id_for_local_path(&info.local_path), None);
        assert!(edits.sync(&info.id, false).await.is_err());

        edits.clear_cache(cache.path()).await;
        assert!(!cache.path().exists());
    }
}
