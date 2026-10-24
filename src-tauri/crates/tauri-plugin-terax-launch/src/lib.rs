//! Folders handed to Terax by the OS.
//!
//! macOS delivers `open -a Terax <folder>` (what VS Code runs for "Open New External Terminal") as an
//! "open" event rather than as a command line argument, and the app itself only accepts files from that
//! event. This plugin takes the folders from it, keeps them until the frontend collects them (so a
//! launch that arrives before the window is ready is not lost) and tells the frontend to look.
//! Linux and Windows pass the folder as the working directory or an argument, which the app handles.

mod folders;
mod state;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State};

use state::Pending;

/// Frontend event that means "call `take_pending_folders`". It carries no payload on purpose, so the
/// pending list is the only place a folder can be read from and none is ever handled twice.
pub const FOLDERS_EVENT: &str = "terax:open-folders";

#[tauri::command]
fn take_pending_folders(state: State<'_, Pending>) -> Vec<String> {
    state.take()
}

/// Keeps the folders and wakes the frontend. Not macOS-only itself, so it is compiled and linted
/// everywhere; only the event that feeds it is.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn announce<R: Runtime>(app: &AppHandle<R>, found: Vec<String>) {
    if found.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<Pending>() {
        state.push(found);
    }
    if let Err(e) = app.emit(FOLDERS_EVENT, ()) {
        log::warn!("could not announce opened folders: {e}");
    }
}

fn handle_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Opened { urls } = event {
        announce(app, folders::from_urls(urls));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("terax-launch")
        .invoke_handler(tauri::generate_handler![take_pending_folders])
        .setup(|app, _api| {
            app.manage(Pending::default());
            Ok(())
        })
        .on_event(handle_event)
        .build()
}
