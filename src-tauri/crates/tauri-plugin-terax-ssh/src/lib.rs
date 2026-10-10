mod commands;
mod debounce;
mod events;
mod state;

use std::time::Duration;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, RunEvent, Runtime};

use commands::*;
use state::SshState;

const EXIT_GRACE: Duration = Duration::from_secs(2);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("terax-ssh")
        .invoke_handler(tauri::generate_handler![
            profiles_list,
            profile_save,
            profile_remove,
            profiles_import_ssh_config,
            terminal_args,
            connect,
            disconnect,
            connections_list,
            trust_host_key,
            known_hosts_list,
            known_host_remove,
            fs_home,
            fs_canonicalize,
            fs_list,
            fs_stat,
            fs_mkdir,
            fs_create_file,
            fs_rename,
            fs_remove,
            fs_chmod,
            transfer_start,
            transfer_cancel,
            transfer_resolve,
            keys_list,
            key_generate,
            key_import,
            key_delete,
            key_change_passphrase,
            key_public,
            key_deploy,
            forwards_list,
            forward_save,
            forward_remove,
            forward_start,
            forward_stop,
            tunnels_status,
            forwards_autostart,
            edit_open,
            edit_sync,
            edit_reload,
            edit_close,
        ])
        .setup(|app, _api| {
            let data_dir = app.path().app_local_data_dir()?.join("terax-ssh");
            let cache_dir = app.path().app_cache_dir()?.join("terax-ssh");
            app.manage(SshState::new(data_dir, cache_dir));
            events::listen_for_saves(app);
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(service) = app.state::<SshState>().peek() {
                    tauri::async_runtime::block_on(async {
                        let _ = tokio::time::timeout(EXIT_GRACE, service.shutdown()).await;
                    });
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        let from = text.find(start).expect("start marker") + start.len();
        let to = from + text[from..].find(end).expect("end marker");
        &text[from..to]
    }

    fn quoted(block: &str) -> BTreeSet<String> {
        block
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"')?.split('"').next().map(str::to_string))
            .collect()
    }

    #[test]
    fn build_script_permissions_and_command_functions_stay_in_step() {
        let build = include_str!("../build.rs");
        let commands: BTreeSet<String> = quoted(between(build, "COMMANDS: &[&str] = &[", "];"));
        assert!(commands.len() > 30);

        let toml = include_str!("../permissions/default.toml");
        let permissions: BTreeSet<String> = quoted(between(toml, "permissions = [", "]"));
        let expected: BTreeSet<String> = commands.iter().map(|c| format!("allow-{}", c.replace('_', "-"))).collect();
        assert_eq!(permissions, expected, "default.toml must allow exactly the commands in build.rs");

        let source = include_str!("commands.rs");
        let registered = include_str!("lib.rs");
        let handler = between(registered, "generate_handler![", "])");
        let in_handler: BTreeSet<String> = handler.lines().map(|l| l.trim().trim_end_matches(',').to_string()).filter(|l| !l.is_empty()).collect();
        assert_eq!(in_handler, commands, "generate_handler! must list exactly the commands in build.rs");
        for command in &commands {
            assert!(
                source.contains(&format!("pub async fn {command}(")),
                "commands.rs has no `{command}` command"
            );
        }
    }
}
