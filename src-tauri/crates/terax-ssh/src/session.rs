//! One authenticated SSH connection, optionally tunnelled through a jump host.
//!
//! Host keys are verified here and never auto-accepted: an unknown or changed key aborts the
//! handshake and the caller receives the details to show the user.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::ssh_key::{Algorithm, HashAlg, PublicKey};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelStream, MethodKind, Preferred};
use russh_sftp::client::SftpSession;
use tokio::net::TcpStream;

use crate::error::{ErrorCode, Result, SshError};
use crate::keys::load_private;
use crate::known_hosts::{
    algorithm_name, check, fingerprint, recorded_algorithms, KnownHostEntry, KnownHostsFile,
    HostCheck,
};
use crate::profile::{expand_tilde, AuthMethod, SshProfile};
use crate::secret::Secret;

const SFTP_REQUEST_TIMEOUT_SECS: u64 = 60;
const WINDOW_SIZE: u32 = 4 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct Credentials {
    pub password: Option<Secret>,
    pub key_passphrase: Option<Secret>,
}

#[derive(Clone)]
pub struct HostSpec {
    pub profile: SshProfile,
    pub credentials: Credentials,
}

#[derive(Clone)]
pub struct ConnectContext {
    pub known_hosts: KnownHostsFile,
    pub system_known_hosts: Option<PathBuf>,
    pub timeout: Duration,
}

type RemoteForwards = Arc<Mutex<HashMap<u32, (String, u16)>>>;
type HostKeySlot = Arc<Mutex<Option<(HostCheck, PublicKey)>>>;

pub(crate) struct ClientHandler {
    entries: Vec<KnownHostEntry>,
    host: String,
    port: u16,
    slot: HostKeySlot,
    forwards: RemoteForwards,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = server_public_key else {
            return Ok(false);
        };
        match check(&self.entries, &self.host, self.port, key) {
            HostCheck::Trusted => Ok(true),
            other => {
                if let Ok(mut slot) = self.slot.lock() {
                    *slot = Some((other, key.clone()));
                }
                Ok(false)
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let target = self
            .forwards
            .lock()
            .ok()
            .and_then(|map| map.get(&connected_port).cloned());
        let Some((host, port)) = target else {
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            if let Ok(mut local) = TcpStream::connect((host.as_str(), port)).await {
                let mut remote = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
            }
        });
        Ok(())
    }
}

pub struct SshSession {
    handle: Handle<ClientHandler>,
    forwards: RemoteForwards,
    _jump: Option<Arc<SshSession>>,
    pub host: String,
    pub port: u16,
    pub user: String,
}

fn map_russh(err: russh::Error) -> SshError {
    use russh::Error as E;
    match err {
        E::NoAuthMethod => SshError::auth("the server accepts none of the available login methods"),
        E::ConnectionTimeout | E::KeepaliveTimeout | E::InactivityTimeout => {
            SshError::connect("the connection timed out")
        }
        E::Disconnect | E::HUP => SshError::connect("the server closed the connection"),
        E::IO(io) => SshError::connect(io.to_string()),
        E::RequestDenied => SshError::new(ErrorCode::Unsupported, "the server denied the request"),
        other => SshError::protocol(other.to_string()),
    }
}

fn host_key_error(host: &str, port: u16, check: HostCheck, key: &PublicKey) -> SshError {
    let presented = serde_json::json!({
        "algorithm": algorithm_name(key),
        "fingerprint": fingerprint(key),
        "publicKey": key.to_openssh().unwrap_or_default(),
    });
    match check {
        HostCheck::Unknown { other_keys } => SshError::new(
            ErrorCode::HostKeyUnknown,
            format!("the authenticity of {host}:{port} cannot be established"),
        )
        .with_data(serde_json::json!({
            "host": host, "port": port, "presented": presented, "otherKeys": other_keys,
        })),
        HostCheck::Changed { recorded } => SshError::new(
            ErrorCode::HostKeyChanged,
            format!("the host key of {host}:{port} has changed"),
        )
        .with_data(serde_json::json!({
            "host": host, "port": port, "presented": presented, "recorded": recorded, "revoked": false,
        })),
        HostCheck::Revoked => SshError::new(
            ErrorCode::HostKeyChanged,
            format!("the host key of {host}:{port} is marked as revoked"),
        )
        .with_data(serde_json::json!({
            "host": host, "port": port, "presented": presented, "recorded": [], "revoked": true,
        })),
        HostCheck::Trusted => SshError::protocol("host key was trusted"),
    }
}

fn build_config(profile: &SshProfile, recorded: Vec<Algorithm>) -> Arc<client::Config> {
    let mut keys: Vec<Algorithm> = recorded.clone();
    for algorithm in Preferred::DEFAULT.key.iter() {
        if !keys.contains(algorithm) {
            keys.push(algorithm.clone());
        }
    }
    let preferred = Preferred {
        key: Cow::Owned(keys),
        ..Preferred::DEFAULT
    };
    Arc::new(client::Config {
        preferred,
        window_size: WINDOW_SIZE,
        keepalive_interval: (profile.keepalive_secs > 0)
            .then(|| Duration::from_secs(u64::from(profile.keepalive_secs))),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    })
}

async fn rsa_hash(handle: &Handle<ClientHandler>) -> Option<HashAlg> {
    match handle.best_supported_rsa_hash().await {
        Ok(Some(hash)) => hash,
        _ => Some(HashAlg::Sha256),
    }
}

#[cfg(unix)]
async fn connect_agent() -> Result<AgentClient<Box<dyn russh::keys::agent::client::AgentStream + Send + Unpin>>> {
    let client = AgentClient::connect_env()
        .await
        .map_err(|err| SshError::auth(format!("cannot reach the SSH agent: {err}")))?;
    Ok(client.dynamic())
}

#[cfg(windows)]
async fn connect_agent() -> Result<AgentClient<Box<dyn russh::keys::agent::client::AgentStream + Send + Unpin>>> {
    if let Ok(client) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        return Ok(client.dynamic());
    }
    AgentClient::connect_pageant()
        .await
        .map(|c| c.dynamic())
        .map_err(|err| SshError::auth(format!("cannot reach the SSH agent: {err}")))
}

async fn auth_agent(handle: &mut Handle<ClientHandler>, user: &str) -> Result<()> {
    let mut agent = connect_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|err| SshError::auth(format!("the SSH agent did not list its keys: {err}")))?;
    if identities.is_empty() {
        return Err(SshError::auth("the SSH agent holds no keys"));
    }
    let hash = rsa_hash(handle).await;
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        match handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
        {
            Ok(AuthResult::Success) => return Ok(()),
            Ok(AuthResult::Failure { .. }) => continue,
            Err(err) => log::debug!("agent signing failed: {err}"),
        }
    }
    Err(SshError::auth("the server accepted none of the agent's keys"))
}

async fn auth_key(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    path: &str,
    passphrase: Option<Secret>,
) -> Result<()> {
    let path = expand_tilde(path);
    let key = tokio::task::spawn_blocking(move || load_private(&path, passphrase.as_ref()))
        .await
        .map_err(|err| SshError::io(format!("key loading was interrupted: {err}")))??;
    let hash = if key.algorithm().is_rsa() {
        rsa_hash(handle).await
    } else {
        None
    };
    match handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(key, hash))
        .await
        .map_err(map_russh)?
    {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(SshError::auth("the server rejected this key")),
    }
}

async fn auth_password(handle: &mut Handle<ClientHandler>, user: &str, password: Secret) -> Result<()> {
    match handle
        .authenticate_password(user, password.expose())
        .await
        .map_err(map_russh)?
    {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { remaining_methods, .. } => {
            if remaining_methods.contains(&MethodKind::KeyboardInteractive) {
                auth_keyboard_interactive(handle, user, &password).await
            } else {
                Err(SshError::auth("incorrect password or login not permitted"))
            }
        }
    }
}

async fn auth_keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    user: &str,
    password: &Secret,
) -> Result<()> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await
        .map_err(map_russh)?;
    for _ in 0..4 {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(SshError::auth("incorrect password or login not permitted"));
            }
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = match prompts.as_slice() {
                    [] => Vec::new(),
                    [only] if only.prompt.to_lowercase().contains("password") => {
                        vec![password.expose().to_string()]
                    }
                    _ => {
                        return Err(SshError::auth(
                            "the server asks for extra verification, which is not supported yet",
                        ));
                    }
                };
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(map_russh)?;
            }
        }
    }
    Err(SshError::auth("the server kept asking for verification"))
}

async fn authenticate(handle: &mut Handle<ClientHandler>, spec: &HostSpec) -> Result<()> {
    let user = spec.profile.user.as_str();
    match &spec.profile.auth {
        AuthMethod::Agent => auth_agent(handle, user).await,
        AuthMethod::KeyFile { path } => {
            auth_key(handle, user, path, spec.credentials.key_passphrase.clone()).await
        }
        AuthMethod::Password => {
            let password = spec
                .credentials
                .password
                .clone()
                .ok_or_else(|| SshError::new(ErrorCode::PasswordRequired, "a password is required"))?;
            auth_password(handle, user, password).await
        }
    }
}

async fn connect_direct(
    ctx: &ConnectContext,
    spec: &HostSpec,
    via: Option<Arc<SshSession>>,
) -> Result<Arc<SshSession>> {
    spec.profile.validate()?;
    let host = spec.profile.host.clone();
    let port = spec.profile.port;

    let mut entries = ctx.known_hosts.load()?;
    if let Some(path) = &ctx.system_known_hosts {
        if let Ok(text) = std::fs::read_to_string(path) {
            entries.extend(crate::known_hosts::parse(&text));
        }
    }
    let recorded = recorded_algorithms(&entries, &host, port);
    let slot: HostKeySlot = Arc::new(Mutex::new(None));
    let forwards: RemoteForwards = Arc::new(Mutex::new(HashMap::new()));
    let handler = ClientHandler {
        entries,
        host: host.clone(),
        port,
        slot: slot.clone(),
        forwards: forwards.clone(),
    };
    let config = build_config(&spec.profile, recorded);

    let work = async {
        let connected = match &via {
            None => {
                let tcp = TcpStream::connect((host.as_str(), port))
                    .await
                    .map_err(|err| SshError::connect(format!("{host}:{port}: {err}")))?;
                client::connect_stream(config, tcp, handler).await
            }
            Some(jump) => {
                let channel = jump
                    .handle
                    .channel_open_direct_tcpip(host.clone(), u32::from(port), "127.0.0.1", 0)
                    .await
                    .map_err(|err| {
                        SshError::connect(format!("the jump host could not reach {host}:{port}: {err}"))
                    })?;
                client::connect_stream(config, channel.into_stream(), handler).await
            }
        };
        let mut handle = match connected {
            Ok(handle) => handle,
            Err(err) => {
                let pending = slot.lock().ok().and_then(|mut s| s.take());
                return Err(match pending {
                    Some((check, key)) => host_key_error(&host, port, check, &key),
                    None => map_russh(err),
                });
            }
        };
        authenticate(&mut handle, spec).await?;
        Ok::<_, SshError>(handle)
    };

    let handle = tokio::time::timeout(ctx.timeout, work)
        .await
        .map_err(|_| SshError::connect(format!("timed out connecting to {host}:{port}")))??;

    Ok(Arc::new(SshSession {
        handle,
        forwards,
        _jump: via,
        host,
        port,
        user: spec.profile.user.clone(),
    }))
}

impl SshSession {
    pub async fn connect(
        ctx: &ConnectContext,
        target: &HostSpec,
        jump: Option<&HostSpec>,
    ) -> Result<Arc<SshSession>> {
        let via = match jump {
            Some(spec) => Some(connect_direct(ctx, spec, None).await?),
            None => None,
        };
        connect_direct(ctx, target, via).await
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn open_sftp(&self) -> Result<SftpSession> {
        let channel = self.handle.channel_open_session().await.map_err(map_russh)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|_| SshError::new(ErrorCode::Unsupported, "the server has no SFTP subsystem"))?;
        let config = russh_sftp::client::Config {
            request_timeout_secs: SFTP_REQUEST_TIMEOUT_SECS,
            ..Default::default()
        };
        SftpSession::new_with_config(channel.into_stream(), config)
            .await
            .map_err(|err| SshError::protocol(format!("SFTP handshake failed: {err}")))
    }

    /// Opens a TCP connection from the server to `host:port`, for local and dynamic forwards.
    pub async fn open_direct(
        &self,
        host: &str,
        port: u16,
        origin: &str,
        origin_port: u16,
    ) -> Result<ChannelStream<client::Msg>> {
        let channel = self
            .handle
            .channel_open_direct_tcpip(host.to_string(), u32::from(port), origin.to_string(), u32::from(origin_port))
            .await
            .map_err(|err| SshError::connect(format!("the server could not reach {host}:{port}: {err}")))?;
        Ok(channel.into_stream())
    }

    /// Asks the server to listen on `bind_address:bind_port` and route connections to `target`.
    /// Returns the port the server actually bound.
    pub async fn request_remote_forward(
        &self,
        bind_address: &str,
        bind_port: u16,
        target: (String, u16),
    ) -> Result<u16> {
        let bound = self
            .handle
            .tcpip_forward(bind_address.to_string(), u32::from(bind_port))
            .await
            .map_err(|err| SshError::new(ErrorCode::Unsupported, format!("the server refused the forward: {err}")))?;
        let actual = if bound == 0 { u32::from(bind_port) } else { bound };
        if let Ok(mut map) = self.forwards.lock() {
            map.insert(actual, target);
        }
        u16::try_from(actual).map_err(|_| SshError::protocol("the server returned an invalid port"))
    }

    pub async fn cancel_remote_forward(&self, bind_address: &str, bound_port: u16) -> Result<()> {
        if let Ok(mut map) = self.forwards.lock() {
            map.remove(&u32::from(bound_port));
        }
        self.handle
            .cancel_tcpip_forward(bind_address.to_string(), u32::from(bound_port))
            .await
            .map_err(map_russh)
    }

    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}

/// Records a host key the user has explicitly approved. `replace` first forgets what was on file.
pub fn trust_host_key(
    ctx: &ConnectContext,
    host: &str,
    port: u16,
    public_key_openssh: &str,
    replace: bool,
) -> Result<()> {
    let key = PublicKey::from_openssh(public_key_openssh.trim())
        .map_err(|err| SshError::invalid(format!("not a valid public key: {err}")))?;
    let mut entries = ctx.known_hosts.load()?;
    if let Some(path) = &ctx.system_known_hosts {
        if let Ok(text) = std::fs::read_to_string(path) {
            entries.extend(crate::known_hosts::parse(&text));
        }
    }
    match check(&entries, host, port, &key) {
        HostCheck::Revoked => {
            return Err(SshError::invalid("this host key is marked as revoked and cannot be trusted"));
        }
        HostCheck::Changed { .. } if !replace => {
            return Err(SshError::invalid(
                "a different key is on file for this host; replacing it needs explicit confirmation",
            ));
        }
        _ => {}
    }
    if replace {
        ctx.known_hosts.forget_host(host, port)?;
    }
    ctx.known_hosts.learn(host, port, &key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{generate, GenerateSpec, KeyAlgorithm};
    use crate::testing::{context, password_spec, trust, Opts, TestServer};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn alice() -> Opts {
        Opts {
            users: vec![("alice".to_string(), "secret".to_string())],
            ..Default::default()
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unknown_host_key_stops_the_handshake_and_reports_the_fingerprint() {
        let server = TestServer::start(alice()).await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());

        let err = SshSession::connect(&ctx, &password_spec(&server, "alice", "secret"), None)
            .await
            .err()
            .expect("must not connect");
        assert_eq!(err.code, ErrorCode::HostKeyUnknown);
        let data = err.data.expect("details");
        assert_eq!(data["host"], "127.0.0.1");
        assert_eq!(data["presented"]["fingerprint"], fingerprint(&server.host_key));
        assert!(!ctx.known_hosts.path().exists());

        let key_line = data["presented"]["publicKey"].as_str().unwrap().to_string();
        trust_host_key(&ctx, "127.0.0.1", server.port, &key_line, false).unwrap();
        let session = SshSession::connect(&ctx, &password_spec(&server, "alice", "secret"), None)
            .await
            .expect("connects once trusted");
        assert!(!session.is_closed());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_changed_host_key_is_refused_until_explicitly_replaced() {
        let server = TestServer::start(alice()).await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        let old = russh::keys::ssh_key::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            Algorithm::Ed25519,
        )
        .unwrap();
        ctx.known_hosts
            .learn("127.0.0.1", server.port, old.public_key())
            .unwrap();

        let err = SshSession::connect(&ctx, &password_spec(&server, "alice", "secret"), None)
            .await
            .err()
            .expect("must not connect");
        assert_eq!(err.code, ErrorCode::HostKeyChanged);
        let data = err.data.expect("details");
        assert_eq!(data["recorded"][0]["fingerprint"], fingerprint(old.public_key()));
        assert_eq!(data["presented"]["fingerprint"], fingerprint(&server.host_key));

        let key_line = data["presented"]["publicKey"].as_str().unwrap().to_string();
        assert!(trust_host_key(&ctx, "127.0.0.1", server.port, &key_line, false).is_err());
        trust_host_key(&ctx, "127.0.0.1", server.port, &key_line, true).unwrap();
        SshSession::connect(&ctx, &password_spec(&server, "alice", "secret"), None)
            .await
            .expect("connects after the explicit replace");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn password_auth_distinguishes_wrong_and_missing_passwords() {
        let server = TestServer::start(alice()).await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        trust(&ctx, &server);

        let wrong = SshSession::connect(&ctx, &password_spec(&server, "alice", "nope"), None)
            .await
            .err()
            .unwrap();
        assert_eq!(wrong.code, ErrorCode::Auth);

        let mut missing = password_spec(&server, "alice", "x");
        missing.credentials.password = None;
        let err = SshSession::connect(&ctx, &missing, None).await.err().unwrap();
        assert_eq!(err.code, ErrorCode::PasswordRequired);

        SshSession::connect(&ctx, &password_spec(&server, "alice", "secret"), None)
            .await
            .expect("correct password works");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn key_file_auth_handles_passphrases_and_unauthorized_keys() {
        let keys = tempfile::tempdir().unwrap();
        let plain = generate(
            keys.path(),
            &GenerateSpec {
                name: "plain".to_string(),
                algorithm: KeyAlgorithm::Ed25519,
                comment: String::new(),
                passphrase: None,
            },
        )
        .unwrap();
        let locked = generate(
            keys.path(),
            &GenerateSpec {
                name: "locked".to_string(),
                algorithm: KeyAlgorithm::EcdsaP256,
                comment: String::new(),
                passphrase: Some(Secret::new("pw")),
            },
        )
        .unwrap();
        let stranger = generate(
            keys.path(),
            &GenerateSpec {
                name: "stranger".to_string(),
                algorithm: KeyAlgorithm::Ed25519,
                comment: String::new(),
                passphrase: None,
            },
        )
        .unwrap();
        let parse = |info: &crate::keys::KeyInfo| {
            PublicKey::from_openssh(info.public_key.as_deref().unwrap()).unwrap()
        };
        let server = TestServer::start(Opts {
            authorized_keys: vec![parse(&plain), parse(&locked)],
            ..Default::default()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        trust(&ctx, &server);

        let spec = |info: &crate::keys::KeyInfo, passphrase: Option<&str>| HostSpec {
            profile: server.profile("k", "alice", AuthMethod::KeyFile { path: info.path.clone() }),
            credentials: Credentials {
                password: None,
                key_passphrase: passphrase.map(Secret::new),
            },
        };

        SshSession::connect(&ctx, &spec(&plain, None), None).await.expect("plain key");
        assert_eq!(
            SshSession::connect(&ctx, &spec(&locked, None), None).await.err().unwrap().code,
            ErrorCode::PassphraseRequired
        );
        assert_eq!(
            SshSession::connect(&ctx, &spec(&locked, Some("bad")), None).await.err().unwrap().code,
            ErrorCode::PassphraseInvalid
        );
        SshSession::connect(&ctx, &spec(&locked, Some("pw")), None).await.expect("locked key");
        assert_eq!(
            SshSession::connect(&ctx, &spec(&stranger, None), None).await.err().unwrap().code,
            ErrorCode::Auth
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_jump_host_carries_the_connection_and_its_key_is_verified_too() {
        let jump = TestServer::start(Opts {
            users: vec![("ops".to_string(), "jump-pw".to_string())],
            direct_tcpip: true,
            ..Default::default()
        })
        .await;
        let target = TestServer::start(alice()).await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        trust(&ctx, &target);

        let jump_spec = password_spec(&jump, "ops", "jump-pw");
        let target_spec = password_spec(&target, "alice", "secret");

        let err = SshSession::connect(&ctx, &target_spec, Some(&jump_spec)).await.err().unwrap();
        assert_eq!(err.code, ErrorCode::HostKeyUnknown);
        assert_eq!(err.data.unwrap()["port"], jump.port);

        trust(&ctx, &jump);
        let session = SshSession::connect(&ctx, &target_spec, Some(&jump_spec))
            .await
            .expect("through the jump host");
        let sftp = session.open_sftp().await.expect("sftp over the jump");
        assert_eq!(sftp.canonicalize(".").await.unwrap(), "/");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn direct_tcpip_channels_reach_a_service_behind_the_server() {
        let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = echo.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    while let Ok(n) = socket.read(&mut buf).await {
                        if n == 0 || socket.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        let server = TestServer::start(Opts {
            direct_tcpip: true,
            ..alice()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        trust(&ctx, &server);
        let session = SshSession::connect(&ctx, &password_spec(&server, "alice", "secret"), None)
            .await
            .unwrap();
        let mut stream = session.open_direct("127.0.0.1", echo_port, "127.0.0.1", 0).await.unwrap();
        stream.write_all(b"ping").await.unwrap();
        let mut reply = [0u8; 4];
        stream.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"ping");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn invalid_profiles_never_reach_the_network() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        let mut spec = HostSpec {
            profile: crate::profile::fixtures::profile("", "x"),
            credentials: Credentials::default(),
        };
        spec.profile.host = "-oProxyCommand=evil".to_string();
        let err = SshSession::connect(&ctx, &spec, None).await.err().unwrap();
        assert_eq!(err.code, ErrorCode::Invalid);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unreachable_host_fails_fast_with_a_connect_error() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut spec = HostSpec {
            profile: crate::profile::fixtures::profile("", "x"),
            credentials: Credentials::default(),
        };
        spec.profile.host = "127.0.0.1".to_string();
        spec.profile.port = port;
        let err = SshSession::connect(&ctx, &spec, None).await.err().unwrap();
        assert_eq!(err.code, ErrorCode::Connect);
    }
}
