//! Port forwarding: local (-L), remote (-R) and dynamic SOCKS5 (-D).
//!
//! Listeners bind loopback unless a forward is explicitly marked as exposed.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::error::{ErrorCode, Result, SshError};
use crate::fsutil::{atomic_write, random_hex};
use crate::profile::validate_host;
use crate::session::SshSession;

const MAX_CONNECTIONS: usize = 256;
const MAX_FORWARDS_PER_PROFILE: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ForwardKind {
    #[serde(rename_all = "camelCase")]
    Local {
        listen_host: String,
        listen_port: u16,
        dest_host: String,
        dest_port: u16,
    },
    #[serde(rename_all = "camelCase")]
    Remote {
        bind_host: String,
        bind_port: u16,
        dest_host: String,
        dest_port: u16,
    },
    #[serde(rename_all = "camelCase")]
    Dynamic { listen_host: String, listen_port: u16 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSpec {
    #[serde(default)]
    pub id: String,
    pub profile_id: String,
    pub name: String,
    #[serde(flatten)]
    pub kind: ForwardKind,
    #[serde(default)]
    pub autostart: bool,
    /// Allows a listener on a non-loopback address. Off by default.
    #[serde(default)]
    pub expose: bool,
}

pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_matches(|c| c == '[' || c == ']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

impl ForwardSpec {
    pub fn validate(&self) -> Result<()> {
        let name = self.name.trim();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(|c| c.is_control()) {
            return Err(SshError::invalid("name must be 1 to 80 printable characters"));
        }
        if !self.id.is_empty() && !self.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return Err(SshError::invalid("forward id is malformed"));
        }
        let (listen_host, dest) = match &self.kind {
            ForwardKind::Local { listen_host, dest_host, dest_port, .. } => (listen_host, Some((dest_host, *dest_port))),
            ForwardKind::Remote { bind_host, dest_host, dest_port, .. } => (bind_host, Some((dest_host, *dest_port))),
            ForwardKind::Dynamic { listen_host, .. } => (listen_host, None),
        };
        validate_host(listen_host.trim_matches(|c| c == '[' || c == ']'))
            .map_err(|_| SshError::invalid("the listen address is not a valid host name or IP address"))?;
        if let Some((dest_host, dest_port)) = dest {
            validate_host(dest_host)
                .map_err(|_| SshError::invalid("the destination is not a valid host name or IP address"))?;
            if dest_port == 0 {
                return Err(SshError::invalid("the destination port must be between 1 and 65535"));
            }
        }
        let local_listener = !matches!(self.kind, ForwardKind::Remote { .. });
        if local_listener && !self.expose && !is_loopback_host(listen_host) {
            return Err(SshError::invalid(
                "listening on a non-loopback address exposes the forward to your network; enable 'expose' to allow it",
            ));
        }
        Ok(())
    }

    pub fn normalized(mut self) -> Self {
        self.name = self.name.trim().to_string();
        self
    }
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    forwards: Vec<ForwardSpec>,
}

pub struct ForwardStore {
    path: PathBuf,
    forwards: Vec<ForwardSpec>,
}

impl ForwardStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let forwards = match std::fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice::<StoreFile>(&bytes)
                    .map_err(|err| SshError::invalid(format!("{} is not valid: {err}", path.display())))?
                    .forwards
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => return Err(err.into()),
        };
        Ok(Self { path, forwards })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list(&self) -> &[ForwardSpec] {
        &self.forwards
    }

    pub fn get(&self, id: &str) -> Option<&ForwardSpec> {
        self.forwards.iter().find(|f| f.id == id)
    }

    fn persist(&self) -> Result<()> {
        let file = StoreFile { version: 1, forwards: self.forwards.clone() };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|err| SshError::io(format!("could not encode forwards: {err}")))?;
        atomic_write(&self.path, &bytes, true)
    }

    pub fn save(&mut self, spec: ForwardSpec) -> Result<ForwardSpec> {
        let mut spec = spec.normalized();
        let is_new = spec.id.is_empty();
        if is_new {
            spec.id = random_hex(8)?;
        }
        spec.validate()?;
        if !is_new && self.get(&spec.id).is_none() {
            return Err(SshError::not_found("forward does not exist"));
        }
        if self.forwards.iter().filter(|f| f.profile_id == spec.profile_id && f.id != spec.id).count() >= MAX_FORWARDS_PER_PROFILE {
            return Err(SshError::invalid("too many forwards for this server"));
        }
        let previous = self.forwards.clone();
        match self.forwards.iter_mut().find(|f| f.id == spec.id) {
            Some(slot) => *slot = spec.clone(),
            None => self.forwards.push(spec.clone()),
        }
        if let Err(err) = self.persist() {
            self.forwards = previous;
            return Err(err);
        }
        Ok(spec)
    }

    pub fn remove(&mut self, id: &str) -> Result<()> {
        if self.get(id).is_none() {
            return Err(SshError::not_found("forward does not exist"));
        }
        let previous = self.forwards.clone();
        self.forwards.retain(|f| f.id != id);
        if let Err(err) = self.persist() {
            self.forwards = previous;
            return Err(err);
        }
        Ok(())
    }

    pub fn remove_for_profile(&mut self, profile_id: &str) -> Result<()> {
        let previous = self.forwards.clone();
        self.forwards.retain(|f| f.profile_id != profile_id);
        if let Err(err) = self.persist() {
            self.forwards = previous;
            return Err(err);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Socks5Request {
    Connect { host: String, port: u16 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Socks5Error {
    Incomplete,
    BadVersion,
    UnsupportedCommand,
    UnsupportedAddress,
    Malformed,
}

/// Parses the method negotiation sent first. Returns the number of bytes consumed.
pub fn parse_socks5_greeting(buf: &[u8]) -> std::result::Result<(bool, usize), Socks5Error> {
    let (&version, rest) = buf.split_first().ok_or(Socks5Error::Incomplete)?;
    if version != 5 {
        return Err(Socks5Error::BadVersion);
    }
    let (&count, rest) = rest.split_first().ok_or(Socks5Error::Incomplete)?;
    let methods = rest.get(..count as usize).ok_or(Socks5Error::Incomplete)?;
    Ok((methods.contains(&0), 2 + count as usize))
}

pub fn parse_socks5_request(buf: &[u8]) -> std::result::Result<(Socks5Request, usize), Socks5Error> {
    if buf.len() < 4 {
        return Err(Socks5Error::Incomplete);
    }
    if buf[0] != 5 {
        return Err(Socks5Error::BadVersion);
    }
    if buf[1] != 1 {
        return Err(Socks5Error::UnsupportedCommand);
    }
    let (host, used) = match buf[3] {
        1 => {
            let octets = buf.get(4..8).ok_or(Socks5Error::Incomplete)?;
            (Ipv4Addr::new(octets[0], octets[1], octets[2], octets[3]).to_string(), 8)
        }
        3 => {
            let len = *buf.get(4).ok_or(Socks5Error::Incomplete)? as usize;
            let name = buf.get(5..5 + len).ok_or(Socks5Error::Incomplete)?;
            let name = std::str::from_utf8(name).map_err(|_| Socks5Error::Malformed)?;
            if name.is_empty() {
                return Err(Socks5Error::Malformed);
            }
            (name.to_string(), 5 + len)
        }
        4 => {
            let octets: [u8; 16] = buf.get(4..20).ok_or(Socks5Error::Incomplete)?.try_into().map_err(|_| Socks5Error::Malformed)?;
            (Ipv6Addr::from(octets).to_string(), 20)
        }
        _ => return Err(Socks5Error::UnsupportedAddress),
    };
    let port = buf.get(used..used + 2).ok_or(Socks5Error::Incomplete)?;
    Ok((Socks5Request::Connect { host, port: u16::from_be_bytes([port[0], port[1]]) }, used + 2))
}

fn socks5_reply(code: u8) -> [u8; 10] {
    [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    pub bound_port: u16,
    pub active_connections: u32,
    pub total_connections: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
}

#[derive(Default)]
struct Counters {
    active: AtomicU32,
    total: AtomicU64,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
}

struct Running {
    cancel: CancellationToken,
    bound_port: u16,
    counters: Arc<Counters>,
    session: Arc<SshSession>,
    remote: Option<(String, u16)>,
}

#[derive(Default)]
pub struct Tunnels {
    running: Mutex<HashMap<String, Running>>,
}

async fn bridge(local: TcpStream, remote: impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin, counters: &Counters) {
    let mut local = local;
    let mut remote = remote;
    if let Ok((to_remote, to_local)) = tokio::io::copy_bidirectional(&mut local, &mut remote).await {
        counters.bytes_out.fetch_add(to_remote, Ordering::Relaxed);
        counters.bytes_in.fetch_add(to_local, Ordering::Relaxed);
    }
}

async fn serve_socks(mut socket: TcpStream, session: Arc<SshSession>, counters: Arc<Counters>, peer: SocketAddr) {
    let mut buf = vec![0u8; 512];
    let mut have = 0usize;

    let greeting = loop {
        match parse_socks5_greeting(&buf[..have]) {
            Ok(parsed) => break parsed,
            Err(Socks5Error::Incomplete) => {}
            Err(_) => return,
        }
        match socket.read(&mut buf[have..]).await {
            Ok(0) | Err(_) => return,
            Ok(n) => have += n,
        }
    };
    if !greeting.0 {
        let _ = socket.write_all(&[5, 0xff]).await;
        return;
    }
    if socket.write_all(&[5, 0]).await.is_err() {
        return;
    }
    buf.copy_within(greeting.1..have, 0);
    have -= greeting.1;

    let request = loop {
        match parse_socks5_request(&buf[..have]) {
            Ok(parsed) => break parsed,
            Err(Socks5Error::Incomplete) => {}
            Err(Socks5Error::UnsupportedCommand) => {
                let _ = socket.write_all(&socks5_reply(7)).await;
                return;
            }
            Err(Socks5Error::UnsupportedAddress) => {
                let _ = socket.write_all(&socks5_reply(8)).await;
                return;
            }
            Err(_) => return,
        }
        if have == buf.len() {
            return;
        }
        match socket.read(&mut buf[have..]).await {
            Ok(0) | Err(_) => return,
            Ok(n) => have += n,
        }
    };
    let Socks5Request::Connect { host, port } = request.0;
    match session.open_direct(&host, port, &peer.ip().to_string(), peer.port()).await {
        Ok(channel) => {
            if socket.write_all(&socks5_reply(0)).await.is_err() {
                return;
            }
            bridge(socket, channel, &counters).await;
        }
        Err(_) => {
            let _ = socket.write_all(&socks5_reply(5)).await;
        }
    }
}

async fn accept_loop(
    listener: TcpListener,
    session: Arc<SshSession>,
    counters: Arc<Counters>,
    cancel: CancellationToken,
    dest: Option<(String, u16)>,
) {
    let limit = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        let (socket, peer) = tokio::select! {
            _ = cancel.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                Err(_) => break,
            },
        };
        let Ok(permit) = limit.clone().try_acquire_owned() else {
            continue;
        };
        let session = session.clone();
        let counters = counters.clone();
        let dest = dest.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            counters.active.fetch_add(1, Ordering::Relaxed);
            counters.total.fetch_add(1, Ordering::Relaxed);
            let work = async {
                match dest {
                    Some((host, port)) => {
                        if let Ok(channel) = session.open_direct(&host, port, &peer.ip().to_string(), peer.port()).await {
                            bridge(socket, channel, &counters).await;
                        }
                    }
                    None => serve_socks(socket, session, counters.clone(), peer).await,
                }
            };
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = work => {}
            }
            counters.active.fetch_sub(1, Ordering::Relaxed);
            drop(permit);
        });
    }
}

async fn bind(host: &str, port: u16) -> Result<TcpListener> {
    let host = host.trim_matches(|c| c == '[' || c == ']');
    TcpListener::bind((host, port))
        .await
        .map_err(|err| SshError::new(ErrorCode::Io, format!("cannot listen on {host}:{port}: {err}")))
}

impl Tunnels {
    pub fn is_running(&self, id: &str) -> bool {
        self.running.lock().map(|r| r.contains_key(id)).unwrap_or(false)
    }

    pub async fn start(&self, spec: &ForwardSpec, session: Arc<SshSession>) -> Result<TunnelStatus> {
        spec.validate()?;
        if self.is_running(&spec.id) {
            return Err(SshError::exists("this forward is already running"));
        }
        let cancel = CancellationToken::new();
        let counters = Arc::new(Counters::default());
        let (bound_port, remote) = match &spec.kind {
            ForwardKind::Local { listen_host, listen_port, dest_host, dest_port } => {
                let listener = bind(listen_host, *listen_port).await?;
                let bound = listener.local_addr().map(|a| a.port()).unwrap_or(*listen_port);
                tokio::spawn(accept_loop(listener, session.clone(), counters.clone(), cancel.clone(), Some((dest_host.clone(), *dest_port))));
                (bound, None)
            }
            ForwardKind::Dynamic { listen_host, listen_port } => {
                let listener = bind(listen_host, *listen_port).await?;
                let bound = listener.local_addr().map(|a| a.port()).unwrap_or(*listen_port);
                tokio::spawn(accept_loop(listener, session.clone(), counters.clone(), cancel.clone(), None));
                (bound, None)
            }
            ForwardKind::Remote { bind_host, bind_port, dest_host, dest_port } => {
                let bound = session
                    .request_remote_forward(bind_host, *bind_port, (dest_host.clone(), *dest_port))
                    .await?;
                (bound, Some((bind_host.clone(), bound)))
            }
        };
        let status = TunnelStatus {
            id: spec.id.clone(),
            bound_port,
            active_connections: 0,
            total_connections: 0,
            bytes_in: 0,
            bytes_out: 0,
        };
        if let Ok(mut running) = self.running.lock() {
            running.insert(spec.id.clone(), Running { cancel, bound_port, counters, session, remote });
        }
        Ok(status)
    }

    pub async fn stop(&self, id: &str) -> Result<()> {
        let running = self.running.lock().ok().and_then(|mut r| r.remove(id));
        let Some(running) = running else {
            return Err(SshError::not_found("this forward is not running"));
        };
        running.cancel.cancel();
        if let Some((host, port)) = running.remote {
            let _ = running.session.cancel_remote_forward(&host, port).await;
        }
        Ok(())
    }

    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.running.lock().map(|r| r.keys().cloned().collect()).unwrap_or_default();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }

    /// Stops every forward that belongs to this session, for example after it disconnects.
    pub async fn stop_for_session(&self, session: &Arc<SshSession>) {
        let ids: Vec<String> = self
            .running
            .lock()
            .map(|r| r.iter().filter(|(_, v)| Arc::ptr_eq(&v.session, session)).map(|(k, _)| k.clone()).collect())
            .unwrap_or_default();
        for id in ids {
            let _ = self.stop(&id).await;
        }
    }

    pub fn status(&self) -> Vec<TunnelStatus> {
        let Ok(running) = self.running.lock() else {
            return Vec::new();
        };
        running
            .iter()
            .map(|(id, r)| TunnelStatus {
                id: id.clone(),
                bound_port: r.bound_port,
                active_connections: r.counters.active.load(Ordering::Relaxed),
                total_connections: r.counters.total.load(Ordering::Relaxed),
                bytes_in: r.counters.bytes_in.load(Ordering::Relaxed),
                bytes_out: r.counters.bytes_out.load(Ordering::Relaxed),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{context, password_spec, trust, Opts, TestServer};

    fn local(listen_host: &str, expose: bool) -> ForwardSpec {
        ForwardSpec {
            id: String::new(),
            profile_id: "profile1".to_string(),
            name: "web".to_string(),
            kind: ForwardKind::Local {
                listen_host: listen_host.to_string(),
                listen_port: 8080,
                dest_host: "localhost".to_string(),
                dest_port: 80,
            },
            autostart: false,
            expose,
        }
    }

    #[test]
    fn listeners_must_be_loopback_unless_exposed() {
        local("127.0.0.1", false).validate().unwrap();
        local("localhost", false).validate().unwrap();
        local("::1", false).validate().unwrap();
        local("[::1]", false).validate().unwrap();
        for host in ["0.0.0.0", "::", "192.168.1.5", "example.com"] {
            assert!(local(host, false).validate().is_err(), "{host} must need expose");
            local(host, true).validate().unwrap();
        }
    }

    #[test]
    fn rejects_bad_hosts_ports_and_names() {
        let mut spec = local("127.0.0.1", false);
        spec.kind = ForwardKind::Local {
            listen_host: "127.0.0.1".to_string(),
            listen_port: 0,
            dest_host: "-oProxyCommand=x".to_string(),
            dest_port: 80,
        };
        assert!(spec.validate().is_err());
        spec.kind = ForwardKind::Local {
            listen_host: "127.0.0.1".to_string(),
            listen_port: 0,
            dest_host: "db.internal".to_string(),
            dest_port: 0,
        };
        assert!(spec.validate().is_err());
        let mut unnamed = local("127.0.0.1", false);
        unnamed.name = "  ".to_string();
        assert!(unnamed.validate().is_err());
    }

    #[test]
    fn remote_forwards_listen_on_the_server_so_their_bind_host_is_not_restricted() {
        let spec = ForwardSpec {
            id: String::new(),
            profile_id: "p".to_string(),
            name: "r".to_string(),
            kind: ForwardKind::Remote {
                bind_host: "0.0.0.0".to_string(),
                bind_port: 9000,
                dest_host: "localhost".to_string(),
                dest_port: 3000,
            },
            autostart: false,
            expose: false,
        };
        spec.validate().unwrap();
    }

    #[test]
    fn store_round_trips_and_validates() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ForwardStore::open(dir.path().join("forwards.json")).unwrap();
        let saved = store.save(local("127.0.0.1", false)).unwrap();
        assert_eq!(saved.id.len(), 16);
        let mut renamed = saved.clone();
        renamed.name = "web 2".to_string();
        store.save(renamed).unwrap();
        assert_eq!(store.list().len(), 1);
        assert!(store.save(local("0.0.0.0", false)).is_err());
        let reopened = ForwardStore::open(dir.path().join("forwards.json")).unwrap();
        assert_eq!(reopened.list().len(), 1);
        assert_eq!(reopened.list()[0].name, "web 2");
        store.remove(&saved.id).unwrap();
        assert!(store.remove(&saved.id).is_err());
        assert!(store.list().is_empty());
    }

    #[test]
    fn serializes_with_a_flat_kind_tag() {
        let json = serde_json::to_value(local("127.0.0.1", false)).unwrap();
        assert_eq!(json["kind"], "local");
        assert_eq!(json["listenHost"], "127.0.0.1");
        assert_eq!(json["destPort"], 80);
        let back: ForwardSpec = serde_json::from_value(json).unwrap();
        assert_eq!(back, local("127.0.0.1", false));
    }

    #[test]
    fn socks5_greeting_and_request_parsing() {
        assert_eq!(parse_socks5_greeting(&[5, 1, 0]), Ok((true, 3)));
        assert_eq!(parse_socks5_greeting(&[5, 2, 2, 0]), Ok((true, 4)));
        assert_eq!(parse_socks5_greeting(&[5, 1, 2]), Ok((false, 3)));
        assert_eq!(parse_socks5_greeting(&[4, 1, 0]), Err(Socks5Error::BadVersion));
        assert_eq!(parse_socks5_greeting(&[5]), Err(Socks5Error::Incomplete));
        assert_eq!(parse_socks5_greeting(&[5, 3, 0]), Err(Socks5Error::Incomplete));

        let ipv4 = [5, 1, 0, 1, 10, 0, 0, 7, 0x01, 0xbb];
        assert_eq!(
            parse_socks5_request(&ipv4),
            Ok((Socks5Request::Connect { host: "10.0.0.7".to_string(), port: 443 }, 10))
        );
        let mut domain = vec![5, 1, 0, 3, 11];
        domain.extend_from_slice(b"example.org");
        domain.extend_from_slice(&[0, 80]);
        assert_eq!(
            parse_socks5_request(&domain),
            Ok((Socks5Request::Connect { host: "example.org".to_string(), port: 80 }, 18))
        );
        let mut ipv6 = vec![5, 1, 0, 4];
        ipv6.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        ipv6.extend_from_slice(&[0x1f, 0x90]);
        assert_eq!(
            parse_socks5_request(&ipv6),
            Ok((Socks5Request::Connect { host: "::1".to_string(), port: 8080 }, 22))
        );
    }

    #[test]
    fn socks5_rejects_what_it_does_not_support() {
        assert_eq!(parse_socks5_request(&[5, 2, 0, 1, 1, 1, 1, 1, 0, 80]), Err(Socks5Error::UnsupportedCommand));
        assert_eq!(parse_socks5_request(&[5, 3, 0, 1, 0, 0, 0, 0, 0, 0]), Err(Socks5Error::UnsupportedCommand));
        assert_eq!(parse_socks5_request(&[5, 1, 0, 9, 0, 0]), Err(Socks5Error::UnsupportedAddress));
        assert_eq!(parse_socks5_request(&[4, 1, 0, 1, 1, 1, 1, 1, 0, 80]), Err(Socks5Error::BadVersion));
        assert_eq!(parse_socks5_request(&[5, 1, 0, 1, 1, 1]), Err(Socks5Error::Incomplete));
        assert_eq!(parse_socks5_request(&[5, 1, 0, 3, 0, 0, 80]), Err(Socks5Error::Malformed));
        assert_eq!(parse_socks5_request(&[5, 1, 0, 3, 4, b'a', b'b']), Err(Socks5Error::Incomplete));
        assert_eq!(parse_socks5_request(&[5, 1]), Err(Socks5Error::Incomplete));
    }

    async fn echo_server() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 256];
                    while let Ok(n) = socket.read(&mut buf).await {
                        if n == 0 || socket.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    async fn connected() -> (TestServer, Arc<SshSession>, tempfile::TempDir) {
        let server = TestServer::start(Opts {
            users: vec![("alice".to_string(), "secret".to_string())],
            direct_tcpip: true,
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        trust(&ctx, &server);
        let session = SshSession::connect(&ctx, &password_spec(&server, "alice", "secret"), None).await.unwrap();
        (server, session, dir)
    }

    async fn roundtrip(port: u16, payload: &[u8]) -> Vec<u8> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(payload).await.unwrap();
        let mut out = vec![0u8; payload.len()];
        stream.read_exact(&mut out).await.unwrap();
        out
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_local_forward_reaches_a_service_through_the_server_and_counts_traffic() {
        let echo = echo_server().await;
        let (_server, session, _keep) = connected().await;
        let tunnels = Tunnels::default();
        let mut spec = local("127.0.0.1", false);
        spec.id = "t1".to_string();
        spec.kind = ForwardKind::Local {
            listen_host: "127.0.0.1".to_string(),
            listen_port: 0,
            dest_host: "127.0.0.1".to_string(),
            dest_port: echo,
        };
        let status = tunnels.start(&spec, session).await.unwrap();
        assert_ne!(status.bound_port, 0);
        assert_eq!(roundtrip(status.bound_port, b"hello tunnel").await, b"hello tunnel");
        assert!(tunnels.start(&spec, tunnels_session_clone(&tunnels, "t1")).await.is_err(), "already running");

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let stats = tunnels.status();
        assert_eq!(stats.len(), 1);
        assert!(stats[0].total_connections >= 1);

        tunnels.stop("t1").await.unwrap();
        assert!(tunnels.stop("t1").await.is_err());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(TcpStream::connect(("127.0.0.1", status.bound_port)).await.is_err(), "listener closed");
    }

    fn tunnels_session_clone(tunnels: &Tunnels, id: &str) -> Arc<SshSession> {
        tunnels.running.lock().unwrap().get(id).unwrap().session.clone()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_dynamic_forward_speaks_socks5() {
        let echo = echo_server().await;
        let (_server, session, _keep) = connected().await;
        let tunnels = Tunnels::default();
        let mut spec = local("127.0.0.1", false);
        spec.id = "socks".to_string();
        spec.kind = ForwardKind::Dynamic { listen_host: "127.0.0.1".to_string(), listen_port: 0 };
        let status = tunnels.start(&spec, session).await.unwrap();

        let mut client = TcpStream::connect(("127.0.0.1", status.bound_port)).await.unwrap();
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut method = [0u8; 2];
        client.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [5, 0]);
        let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
        request.extend_from_slice(&echo.to_be_bytes());
        client.write_all(&request).await.unwrap();
        let mut reply = [0u8; 10];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[1], 0, "connect succeeded");
        client.write_all(b"via socks").await.unwrap();
        let mut echoed = [0u8; 9];
        client.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"via socks");

        let mut refused = TcpStream::connect(("127.0.0.1", status.bound_port)).await.unwrap();
        refused.write_all(&[5, 1, 0]).await.unwrap();
        refused.read_exact(&mut method).await.unwrap();
        let mut bind_cmd = vec![5, 2, 0, 1, 127, 0, 0, 1];
        bind_cmd.extend_from_slice(&echo.to_be_bytes());
        refused.write_all(&bind_cmd).await.unwrap();
        let mut denied = [0u8; 10];
        refused.read_exact(&mut denied).await.unwrap();
        assert_eq!(denied[1], 7, "BIND is not supported");
        tunnels.stop_all().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_remote_forward_brings_a_local_service_to_the_server() {
        let echo = echo_server().await;
        let (_server, session, _keep) = connected().await;
        let tunnels = Tunnels::default();
        let spec = ForwardSpec {
            id: "remote1".to_string(),
            profile_id: "p".to_string(),
            name: "r".to_string(),
            kind: ForwardKind::Remote {
                bind_host: "127.0.0.1".to_string(),
                bind_port: 0,
                dest_host: "127.0.0.1".to_string(),
                dest_port: echo,
            },
            autostart: false,
            expose: false,
        };
        let status = tunnels.start(&spec, session).await.unwrap();
        assert_ne!(status.bound_port, 0);
        assert_eq!(roundtrip(status.bound_port, b"from the server side").await, b"from the server side");
        tunnels.stop("remote1").await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn stopping_a_session_stops_its_forwards() {
        let echo = echo_server().await;
        let (_server, session, _keep) = connected().await;
        let tunnels = Tunnels::default();
        let mut spec = local("127.0.0.1", false);
        spec.id = "t".to_string();
        spec.kind = ForwardKind::Local {
            listen_host: "127.0.0.1".to_string(),
            listen_port: 0,
            dest_host: "127.0.0.1".to_string(),
            dest_port: echo,
        };
        tunnels.start(&spec, session.clone()).await.unwrap();
        tunnels.stop_for_session(&session).await;
        assert!(tunnels.status().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_busy_listen_port_is_reported_clearly() {
        let (_server, session, _keep) = connected().await;
        let busy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = busy.local_addr().unwrap().port();
        let tunnels = Tunnels::default();
        let mut spec = local("127.0.0.1", false);
        spec.id = "busy".to_string();
        spec.kind = ForwardKind::Local {
            listen_host: "127.0.0.1".to_string(),
            listen_port: port,
            dest_host: "127.0.0.1".to_string(),
            dest_port: 1,
        };
        let err = tunnels.start(&spec, session).await.unwrap_err();
        assert!(err.message.contains("cannot listen"));
        assert!(!tunnels.is_running("busy"));
    }
}
