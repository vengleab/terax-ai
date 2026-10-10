use tauri::{plugin::TauriPlugin, Runtime};

#[tauri::command]
async fn ssh_ping() -> &'static str {
    "pong"
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("terax-ssh")
        .invoke_handler(tauri::generate_handler![ssh_ping])
        .build()
}
