use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};
use terax_ssh::edit::SyncOutcome;
use terax_ssh::error::SshError;

use crate::debounce::Debouncer;
use crate::state::SshState;

pub const EDIT_EVENT: &str = "terax-ssh://edit-sync";
const SAVE_EVENT: &str = "fs:file-written";
const SAVE_SETTLE: Duration = Duration::from_millis(300);

#[derive(Deserialize)]
struct FileWritten {
    path: String,
}

#[derive(Serialize, Clone)]
pub struct EditSyncEvent {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<SyncOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SshError>,
}

/// Uploads a remote-edit file shortly after the editor saves it. Costs nothing unless the
/// service exists and the saved path belongs to a remote edit session.
pub fn listen_for_saves<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let debouncer = Arc::new(Debouncer::default());
    app.listen_any(SAVE_EVENT, move |event| {
        let Ok(written) = serde_json::from_str::<FileWritten>(event.payload()) else {
            return;
        };
        let state = handle.state::<SshState>();
        let Some(service) = state.peek() else {
            return;
        };
        let Some(id) = service.edit_for_local_path(&written.path) else {
            return;
        };
        let handle = handle.clone();
        let debouncer = debouncer.clone();
        tauri::async_runtime::spawn(async move {
            let Some(generation) = debouncer.settle(&id, SAVE_SETTLE).await else {
                return;
            };
            let payload = match service.edit_sync(&id, false).await {
                Ok(SyncOutcome::Unchanged) => None,
                Ok(outcome) => Some(EditSyncEvent { id: id.clone(), outcome: Some(outcome), error: None }),
                Err(error) => Some(EditSyncEvent { id: id.clone(), outcome: None, error: Some(error) }),
            };
            debouncer.finish(&id, generation);
            if let Some(payload) = payload {
                let _ = handle.emit(EDIT_EVENT, payload);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_save_payload_is_read_ignoring_extra_fields() {
        let parsed: FileWritten = serde_json::from_str(r#"{"path":"/tmp/a.txt","source":"editor"}"#).unwrap();
        assert_eq!(parsed.path, "/tmp/a.txt");
        assert!(serde_json::from_str::<FileWritten>(r#"{"source":"editor"}"#).is_err());
    }

    #[test]
    fn edit_events_serialize_only_what_is_set() {
        let uploaded = EditSyncEvent { id: "x".into(), outcome: Some(SyncOutcome::Uploaded { size: 3 }), error: None };
        let json = serde_json::to_value(&uploaded).unwrap();
        assert_eq!(json["outcome"]["kind"], "uploaded");
        assert!(json.get("error").is_none());
        let failed = EditSyncEvent { id: "x".into(), outcome: None, error: Some(SshError::io("boom")) };
        let json = serde_json::to_value(&failed).unwrap();
        assert_eq!(json["error"]["code"], "io");
        assert!(json.get("outcome").is_none());
    }
}
