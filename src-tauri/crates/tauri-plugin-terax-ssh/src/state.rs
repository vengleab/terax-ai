use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use terax_ssh::error::SshError;
use terax_ssh::service::{Service, ServiceConfig};

/// Holds the service, created on first use so an app that never opens SSH File Transfer pays nothing.
pub struct SshState {
    data_dir: PathBuf,
    cache_dir: PathBuf,
    cell: OnceLock<Result<Arc<Service>, SshError>>,
}

impl SshState {
    pub fn new(data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            data_dir,
            cache_dir,
            cell: OnceLock::new(),
        }
    }

    pub fn service(&self) -> Result<Arc<Service>, SshError> {
        self.cell
            .get_or_init(|| {
                Service::new(ServiceConfig {
                    data_dir: self.data_dir.clone(),
                    cache_dir: self.cache_dir.clone(),
                    ssh_dir: None,
                    system_known_hosts: None,
                })
            })
            .clone()
    }

    /// The service if it has been created and is healthy, without creating it.
    pub fn peek(&self) -> Option<Arc<Service>> {
        self.cell.get().and_then(|result| result.as_ref().ok().cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_service_is_created_lazily_and_once() {
        let dir = tempfile::tempdir().unwrap();
        let state = SshState::new(dir.path().join("data"), dir.path().join("cache"));
        assert!(state.peek().is_none());
        let first = state.service().unwrap();
        let second = state.service().unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert!(state.peek().is_some());
    }

    #[test]
    fn a_damaged_data_file_is_reported_without_panicking() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("profiles.json"), b"{ broken").unwrap();
        let state = SshState::new(data, dir.path().join("cache"));
        let err = state.service().err().expect("must fail");
        assert!(err.message.contains("profiles.json"));
        assert!(state.peek().is_none());
        assert!(state.service().is_err(), "the failure is remembered, not retried silently");
    }
}
