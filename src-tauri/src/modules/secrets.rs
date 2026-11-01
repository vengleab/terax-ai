//! Secret storage with platform-appropriate backends.
//!
//! - macOS: one macOS Keychain item (`VAULT_SERVICE`/`VAULT_ACCOUNT`) holding a
//!   JSON map of every secret. Keychain access control is per item, so storing
//!   one item per key made macOS ask for the login password once per key
//!   (first launch, opening the Models tab, ...). A single item is read at
//!   most once per launch and then served from memory. Items written by older
//!   versions (one keychain item per key) are migrated into the vault the
//!   first time they are requested.
//! - Windows: Credential Manager (via `keyring` crate), one entry per key. It
//!   never prompts, and its per-credential size cap rules out a shared blob.
//! - Linux: a file in the app's local data dir, mode 0600. The default
//!   `keyring` backend on Linux is the Secret Service over D-Bus, which
//!   silently fails on systems without gnome-keyring/kwallet (and on the
//!   "login" collection not being created). For an open-source desktop
//!   app shipped via AppImage/deb/rpm, we cannot assume a keyring daemon
//!   exists. The file backend is the same approach Brave/Chromium fall
//!   back to in that scenario; user-only file permissions provide the
//!   isolation the secret-service collection would have otherwise.
//!
//! The frontend talks to `secrets_get`, `secrets_set`, `secrets_delete`,
//! and `secrets_get_all` — no platform branching in JS.
//!
//! All commands take `&AppHandle` so we can resolve the data directory
//! once via Tauri's path API.

use std::sync::Mutex;

use tauri::AppHandle;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::fs;
#[cfg(target_os = "linux")]
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use tauri::Manager;

#[cfg(target_os = "macos")]
const VAULT_SERVICE: &str = "terax-ai";
#[cfg(target_os = "macos")]
const VAULT_ACCOUNT: &str = "vault";

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[derive(Default)]
struct Vault {
    map: Option<HashMap<String, String>>,
    /// Accounts already looked up as pre-vault keychain items, so a missing key
    /// does not trigger another keychain read on every request.
    #[cfg(target_os = "macos")]
    legacy_checked: std::collections::HashSet<String>,
}

#[derive(Default)]
pub struct SecretsState {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    vault: Mutex<Vault>,
    #[cfg(target_os = "windows")]
    _phantom: Mutex<()>,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn key(service: &str, account: &str) -> String {
    format!("{}::{}", service, account)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn parse_vault(raw: &str) -> Result<HashMap<String, String>, String> {
    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(raw).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

#[cfg(target_os = "linux")]
pub(crate) fn read_store_at(path: &std::path::Path) -> Result<HashMap<String, String>, String> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    parse_vault(&fs::read_to_string(path).map_err(|e| e.to_string())?)
}

#[cfg(target_os = "linux")]
pub(crate) fn write_store_at(
    path: &std::path::Path,
    map: &HashMap<String, String>,
) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(map).map_err(|e| e.to_string())?;

    // 0600: only the owning user can read or write the secrets file.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn load_map(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    read_store_at(&store_path(app)?)
}

#[cfg(target_os = "linux")]
fn persist_map(app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    write_store_at(&store_path(app)?, map)
}

#[cfg(target_os = "macos")]
fn vault_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(VAULT_SERVICE, VAULT_ACCOUNT).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn load_map(_app: &AppHandle) -> Result<HashMap<String, String>, String> {
    match vault_entry()?.get_password() {
        Ok(raw) => parse_vault(&raw),
        Err(keyring::Error::NoEntry) => Ok(HashMap::new()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn persist_map(_app: &AppHandle, map: &HashMap<String, String>) -> Result<(), String> {
    let raw = serde_json::to_string(map).map_err(|e| e.to_string())?;
    vault_entry()?.set_password(&raw).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn loaded<'a>(app: &AppHandle, vault: &'a mut Vault) -> Result<&'a mut HashMap<String, String>, String> {
    if vault.map.is_none() {
        vault.map = Some(load_map(app)?);
    }
    Ok(vault.map.as_mut().expect("map initialized above"))
}

/// Moves a pre-vault keychain item (one item per key) into the vault.
#[cfg(target_os = "macos")]
fn migrate_legacy(
    app: &AppHandle,
    vault: &mut Vault,
    service: &str,
    account: &str,
) -> Result<Option<String>, String> {
    let k = key(service, account);
    if vault.legacy_checked.contains(&k) {
        return Ok(None);
    }
    let legacy = keyring::Entry::new(service, account).map_err(|e| e.to_string())?;
    let value = match legacy.get_password() {
        Ok(v) => v,
        Err(keyring::Error::NoEntry) => {
            vault.legacy_checked.insert(k);
            return Ok(None);
        }
        // Denied or locked: leave it unchecked so a later request can retry.
        Err(_) => return Ok(None),
    };
    let map = loaded(app, vault)?;
    map.insert(k.clone(), value.clone());
    // Only drop the old item once the vault holds the value.
    if persist_map(app, map).is_ok() {
        let _ = legacy.delete_credential();
        vault.legacy_checked.insert(k);
    }
    Ok(Some(value))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn lookup(
    app: &AppHandle,
    vault: &mut Vault,
    service: &str,
    account: &str,
) -> Result<Option<String>, String> {
    if let Some(v) = loaded(app, vault)?.get(&key(service, account)) {
        return Ok(Some(v.clone()));
    }
    #[cfg(target_os = "macos")]
    {
        migrate_legacy(app, vault, service, account)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[cfg(target_os = "windows")]
fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn secrets_get(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
        lookup(&app, &mut vault, &service, &account)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[tauri::command]
pub async fn secrets_set(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
    password: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
        let map = loaded(&app, &mut vault)?;
        map.insert(key(&service, &account), password);
        persist_map(&app, map)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        e.set_password(&password).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn secrets_delete(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    account: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
        let k = key(&service, &account);
        let map = loaded(&app, &mut vault)?;
        map.remove(&k);
        persist_map(&app, map)?;
        #[cfg(target_os = "macos")]
        {
            if vault.legacy_checked.insert(k) {
                // A surviving pre-vault copy would be migrated back on the next launch.
                if let Ok(legacy) = keyring::Entry::new(&service, &account) {
                    let _ = legacy.delete_credential();
                }
            }
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (app, state);
        let e = entry(&service, &account)?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use tempfile::TempDir;

    #[test]
    fn key_format_is_service_double_colon_account() {
        assert_eq!(key("openai", "alice"), "openai::alice");
        assert_eq!(key("", ""), "::");
    }

    #[test]
    fn read_store_at_missing_path_is_empty() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nope.json");
        let map = read_store_at(&p).unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        let mut m = HashMap::new();
        m.insert(key("svc", "alice"), "p1".into());
        m.insert(key("svc", "bob"), "p2".into());

        write_store_at(&p, &m).unwrap();
        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, m);
    }

    #[test]
    fn write_uses_mode_0600() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let mode = fs::metadata(&p).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600, "secrets file must be user-only readable");
    }

    #[test]
    fn write_does_not_leave_tmp_file_on_success() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        write_store_at(&p, &HashMap::new()).unwrap();

        let tmp_path = p.with_extension("json.tmp");
        assert!(!tmp_path.exists(), "tmp file must be renamed away on success");
    }

    #[test]
    fn write_overwrites_existing_atomically() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");

        let mut first = HashMap::new();
        first.insert("a".into(), "1".into());
        write_store_at(&p, &first).unwrap();

        let mut second = HashMap::new();
        second.insert("b".into(), "2".into());
        write_store_at(&p, &second).unwrap();

        let loaded = read_store_at(&p).unwrap();
        assert_eq!(loaded, second);
        assert!(!loaded.contains_key("a"));
    }

    #[test]
    fn parse_vault_treats_blank_as_empty() {
        assert!(parse_vault("").unwrap().is_empty());
        assert!(parse_vault("  \n").unwrap().is_empty());
    }

    #[test]
    fn parse_vault_roundtrips_and_rejects_garbage() {
        let mut m = HashMap::new();
        m.insert(key("svc", "a"), "1".to_string());
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(parse_vault(&json).unwrap(), m);
        assert!(parse_vault("not json").is_err());
    }

    #[test]
    fn read_store_at_garbage_file_errors() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("secrets.json");
        fs::write(&p, b"not json").unwrap();
        assert!(read_store_at(&p).is_err());
    }
}

/// Batch read — single IPC roundtrip for the cold-boot fan-out.
#[tauri::command]
pub async fn secrets_get_all(
    app: AppHandle,
    state: tauri::State<'_, SecretsState>,
    service: String,
    accounts: Vec<String>,
) -> Result<Vec<Option<String>>, String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mut vault = state.vault.lock().map_err(|e| e.to_string())?;
        accounts
            .iter()
            .map(|a| lookup(&app, &mut vault, &service, a))
            .collect()
    }
    #[cfg(target_os = "windows")]
    {
        let _ = (app, state);
        Ok(accounts
            .into_iter()
            .map(|a| {
                keyring::Entry::new(&service, &a)
                    .ok()
                    .and_then(|e| e.get_password().ok())
            })
            .collect())
    }
}
