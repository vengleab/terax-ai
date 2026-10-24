const COMMANDS: &[&str] = &["take_pending_folders"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
