//! The facade the Tauri plugin calls. It owns every long-lived piece of state: stored profiles
//! and forwards, live connections, running transfers, tunnels and remote edit sessions.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::edit::{EditInfo, Edits, SyncOutcome};
use crate::error::{Result, SshError};
use crate::forward::{ForwardSpec, ForwardStore, TunnelStatus, Tunnels};
use crate::fs::{FileEntry, FileStat, Fs};
use crate::keys::{self, GenerateSpec, KeyInfo};
use crate::known_hosts::{self, KnownHostRow, KnownHostsFile};
use crate::profile::{self, SshProfile};
use crate::profile_store::ProfileStore;
use crate::secret::Secret;
use crate::session::{ConnectContext, Credentials, HostSpec, SshSession};
use crate::ssh_config::{self, ConfigImport};
use crate::transfer::engine::{
    self, BoxFuture, ConflictDecision, ConflictInfo, ConflictPolicy, Resolution, TransferEvent, TransferHooks,
    TransferJob, TransferMode, TransferSummary,
};
use crate::transfer::plan::SkippedItem;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    /// Where keys are listed and created. Defaults to `~/.ssh`.
    pub ssh_dir: Option<PathBuf>,
    /// Read-only extra source of trusted host keys. Defaults to `~/.ssh/known_hosts`.
    pub system_known_hosts: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EndpointRef {
    Local,
    #[serde(rename_all = "camelCase")]
    Remote { profile_id: String },
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub profile_id: String,
    #[serde(default)]
    pub password: Option<Secret>,
    #[serde(default)]
    pub key_passphrase: Option<Secret>,
    #[serde(default)]
    pub jump_password: Option<Secret>,
    #[serde(default)]
    pub jump_key_passphrase: Option<Secret>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub home: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub src: EndpointRef,
    pub dst: EndpointRef,
    pub sources: Vec<String>,
    pub dst_dir: String,
    #[serde(default = "default_mode")]
    pub mode: TransferMode,
    #[serde(default = "default_policy")]
    pub conflict: ConflictPolicy,
    #[serde(default)]
    pub resume: Option<bool>,
    #[serde(default)]
    pub concurrency: Option<usize>,
}

fn default_mode() -> TransferMode {
    TransferMode::Copy
}

fn default_policy() -> ConflictPolicy {
    ConflictPolicy::Ask
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WireEvent {
    #[serde(rename_all = "camelCase")]
    Planned { files: u64, bytes: u64, skipped: Vec<SkippedItem> },
    #[serde(rename_all = "camelCase")]
    Progress {
        bytes_done: u64,
        bytes_total: u64,
        files_done: u64,
        files_total: u64,
        bytes_per_sec: u64,
        current: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Conflict { conflict_id: u32, info: ConflictInfo },
    #[serde(rename_all = "camelCase")]
    Finished { summary: TransferSummary },
    #[serde(rename_all = "camelCase")]
    Failed { error: SshError },
}

impl From<TransferEvent> for WireEvent {
    fn from(event: TransferEvent) -> Self {
        match event {
            TransferEvent::Planned { files, bytes, skipped } => WireEvent::Planned { files, bytes, skipped },
            TransferEvent::Progress { bytes_done, bytes_total, files_done, files_total, bytes_per_sec, current } => {
                WireEvent::Progress { bytes_done, bytes_total, files_done, files_total, bytes_per_sec, current }
            }
        }
    }
}

pub type Emit = Arc<dyn Fn(WireEvent) + Send + Sync>;

struct Connection {
    info: ConnectionInfo,
    session: Arc<SshSession>,
    sftp: tokio::sync::Mutex<Option<Arc<SftpSession>>>,
}

struct JobHandle {
    cancel: CancellationToken,
    waiters: Mutex<HashMap<u32, oneshot::Sender<Resolution>>>,
    next_conflict: AtomicU32,
}

struct JobHooks {
    emit: Emit,
    job: Arc<JobHandle>,
}

impl TransferHooks for JobHooks {
    fn emit(&self, event: TransferEvent) {
        (self.emit)(event.into());
    }

    fn resolve_conflict(&self, info: ConflictInfo) -> BoxFuture<Resolution> {
        let (tx, rx) = oneshot::channel();
        let id = self.job.next_conflict.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut waiters) = self.job.waiters.lock() {
            waiters.insert(id, tx);
        }
        (self.emit)(WireEvent::Conflict { conflict_id: id, info });
        Box::pin(async move {
            rx.await.unwrap_or(Resolution { decision: ConflictDecision::Cancel, apply_to_all: false })
        })
    }
}

pub struct Service {
    cfg: ServiceConfig,
    profiles: Mutex<ProfileStore>,
    forwards: Mutex<ForwardStore>,
    known_hosts: KnownHostsFile,
    connections: tokio::sync::Mutex<HashMap<String, Arc<Connection>>>,
    jobs: Arc<Mutex<HashMap<u32, Arc<JobHandle>>>>,
    next_job: AtomicU32,
    tunnels: Tunnels,
    edits: Edits,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| SshError::io("internal state is unavailable"))
}

impl Service {
    pub fn new(cfg: ServiceConfig) -> Result<Arc<Service>> {
        let dir = cfg.data_dir.clone();
        Ok(Arc::new(Service {
            profiles: Mutex::new(ProfileStore::open(dir.join("profiles.json"))?),
            forwards: Mutex::new(ForwardStore::open(dir.join("forwards.json"))?),
            known_hosts: KnownHostsFile::new(dir.join("known_hosts")),
            cfg,
            connections: tokio::sync::Mutex::new(HashMap::new()),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            next_job: AtomicU32::new(1),
            tunnels: Tunnels::default(),
            edits: Edits::default(),
        }))
    }

    fn ctx(&self) -> ConnectContext {
        ConnectContext {
            known_hosts: self.known_hosts.clone(),
            system_known_hosts: self
                .cfg
                .system_known_hosts
                .clone()
                .or_else(known_hosts::system_known_hosts_path),
            timeout: CONNECT_TIMEOUT,
        }
    }

    fn ssh_dir(&self) -> Result<PathBuf> {
        match &self.cfg.ssh_dir {
            Some(dir) => Ok(dir.clone()),
            None => keys::default_ssh_dir(),
        }
    }

    fn edit_cache(&self) -> PathBuf {
        self.cfg.cache_dir.join("edit")
    }

    pub fn profiles(&self) -> Result<Vec<SshProfile>> {
        Ok(lock(&self.profiles)?.list().to_vec())
    }

    pub fn profile_save(&self, profile: SshProfile) -> Result<SshProfile> {
        lock(&self.profiles)?.save(profile)
    }

    pub async fn profile_remove(&self, id: &str) -> Result<()> {
        self.disconnect(id).await;
        lock(&self.profiles)?.remove(id)?;
        lock(&self.forwards)?.remove_for_profile(id)
    }

    pub fn ssh_config_import(&self) -> Result<ConfigImport> {
        let parsed = ssh_config::parse_user_config()?;
        let fallback = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok();
        ssh_config::import_into(&mut *lock(&self.profiles)?, &parsed, fallback.as_deref())
    }

    /// Arguments for the system `ssh` binary that open a terminal for this profile.
    pub fn terminal_args(&self, profile_id: &str) -> Result<Vec<String>> {
        let profiles = lock(&self.profiles)?;
        let profile = profiles.get(profile_id).ok_or_else(|| SshError::not_found("unknown server"))?;
        let jump = match &profile.jump_host {
            Some(id) => Some(profiles.get(id).ok_or_else(|| SshError::not_found("unknown jump host"))?),
            None => None,
        };
        profile::terminal_args(profile, jump)
    }

    fn spec_for(&self, profile_id: &str, password: Option<Secret>, passphrase: Option<Secret>) -> Result<HostSpec> {
        let profile = lock(&self.profiles)?
            .get(profile_id)
            .cloned()
            .ok_or_else(|| SshError::not_found("unknown server"))?;
        Ok(HostSpec { profile, credentials: Credentials { password, key_passphrase: passphrase } })
    }

    pub async fn connect(&self, request: ConnectRequest) -> Result<ConnectionInfo> {
        if let Some(existing) = self.connections.lock().await.get(&request.profile_id).cloned() {
            if !existing.session.is_closed() {
                return Ok(existing.info.clone());
            }
        }
        let target = self.spec_for(&request.profile_id, request.password, request.key_passphrase)?;
        let jump = match target.profile.jump_host.clone() {
            Some(jump_id) => Some(self.spec_for(&jump_id, request.jump_password, request.jump_key_passphrase)?),
            None => None,
        };
        let session = SshSession::connect(&self.ctx(), &target, jump.as_ref()).await?;
        let sftp = Arc::new(session.open_sftp().await?);
        let fs = Fs::Remote(sftp.clone());
        let home = match &target.profile.default_remote_dir {
            Some(dir) if !dir.is_empty() => fs.canonicalize(dir).await.or(fs.home().await)?,
            _ => fs.home().await?,
        };
        let info = ConnectionInfo {
            profile_id: target.profile.id.clone(),
            host: target.profile.host.clone(),
            port: target.profile.port,
            user: target.profile.user.clone(),
            home,
        };
        let connection = Arc::new(Connection {
            info: info.clone(),
            session,
            sftp: tokio::sync::Mutex::new(Some(sftp)),
        });
        let previous = self.connections.lock().await.insert(request.profile_id, connection);
        if let Some(previous) = previous {
            self.tunnels.stop_for_session(&previous.session).await;
            previous.session.disconnect().await;
        }
        Ok(info)
    }

    pub async fn disconnect(&self, profile_id: &str) {
        let removed = self.connections.lock().await.remove(profile_id);
        if let Some(connection) = removed {
            self.tunnels.stop_for_session(&connection.session).await;
            connection.session.disconnect().await;
        }
    }

    pub async fn connections(&self) -> Vec<ConnectionInfo> {
        let mut map = self.connections.lock().await;
        map.retain(|_, c| !c.session.is_closed());
        map.values().map(|c| c.info.clone()).collect()
    }

    async fn connection(&self, profile_id: &str) -> Result<Arc<Connection>> {
        let mut map = self.connections.lock().await;
        let connection = map
            .get(profile_id)
            .cloned()
            .ok_or_else(|| SshError::connect("not connected to this server"))?;
        if connection.session.is_closed() {
            map.remove(profile_id);
            return Err(SshError::connect("the connection to this server was lost"));
        }
        Ok(connection)
    }

    pub async fn endpoint_fs(&self, endpoint: &EndpointRef) -> Result<Fs> {
        match endpoint {
            EndpointRef::Local => Ok(Fs::Local),
            EndpointRef::Remote { profile_id } => {
                let connection = self.connection(profile_id).await?;
                let mut sftp = connection.sftp.lock().await;
                if sftp.is_none() {
                    *sftp = Some(Arc::new(connection.session.open_sftp().await?));
                }
                match sftp.as_ref() {
                    Some(sftp) => Ok(Fs::Remote(sftp.clone())),
                    None => Err(SshError::connect("the SFTP channel is not available")),
                }
            }
        }
    }

    pub async fn fs_home(&self, endpoint: &EndpointRef) -> Result<String> {
        self.endpoint_fs(endpoint).await?.home().await
    }

    pub async fn fs_canonicalize(&self, endpoint: &EndpointRef, path: &str) -> Result<String> {
        self.endpoint_fs(endpoint).await?.canonicalize(path).await
    }

    pub async fn fs_list(&self, endpoint: &EndpointRef, path: &str) -> Result<Vec<FileEntry>> {
        self.endpoint_fs(endpoint).await?.list(path).await
    }

    pub async fn fs_stat(&self, endpoint: &EndpointRef, path: &str) -> Result<FileStat> {
        self.endpoint_fs(endpoint).await?.stat(path, true).await
    }

    pub async fn fs_mkdir(&self, endpoint: &EndpointRef, path: &str) -> Result<()> {
        self.endpoint_fs(endpoint).await?.mkdir(path).await
    }

    pub async fn fs_create_file(&self, endpoint: &EndpointRef, path: &str) -> Result<()> {
        let fs = self.endpoint_fs(endpoint).await?;
        if fs.exists(path).await? {
            return Err(SshError::exists("something with this name already exists"));
        }
        let mut writer = fs.open_write(path, None).await?;
        writer.shutdown().await?;
        Ok(())
    }

    pub async fn fs_rename(&self, endpoint: &EndpointRef, from: &str, to: &str) -> Result<()> {
        let fs = self.endpoint_fs(endpoint).await?;
        if fs.exists(to).await? {
            return Err(SshError::exists("something with this name already exists"));
        }
        fs.rename(from, to).await
    }

    /// Deletes each path (folders recursively). Returns the paths that could not be deleted.
    pub async fn fs_remove(&self, endpoint: &EndpointRef, paths: &[String]) -> Result<Vec<crate::transfer::engine::ItemError>> {
        let fs = self.endpoint_fs(endpoint).await?;
        let mut failed = Vec::new();
        for path in paths {
            if let Err(err) = fs.remove_all(path).await {
                failed.push(crate::transfer::engine::ItemError { path: path.clone(), message: err.message });
            }
        }
        Ok(failed)
    }

    pub async fn fs_chmod(&self, endpoint: &EndpointRef, path: &str, mode: u32) -> Result<()> {
        self.endpoint_fs(endpoint).await?.set_mode(path, mode).await
    }

    pub fn keys_list(&self) -> Result<Vec<KeyInfo>> {
        keys::list_keys(&self.ssh_dir()?)
    }

    pub async fn key_generate(&self, spec: GenerateSpec) -> Result<KeyInfo> {
        let dir = self.ssh_dir()?;
        tokio::task::spawn_blocking(move || keys::generate(&dir, &spec))
            .await
            .map_err(|err| SshError::io(format!("key generation was interrupted: {err}")))?
    }

    pub fn key_import(&self, source: &str, name: &str) -> Result<KeyInfo> {
        keys::import(&self.ssh_dir()?, std::path::Path::new(source), name)
    }

    pub fn key_delete(&self, name: &str) -> Result<()> {
        keys::delete(&self.ssh_dir()?, name)
    }

    pub async fn key_change_passphrase(&self, name: &str, old: Option<Secret>, new: Option<Secret>) -> Result<KeyInfo> {
        keys::validate_key_name(name)?;
        let path = self.ssh_dir()?.join(name);
        tokio::task::spawn_blocking(move || keys::change_passphrase(&path, old.as_ref(), new.as_ref()))
            .await
            .map_err(|err| SshError::io(format!("the passphrase change was interrupted: {err}")))?
    }

    pub fn key_public(&self, name: &str) -> Result<String> {
        keys::validate_key_name(name)?;
        keys::read_public_key(&self.ssh_dir()?.join(name))
    }

    /// Installs a public key in the server's `~/.ssh/authorized_keys`. Returns false if it was already there.
    pub async fn key_deploy(&self, profile_id: &str, name: &str) -> Result<bool> {
        let line = self.key_public(name)?;
        let fs = self.endpoint_fs(&EndpointRef::Remote { profile_id: profile_id.to_string() }).await?;
        let home = fs.home().await?;
        let ssh_dir = fs.join(&home, ".ssh");
        let file = fs.join(&ssh_dir, "authorized_keys");

        if !fs.exists(&ssh_dir).await? {
            fs.mkdir(&ssh_dir).await?;
            fs.set_mode(&ssh_dir, 0o700).await?;
        }
        let existing = if fs.exists(&file).await? {
            let mut reader = fs.open_read(&file, 0).await?;
            let mut text = String::new();
            (&mut reader).take(1024 * 1024).read_to_string(&mut text).await?;
            text
        } else {
            String::new()
        };
        let Some(updated) = keys::authorized_keys_with(&existing, &line)? else {
            return Ok(false);
        };
        let part = fs.join(&ssh_dir, "authorized_keys.terax-part");
        let mut writer = fs.open_write(&part, None).await?;
        writer.write_all(updated.as_bytes()).await?;
        writer.shutdown().await?;
        fs.set_mode(&part, 0o600).await?;
        fs.rename_over(&part, &file).await?;
        Ok(true)
    }

    pub fn known_hosts(&self) -> Result<Vec<KnownHostRow>> {
        Ok(known_hosts::rows(&self.known_hosts.load()?))
    }

    pub fn known_host_remove(&self, line: usize) -> Result<()> {
        self.known_hosts.remove_line(line)
    }

    pub fn trust_host_key(&self, host: &str, port: u16, public_key: &str, replace: bool) -> Result<()> {
        crate::session::trust_host_key(&self.ctx(), host, port, public_key, replace)
    }

    pub async fn transfer_start(self: &Arc<Self>, request: TransferRequest, emit: Emit) -> Result<u32> {
        let src = self.endpoint_fs(&request.src).await?;
        let dst = self.endpoint_fs(&request.dst).await?;
        if request.sources.is_empty() {
            return Err(SshError::invalid("nothing to transfer"));
        }
        let mut job = TransferJob::new(src, dst, request.sources, request.dst_dir);
        job.mode = request.mode;
        job.conflict = request.conflict;
        if let Some(resume) = request.resume {
            job.resume = resume;
        }
        if let Some(concurrency) = request.concurrency {
            job.concurrency = concurrency;
        }

        let id = self.next_job.fetch_add(1, Ordering::Relaxed);
        let handle = Arc::new(JobHandle {
            cancel: CancellationToken::new(),
            waiters: Mutex::new(HashMap::new()),
            next_conflict: AtomicU32::new(1),
        });
        lock(&self.jobs)?.insert(id, handle.clone());
        let hooks = Arc::new(JobHooks { emit: emit.clone(), job: handle.clone() });
        let jobs = self.jobs.clone();
        tokio::spawn(async move {
            let outcome = engine::run(job, hooks, handle.cancel.clone()).await;
            match outcome {
                Ok(summary) => emit(WireEvent::Finished { summary }),
                Err(error) => emit(WireEvent::Failed { error }),
            }
            if let Ok(mut jobs) = jobs.lock() {
                jobs.remove(&id);
            }
        });
        Ok(id)
    }

    pub fn transfer_cancel(&self, id: u32) -> Result<()> {
        let job = lock(&self.jobs)?.get(&id).cloned().ok_or_else(|| SshError::not_found("this transfer is not running"))?;
        job.cancel.cancel();
        if let Ok(mut waiters) = job.waiters.lock() {
            waiters.clear();
        }
        Ok(())
    }

    pub fn transfer_resolve(&self, id: u32, conflict_id: u32, decision: ConflictDecision, apply_to_all: bool) -> Result<()> {
        let job = lock(&self.jobs)?.get(&id).cloned().ok_or_else(|| SshError::not_found("this transfer is not running"))?;
        let waiter = lock(&job.waiters)?.remove(&conflict_id);
        match waiter {
            Some(tx) => {
                let _ = tx.send(Resolution { decision, apply_to_all });
                Ok(())
            }
            None => Err(SshError::not_found("this conflict was already answered")),
        }
    }

    pub fn forwards(&self) -> Result<Vec<ForwardSpec>> {
        Ok(lock(&self.forwards)?.list().to_vec())
    }

    pub fn forward_save(&self, spec: ForwardSpec) -> Result<ForwardSpec> {
        if lock(&self.profiles)?.get(&spec.profile_id).is_none() {
            return Err(SshError::not_found("unknown server"));
        }
        lock(&self.forwards)?.save(spec)
    }

    pub async fn forward_remove(&self, id: &str) -> Result<()> {
        let _ = self.tunnels.stop(id).await;
        lock(&self.forwards)?.remove(id)
    }

    pub async fn forward_start(&self, id: &str) -> Result<TunnelStatus> {
        let spec = lock(&self.forwards)?.get(id).cloned().ok_or_else(|| SshError::not_found("unknown forward"))?;
        let connection = self.connection(&spec.profile_id).await?;
        self.tunnels.start(&spec, connection.session.clone()).await
    }

    pub async fn forward_stop(&self, id: &str) -> Result<()> {
        self.tunnels.stop(id).await
    }

    pub fn tunnel_status(&self) -> Vec<TunnelStatus> {
        self.tunnels.status()
    }

    /// Starts every forward of `profile_id` marked for autostart. Failures are returned per forward.
    pub async fn forwards_autostart(&self, profile_id: &str) -> Vec<(String, SshError)> {
        let specs: Vec<ForwardSpec> = lock(&self.forwards)
            .map(|f| f.list().iter().filter(|s| s.profile_id == profile_id && s.autostart).cloned().collect())
            .unwrap_or_default();
        let mut failures = Vec::new();
        for spec in specs {
            if let Err(err) = self.forward_start(&spec.id).await {
                failures.push((spec.name, err));
            }
        }
        failures
    }

    pub async fn edit_open(&self, profile_id: &str, remote_path: &str) -> Result<EditInfo> {
        let fs = self.endpoint_fs(&EndpointRef::Remote { profile_id: profile_id.to_string() }).await?;
        self.edits.open(fs, remote_path, &self.edit_cache()).await
    }

    pub fn edit_for_local_path(&self, local_path: &str) -> Option<String> {
        self.edits.id_for_local_path(local_path)
    }

    pub async fn edit_sync(&self, id: &str, force: bool) -> Result<SyncOutcome> {
        self.edits.sync(id, force).await
    }

    pub async fn edit_reload(&self, id: &str) -> Result<()> {
        self.edits.reload(id).await
    }

    pub async fn edit_close(&self, id: &str) -> Result<()> {
        self.edits.close(id).await
    }

    pub async fn clear_edit_cache(&self) {
        self.edits.clear_cache(&self.edit_cache()).await;
    }

    /// Stops everything. Called when the application exits.
    pub async fn shutdown(&self) {
        let jobs: Vec<Arc<JobHandle>> = lock(&self.jobs).map(|j| j.values().cloned().collect()).unwrap_or_default();
        for job in jobs {
            job.cancel.cancel();
        }
        self.tunnels.stop_all().await;
        let connections: Vec<Arc<Connection>> = self.connections.lock().await.drain().map(|(_, c)| c).collect();
        for connection in connections {
            connection.session.disconnect().await;
        }
        self.clear_edit_cache().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::testing::{Opts, TestServer};
    use crate::profile::{AuthMethod, ProfileSource};
    use std::fs;

    struct Fixture {
        service: Arc<Service>,
        server: TestServer,
        _dir: tempfile::TempDir,
    }

    async fn fixture() -> Fixture {
        let server = TestServer::start(Opts {
            users: vec![("alice".to_string(), "secret".to_string())],
            direct_tcpip: true,
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let service = Service::new(ServiceConfig {
            data_dir: dir.path().join("data"),
            cache_dir: dir.path().join("cache"),
            ssh_dir: Some(dir.path().join("dotssh")),
            system_known_hosts: Some(dir.path().join("none")),
        })
        .unwrap();
        Fixture { service, server, _dir: dir }
    }

    fn save_profile(f: &Fixture, name: &str) -> SshProfile {
        let mut profile = f.server.profile(name, "alice", AuthMethod::Password);
        profile.source = ProfileSource::Manual;
        f.service.profile_save(profile).unwrap()
    }

    fn request(profile_id: &str, password: Option<&str>) -> ConnectRequest {
        ConnectRequest {
            profile_id: profile_id.to_string(),
            password: password.map(Secret::new),
            ..Default::default()
        }
    }

    async fn connect_trusted(f: &Fixture, profile: &SshProfile) -> ConnectionInfo {
        let err = f.service.connect(request(&profile.id, Some("secret"))).await.expect_err("host key is unknown first");
        assert_eq!(err.code, ErrorCode::HostKeyUnknown);
        let key = err.data.unwrap()["presented"]["publicKey"].as_str().unwrap().to_string();
        f.service.trust_host_key(&profile.host, profile.port, &key, false).unwrap();
        f.service.connect(request(&profile.id, Some("secret"))).await.unwrap()
    }

    fn collector() -> (Emit, Arc<Mutex<Vec<WireEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emit: Emit = Arc::new(move |event| sink.lock().unwrap().push(event));
        (emit, events)
    }

    async fn wait_finished(events: &Arc<Mutex<Vec<WireEvent>>>) -> TransferSummary {
        for _ in 0..400 {
            if let Some(WireEvent::Finished { summary }) = events.lock().unwrap().iter().find(|e| matches!(e, WireEvent::Finished { .. })).cloned() {
                return summary;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("transfer did not finish: {:?}", events.lock().unwrap());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn connect_browse_upload_and_disconnect() {
        let f = fixture().await;
        let profile = save_profile(&f, "box");
        let info = connect_trusted(&f, &profile).await;
        assert_eq!(info.home, "/");
        assert_eq!(f.service.connections().await.len(), 1);
        assert!(f.service.connect(request(&profile.id, None)).await.is_ok(), "an existing connection is reused");

        let remote = EndpointRef::Remote { profile_id: profile.id.clone() };
        f.service.fs_mkdir(&remote, "/uploads").await.unwrap();
        assert!(f.service.fs_mkdir(&remote, "/uploads").await.is_err());
        let local = tempfile::tempdir().unwrap();
        fs::write(local.path().join("hello.txt"), b"hello").unwrap();
        let src = local.path().join("hello.txt").to_string_lossy().replace('\\', "/");

        let (emit, events) = collector();
        let id = f
            .service
            .transfer_start(
                TransferRequest {
                    src: EndpointRef::Local,
                    dst: remote.clone(),
                    sources: vec![src],
                    dst_dir: "/uploads".to_string(),
                    mode: TransferMode::Copy,
                    conflict: ConflictPolicy::Skip,
                    resume: None,
                    concurrency: None,
                },
                emit,
            )
            .await
            .unwrap();
        assert!(id >= 1);
        let summary = wait_finished(&events).await;
        assert_eq!(summary.files_done, 1);
        assert_eq!(fs::read(f.server.root.path().join("uploads/hello.txt")).unwrap(), b"hello");

        let listing = f.service.fs_list(&remote, "/uploads").await.unwrap();
        assert_eq!(listing.len(), 1);
        f.service.fs_rename(&remote, "/uploads/hello.txt", "/uploads/hi.txt").await.unwrap();
        let failed = f.service.fs_remove(&remote, &["/uploads".to_string(), "/missing".to_string()]).await.unwrap();
        assert_eq!(failed.len(), 1);
        assert!(!f.server.root.path().join("uploads").exists());

        f.service.disconnect(&profile.id).await;
        assert!(f.service.connections().await.is_empty());
        assert_eq!(f.service.fs_list(&remote, "/").await.unwrap_err().code, ErrorCode::Connect);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn conflicts_are_answered_through_the_service() {
        let f = fixture().await;
        let profile = save_profile(&f, "box");
        connect_trusted(&f, &profile).await;
        fs::write(f.server.root.path().join("a.txt"), b"old").unwrap();
        let local = tempfile::tempdir().unwrap();
        fs::write(local.path().join("a.txt"), b"new").unwrap();

        let (emit, events) = collector();
        let id = f
            .service
            .transfer_start(
                TransferRequest {
                    src: EndpointRef::Local,
                    dst: EndpointRef::Remote { profile_id: profile.id.clone() },
                    sources: vec![local.path().join("a.txt").to_string_lossy().replace('\\', "/")],
                    dst_dir: "/".to_string(),
                    mode: TransferMode::Copy,
                    conflict: ConflictPolicy::Ask,
                    resume: None,
                    concurrency: None,
                },
                emit,
            )
            .await
            .unwrap();

        let conflict_id = loop {
            let found = events.lock().unwrap().iter().find_map(|e| match e {
                WireEvent::Conflict { conflict_id, .. } => Some(*conflict_id),
                _ => None,
            });
            if let Some(found) = found {
                break found;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        f.service.transfer_resolve(id, conflict_id, ConflictDecision::Overwrite, false).unwrap();
        assert!(f.service.transfer_resolve(id, conflict_id, ConflictDecision::Skip, false).is_err(), "answered once");
        let summary = wait_finished(&events).await;
        assert_eq!(summary.files_done, 1);
        assert_eq!(fs::read(f.server.root.path().join("a.txt")).unwrap(), b"new");
        assert!(f.service.transfer_cancel(id).is_err(), "finished jobs are gone");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_transfer_can_be_cancelled_from_the_outside() {
        let f = fixture().await;
        let profile = save_profile(&f, "box");
        connect_trusted(&f, &profile).await;
        let local = tempfile::tempdir().unwrap();
        fs::write(local.path().join("big.bin"), vec![3u8; 60 * 1024 * 1024]).unwrap();
        let (emit, events) = collector();
        let id = f
            .service
            .transfer_start(
                TransferRequest {
                    src: EndpointRef::Local,
                    dst: EndpointRef::Remote { profile_id: profile.id.clone() },
                    sources: vec![local.path().join("big.bin").to_string_lossy().replace('\\', "/")],
                    dst_dir: "/".to_string(),
                    mode: TransferMode::Copy,
                    conflict: ConflictPolicy::Skip,
                    resume: Some(false),
                    concurrency: None,
                },
                emit,
            )
            .await
            .unwrap();
        loop {
            let started = events.lock().unwrap().iter().any(|e| matches!(e, WireEvent::Progress { bytes_done, .. } if *bytes_done > 0));
            if started {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        f.service.transfer_cancel(id).unwrap();
        let summary = wait_finished(&events).await;
        assert!(summary.cancelled);
        assert!(!f.server.root.path().join("big.bin").exists());
        assert!(!f.server.root.path().join("big.bin.terax-part").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn removing_a_profile_disconnects_it_and_drops_its_forwards() {
        let f = fixture().await;
        let profile = save_profile(&f, "box");
        connect_trusted(&f, &profile).await;
        let spec = f
            .service
            .forward_save(ForwardSpec {
                id: String::new(),
                profile_id: profile.id.clone(),
                name: "db".to_string(),
                kind: crate::forward::ForwardKind::Local {
                    listen_host: "127.0.0.1".to_string(),
                    listen_port: 0,
                    dest_host: "127.0.0.1".to_string(),
                    dest_port: 9,
                },
                autostart: true,
                expose: false,
            })
            .unwrap();
        assert!(f.service.forward_save(ForwardSpec { profile_id: "nope".to_string(), ..spec.clone() }).is_err());
        let status = f.service.forward_start(&spec.id).await.unwrap();
        assert_ne!(status.bound_port, 0);
        assert_eq!(f.service.tunnel_status().len(), 1);

        f.service.profile_remove(&profile.id).await.unwrap();
        assert!(f.service.connections().await.is_empty());
        assert!(f.service.tunnel_status().is_empty());
        assert!(f.service.forwards().unwrap().is_empty());
        assert!(f.service.profiles().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn deploying_a_key_installs_it_once_with_safe_permissions() {
        let f = fixture().await;
        let profile = save_profile(&f, "box");
        connect_trusted(&f, &profile).await;
        let key = f
            .service
            .key_generate(GenerateSpec {
                name: "id_deploy".to_string(),
                algorithm: keys::KeyAlgorithm::Ed25519,
                comment: "deploy@test".to_string(),
                passphrase: None,
            })
            .await
            .unwrap();
        assert_eq!(f.service.keys_list().unwrap().len(), 1);

        assert!(f.service.key_deploy(&profile.id, "id_deploy").await.unwrap());
        assert!(!f.service.key_deploy(&profile.id, "id_deploy").await.unwrap(), "already installed");
        let authorized = fs::read_to_string(f.server.root.path().join(".ssh/authorized_keys")).unwrap();
        assert_eq!(authorized.lines().count(), 1);
        assert!(authorized.contains(key.public_key.as_deref().unwrap()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let dir_mode = fs::metadata(f.server.root.path().join(".ssh")).unwrap().permissions().mode();
            let file_mode = fs::metadata(f.server.root.path().join(".ssh/authorized_keys")).unwrap().permissions().mode();
            assert_eq!(dir_mode & 0o777, 0o700);
            assert_eq!(file_mode & 0o777, 0o600);
        }
        assert!(!f.server.root.path().join(".ssh/authorized_keys.terax-part").exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn remote_edit_round_trip_through_the_service() {
        let f = fixture().await;
        let profile = save_profile(&f, "box");
        connect_trusted(&f, &profile).await;
        fs::write(f.server.root.path().join("conf.ini"), b"a=1\n").unwrap();
        let info = f.service.edit_open(&profile.id, "/conf.ini").await.unwrap();
        assert_eq!(f.service.edit_for_local_path(&info.local_path), Some(info.id.clone()));
        let mut text = String::new();
        tokio::fs::File::open(&info.local_path).await.unwrap().read_to_string(&mut text).await.unwrap();
        assert_eq!(text, "a=1\n");

        fs::write(&info.local_path, b"a=2\nb=3\n").unwrap();
        let when = std::time::UNIX_EPOCH + Duration::from_secs(1_700_001_234);
        fs::OpenOptions::new().write(true).open(&info.local_path).unwrap().set_modified(when).unwrap();
        assert_eq!(f.service.edit_sync(&info.id, false).await.unwrap(), SyncOutcome::Uploaded { size: 8 });
        assert_eq!(fs::read(f.server.root.path().join("conf.ini")).unwrap(), b"a=2\nb=3\n");

        f.service.shutdown().await;
        assert!(!std::path::Path::new(&info.local_path).exists());
        assert!(f.service.connections().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn terminal_args_come_from_validated_profiles() {
        let f = fixture().await;
        let profile = save_profile(&f, "box");
        let args = f.service.terminal_args(&profile.id).unwrap();
        assert_eq!(args.last().unwrap(), "alice@127.0.0.1");
        assert!(args.contains(&"-p".to_string()));
        assert!(f.service.terminal_args("missing").is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_known_hosts_list_reflects_trusted_keys_and_can_forget_them() {
        let f = fixture().await;
        let profile = save_profile(&f, "box");
        connect_trusted(&f, &profile).await;
        let rows = f.service.known_hosts().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].algorithm, "ssh-ed25519");
        f.service.known_host_remove(rows[0].line).unwrap();
        assert!(f.service.known_hosts().unwrap().is_empty());
    }
}
