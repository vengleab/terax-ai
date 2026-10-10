//! SSH key management for `~/.ssh`.
//!
//! Everything that leaves this module is public metadata. Private key bytes are only
//! read to load or re-encrypt a key and are never returned.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh::keys::key::safe_rng;
use russh::keys::ssh_key::{Algorithm, EcdsaCurve, LineEnding, PrivateKey, PublicKey};
use russh::keys::{decode_secret_key, Error as KeyError};
use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, Result, SshError};
use crate::fsutil::atomic_write;
use crate::known_hosts::{algorithm_name, fingerprint};
use crate::secret::Secret;

const MAX_KEY_FILE_BYTES: u64 = 256 * 1024;
const RESERVED_NAMES: &[&str] = &[
    "config",
    "known_hosts",
    "known_hosts.old",
    "authorized_keys",
    "authorized_keys2",
    "environment",
    "rc",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub name: String,
    pub path: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub comment: String,
    pub encrypted: bool,
    pub has_public_file: bool,
    pub public_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyAlgorithm {
    Ed25519,
    EcdsaP256,
    EcdsaP384,
    Rsa,
}

impl KeyAlgorithm {
    fn to_algorithm(self) -> Algorithm {
        match self {
            Self::Ed25519 => Algorithm::Ed25519,
            Self::EcdsaP256 => Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
            Self::EcdsaP384 => Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP384,
            },
            Self::Rsa => Algorithm::Rsa { hash: None },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSpec {
    pub name: String,
    pub algorithm: KeyAlgorithm,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub passphrase: Option<Secret>,
}

pub fn default_ssh_dir() -> Result<PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".ssh"))
        .ok_or_else(|| SshError::not_found("home directory could not be determined"))
}

pub fn validate_key_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !ok {
        return Err(SshError::invalid(
            "key name may contain letters, digits and . _ - and must not start with a dot or dash",
        ));
    }
    if name.ends_with(".pub") || RESERVED_NAMES.contains(&name) {
        return Err(SshError::invalid("that file name is reserved"));
    }
    Ok(())
}

fn validate_comment(comment: &str) -> Result<()> {
    if comment.chars().count() > 128 || comment.chars().any(|c| c.is_control()) {
        return Err(SshError::invalid("comment must be at most 128 printable characters"));
    }
    Ok(())
}

fn public_path(private: &Path) -> PathBuf {
    let mut name = private.as_os_str().to_os_string();
    name.push(".pub");
    PathBuf::from(name)
}

fn read_key_file(path: &Path) -> Result<String> {
    let meta = fs::metadata(path)?;
    if !meta.is_file() {
        return Err(SshError::invalid("not a regular file"));
    }
    if meta.len() > MAX_KEY_FILE_BYTES {
        return Err(SshError::invalid("file is too large to be a key"));
    }
    Ok(fs::read_to_string(path)?)
}

fn looks_like_key(text: &str) -> bool {
    let head = text.trim_start();
    head.starts_with("-----BEGIN") || head.starts_with("PuTTY-User-Key-File-")
}

fn looks_encrypted(text: &str) -> bool {
    match PrivateKey::from_openssh(text) {
        Ok(key) => key.is_encrypted(),
        Err(_) => text.contains("ENCRYPTED") || text.contains("Encryption: aes"),
    }
}

struct Parsed {
    public: Option<PublicKey>,
    encrypted: bool,
}

fn parse_key_text(text: &str) -> Option<Parsed> {
    if let Ok(key) = PrivateKey::from_openssh(text) {
        return Some(Parsed {
            public: Some(key.public_key().clone()),
            encrypted: key.is_encrypted(),
        });
    }
    match decode_secret_key(text, None) {
        Ok(key) => Some(Parsed {
            public: Some(key.public_key().clone()),
            encrypted: false,
        }),
        Err(KeyError::KeyIsEncrypted) => Some(Parsed {
            public: None,
            encrypted: true,
        }),
        Err(_) if looks_key_and_encrypted(text) => Some(Parsed {
            public: None,
            encrypted: true,
        }),
        Err(_) => None,
    }
}

fn looks_key_and_encrypted(text: &str) -> bool {
    looks_like_key(text) && looks_encrypted(text)
}

pub fn inspect(path: &Path) -> Result<KeyInfo> {
    let text = read_key_file(path)?;
    if !looks_like_key(&text) {
        return Err(SshError::invalid("not a private key file"));
    }
    let parsed = parse_key_text(&text).ok_or_else(|| SshError::invalid("unsupported or corrupt key"))?;
    let pub_path = public_path(path);
    let pub_from_file = fs::read_to_string(&pub_path)
        .ok()
        .and_then(|t| PublicKey::from_openssh(t.trim()).ok());
    // An encrypted key hides its comment, so the .pub file wins whenever it describes the same key.
    let public = match (parsed.public, pub_from_file) {
        (Some(parsed), Some(file)) if parsed.key_data() == file.key_data() => Some(file),
        (Some(parsed), _) => Some(parsed),
        (None, file) => file,
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(KeyInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        algorithm: public.as_ref().map(algorithm_name).unwrap_or_default(),
        fingerprint: public.as_ref().map(fingerprint).unwrap_or_default(),
        comment: public
            .as_ref()
            .map(|p| p.comment().to_string())
            .unwrap_or_default(),
        encrypted: parsed.encrypted,
        has_public_file: pub_path.is_file(),
        public_key: public.as_ref().and_then(|p| p.to_openssh().ok()),
    })
}

/// Lists private keys directly inside `dir`. Files that are not keys are skipped silently.
pub fn list_keys(dir: &Path) -> Result<Vec<KeyInfo>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    let mut keys = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".pub") || RESERVED_NAMES.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Ok(info) = inspect(&path) {
            keys.push(info);
        }
    }
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(keys)
}

fn ensure_dir(dir: &Path) -> Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8], private: bool) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if private { 0o600 } else { 0o644 });
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut file = options.open(path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            SshError::exists(format!("{} already exists", path.display()))
        } else {
            err.into()
        }
    })?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    if let Err(err) = written {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(err.into());
    }
    Ok(())
}

fn encode_private(key: &PrivateKey) -> Result<zeroize::Zeroizing<String>> {
    key.to_openssh(LineEnding::LF)
        .map_err(|err| SshError::protocol(format!("could not encode key: {err}")))
}

fn encrypt_if_needed(key: PrivateKey, passphrase: Option<&Secret>) -> Result<PrivateKey> {
    match passphrase.filter(|p| !p.is_empty()) {
        Some(passphrase) => {
            let mut rng = safe_rng();
            key.encrypt(&mut rng, passphrase.expose().as_bytes())
                .map_err(|err| SshError::protocol(format!("could not encrypt key: {err}")))
        }
        None => Ok(key),
    }
}

/// Creates a new key pair in `dir`. An existing file is never overwritten.
pub fn generate(dir: &Path, spec: &GenerateSpec) -> Result<KeyInfo> {
    validate_key_name(&spec.name)?;
    validate_comment(&spec.comment)?;
    ensure_dir(dir)?;
    let private_path = dir.join(&spec.name);
    let pub_path = public_path(&private_path);
    if private_path.exists() || pub_path.exists() {
        return Err(SshError::exists(format!("{} already exists", spec.name)));
    }

    let mut rng = safe_rng();
    let mut key = PrivateKey::random(&mut rng, spec.algorithm.to_algorithm())
        .map_err(|err| SshError::protocol(format!("could not generate key: {err}")))?;
    key.set_comment(spec.comment.as_str());
    let public_line = key
        .public_key()
        .to_openssh()
        .map_err(|err| SshError::protocol(format!("could not encode public key: {err}")))?;

    let key = encrypt_if_needed(key, spec.passphrase.as_ref())?;
    let encoded = encode_private(&key)?;
    write_new(&private_path, encoded.as_bytes(), true)?;
    if let Err(err) = write_new(&pub_path, format!("{public_line}\n").as_bytes(), false) {
        let _ = fs::remove_file(&private_path);
        return Err(err);
    }
    inspect(&private_path)
}

/// Copies a private key from `source` into `dir` under `name`, together with its `.pub` when present.
pub fn import(dir: &Path, source: &Path, name: &str) -> Result<KeyInfo> {
    validate_key_name(name)?;
    let text = read_key_file(source)?;
    if !looks_like_key(&text) || parse_key_text(&text).is_none() {
        return Err(SshError::invalid("the selected file is not a supported private key"));
    }
    ensure_dir(dir)?;
    let target = dir.join(name);
    let target_pub = public_path(&target);
    if target_pub.exists() {
        return Err(SshError::exists(format!("{name}.pub already exists")));
    }
    write_new(&target, text.as_bytes(), true)?;

    let source_pub = public_path(source);
    let pub_text = fs::read_to_string(&source_pub)
        .ok()
        .filter(|t| PublicKey::from_openssh(t.trim()).is_ok())
        .or_else(|| {
            parse_key_text(&text)
                .and_then(|p| p.public)
                .and_then(|p| p.to_openssh().ok())
                .map(|l| format!("{l}\n"))
        });
    if let Some(pub_text) = pub_text {
        if let Err(err) = write_new(&target_pub, pub_text.as_bytes(), false) {
            let _ = fs::remove_file(&target);
            return Err(err);
        }
    }
    inspect(&target)
}

/// Deletes a key and its `.pub` from `dir`. Only plain file names inside `dir` are accepted.
pub fn delete(dir: &Path, name: &str) -> Result<()> {
    validate_key_name(name)?;
    let private_path = dir.join(name);
    if !private_path.is_file() {
        return Err(SshError::not_found("key does not exist"));
    }
    fs::remove_file(&private_path)?;
    let pub_path = public_path(&private_path);
    if pub_path.is_file() {
        fs::remove_file(pub_path)?;
    }
    Ok(())
}

/// Loads a private key for authentication. Distinguishes a missing passphrase from a wrong one.
pub fn load_private(path: &Path, passphrase: Option<&Secret>) -> Result<Arc<PrivateKey>> {
    let text = read_key_file(path)?;
    let passphrase = passphrase.filter(|p| !p.is_empty()).map(|p| p.expose());
    match decode_secret_key(&text, passphrase) {
        Ok(key) => Ok(Arc::new(key)),
        Err(KeyError::KeyIsEncrypted) => Err(SshError::new(
            ErrorCode::PassphraseRequired,
            "this key is protected by a passphrase",
        )),
        Err(err) if passphrase.is_some() && looks_encrypted(&text) => {
            let _ = err;
            Err(SshError::new(
                ErrorCode::PassphraseInvalid,
                "the passphrase is incorrect",
            ))
        }
        Err(err) => Err(SshError::invalid(format!("could not read key: {err}"))),
    }
}

/// Sets, changes or removes (`new` = None) the passphrase. The key is rewritten in OpenSSH format.
pub fn change_passphrase(path: &Path, old: Option<&Secret>, new: Option<&Secret>) -> Result<KeyInfo> {
    let key = load_private(path, old)?;
    let plain = PrivateKey::new(key.key_data().clone(), key.comment().clone())
        .map_err(|err| SshError::protocol(format!("could not rebuild key: {err}")))?;
    let rekeyed = encrypt_if_needed(plain, new)?;
    let encoded = encode_private(&rekeyed)?;
    atomic_write(path, encoded.as_bytes(), true)?;
    inspect(path)
}

/// Appends `public_key_line` to the text of an `authorized_keys` file. Returns `None` when the
/// same key is already listed, so deploying twice never duplicates it.
pub fn authorized_keys_with(existing: &str, public_key_line: &str) -> Result<Option<String>> {
    let new_key = PublicKey::from_openssh(public_key_line.trim())
        .map_err(|err| SshError::invalid(format!("not a valid public key: {err}")))?;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        for index in 0..tokens.len().saturating_sub(1) {
            let looks_like_type = ["ssh-", "ecdsa-", "sk-"].iter().any(|p| tokens[index].starts_with(p));
            if !looks_like_type {
                continue;
            }
            if let Ok(found) = PublicKey::from_openssh(&format!("{} {}", tokens[index], tokens[index + 1])) {
                if found.key_data() == new_key.key_data() {
                    return Ok(None);
                }
                break;
            }
        }
    }
    let mut out = existing.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(public_key_line.trim());
    out.push('\n');
    Ok(Some(out))
}

pub fn read_public_key(path: &Path) -> Result<String> {
    inspect(path)?
        .public_key
        .ok_or_else(|| SshError::not_found("no public key is available for this key"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(name: &str, passphrase: Option<&str>) -> GenerateSpec {
        GenerateSpec {
            name: name.to_string(),
            algorithm: KeyAlgorithm::Ed25519,
            comment: "me@test".to_string(),
            passphrase: passphrase.map(Secret::new),
        }
    }

    #[test]
    fn generates_a_key_pair_with_private_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let info = generate(dir.path(), &spec("id_test", None)).unwrap();
        assert_eq!(info.name, "id_test");
        assert_eq!(info.algorithm, "ssh-ed25519");
        assert!(info.fingerprint.starts_with("SHA256:"));
        assert_eq!(info.comment, "me@test");
        assert!(!info.encrypted);
        assert!(info.has_public_file);
        assert!(info.public_key.as_deref().unwrap().starts_with("ssh-ed25519 "));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join("id_test")).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0);
        }
        let pub_text = fs::read_to_string(dir.path().join("id_test.pub")).unwrap();
        assert_eq!(pub_text.trim(), info.public_key.unwrap());
    }

    #[test]
    fn never_overwrites_an_existing_key() {
        let dir = tempfile::tempdir().unwrap();
        generate(dir.path(), &spec("id_test", None)).unwrap();
        let before = fs::read(dir.path().join("id_test")).unwrap();
        let err = generate(dir.path(), &spec("id_test", None)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Exists);
        assert_eq!(fs::read(dir.path().join("id_test")).unwrap(), before);
    }

    #[test]
    fn key_names_cannot_escape_the_directory_or_hit_reserved_files() {
        for bad in ["", "../x", "a/b", "a\\b", ".hidden", "-dash", "config", "known_hosts", "x.pub", "authorized_keys", "a b"] {
            assert!(validate_key_name(bad).is_err(), "{bad:?} should be rejected");
        }
        validate_key_name("id_ed25519-work.2024").unwrap();
    }

    #[test]
    fn passphrase_protected_keys_report_missing_and_wrong_passphrases() {
        let dir = tempfile::tempdir().unwrap();
        let info = generate(dir.path(), &spec("id_pw", Some("correct horse"))).unwrap();
        assert!(info.encrypted);
        assert!(info.fingerprint.starts_with("SHA256:"));
        let path = dir.path().join("id_pw");

        let missing = load_private(&path, None).unwrap_err();
        assert_eq!(missing.code, ErrorCode::PassphraseRequired);
        let wrong = load_private(&path, Some(&Secret::new("nope"))).unwrap_err();
        assert_eq!(wrong.code, ErrorCode::PassphraseInvalid);
        let key = load_private(&path, Some(&Secret::new("correct horse"))).unwrap();
        assert_eq!(fingerprint(key.public_key()), info.fingerprint);
    }

    #[test]
    fn the_passphrase_can_be_changed_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let original = generate(dir.path(), &spec("id_cp", None)).unwrap();
        let path = dir.path().join("id_cp");

        let added = change_passphrase(&path, None, Some(&Secret::new("one"))).unwrap();
        assert!(added.encrypted);
        assert_eq!(added.fingerprint, original.fingerprint);
        assert_eq!(added.comment, "me@test");

        let changed = change_passphrase(&path, Some(&Secret::new("one")), Some(&Secret::new("two"))).unwrap();
        assert!(changed.encrypted);
        assert!(load_private(&path, Some(&Secret::new("one"))).is_err());
        load_private(&path, Some(&Secret::new("two"))).unwrap();

        let removed = change_passphrase(&path, Some(&Secret::new("two")), None).unwrap();
        assert!(!removed.encrypted);
        assert_eq!(removed.fingerprint, original.fingerprint);
        load_private(&path, None).unwrap();
    }

    #[test]
    fn a_wrong_old_passphrase_leaves_the_key_untouched() {
        let dir = tempfile::tempdir().unwrap();
        generate(dir.path(), &spec("id_keep", Some("right"))).unwrap();
        let path = dir.path().join("id_keep");
        let before = fs::read(&path).unwrap();
        assert!(change_passphrase(&path, Some(&Secret::new("wrong")), None).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn listing_skips_everything_that_is_not_a_private_key() {
        let dir = tempfile::tempdir().unwrap();
        generate(dir.path(), &spec("id_b", None)).unwrap();
        generate(dir.path(), &spec("id_a", Some("pw"))).unwrap();
        fs::write(dir.path().join("config"), "Host x\n").unwrap();
        fs::write(dir.path().join("known_hosts"), "x ssh-ed25519 AAAA\n").unwrap();
        fs::write(dir.path().join("notes.txt"), "hello").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let keys = list_keys(dir.path()).unwrap();
        let names: Vec<_> = keys.iter().map(|k| k.name.as_str()).collect();
        assert_eq!(names, vec!["id_a", "id_b"]);
        assert!(keys[0].encrypted && !keys[1].encrypted);
    }

    #[test]
    fn listing_a_missing_directory_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_keys(&dir.path().join("nope")).unwrap().is_empty());
    }

    #[test]
    fn generates_ecdsa_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = spec("id_ec", None);
        s.algorithm = KeyAlgorithm::EcdsaP256;
        let info = generate(dir.path(), &s).unwrap();
        assert_eq!(info.algorithm, "ecdsa-sha2-nistp256");
        s.name = "id_ec384".to_string();
        s.algorithm = KeyAlgorithm::EcdsaP384;
        assert_eq!(generate(dir.path(), &s).unwrap().algorithm, "ecdsa-sha2-nistp384");
    }

    #[test]
    fn import_copies_the_key_and_its_public_half() {
        let src_dir = tempfile::tempdir().unwrap();
        let dst_dir = tempfile::tempdir().unwrap();
        let original = generate(src_dir.path(), &spec("source_key", None)).unwrap();
        let imported = import(dst_dir.path(), &src_dir.path().join("source_key"), "work_key").unwrap();
        assert_eq!(imported.name, "work_key");
        assert_eq!(imported.fingerprint, original.fingerprint);
        assert!(imported.has_public_file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dst_dir.path().join("work_key")).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0);
        }
        assert_eq!(import(dst_dir.path(), &src_dir.path().join("source_key"), "work_key").unwrap_err().code, ErrorCode::Exists);
    }

    #[test]
    fn import_rejects_files_that_are_not_keys() {
        let dir = tempfile::tempdir().unwrap();
        let junk = dir.path().join("junk");
        fs::write(&junk, "just text").unwrap();
        assert!(import(dir.path(), &junk, "k").is_err());
        let fake = dir.path().join("fake");
        fs::write(&fake, "-----BEGIN OPENSSH PRIVATE KEY-----\nnotbase64!!\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
        assert!(import(dir.path(), &fake, "k2").is_err());
        assert!(!dir.path().join("k").exists());
    }

    #[test]
    fn delete_removes_both_files_and_refuses_paths() {
        let dir = tempfile::tempdir().unwrap();
        generate(dir.path(), &spec("id_gone", None)).unwrap();
        assert!(delete(dir.path(), "../id_gone").is_err());
        delete(dir.path(), "id_gone").unwrap();
        assert!(!dir.path().join("id_gone").exists());
        assert!(!dir.path().join("id_gone.pub").exists());
        assert_eq!(delete(dir.path(), "id_gone").unwrap_err().code, ErrorCode::NotFound);
    }

    #[test]
    fn read_public_key_returns_an_authorized_keys_line() {
        let dir = tempfile::tempdir().unwrap();
        let info = generate(dir.path(), &spec("id_pub", Some("pw"))).unwrap();
        let line = read_public_key(&dir.path().join("id_pub")).unwrap();
        assert_eq!(Some(line.clone()), info.public_key);
        assert!(line.ends_with("me@test"));
    }

    #[test]
    fn authorized_keys_gain_a_key_once() {
        let dir = tempfile::tempdir().unwrap();
        let info = generate(dir.path(), &spec("id_dep", None)).unwrap();
        let line = info.public_key.unwrap();

        let first = authorized_keys_with("", &line).unwrap().unwrap();
        assert_eq!(first, format!("{line}\n"));
        assert_eq!(authorized_keys_with(&first, &line).unwrap(), None);

        let with_other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ other@host";
        let appended = authorized_keys_with(with_other, &line).unwrap().unwrap();
        assert!(appended.starts_with(with_other));
        assert!(appended.contains(&format!("\n{line}\n")));
    }

    #[test]
    fn authorized_keys_detection_sees_through_options_and_comments() {
        let dir = tempfile::tempdir().unwrap();
        let info = generate(dir.path(), &spec("id_opt", None)).unwrap();
        let line = info.public_key.unwrap();
        let existing = format!("# managed by hand\n\ncommand=\"/bin/true\",no-pty {line}\n");
        assert_eq!(authorized_keys_with(&existing, &line).unwrap(), None);
        assert!(authorized_keys_with("garbage", "not a key").is_err());
    }

    #[test]
    fn comments_are_validated() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = spec("id_c", None);
        s.comment = "bad\ncomment".to_string();
        assert!(generate(dir.path(), &s).is_err());
        assert!(!dir.path().join("id_c").exists());
    }
}
