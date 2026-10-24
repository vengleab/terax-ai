//! Host key verification against OpenSSH `known_hosts` files.
//!
//! The app keeps its own file; `~/.ssh/known_hosts` can be consulted read-only. A key that
//! differs from a recorded one is never accepted here: the caller must stop and ask the user.

use std::path::{Path, PathBuf};

use data_encoding::BASE64;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::ssh_key::{Algorithm, HashAlg, PublicKey};
use serde::Serialize;
use sha1::Sha1;

use crate::error::{Result, SshError};
use crate::fsutil::atomic_write;
use crate::ssh_config::wildcard_match;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Marker {
    Revoked,
    CertAuthority,
}

#[derive(Debug, Clone)]
pub struct KnownHostEntry {
    pub line: usize,
    pub marker: Option<Marker>,
    pub patterns: Vec<String>,
    pub key: PublicKey,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownKey {
    pub line: usize,
    pub algorithm: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCheck {
    Trusted,
    /// No key on file for this host. `other_keys` lists keys of other algorithms recorded for it.
    Unknown { other_keys: Vec<KnownKey> },
    /// A key of the same algorithm is on file and differs from the presented one.
    Changed { recorded: Vec<KnownKey> },
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostRow {
    pub line: usize,
    pub hosts: Vec<String>,
    pub hashed: bool,
    pub algorithm: String,
    pub fingerprint: String,
    pub comment: Option<String>,
    pub marker: Option<Marker>,
}

pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

pub fn algorithm_name(key: &PublicKey) -> String {
    key.algorithm().to_string()
}

fn known_key(line: usize, key: &PublicKey) -> KnownKey {
    KnownKey {
        line,
        algorithm: algorithm_name(key),
        fingerprint: fingerprint(key),
    }
}

/// The name OpenSSH looks up and hashes: the host alone on port 22, else `[host]:port`.
pub fn lookup_name(host: &str, port: u16) -> String {
    let host = host.to_ascii_lowercase();
    if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    }
}

fn parse_line(line_no: usize, raw: &str) -> Option<KnownHostEntry> {
    let line = raw.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let mut fields = line.split_whitespace();
    let mut first = fields.next()?;
    let mut marker = None;
    if let Some(m) = first.strip_prefix('@') {
        marker = Some(match m {
            "revoked" => Marker::Revoked,
            "cert-authority" => Marker::CertAuthority,
            _ => return None,
        });
        first = fields.next()?;
    }
    let algorithm = fields.next()?;
    let blob = fields.next()?;
    let key = PublicKey::from_openssh(&format!("{algorithm} {blob}")).ok()?;
    let rest: Vec<&str> = fields.collect();
    Some(KnownHostEntry {
        line: line_no,
        marker,
        patterns: first.split(',').map(str::to_string).collect(),
        key,
        comment: if rest.is_empty() {
            None
        } else {
            Some(rest.join(" "))
        },
    })
}

/// Lines that are not valid entries are skipped, never an error.
pub fn parse(text: &str) -> Vec<KnownHostEntry> {
    text.lines()
        .enumerate()
        .filter_map(|(index, raw)| parse_line(index + 1, raw))
        .collect()
}

fn hashed_matches(pattern: &str, name: &str) -> bool {
    let mut parts = pattern.split('|').skip(2);
    let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else {
        return false;
    };
    let (Ok(salt), Ok(hash)) = (BASE64.decode(salt.as_bytes()), BASE64.decode(hash.as_bytes()))
    else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(&salt) else {
        return false;
    };
    mac.update(name.as_bytes());
    mac.verify_slice(&hash).is_ok()
}

pub fn entry_matches(entry: &KnownHostEntry, name: &str) -> bool {
    let mut matched = false;
    for pattern in &entry.patterns {
        if pattern.starts_with("|1|") {
            if hashed_matches(pattern, name) {
                matched = true;
            }
        } else if let Some(negated) = pattern.strip_prefix('!') {
            if wildcard_match(negated, name) {
                return false;
            }
        } else if wildcard_match(pattern, name) {
            matched = true;
        }
    }
    matched
}

pub fn check(entries: &[KnownHostEntry], host: &str, port: u16, key: &PublicKey) -> HostCheck {
    let name = lookup_name(host, port);
    let matching: Vec<&KnownHostEntry> = entries
        .iter()
        .filter(|e| e.marker != Some(Marker::CertAuthority) && entry_matches(e, &name))
        .collect();

    if matching
        .iter()
        .any(|e| e.marker == Some(Marker::Revoked) && e.key.key_data() == key.key_data())
    {
        return HostCheck::Revoked;
    }

    let live: Vec<&&KnownHostEntry> = matching
        .iter()
        .filter(|e| e.marker != Some(Marker::Revoked))
        .collect();

    if live.iter().any(|e| e.key.key_data() == key.key_data()) {
        return HostCheck::Trusted;
    }

    let same_algorithm: Vec<KnownKey> = live
        .iter()
        .filter(|e| e.key.algorithm() == key.algorithm())
        .map(|e| known_key(e.line, &e.key))
        .collect();
    if !same_algorithm.is_empty() {
        return HostCheck::Changed {
            recorded: same_algorithm,
        };
    }

    HostCheck::Unknown {
        other_keys: live.iter().map(|e| known_key(e.line, &e.key)).collect(),
    }
}

/// Algorithms recorded for this host, so the handshake can prefer them and avoid a false "new key".
pub fn recorded_algorithms(entries: &[KnownHostEntry], host: &str, port: u16) -> Vec<Algorithm> {
    let name = lookup_name(host, port);
    let mut out: Vec<Algorithm> = Vec::new();
    for entry in entries {
        if entry.marker.is_some() || !entry_matches(entry, &name) {
            continue;
        }
        let algorithm = entry.key.algorithm();
        if !out.contains(&algorithm) {
            out.push(algorithm);
        }
    }
    out
}

pub fn rows(entries: &[KnownHostEntry]) -> Vec<KnownHostRow> {
    entries
        .iter()
        .map(|e| {
            let hashed = e.patterns.iter().any(|p| p.starts_with("|1|"));
            KnownHostRow {
                line: e.line,
                hosts: if hashed {
                    Vec::new()
                } else {
                    e.patterns.clone()
                },
                hashed,
                algorithm: algorithm_name(&e.key),
                fingerprint: fingerprint(&e.key),
                comment: e.comment.clone(),
                marker: e.marker,
            }
        })
        .collect()
}

pub fn format_entry(host: &str, port: u16, key: &PublicKey) -> Result<String> {
    let mut bare = key.clone();
    bare.set_comment("");
    let line = bare
        .to_openssh()
        .map_err(|err| SshError::protocol(format!("could not encode host key: {err}")))?;
    Ok(format!("{} {}", lookup_name(host, port), line.trim_end()))
}

/// The app-owned known_hosts file.
#[derive(Debug, Clone)]
pub struct KnownHostsFile {
    path: PathBuf,
}

impl KnownHostsFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read_text(&self) -> Result<String> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => Ok(text),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(err) => Err(err.into()),
        }
    }

    pub fn load(&self) -> Result<Vec<KnownHostEntry>> {
        Ok(parse(&self.read_text()?))
    }

    /// Appends a trusted key. Does nothing if the exact key is already trusted for the host.
    pub fn learn(&self, host: &str, port: u16, key: &PublicKey) -> Result<()> {
        let mut text = self.read_text()?;
        let entries = parse(&text);
        if check(&entries, host, port, key) == HostCheck::Trusted {
            return Ok(());
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&format_entry(host, port, key)?);
        text.push('\n');
        atomic_write(&self.path, text.as_bytes(), true)
    }

    /// Removes every entry that applies to this host, so a replaced key can be learned afresh.
    pub fn forget_host(&self, host: &str, port: u16) -> Result<usize> {
        let text = self.read_text()?;
        let name = lookup_name(host, port);
        let doomed: Vec<usize> = parse(&text)
            .iter()
            .filter(|e| entry_matches(e, &name))
            .map(|e| e.line)
            .collect();
        self.remove_lines(&text, &doomed)
    }

    /// Removes one entry by its 1-based line number.
    pub fn remove_line(&self, line: usize) -> Result<()> {
        let text = self.read_text()?;
        if !parse(&text).iter().any(|e| e.line == line) {
            return Err(SshError::not_found("no host key entry on that line"));
        }
        self.remove_lines(&text, &[line]).map(|_| ())
    }

    fn remove_lines(&self, text: &str, lines: &[usize]) -> Result<usize> {
        if lines.is_empty() {
            return Ok(0);
        }
        let kept: Vec<&str> = text
            .lines()
            .enumerate()
            .filter(|(index, _)| !lines.contains(&(index + 1)))
            .map(|(_, line)| line)
            .collect();
        let mut out = kept.join("\n");
        if !out.is_empty() {
            out.push('\n');
        }
        atomic_write(&self.path, out.as_bytes(), true)?;
        Ok(lines.len())
    }
}

pub fn system_known_hosts_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}

/// Checks the app file and, when given, a read-only system file. A key trusted by either is trusted.
pub fn check_files(
    app: &KnownHostsFile,
    system: Option<&Path>,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> Result<HostCheck> {
    let mut entries = app.load()?;
    if let Some(path) = system {
        if let Ok(text) = std::fs::read_to_string(path) {
            entries.extend(parse(&text));
        }
    }
    Ok(check(&entries, host, port, key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::key::safe_rng;
    use russh::keys::PrivateKey;

    fn new_key(comment: &str) -> PublicKey {
        let mut rng = safe_rng();
        let mut key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        key.set_comment(comment);
        key.public_key().clone()
    }

    fn ecdsa_key() -> PublicKey {
        let mut rng = safe_rng();
        PrivateKey::random(
            &mut rng,
            Algorithm::Ecdsa {
                curve: russh::keys::EcdsaCurve::NistP256,
            },
        )
        .unwrap()
        .public_key()
        .clone()
    }

    fn line_for(patterns: &str, key: &PublicKey) -> String {
        format!("{patterns} {}", key.to_openssh().unwrap())
    }

    #[test]
    fn lookup_names_follow_openssh_conventions() {
        assert_eq!(lookup_name("Example.COM", 22), "example.com");
        assert_eq!(lookup_name("example.com", 2222), "[example.com]:2222");
    }

    #[test]
    fn unknown_then_trusted_after_learning() {
        let dir = tempfile::tempdir().unwrap();
        let file = KnownHostsFile::new(dir.path().join("known_hosts"));
        let key = new_key("");
        let before = check_files(&file, None, "a.example", 22, &key).unwrap();
        assert_eq!(before, HostCheck::Unknown { other_keys: vec![] });
        file.learn("a.example", 22, &key).unwrap();
        assert_eq!(
            check_files(&file, None, "a.example", 22, &key).unwrap(),
            HostCheck::Trusted
        );
        assert_eq!(
            check_files(&file, None, "b.example", 22, &key).unwrap(),
            HostCheck::Unknown { other_keys: vec![] }
        );
    }

    #[test]
    fn a_different_key_of_the_same_algorithm_is_a_hard_change() {
        let dir = tempfile::tempdir().unwrap();
        let file = KnownHostsFile::new(dir.path().join("known_hosts"));
        let original = new_key("");
        let impostor = new_key("");
        file.learn("h", 22, &original).unwrap();
        match check_files(&file, None, "h", 22, &impostor).unwrap() {
            HostCheck::Changed { recorded } => {
                assert_eq!(recorded.len(), 1);
                assert_eq!(recorded[0].fingerprint, fingerprint(&original));
                assert_eq!(recorded[0].line, 1);
            }
            other => panic!("expected Changed, got {other:?}"),
        }
    }

    #[test]
    fn a_key_of_another_algorithm_is_unknown_but_reports_what_is_on_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = KnownHostsFile::new(dir.path().join("known_hosts"));
        let recorded = new_key("");
        file.learn("h", 22, &recorded).unwrap();
        match check_files(&file, None, "h", 22, &ecdsa_key()).unwrap() {
            HostCheck::Unknown { other_keys } => {
                assert_eq!(other_keys.len(), 1);
                assert_eq!(other_keys[0].fingerprint, fingerprint(&recorded));
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn non_default_ports_are_tracked_separately() {
        let dir = tempfile::tempdir().unwrap();
        let file = KnownHostsFile::new(dir.path().join("known_hosts"));
        let key = new_key("");
        file.learn("h", 2222, &key).unwrap();
        assert_eq!(check_files(&file, None, "h", 2222, &key).unwrap(), HostCheck::Trusted);
        assert!(matches!(
            check_files(&file, None, "h", 22, &key).unwrap(),
            HostCheck::Unknown { .. }
        ));
        let text = std::fs::read_to_string(file.path()).unwrap();
        assert!(text.starts_with("[h]:2222 ssh-ed25519 "));
    }

    #[test]
    fn learning_the_same_key_twice_does_not_duplicate_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let file = KnownHostsFile::new(dir.path().join("known_hosts"));
        let key = new_key("");
        file.learn("h", 22, &key).unwrap();
        file.learn("h", 22, &key).unwrap();
        assert_eq!(file.load().unwrap().len(), 1);
    }

    #[test]
    fn host_names_are_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let file = KnownHostsFile::new(dir.path().join("known_hosts"));
        let key = new_key("");
        file.learn("Host.Example", 22, &key).unwrap();
        assert_eq!(
            check_files(&file, None, "HOST.example", 22, &key).unwrap(),
            HostCheck::Trusted
        );
    }

    #[test]
    fn wildcard_negation_comma_lists_and_comments_are_understood() {
        let key = new_key("");
        let text = format!(
            "# a comment\n{}\n{}\n",
            line_for("*.corp,!bad.corp,10.0.0.1", &key),
            "garbage line that is not an entry"
        );
        let entries = parse(&text);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].line, 2);
        assert_eq!(check(&entries, "ok.corp", 22, &key), HostCheck::Trusted);
        assert_eq!(check(&entries, "10.0.0.1", 22, &key), HostCheck::Trusted);
        assert!(matches!(
            check(&entries, "bad.corp", 22, &key),
            HostCheck::Unknown { .. }
        ));
    }

    #[test]
    fn hashed_entries_match_with_and_without_a_port() {
        let key = new_key("");
        let make_hash = |name: &str| {
            let salt = [7u8; 20];
            let mut mac = Hmac::<Sha1>::new_from_slice(&salt).unwrap();
            mac.update(name.as_bytes());
            format!(
                "|1|{}|{}",
                BASE64.encode(&salt),
                BASE64.encode(&mac.finalize().into_bytes())
            )
        };
        let text = format!(
            "{}\n{}\n",
            line_for(&make_hash("secret.example"), &key),
            line_for(&make_hash("[secret.example]:2200"), &key)
        );
        let entries = parse(&text);
        assert_eq!(check(&entries, "secret.example", 22, &key), HostCheck::Trusted);
        assert_eq!(check(&entries, "secret.example", 2200, &key), HostCheck::Trusted);
        assert!(matches!(
            check(&entries, "other.example", 22, &key),
            HostCheck::Unknown { .. }
        ));
        let listed = rows(&entries);
        assert!(listed.iter().all(|r| r.hashed && r.hosts.is_empty()));
    }

    #[test]
    fn revoked_keys_are_refused_even_if_trusted_elsewhere() {
        let key = new_key("");
        let text = format!("{}\n@revoked {}\n", line_for("h", &key), line_for("h", &key));
        let entries = parse(&text);
        assert_eq!(check(&entries, "h", 22, &key), HostCheck::Revoked);
    }

    #[test]
    fn cert_authority_lines_never_make_a_key_trusted() {
        let key = new_key("");
        let text = format!("@cert-authority {}\n", line_for("*", &key));
        let entries = parse(&text);
        assert!(matches!(check(&entries, "h", 22, &key), HostCheck::Unknown { .. }));
    }

    #[test]
    fn the_system_file_is_consulted_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let system = dir.path().join("system_known_hosts");
        let key = new_key("");
        std::fs::write(&system, format!("{}\n", line_for("sys.example", &key))).unwrap();
        let app = KnownHostsFile::new(dir.path().join("app"));
        assert_eq!(
            check_files(&app, Some(&system), "sys.example", 22, &key).unwrap(),
            HostCheck::Trusted
        );
        assert!(!app.path().exists());
        let impostor = new_key("");
        assert!(matches!(
            check_files(&app, Some(&system), "sys.example", 22, &impostor).unwrap(),
            HostCheck::Changed { .. }
        ));
    }

    #[test]
    fn a_trusted_app_key_beats_a_stale_system_key() {
        let dir = tempfile::tempdir().unwrap();
        let system = dir.path().join("system_known_hosts");
        let old = new_key("");
        let current = new_key("");
        std::fs::write(&system, format!("{}\n", line_for("h", &old))).unwrap();
        let app = KnownHostsFile::new(dir.path().join("app"));
        app.learn("h", 22, &current).unwrap();
        assert_eq!(
            check_files(&app, Some(&system), "h", 22, &current).unwrap(),
            HostCheck::Trusted
        );
    }

    #[test]
    fn forgetting_a_host_removes_only_its_entries() {
        let dir = tempfile::tempdir().unwrap();
        let file = KnownHostsFile::new(dir.path().join("known_hosts"));
        let a = new_key("");
        let b = new_key("");
        file.learn("a", 22, &a).unwrap();
        file.learn("b", 22, &b).unwrap();
        assert_eq!(file.forget_host("a", 22).unwrap(), 1);
        let left = file.load().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].patterns, vec!["b".to_string()]);
        assert_eq!(file.forget_host("missing", 22).unwrap(), 0);
    }

    #[test]
    fn remove_line_validates_the_target() {
        let dir = tempfile::tempdir().unwrap();
        let file = KnownHostsFile::new(dir.path().join("known_hosts"));
        file.learn("a", 22, &new_key("")).unwrap();
        file.learn("b", 22, &new_key("")).unwrap();
        assert!(file.remove_line(9).is_err());
        file.remove_line(1).unwrap();
        let left = file.load().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].patterns, vec!["b".to_string()]);
    }

    #[test]
    fn recorded_algorithms_lists_matching_entries_once() {
        let key = new_key("");
        let text = format!("{}\n{}\n", line_for("h", &key), line_for("h", &key));
        let entries = parse(&text);
        assert_eq!(recorded_algorithms(&entries, "h", 22), vec![Algorithm::Ed25519]);
        assert!(recorded_algorithms(&entries, "other", 22).is_empty());
    }

    #[test]
    fn comments_on_the_presented_key_do_not_affect_trust() {
        let dir = tempfile::tempdir().unwrap();
        let file = KnownHostsFile::new(dir.path().join("known_hosts"));
        let key = new_key("first-comment");
        file.learn("h", 22, &key).unwrap();
        let mut renamed = key.clone();
        renamed.set_comment("another");
        assert_eq!(check_files(&file, None, "h", 22, &renamed).unwrap(), HostCheck::Trusted);
    }
}
