import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ConfigImport,
  ConflictDecision,
  ConnectionInfo,
  ConnectRequest,
  EditInfo,
  EndpointRef,
  FileEntry,
  FileStat,
  ForwardSpec,
  GenerateKeySpec,
  ItemError,
  KeyInfo,
  KnownHostRow,
  SshProfile,
  SyncOutcome,
  TransferRequest,
  TunnelStatus,
  WireEvent,
} from "../types";
import { toApiError } from "./errors";

const PLUGIN = "plugin:terax-ssh|";

async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(`${PLUGIN}${command}`, args);
  } catch (error) {
    throw toApiError(error);
  }
}

export const sshApi = {
  profilesList: () => call<SshProfile[]>("profiles_list"),
  profileSave: (profile: Partial<SshProfile> & Pick<SshProfile, "name" | "host" | "user" | "auth">) =>
    call<SshProfile>("profile_save", { profile }),
  profileRemove: (id: string) => call<void>("profile_remove", { id }),
  importSshConfig: () => call<ConfigImport>("profiles_import_ssh_config"),
  terminalArgs: (profileId: string) =>
    call<string[]>("terminal_args", { profileId }),

  connect: (request: ConnectRequest) =>
    call<ConnectionInfo>("connect", { request }),
  disconnect: (profileId: string) => call<void>("disconnect", { profileId }),
  connections: () => call<ConnectionInfo[]>("connections_list"),

  trustHostKey: (
    host: string,
    port: number,
    publicKey: string,
    replace: boolean,
  ) => call<void>("trust_host_key", { host, port, publicKey, replace }),
  knownHosts: () => call<KnownHostRow[]>("known_hosts_list"),
  knownHostRemove: (line: number) => call<void>("known_host_remove", { line }),

  fsHome: (endpoint: EndpointRef) => call<string>("fs_home", { endpoint }),
  fsCanonicalize: (endpoint: EndpointRef, path: string) =>
    call<string>("fs_canonicalize", { endpoint, path }),
  fsList: (endpoint: EndpointRef, path: string) =>
    call<FileEntry[]>("fs_list", { endpoint, path }),
  fsStat: (endpoint: EndpointRef, path: string) =>
    call<FileStat>("fs_stat", { endpoint, path }),
  fsMkdir: (endpoint: EndpointRef, path: string) =>
    call<void>("fs_mkdir", { endpoint, path }),
  fsCreateFile: (endpoint: EndpointRef, path: string) =>
    call<void>("fs_create_file", { endpoint, path }),
  fsRename: (endpoint: EndpointRef, from: string, to: string) =>
    call<void>("fs_rename", { endpoint, from, to }),
  fsRemove: (endpoint: EndpointRef, paths: string[]) =>
    call<ItemError[]>("fs_remove", { endpoint, paths }),
  fsChmod: (endpoint: EndpointRef, path: string, mode: number) =>
    call<void>("fs_chmod", { endpoint, path, mode }),

  transferStart: async (
    request: TransferRequest,
    onEvent: (event: WireEvent) => void,
  ): Promise<number> => {
    const channel = new Channel<WireEvent>();
    channel.onmessage = onEvent;
    return call<number>("transfer_start", { request, onEvent: channel });
  },
  transferCancel: (id: number) => call<void>("transfer_cancel", { id }),
  transferResolve: (
    id: number,
    conflictId: number,
    decision: ConflictDecision,
    applyToAll: boolean,
  ) =>
    call<void>("transfer_resolve", { id, conflictId, decision, applyToAll }),

  keys: () => call<KeyInfo[]>("keys_list"),
  keyGenerate: (spec: GenerateKeySpec) =>
    call<KeyInfo>("key_generate", { spec }),
  keyImport: (source: string, name: string) =>
    call<KeyInfo>("key_import", { source, name }),
  keyDelete: (name: string) => call<void>("key_delete", { name }),
  keyChangePassphrase: (name: string, oldPassphrase?: string, newPassphrase?: string) =>
    call<KeyInfo>("key_change_passphrase", {
      name,
      old: oldPassphrase ?? null,
      new: newPassphrase ?? null,
    }),
  keyPublic: (name: string) => call<string>("key_public", { name }),
  keyDeploy: (profileId: string, name: string) =>
    call<boolean>("key_deploy", { profileId, name }),

  forwards: () => call<ForwardSpec[]>("forwards_list"),
  forwardSave: (spec: Omit<ForwardSpec, "id"> & { id?: string }) =>
    call<ForwardSpec>("forward_save", { spec: { id: "", ...spec } }),
  forwardRemove: (id: string) => call<void>("forward_remove", { id }),
  forwardStart: (id: string) => call<TunnelStatus>("forward_start", { id }),
  forwardStop: (id: string) => call<void>("forward_stop", { id }),
  tunnels: () => call<TunnelStatus[]>("tunnels_status"),
  forwardsAutostart: (profileId: string) =>
    call<{ name: string; error: { code: string; message: string } }[]>(
      "forwards_autostart",
      { profileId },
    ),

  editOpen: (profileId: string, remotePath: string) =>
    call<EditInfo>("edit_open", { profileId, remotePath }),
  editSync: (id: string, force: boolean) =>
    call<SyncOutcome>("edit_sync", { id, force }),
  editReload: (id: string) => call<void>("edit_reload", { id }),
  editClose: (id: string) => call<void>("edit_close", { id }),
};

export const EDIT_SYNC_EVENT = "terax-ssh://edit-sync";
