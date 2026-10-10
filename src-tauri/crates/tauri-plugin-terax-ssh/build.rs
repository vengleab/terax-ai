const COMMANDS: &[&str] = &["ssh_ping"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
