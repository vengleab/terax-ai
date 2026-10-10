//! In-process SSH and SFTP server for tests. Nothing here is compiled outside `cfg(test)`.

use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use russh::keys::key::safe_rng;
use russh::keys::ssh_key::{Algorithm, PrivateKey, PublicKey};
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use crate::profile::{AuthMethod, ProfileSource, SshProfile};
use crate::session::{ConnectContext, Credentials, HostSpec};
use crate::known_hosts::KnownHostsFile;

#[derive(Clone, Default)]
pub struct Opts {
    pub users: Vec<(String, String)>,
    pub authorized_keys: Vec<PublicKey>,
    pub direct_tcpip: bool,
    pub host_key: Option<PrivateKey>,
}

pub struct TestServer {
    pub port: u16,
    pub root: tempfile::TempDir,
    pub host_key: PublicKey,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone)]
struct ServerFactory {
    opts: Arc<Opts>,
    root: PathBuf,
}

impl russh::server::Server for ServerFactory {
    type Handler = ServerHandler;

    fn new_client(&mut self, _: Option<SocketAddr>) -> Self::Handler {
        ServerHandler {
            opts: self.opts.clone(),
            root: self.root.clone(),
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct ServerHandler {
    opts: Arc<Opts>,
    root: PathBuf,
    channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl russh::server::Handler for ServerHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        let ok = self.opts.users.iter().any(|(u, p)| u == user && p == password);
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey(&mut self, _user: &str, key: &PublicKey) -> Result<Auth, Self::Error> {
        let ok = self
            .opts
            .authorized_keys
            .iter()
            .any(|k| k.key_data() == key.key_data());
        Ok(if ok { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_publickey_offered(
        &mut self,
        user: &str,
        key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        self.auth_publickey(user, key).await
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn channel_eof(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.close(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel_id)?;
            return Ok(());
        }
        let channel = self.channels.lock().await.remove(&channel_id);
        match channel {
            Some(channel) => {
                session.channel_success(channel_id)?;
                russh_sftp::server::run(
                    channel.into_stream(),
                    SftpHandler::new(self.root.clone()),
                )
                .await;
            }
            None => session.channel_failure(channel_id)?,
        }
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.opts.direct_tcpip {
            return Ok(());
        }
        let Ok(port) = u16::try_from(port_to_connect) else {
            return Ok(());
        };
        if let Ok(mut tcp) = TcpStream::connect((host_to_connect, port)).await {
            reply.accept().await;
            tokio::spawn(async move {
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
            });
        }
        Ok(())
    }
}

enum Open {
    File(fs::File),
    Dir { entries: Vec<File>, sent: bool },
}

struct SftpHandler {
    root: PathBuf,
    handles: HashMap<String, Open>,
    next: u64,
}

fn status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

fn code(err: std::io::Error) -> StatusCode {
    match err.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

#[cfg(unix)]
fn read_at(file: &fs::File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, offset)
}

#[cfg(windows)]
fn read_at(file: &fs::File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buf, offset)
}

#[cfg(unix)]
fn write_all_at(file: &fs::File, mut buf: &[u8], mut offset: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        let n = std::os::unix::fs::FileExt::write_at(file, buf, offset)?;
        buf = &buf[n..];
        offset += n as u64;
    }
    Ok(())
}

#[cfg(windows)]
fn write_all_at(file: &fs::File, mut buf: &[u8], mut offset: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        let n = std::os::windows::fs::FileExt::seek_write(file, buf, offset)?;
        buf = &buf[n..];
        offset += n as u64;
    }
    Ok(())
}

impl SftpHandler {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            handles: HashMap::new(),
            next: 0,
        }
    }

    fn resolve(&self, remote: &str) -> PathBuf {
        let mut parts: Vec<&str> = Vec::new();
        for part in remote.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other),
            }
        }
        let mut path = self.root.clone();
        for part in parts {
            path.push(part);
        }
        path
    }

    fn remote_name(&self, local: &Path) -> String {
        let rel = local.strip_prefix(&self.root).unwrap_or(local);
        let mut out = String::new();
        for comp in rel.components() {
            if let Component::Normal(name) = comp {
                out.push('/');
                out.push_str(&name.to_string_lossy());
            }
        }
        if out.is_empty() {
            "/".to_string()
        } else {
            out
        }
    }

    fn new_handle(&mut self, open: Open) -> String {
        self.next += 1;
        let key = format!("h{}", self.next);
        self.handles.insert(key.clone(), open);
        key
    }
}

fn attrs_of(meta: &fs::Metadata) -> FileAttributes {
    FileAttributes::from(meta)
}

impl russh_sftp::server::Handler for SftpHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(&mut self, _version: u32, _ext: HashMap<String, String>) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn open(&mut self, id: u32, filename: String, pflags: OpenFlags, _attrs: FileAttributes) -> Result<Handle, Self::Error> {
        let path = self.resolve(&filename);
        let mut options = fs::OpenOptions::new();
        options
            .read(pflags.contains(OpenFlags::READ))
            .write(pflags.contains(OpenFlags::WRITE))
            .append(pflags.contains(OpenFlags::APPEND));
        if pflags.contains(OpenFlags::EXCLUDE) {
            options.create_new(true);
        } else {
            options
                .create(pflags.contains(OpenFlags::CREATE))
                .truncate(pflags.contains(OpenFlags::TRUNCATE));
        }
        let file = options.open(path).map_err(code)?;
        let handle = self.new_handle(Open::File(file));
        Ok(Handle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        if let Some(Open::File(file)) = self.handles.remove(&handle) {
            let _ = file.sync_all();
        }
        Ok(status(id))
    }

    async fn read(&mut self, id: u32, handle: String, offset: u64, len: u32) -> Result<Data, Self::Error> {
        let Some(Open::File(file)) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        let mut buf = vec![0u8; len as usize];
        let n = read_at(file, &mut buf, offset).map_err(code)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        buf.truncate(n);
        Ok(Data { id, data: buf })
    }

    async fn write(&mut self, id: u32, handle: String, offset: u64, data: Vec<u8>) -> Result<Status, Self::Error> {
        let Some(Open::File(file)) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        write_all_at(file, &data, offset).map_err(code)?;
        Ok(status(id))
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let meta = fs::symlink_metadata(self.resolve(&path)).map_err(code)?;
        Ok(Attrs { id, attrs: attrs_of(&meta) })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let meta = fs::metadata(self.resolve(&path)).map_err(code)?;
        Ok(Attrs { id, attrs: attrs_of(&meta) })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let Some(Open::File(file)) = self.handles.get(&handle) else {
            return Err(StatusCode::Failure);
        };
        let meta = file.metadata().map_err(code)?;
        Ok(Attrs { id, attrs: attrs_of(&meta) })
    }

    async fn setstat(&mut self, id: u32, path: String, attrs: FileAttributes) -> Result<Status, Self::Error> {
        let local = self.resolve(&path);
        #[cfg(unix)]
        if let Some(mode) = attrs.permissions {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&local, fs::Permissions::from_mode(mode & 0o7777)).map_err(code)?;
        }
        if let Some(mtime) = attrs.mtime {
            let file = fs::OpenOptions::new().write(true).open(&local).map_err(code)?;
            let when = std::time::UNIX_EPOCH + Duration::from_secs(u64::from(mtime));
            file.set_modified(when).map_err(code)?;
        }
        Ok(status(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let local = self.resolve(&path);
        let mut entries = Vec::new();
        for entry in fs::read_dir(&local).map_err(code)? {
            let entry = entry.map_err(code)?;
            let meta = fs::symlink_metadata(entry.path()).map_err(code)?;
            entries.push(File::new(entry.file_name().to_string_lossy(), attrs_of(&meta)));
        }
        let handle = self.new_handle(Open::Dir { entries, sent: false });
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        match self.handles.get_mut(&handle) {
            Some(Open::Dir { entries, sent }) if !*sent => {
                *sent = true;
                Ok(Name { id, files: std::mem::take(entries) })
            }
            _ => Err(StatusCode::Eof),
        }
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        fs::remove_file(self.resolve(&filename)).map_err(code)?;
        Ok(status(id))
    }

    async fn mkdir(&mut self, id: u32, path: String, _attrs: FileAttributes) -> Result<Status, Self::Error> {
        fs::create_dir(self.resolve(&path)).map_err(code)?;
        Ok(status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        fs::remove_dir(self.resolve(&path)).map_err(code)?;
        Ok(status(id))
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let local = self.resolve(&path);
        Ok(Name { id, files: vec![File::dummy(self.remote_name(&local))] })
    }

    async fn rename(&mut self, id: u32, oldpath: String, newpath: String) -> Result<Status, Self::Error> {
        let to = self.resolve(&newpath);
        if to.exists() {
            return Err(StatusCode::Failure);
        }
        fs::rename(self.resolve(&oldpath), to).map_err(code)?;
        Ok(status(id))
    }

    async fn readlink(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let target = fs::read_link(self.resolve(&path)).map_err(code)?;
        Ok(Name { id, files: vec![File::dummy(target.to_string_lossy())] })
    }

    async fn symlink(&mut self, id: u32, linkpath: String, targetpath: String) -> Result<Status, Self::Error> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(targetpath, self.resolve(&linkpath)).map_err(code)?;
            Ok(status(id))
        }
        #[cfg(not(unix))]
        {
            let _ = (id, linkpath, targetpath);
            Err(StatusCode::OpUnsupported)
        }
    }
}

impl TestServer {
    pub async fn start(opts: Opts) -> TestServer {
        let root = tempfile::tempdir().expect("temp root");
        let host_private = opts
            .host_key
            .clone()
            .unwrap_or_else(|| PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).expect("host key"));
        let host_key = host_private.public_key().clone();
        let config = russh::server::Config {
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            keys: vec![host_private],
            ..Default::default()
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let mut factory = ServerFactory {
            opts: Arc::new(opts),
            root: root.path().to_path_buf(),
        };
        let config = Arc::new(config);
        let task = tokio::spawn(async move {
            let _ = factory.run_on_socket(config, &listener).await;
        });
        TestServer { port, root, host_key, task }
    }

    pub fn profile(&self, name: &str, user: &str, auth: AuthMethod) -> SshProfile {
        SshProfile {
            id: String::new(),
            name: name.to_string(),
            host: "127.0.0.1".to_string(),
            port: self.port,
            user: user.to_string(),
            auth,
            jump_host: None,
            keepalive_secs: 0,
            color: None,
            tags: Vec::new(),
            favorite: false,
            default_remote_dir: None,
            default_local_dir: None,
            source: ProfileSource::Manual,
        }
    }
}

pub fn context(dir: &Path) -> ConnectContext {
    ConnectContext {
        known_hosts: KnownHostsFile::new(dir.join("known_hosts")),
        system_known_hosts: None,
        timeout: Duration::from_secs(20),
    }
}

pub fn password_spec(server: &TestServer, user: &str, password: &str) -> HostSpec {
    HostSpec {
        profile: server.profile("test", user, AuthMethod::Password),
        credentials: Credentials {
            password: Some(crate::secret::Secret::new(password)),
            key_passphrase: None,
        },
    }
}

/// Trusts the server's host key in `ctx`, as the user would after the first-connection prompt.
pub fn trust(ctx: &ConnectContext, server: &TestServer) {
    ctx.known_hosts
        .learn("127.0.0.1", server.port, &server.host_key)
        .expect("learn host key");
}
