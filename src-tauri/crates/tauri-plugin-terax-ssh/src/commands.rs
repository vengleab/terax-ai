use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use terax_ssh::edit::{EditInfo, SyncOutcome};
use terax_ssh::error::SshError;
use terax_ssh::forward::{ForwardSpec, TunnelStatus};
use terax_ssh::fs::{FileEntry, FileStat};
use terax_ssh::keys::{GenerateSpec, KeyInfo};
use terax_ssh::known_hosts::KnownHostRow;
use terax_ssh::profile::SshProfile;
use terax_ssh::secret::Secret;
use terax_ssh::service::{ConnectRequest, ConnectionInfo, EndpointRef, TransferRequest, WireEvent};
use terax_ssh::ssh_config::ConfigImport;
use terax_ssh::transfer::engine::{ConflictDecision, ItemError};

use crate::state::SshState;

type Res<T> = Result<T, SshError>;

#[tauri::command]
pub async fn profiles_list(state: State<'_, SshState>) -> Res<Vec<SshProfile>> {
    state.service()?.profiles()
}

#[tauri::command]
pub async fn profile_save(state: State<'_, SshState>, profile: SshProfile) -> Res<SshProfile> {
    state.service()?.profile_save(profile)
}

#[tauri::command]
pub async fn profile_remove(state: State<'_, SshState>, id: String) -> Res<()> {
    state.service()?.profile_remove(&id).await
}

#[tauri::command]
pub async fn profiles_import_ssh_config(state: State<'_, SshState>) -> Res<ConfigImport> {
    state.service()?.ssh_config_import()
}

#[tauri::command]
pub async fn terminal_args(state: State<'_, SshState>, profile_id: String) -> Res<Vec<String>> {
    state.service()?.terminal_args(&profile_id)
}

#[tauri::command]
pub async fn connect(state: State<'_, SshState>, request: ConnectRequest) -> Res<ConnectionInfo> {
    state.service()?.connect(request).await
}

#[tauri::command]
pub async fn disconnect(state: State<'_, SshState>, profile_id: String) -> Res<()> {
    state.service()?.disconnect(&profile_id).await;
    Ok(())
}

#[tauri::command]
pub async fn connections_list(state: State<'_, SshState>) -> Res<Vec<ConnectionInfo>> {
    Ok(state.service()?.connections().await)
}

#[tauri::command]
pub async fn trust_host_key(
    state: State<'_, SshState>,
    host: String,
    port: u16,
    public_key: String,
    replace: bool,
) -> Res<()> {
    state.service()?.trust_host_key(&host, port, &public_key, replace)
}

#[tauri::command]
pub async fn known_hosts_list(state: State<'_, SshState>) -> Res<Vec<KnownHostRow>> {
    state.service()?.known_hosts()
}

#[tauri::command]
pub async fn known_host_remove(state: State<'_, SshState>, line: usize) -> Res<()> {
    state.service()?.known_host_remove(line)
}

#[tauri::command]
pub async fn fs_home(state: State<'_, SshState>, endpoint: EndpointRef) -> Res<String> {
    state.service()?.fs_home(&endpoint).await
}

#[tauri::command]
pub async fn fs_canonicalize(state: State<'_, SshState>, endpoint: EndpointRef, path: String) -> Res<String> {
    state.service()?.fs_canonicalize(&endpoint, &path).await
}

#[tauri::command]
pub async fn fs_list(state: State<'_, SshState>, endpoint: EndpointRef, path: String) -> Res<Vec<FileEntry>> {
    state.service()?.fs_list(&endpoint, &path).await
}

#[tauri::command]
pub async fn fs_stat(state: State<'_, SshState>, endpoint: EndpointRef, path: String) -> Res<FileStat> {
    state.service()?.fs_stat(&endpoint, &path).await
}

#[tauri::command]
pub async fn fs_mkdir(state: State<'_, SshState>, endpoint: EndpointRef, path: String) -> Res<()> {
    state.service()?.fs_mkdir(&endpoint, &path).await
}

#[tauri::command]
pub async fn fs_create_file(state: State<'_, SshState>, endpoint: EndpointRef, path: String) -> Res<()> {
    state.service()?.fs_create_file(&endpoint, &path).await
}

#[tauri::command]
pub async fn fs_rename(state: State<'_, SshState>, endpoint: EndpointRef, from: String, to: String) -> Res<()> {
    state.service()?.fs_rename(&endpoint, &from, &to).await
}

#[tauri::command]
pub async fn fs_remove(state: State<'_, SshState>, endpoint: EndpointRef, paths: Vec<String>) -> Res<Vec<ItemError>> {
    state.service()?.fs_remove(&endpoint, &paths).await
}

#[tauri::command]
pub async fn fs_chmod(state: State<'_, SshState>, endpoint: EndpointRef, path: String, mode: u32) -> Res<()> {
    state.service()?.fs_chmod(&endpoint, &path, mode).await
}

#[tauri::command]
pub async fn transfer_start(
    state: State<'_, SshState>,
    request: TransferRequest,
    on_event: Channel<WireEvent>,
) -> Res<u32> {
    let emit = Arc::new(move |event: WireEvent| {
        let _ = on_event.send(event);
    });
    state.service()?.transfer_start(request, emit).await
}

#[tauri::command]
pub async fn transfer_cancel(state: State<'_, SshState>, id: u32) -> Res<()> {
    state.service()?.transfer_cancel(id)
}

#[tauri::command]
pub async fn transfer_resolve(
    state: State<'_, SshState>,
    id: u32,
    conflict_id: u32,
    decision: ConflictDecision,
    apply_to_all: bool,
) -> Res<()> {
    state.service()?.transfer_resolve(id, conflict_id, decision, apply_to_all)
}

#[tauri::command]
pub async fn keys_list(state: State<'_, SshState>) -> Res<Vec<KeyInfo>> {
    state.service()?.keys_list()
}

#[tauri::command]
pub async fn key_generate(state: State<'_, SshState>, spec: GenerateSpec) -> Res<KeyInfo> {
    state.service()?.key_generate(spec).await
}

#[tauri::command]
pub async fn key_import(state: State<'_, SshState>, source: String, name: String) -> Res<KeyInfo> {
    state.service()?.key_import(&source, &name)
}

#[tauri::command]
pub async fn key_delete(state: State<'_, SshState>, name: String) -> Res<()> {
    state.service()?.key_delete(&name)
}

#[tauri::command]
pub async fn key_change_passphrase(
    state: State<'_, SshState>,
    name: String,
    old: Option<Secret>,
    new: Option<Secret>,
) -> Res<KeyInfo> {
    state.service()?.key_change_passphrase(&name, old, new).await
}

#[tauri::command]
pub async fn key_public(state: State<'_, SshState>, name: String) -> Res<String> {
    state.service()?.key_public(&name)
}

#[tauri::command]
pub async fn key_deploy(state: State<'_, SshState>, profile_id: String, name: String) -> Res<bool> {
    state.service()?.key_deploy(&profile_id, &name).await
}

#[tauri::command]
pub async fn forwards_list(state: State<'_, SshState>) -> Res<Vec<ForwardSpec>> {
    state.service()?.forwards()
}

#[tauri::command]
pub async fn forward_save(state: State<'_, SshState>, spec: ForwardSpec) -> Res<ForwardSpec> {
    state.service()?.forward_save(spec)
}

#[tauri::command]
pub async fn forward_remove(state: State<'_, SshState>, id: String) -> Res<()> {
    state.service()?.forward_remove(&id).await
}

#[tauri::command]
pub async fn forward_start(state: State<'_, SshState>, id: String) -> Res<TunnelStatus> {
    state.service()?.forward_start(&id).await
}

#[tauri::command]
pub async fn forward_stop(state: State<'_, SshState>, id: String) -> Res<()> {
    state.service()?.forward_stop(&id).await
}

#[tauri::command]
pub async fn tunnels_status(state: State<'_, SshState>) -> Res<Vec<TunnelStatus>> {
    Ok(state.service()?.tunnel_status())
}

#[derive(Serialize)]
pub struct AutostartFailure {
    pub name: String,
    pub error: SshError,
}

#[tauri::command]
pub async fn forwards_autostart(state: State<'_, SshState>, profile_id: String) -> Res<Vec<AutostartFailure>> {
    let failures = state.service()?.forwards_autostart(&profile_id).await;
    Ok(failures
        .into_iter()
        .map(|(name, error)| AutostartFailure { name, error })
        .collect())
}

#[tauri::command]
pub async fn edit_open(state: State<'_, SshState>, profile_id: String, remote_path: String) -> Res<EditInfo> {
    state.service()?.edit_open(&profile_id, &remote_path).await
}

#[tauri::command]
pub async fn edit_sync(state: State<'_, SshState>, id: String, force: bool) -> Res<SyncOutcome> {
    state.service()?.edit_sync(&id, force).await
}

#[tauri::command]
pub async fn edit_reload(state: State<'_, SshState>, id: String) -> Res<()> {
    state.service()?.edit_reload(&id).await
}

#[tauri::command]
pub async fn edit_close(state: State<'_, SshState>, id: String) -> Res<()> {
    state.service()?.edit_close(&id).await
}
