//! One file-system interface over the local disk and an SFTP session.
//!
//! The browser panes and the transfer engine both use this, so local and remote behave alike.
//! Remote paths are POSIX. Local paths are reported with forward slashes on every platform.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncSeek, AsyncSeekExt, AsyncWrite};

use crate::error::{Result, SshError};

const MAX_SYMLINK_LOOKUPS: usize = 256;
const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;

pub trait ReadSeek: AsyncRead + AsyncSeek + Send + Unpin {}
impl<T: AsyncRead + AsyncSeek + Send + Unpin> ReadSeek for T {}

pub trait WriteSeek: AsyncWrite + AsyncSeek + Send + Unpin {}
impl<T: AsyncWrite + AsyncSeek + Send + Unpin> WriteSeek for T {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub kind: EntryKind,
    pub size: u64,
    pub mtime: Option<i64>,
    pub mode: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub mtime: Option<i64>,
    pub mode: Option<u32>,
    pub link_target_is_dir: Option<bool>,
}

#[derive(Clone)]
pub enum Fs {
    Local,
    Remote(Arc<SftpSession>),
}

fn map_sftp(err: SftpError) -> SshError {
    match &err {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => SshError::not_found("no such file or directory"),
            StatusCode::PermissionDenied => SshError::permission_denied("permission denied"),
            StatusCode::ConnectionLost | StatusCode::NoConnection => {
                SshError::connect("the connection was lost")
            }
            StatusCode::OpUnsupported => {
                SshError::new(crate::error::ErrorCode::Unsupported, "the server does not support this operation")
            }
            _ => SshError::io(err.to_string()),
        },
        SftpError::IO(_) | SftpError::Timeout => SshError::connect(err.to_string()),
        _ => SshError::protocol(err.to_string()),
    }
}

fn kind_from_mode(mode: Option<u32>) -> EntryKind {
    match mode.map(|m| m & S_IFMT) {
        Some(S_IFDIR) => EntryKind::Dir,
        Some(S_IFREG) => EntryKind::File,
        Some(S_IFLNK) => EntryKind::Symlink,
        _ => EntryKind::Other,
    }
}

fn stat_from_attrs(attrs: &FileAttributes) -> FileStat {
    FileStat {
        kind: kind_from_mode(attrs.permissions),
        size: attrs.size.unwrap_or(0),
        mtime: attrs.mtime.map(i64::from),
        mode: attrs.permissions.map(|m| m & 0o7777),
    }
}

fn canonical(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.into_owned()
    }
}

pub fn remote_join(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

pub fn remote_parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => trimmed[..index].to_string(),
        None => if path.starts_with('/') { "/".to_string() } else { ".".to_string() },
    }
}

pub fn remote_file_name(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let a_dir = a.kind == EntryKind::Dir || a.link_target_is_dir == Some(true);
        let b_dir = b.kind == EntryKind::Dir || b.link_target_is_dir == Some(true);
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

fn require_absolute(path: &str) -> Result<()> {
    if Path::new(path).is_absolute() {
        Ok(())
    } else {
        Err(SshError::invalid("local paths must be absolute"))
    }
}

fn local_stat(meta: &std::fs::Metadata) -> FileStat {
    let file_type = meta.file_type();
    let kind = if file_type.is_symlink() {
        EntryKind::Symlink
    } else if file_type.is_dir() {
        EntryKind::Dir
    } else if file_type.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    };
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode() & 0o7777)
    };
    #[cfg(not(unix))]
    let mode = None;
    FileStat {
        kind,
        size: if kind == EntryKind::Dir { 0 } else { meta.len() },
        mtime: meta.modified().ok().and_then(system_time_secs),
        mode,
    }
}

fn system_time_secs(time: std::time::SystemTime) -> Option<i64> {
    match time.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_secs()).ok(),
        Err(e) => i64::try_from(e.duration().as_secs()).ok().map(|s| -s),
    }
}

impl Fs {
    pub fn same_endpoint(&self, other: &Fs) -> bool {
        match (self, other) {
            (Fs::Local, Fs::Local) => true,
            (Fs::Remote(a), Fs::Remote(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Fs::Local)
    }

    pub fn join(&self, base: &str, name: &str) -> String {
        match self {
            Fs::Local => canonical(&Path::new(base).join(name)),
            Fs::Remote(_) => remote_join(base, name),
        }
    }

    pub fn parent(&self, path: &str) -> String {
        match self {
            Fs::Local => Path::new(path)
                .parent()
                .map(canonical)
                .unwrap_or_else(|| path.to_string()),
            Fs::Remote(_) => remote_parent(path),
        }
    }

    pub fn file_name(&self, path: &str) -> String {
        match self {
            Fs::Local => Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            Fs::Remote(_) => remote_file_name(path),
        }
    }

    pub async fn home(&self) -> Result<String> {
        match self {
            Fs::Local => dirs::home_dir()
                .map(|p| canonical(&p))
                .ok_or_else(|| SshError::not_found("home directory could not be determined")),
            Fs::Remote(sftp) => sftp.canonicalize(".").await.map_err(map_sftp),
        }
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String> {
        match self {
            Fs::Local => {
                require_absolute(path)?;
                let resolved = tokio::fs::canonicalize(path).await?;
                Ok(canonical(&strip_verbatim(resolved)))
            }
            Fs::Remote(sftp) => sftp.canonicalize(path).await.map_err(map_sftp),
        }
    }

    pub async fn stat(&self, path: &str, follow: bool) -> Result<FileStat> {
        match self {
            Fs::Local => {
                require_absolute(path)?;
                let meta = if follow {
                    tokio::fs::metadata(path).await?
                } else {
                    tokio::fs::symlink_metadata(path).await?
                };
                Ok(local_stat(&meta))
            }
            Fs::Remote(sftp) => {
                let attrs = if follow {
                    sftp.metadata(path).await
                } else {
                    sftp.symlink_metadata(path).await
                }
                .map_err(map_sftp)?;
                Ok(stat_from_attrs(&attrs))
            }
        }
    }

    /// True if something exists at `path`, including a dangling symlink.
    pub async fn exists(&self, path: &str) -> Result<bool> {
        match self.stat(path, false).await {
            Ok(_) => Ok(true),
            Err(err) if err.code == crate::error::ErrorCode::NotFound => Ok(false),
            Err(err) => Err(err),
        }
    }

    pub async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        let mut entries = match self {
            Fs::Local => {
                require_absolute(path)?;
                let mut out = Vec::new();
                let mut reader = tokio::fs::read_dir(path).await?;
                while let Some(entry) = reader.next_entry().await? {
                    let Ok(meta) = entry.metadata().await else {
                        continue;
                    };
                    let stat = local_stat(&meta);
                    let link_target_is_dir = if stat.kind == EntryKind::Symlink {
                        tokio::fs::metadata(entry.path()).await.ok().map(|m| m.is_dir())
                    } else {
                        None
                    };
                    out.push(FileEntry {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        path: canonical(&entry.path()),
                        kind: stat.kind,
                        size: stat.size,
                        mtime: stat.mtime,
                        mode: stat.mode,
                        link_target_is_dir,
                    });
                }
                out
            }
            Fs::Remote(sftp) => {
                let mut out = Vec::new();
                let mut lookups = 0usize;
                for entry in sftp.read_dir(path).await.map_err(map_sftp)? {
                    let attrs = entry.metadata();
                    let stat = stat_from_attrs(&attrs);
                    let entry_path = entry.path();
                    let link_target_is_dir = if stat.kind == EntryKind::Symlink && lookups < MAX_SYMLINK_LOOKUPS {
                        lookups += 1;
                        sftp.metadata(entry_path.clone())
                            .await
                            .ok()
                            .map(|a| kind_from_mode(a.permissions) == EntryKind::Dir)
                    } else {
                        None
                    };
                    out.push(FileEntry {
                        name: entry.file_name(),
                        path: entry_path,
                        kind: stat.kind,
                        size: stat.size,
                        mtime: stat.mtime,
                        mode: stat.mode,
                        link_target_is_dir,
                    });
                }
                out
            }
        };
        sort_entries(&mut entries);
        Ok(entries)
    }

    pub async fn mkdir(&self, path: &str) -> Result<()> {
        match self {
            Fs::Local => {
                require_absolute(path)?;
                Ok(tokio::fs::create_dir(path).await?)
            }
            Fs::Remote(sftp) => sftp.create_dir(path).await.map_err(map_sftp),
        }
    }

    /// Creates `path` and any missing parents. An existing directory is fine.
    pub async fn mkdir_all(&self, path: &str) -> Result<()> {
        match self {
            Fs::Local => {
                require_absolute(path)?;
                Ok(tokio::fs::create_dir_all(path).await?)
            }
            Fs::Remote(sftp) => {
                let mut missing = Vec::new();
                let mut current = path.trim_end_matches('/').to_string();
                loop {
                    if current.is_empty() || current == "." || current == "/" {
                        break;
                    }
                    match sftp.metadata(current.clone()).await {
                        Ok(attrs) => {
                            if kind_from_mode(attrs.permissions) != EntryKind::Dir {
                                return Err(SshError::exists(format!("{current} exists and is not a directory")));
                            }
                            break;
                        }
                        Err(_) => {
                            missing.push(current.clone());
                            current = remote_parent(&current);
                        }
                    }
                }
                for dir in missing.into_iter().rev() {
                    if let Err(err) = sftp.create_dir(dir.clone()).await {
                        let is_dir = sftp
                            .metadata(dir)
                            .await
                            .map(|a| kind_from_mode(a.permissions) == EntryKind::Dir)
                            .unwrap_or(false);
                        if !is_dir {
                            return Err(map_sftp(err));
                        }
                    }
                }
                Ok(())
            }
        }
    }

    pub async fn remove_file(&self, path: &str) -> Result<()> {
        match self {
            Fs::Local => {
                require_absolute(path)?;
                Ok(tokio::fs::remove_file(path).await?)
            }
            Fs::Remote(sftp) => sftp.remove_file(path).await.map_err(map_sftp),
        }
    }

    pub async fn remove_dir(&self, path: &str) -> Result<()> {
        match self {
            Fs::Local => {
                require_absolute(path)?;
                Ok(tokio::fs::remove_dir(path).await?)
            }
            Fs::Remote(sftp) => sftp.remove_dir(path).await.map_err(map_sftp),
        }
    }

    /// Deletes a file, symlink or directory tree. Symlinks are removed, never followed.
    pub async fn remove_all(&self, path: &str) -> Result<()> {
        let root = self.stat(path, false).await?;
        if root.kind != EntryKind::Dir {
            return self.remove_file(path).await;
        }
        let mut dirs = vec![path.to_string()];
        let mut stack = vec![path.to_string()];
        while let Some(dir) = stack.pop() {
            for entry in self.list(&dir).await? {
                if entry.kind == EntryKind::Dir {
                    dirs.push(entry.path.clone());
                    stack.push(entry.path);
                } else {
                    self.remove_file(&entry.path).await?;
                }
            }
        }
        for dir in dirs.into_iter().rev() {
            self.remove_dir(&dir).await?;
        }
        Ok(())
    }

    /// Renames within one endpoint. Fails if `to` exists on SFTP servers that follow the v3 spec.
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        match self {
            Fs::Local => {
                require_absolute(from)?;
                require_absolute(to)?;
                Ok(tokio::fs::rename(from, to).await?)
            }
            Fs::Remote(sftp) => sftp.rename(from, to).await.map_err(map_sftp),
        }
    }

    /// Moves `from` onto `to`, replacing an existing file. On SFTP the replace is remove then
    /// rename, because protocol v3 refuses to rename onto an existing name.
    pub async fn rename_over(&self, from: &str, to: &str) -> Result<()> {
        match self {
            Fs::Local => self.rename(from, to).await,
            Fs::Remote(_) => {
                if self.rename(from, to).await.is_ok() {
                    return Ok(());
                }
                if self.exists(to).await? {
                    self.remove_file(to).await?;
                }
                self.rename(from, to).await
            }
        }
    }

    pub async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn ReadSeek>> {
        let mut reader: Box<dyn ReadSeek> = match self {
            Fs::Local => {
                require_absolute(path)?;
                Box::new(tokio::fs::File::open(path).await?)
            }
            Fs::Remote(sftp) => Box::new(sftp.open(path).await.map_err(map_sftp)?),
        };
        if offset > 0 {
            reader.seek(std::io::SeekFrom::Start(offset)).await?;
        }
        Ok(reader)
    }

    /// Opens `path` for writing. With `resume_at` the existing content is kept and writing continues there.
    pub async fn open_write(&self, path: &str, resume_at: Option<u64>) -> Result<Box<dyn WriteSeek>> {
        let mut writer: Box<dyn WriteSeek> = match self {
            Fs::Local => {
                require_absolute(path)?;
                let mut options = tokio::fs::OpenOptions::new();
                options.write(true);
                if resume_at.is_none() {
                    options.create(true).truncate(true);
                }
                Box::new(options.open(path).await?)
            }
            Fs::Remote(sftp) => {
                let flags = if resume_at.is_some() {
                    OpenFlags::WRITE
                } else {
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
                };
                Box::new(sftp.open_with_flags(path, flags).await.map_err(map_sftp)?)
            }
        };
        if let Some(offset) = resume_at.filter(|o| *o > 0) {
            writer.seek(std::io::SeekFrom::Start(offset)).await?;
        }
        Ok(writer)
    }

    /// Best effort: failures to set times or permissions never fail a transfer.
    pub async fn set_times_and_mode(&self, path: &str, mtime: Option<i64>, mode: Option<u32>) {
        match self {
            Fs::Local => {
                let path = PathBuf::from(path);
                let _ = tokio::task::spawn_blocking(move || {
                    if let Some(mtime) = mtime.and_then(|m| u64::try_from(m).ok()) {
                        if let Ok(file) = std::fs::OpenOptions::new().write(true).open(&path) {
                            let _ = file.set_modified(UNIX_EPOCH + Duration::from_secs(mtime));
                        }
                    }
                    #[cfg(unix)]
                    if let Some(mode) = mode {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & 0o777));
                    }
                    #[cfg(not(unix))]
                    let _ = mode;
                })
                .await;
            }
            Fs::Remote(sftp) => {
                let mut attrs = FileAttributes::empty();
                attrs.permissions = mode.map(|m| m & 0o7777);
                if let Some(mtime) = mtime.and_then(|m| u32::try_from(m).ok()) {
                    attrs.mtime = Some(mtime);
                    attrs.atime = Some(mtime);
                }
                if attrs.permissions.is_some() || attrs.mtime.is_some() {
                    let _ = sftp.set_metadata(path, attrs).await;
                }
            }
        }
    }

    pub async fn set_mode(&self, path: &str, mode: u32) -> Result<()> {
        match self {
            Fs::Local => {
                require_absolute(path)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o7777)).await?;
                    Ok(())
                }
                #[cfg(not(unix))]
                {
                    let _ = mode;
                    Err(SshError::new(crate::error::ErrorCode::Unsupported, "permissions are not supported on this platform"))
                }
            }
            Fs::Remote(sftp) => {
                let mut attrs = FileAttributes::empty();
                attrs.permissions = Some(mode & 0o7777);
                sftp.set_metadata(path, attrs).await.map_err(map_sftp)
            }
        }
    }
}

#[cfg(windows)]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

#[cfg(not(windows))]
fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::session::SshSession;
    use crate::testing::{context, password_spec, trust, Opts, TestServer};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn remote_path_helpers() {
        assert_eq!(remote_join("/a", "b"), "/a/b");
        assert_eq!(remote_join("/a/", "b"), "/a/b");
        assert_eq!(remote_join("", "b"), "b");
        assert_eq!(remote_parent("/a/b"), "/a");
        assert_eq!(remote_parent("/a"), "/");
        assert_eq!(remote_parent("/"), "/");
        assert_eq!(remote_parent("a/b/"), "a");
        assert_eq!(remote_parent("a"), ".");
        assert_eq!(remote_file_name("/a/b.txt"), "b.txt");
        assert_eq!(remote_file_name("/a/b/"), "b");
    }

    #[test]
    fn kinds_come_from_the_file_type_bits_not_the_permission_bits() {
        assert_eq!(kind_from_mode(Some(0o100644)), EntryKind::File);
        assert_eq!(kind_from_mode(Some(0o040755)), EntryKind::Dir);
        assert_eq!(kind_from_mode(Some(0o120777)), EntryKind::Symlink);
        assert_eq!(kind_from_mode(Some(0o020666)), EntryKind::Other);
        assert_eq!(kind_from_mode(None), EntryKind::Other);
    }

    #[test]
    fn directories_sort_first_then_names_ignoring_case() {
        let entry = |name: &str, kind| FileEntry {
            name: name.to_string(),
            path: name.to_string(),
            kind,
            size: 0,
            mtime: None,
            mode: None,
            link_target_is_dir: None,
        };
        let mut entries = vec![
            entry("b.txt", EntryKind::File),
            entry("Zeta", EntryKind::Dir),
            entry("a.txt", EntryKind::File),
            entry("alpha", EntryKind::Dir),
        ];
        sort_entries(&mut entries);
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Zeta", "a.txt", "b.txt"]);
    }

    #[tokio::test]
    async fn local_paths_must_be_absolute() {
        let err = Fs::Local.list("relative/dir").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(Fs::Local.stat("x", true).await.is_err());
    }

    #[tokio::test]
    async fn local_list_stat_mkdir_rename_and_remove_all() {
        let dir = tempfile::tempdir().unwrap();
        let base = canonical(dir.path());
        let fs = Fs::Local;
        let sub = fs.join(&base, "a/b/c");
        fs.mkdir_all(&sub).await.unwrap();
        fs.mkdir_all(&sub).await.unwrap();
        std::fs::write(dir.path().join("a/b/file.txt"), b"12345").unwrap();

        let listing = fs.list(&fs.join(&base, "a/b")).await.unwrap();
        assert_eq!(listing.len(), 2);
        assert_eq!(listing[0].name, "c");
        assert_eq!(listing[0].kind, EntryKind::Dir);
        assert_eq!(listing[1].name, "file.txt");
        assert_eq!(listing[1].size, 5);

        let file = fs.join(&base, "a/b/file.txt");
        assert!(fs.exists(&file).await.unwrap());
        assert!(!fs.exists(&fs.join(&base, "nope")).await.unwrap());
        fs.rename(&file, &fs.join(&base, "a/moved.txt")).await.unwrap();
        assert!(!fs.exists(&file).await.unwrap());

        fs.remove_all(&fs.join(&base, "a")).await.unwrap();
        assert!(!fs.exists(&fs.join(&base, "a")).await.unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_remove_all_removes_symlinks_without_following_them() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("precious.txt"), b"keep").unwrap();
        std::fs::create_dir(dir.path().join("tree")).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("tree/link")).unwrap();
        let base = canonical(dir.path());
        Fs::Local.remove_all(&Fs::Local.join(&base, "tree")).await.unwrap();
        assert!(outside.path().join("precious.txt").exists());
        assert!(!dir.path().join("tree").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_listing_marks_symlinks_to_directories() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("real")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("link")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("missing"), dir.path().join("dangling")).unwrap();
        let listing = Fs::Local.list(&canonical(dir.path())).await.unwrap();
        let find = |name: &str| listing.iter().find(|e| e.name == name).unwrap();
        assert_eq!(find("link").kind, EntryKind::Symlink);
        assert_eq!(find("link").link_target_is_dir, Some(true));
        assert_eq!(find("dangling").link_target_is_dir, None);
        assert_eq!(find("real").kind, EntryKind::Dir);
        assert!(Fs::Local.exists(&canonical(&dir.path().join("dangling"))).await.unwrap());
    }

    #[tokio::test]
    async fn local_streams_support_resume_offsets() {
        let dir = tempfile::tempdir().unwrap();
        let path = canonical(&dir.path().join("f.bin"));
        let fs = Fs::Local;
        let mut w = fs.open_write(&path, None).await.unwrap();
        w.write_all(b"hello ").await.unwrap();
        w.shutdown().await.unwrap();
        let mut w = fs.open_write(&path, Some(6)).await.unwrap();
        w.write_all(b"world").await.unwrap();
        w.shutdown().await.unwrap();
        let mut r = fs.open_read(&path, 3).await.unwrap();
        let mut text = String::new();
        r.read_to_string(&mut text).await.unwrap();
        assert_eq!(text, "lo world");
    }

    async fn remote() -> (TestServer, Fs, tempfile::TempDir) {
        let server = TestServer::start(Opts {
            users: vec![("alice".to_string(), "secret".to_string())],
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        trust(&ctx, &server);
        let session = SshSession::connect(&ctx, &password_spec(&server, "alice", "secret"), None)
            .await
            .unwrap();
        let sftp = session.open_sftp().await.unwrap();
        // The session must outlive the SFTP handle, so leak it for the test's duration.
        std::mem::forget(session);
        (server, Fs::Remote(Arc::new(sftp)), dir)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remote_list_stat_and_mkdir_all() {
        let (server, fs, _keep) = remote().await;
        std::fs::create_dir_all(server.root.path().join("proj/src")).unwrap();
        std::fs::write(server.root.path().join("proj/readme.md"), b"hello").unwrap();

        assert_eq!(fs.home().await.unwrap(), "/");
        let listing = fs.list("/proj").await.unwrap();
        let names: Vec<_> = listing.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(names, vec![("src", EntryKind::Dir), ("readme.md", EntryKind::File)]);
        assert_eq!(listing[1].size, 5);
        assert_eq!(listing[1].path, "/proj/readme.md");

        let stat = fs.stat("/proj/readme.md", true).await.unwrap();
        assert_eq!(stat.kind, EntryKind::File);
        assert_eq!(stat.size, 5);
        assert_eq!(fs.stat("/nope", true).await.unwrap_err().code, ErrorCode::NotFound);
        assert!(!fs.exists("/nope").await.unwrap());

        fs.mkdir_all("/proj/deep/er/still").await.unwrap();
        fs.mkdir_all("/proj/deep/er/still").await.unwrap();
        assert!(server.root.path().join("proj/deep/er/still").is_dir());
        let err = fs.mkdir_all("/proj/readme.md/x").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Exists);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remote_streams_rename_and_remove_all() {
        let (server, fs, _keep) = remote().await;
        let mut w = fs.open_write("/data.bin", None).await.unwrap();
        w.write_all(b"abcdef").await.unwrap();
        w.shutdown().await.unwrap();
        assert_eq!(std::fs::read(server.root.path().join("data.bin")).unwrap(), b"abcdef");

        let mut w = fs.open_write("/data.bin", Some(6)).await.unwrap();
        w.write_all(b"ghi").await.unwrap();
        w.shutdown().await.unwrap();
        let mut r = fs.open_read("/data.bin", 2).await.unwrap();
        let mut text = String::new();
        r.read_to_string(&mut text).await.unwrap();
        assert_eq!(text, "cdefghi");

        fs.rename("/data.bin", "/renamed.bin").await.unwrap();
        assert!(server.root.path().join("renamed.bin").exists());

        fs.mkdir_all("/tree/a/b").await.unwrap();
        std::fs::write(server.root.path().join("tree/a/b/f"), b"x").unwrap();
        std::fs::write(server.root.path().join("tree/top"), b"x").unwrap();
        fs.remove_all("/tree").await.unwrap();
        assert!(!server.root.path().join("tree").exists());
        fs.remove_all("/renamed.bin").await.unwrap();
        assert_eq!(fs.remove_all("/renamed.bin").await.unwrap_err().code, ErrorCode::NotFound);
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remote_symlinks_are_reported_and_resolved() {
        let (server, fs, _keep) = remote().await;
        std::fs::create_dir(server.root.path().join("real")).unwrap();
        std::os::unix::fs::symlink("real", server.root.path().join("link")).unwrap();
        let listing = fs.list("/").await.unwrap();
        let link = listing.iter().find(|e| e.name == "link").unwrap();
        assert_eq!(link.kind, EntryKind::Symlink);
        assert_eq!(link.link_target_is_dir, Some(true));
        assert_eq!(fs.stat("/link", true).await.unwrap().kind, EntryKind::Dir);
        assert_eq!(fs.stat("/link", false).await.unwrap().kind, EntryKind::Symlink);
    }

    #[test]
    fn endpoints_compare_by_identity() {
        assert!(Fs::Local.same_endpoint(&Fs::Local));
    }
}
