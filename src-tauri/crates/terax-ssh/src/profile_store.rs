use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Result, SshError};
use crate::fsutil::{atomic_write, random_hex};
use crate::profile::SshProfile;

const FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct FileFormat {
    version: u32,
    profiles: Vec<SshProfile>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added: Vec<String>,
    pub skipped: Vec<String>,
}

pub struct ProfileStore {
    path: PathBuf,
    profiles: Vec<SshProfile>,
}

impl ProfileStore {
    /// A missing file is an empty store. A corrupt file is an error so it is never overwritten silently.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let profiles = match std::fs::read(&path) {
            Ok(bytes) => {
                let parsed: FileFormat = serde_json::from_slice(&bytes).map_err(|err| {
                    SshError::invalid(format!("{} is not valid: {err}", path.display()))
                })?;
                if parsed.version > FORMAT_VERSION {
                    return Err(SshError::invalid(format!(
                        "{} was written by a newer version",
                        path.display()
                    )));
                }
                parsed.profiles
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => return Err(err.into()),
        };
        Ok(Self { path, profiles })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn list(&self) -> &[SshProfile] {
        &self.profiles
    }

    pub fn get(&self, id: &str) -> Option<&SshProfile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    fn persist(&self) -> Result<()> {
        let file = FileFormat {
            version: FORMAT_VERSION,
            profiles: self.profiles.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|err| SshError::io(format!("could not encode profiles: {err}")))?;
        atomic_write(&self.path, &bytes, true)
    }

    fn check_jump(&self, profile: &SshProfile) -> Result<()> {
        let Some(jump_id) = &profile.jump_host else {
            return Ok(());
        };
        let jump = self
            .get(jump_id)
            .ok_or_else(|| SshError::invalid("the jump host profile does not exist"))?;
        if jump.jump_host.is_some() {
            return Err(SshError::invalid(
                "a jump host cannot itself use another jump host",
            ));
        }
        if self
            .profiles
            .iter()
            .any(|p| p.jump_host.as_deref() == Some(&profile.id) && p.id != profile.id)
        {
            return Err(SshError::invalid(
                "this profile is used as a jump host and cannot use one itself",
            ));
        }
        Ok(())
    }

    fn fresh_id(&self) -> Result<String> {
        for _ in 0..8 {
            let id = random_hex(8)?;
            if self.get(&id).is_none() {
                return Ok(id);
            }
        }
        Err(SshError::io("could not allocate a profile id"))
    }

    /// Inserts a new profile (empty id) or replaces the one with the same id.
    pub fn save(&mut self, profile: SshProfile) -> Result<SshProfile> {
        let mut profile = profile.normalized();
        let is_new = profile.id.is_empty();
        if is_new {
            profile.id = self.fresh_id()?;
        }
        profile.validate()?;
        if !is_new && self.get(&profile.id).is_none() {
            return Err(SshError::not_found("profile does not exist"));
        }
        self.check_jump(&profile)?;
        let previous = self.profiles.clone();
        match self.profiles.iter_mut().find(|p| p.id == profile.id) {
            Some(slot) => *slot = profile.clone(),
            None => self.profiles.push(profile.clone()),
        }
        if let Err(err) = self.persist() {
            self.profiles = previous;
            return Err(err);
        }
        Ok(profile)
    }

    /// Removes a profile. Profiles that used it as a jump host fall back to a direct connection.
    pub fn remove(&mut self, id: &str) -> Result<()> {
        if self.get(id).is_none() {
            return Err(SshError::not_found("profile does not exist"));
        }
        let previous = self.profiles.clone();
        self.profiles.retain(|p| p.id != id);
        for p in &mut self.profiles {
            if p.jump_host.as_deref() == Some(id) {
                p.jump_host = None;
            }
        }
        if let Err(err) = self.persist() {
            self.profiles = previous;
            return Err(err);
        }
        Ok(())
    }

    /// Adds profiles whose name is not taken yet. Existing profiles are never modified.
    pub fn import(&mut self, incoming: Vec<SshProfile>) -> Result<ImportSummary> {
        let mut summary = ImportSummary::default();
        let previous = self.profiles.clone();
        for mut profile in incoming {
            profile.id = String::new();
            let profile = profile.normalized();
            if self.profiles.iter().any(|p| p.name == profile.name) {
                summary.skipped.push(profile.name);
                continue;
            }
            let mut profile = profile;
            profile.id = self.fresh_id()?;
            if let Err(err) = profile.validate() {
                summary.skipped.push(format!("{} ({})", profile.name, err.message));
                continue;
            }
            summary.added.push(profile.name.clone());
            self.profiles.push(profile);
        }
        if let Err(err) = self.persist() {
            self.profiles = previous;
            return Err(err);
        }
        Ok(summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::fixtures::profile;

    fn store() -> (tempfile::TempDir, ProfileStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = ProfileStore::open(dir.path().join("profiles.json")).unwrap();
        (dir, store)
    }

    #[test]
    fn missing_file_opens_empty() {
        let (_dir, store) = store();
        assert!(store.list().is_empty());
    }

    #[test]
    fn save_assigns_ids_and_survives_a_reopen() {
        let (dir, mut store) = store();
        let saved = store.save(profile("", "Prod")).unwrap();
        assert_eq!(saved.id.len(), 16);
        let reopened = ProfileStore::open(dir.path().join("profiles.json")).unwrap();
        assert_eq!(reopened.list(), &[saved]);
    }

    #[test]
    fn save_updates_in_place_and_rejects_unknown_ids() {
        let (_dir, mut store) = store();
        let mut saved = store.save(profile("", "Prod")).unwrap();
        saved.name = "Prod 2".to_string();
        store.save(saved.clone()).unwrap();
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.get(&saved.id).unwrap().name, "Prod 2");
        let ghost = profile("00000000", "ghost");
        assert!(store.save(ghost).is_err());
    }

    #[test]
    fn invalid_profiles_are_not_persisted() {
        let (dir, mut store) = store();
        let mut bad = profile("", "x");
        bad.host = "-oProxyCommand=x".to_string();
        assert!(store.save(bad).is_err());
        assert!(store.list().is_empty());
        assert!(!dir.path().join("profiles.json").exists());
    }

    #[test]
    fn jump_host_must_exist_and_cannot_chain() {
        let (_dir, mut store) = store();
        let bastion = store.save(profile("", "bastion")).unwrap();
        let mut inner = profile("", "inner");
        inner.jump_host = Some("deadbeefdeadbeef".to_string());
        assert!(store.save(inner.clone()).is_err());
        inner.jump_host = Some(bastion.id.clone());
        let inner = store.save(inner).unwrap();

        let mut chained = bastion.clone();
        chained.jump_host = Some(inner.id.clone());
        assert!(store.save(chained).is_err());

        let mut third = profile("", "third");
        third.jump_host = Some(inner.id.clone());
        assert!(store.save(third).is_err());
    }

    #[test]
    fn removing_a_jump_host_clears_references() {
        let (_dir, mut store) = store();
        let bastion = store.save(profile("", "bastion")).unwrap();
        let mut inner = profile("", "inner");
        inner.jump_host = Some(bastion.id.clone());
        let inner = store.save(inner).unwrap();
        store.remove(&bastion.id).unwrap();
        assert_eq!(store.get(&inner.id).unwrap().jump_host, None);
        assert!(store.remove(&bastion.id).is_err());
    }

    #[test]
    fn corrupt_files_are_reported_and_left_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(ProfileStore::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ not json");
    }

    #[test]
    fn files_from_a_newer_version_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profiles.json");
        std::fs::write(&path, br#"{"version":99,"profiles":[]}"#).unwrap();
        assert!(ProfileStore::open(&path).is_err());
    }

    #[test]
    fn import_skips_existing_names_and_invalid_entries() {
        let (_dir, mut store) = store();
        store.save(profile("", "web")).unwrap();
        let mut invalid = profile("", "weird");
        invalid.host = "bad host".to_string();
        let summary = store
            .import(vec![profile("", "web"), profile("", "db"), invalid])
            .unwrap();
        assert_eq!(summary.added, vec!["db".to_string()]);
        assert_eq!(summary.skipped.len(), 2);
        assert_eq!(store.list().len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn the_profile_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, mut store) = store();
        store.save(profile("", "x")).unwrap();
        let mode = std::fs::metadata(dir.path().join("profiles.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);
    }
}
