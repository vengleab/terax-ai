# SSH File Transfer

A fork-only feature: a dual-pane file manager that moves files between this machine and SSH servers (or between two servers) over SFTP, with server, key, known-hosts and port-forward management. It uses a native Rust SSH stack (`russh` + `russh-sftp`), so it needs no system `ssh`, `scp` or `sftp` binary. How the fork stays mergeable with upstream is in [`FORK.md`](../../FORK.md).

## Using it

Open the **SSH** button on the activity bar (or the command palette entry **SSH: Open file transfer**). The sidebar lists servers with a status dot and a search box. Clicking a server opens the file transfer tab; the row buttons connect or disconnect, open an SSH terminal, open that server's port forwards, and edit it. The header buttons add a server and open the key, tunnel and known-hosts managers.

Command palette entries: `SSH: Open file transfer`, `SSH: Add server`, `SSH: Manage keys`, `SSH: Port forwarding`, `SSH: Known hosts`.

### Dual-pane view

Each pane has a source switcher (Local or any saved server), an editable path bar, back and forward history, a hidden-files toggle, sorting and filtering. Panes can show any combination: local and server, server and server, or two views of the same machine.

| Action | How |
|---|---|
| Copy or move between panes | Drag and drop (pointer-based, between the two panes) |
| Upload from the OS | Drop files from the system file manager onto a pane |
| Copy / cut / paste | `Ctrl/Cmd+C`, `X`, `V` |
| Select all | `Ctrl/Cmd+A` |
| Focus the path bar | `Ctrl/Cmd+L` |
| Open, up, back, forward | `Enter`, `Backspace` / `Alt+Up`, `Alt+Left`, `Alt+Right` |
| Rename, refresh, delete | `F2`, `F5`, `Delete` |
| Change permissions | Context menu, chmod dialog |

Server to server transfers are **relayed through this machine** (download and upload streamed in bounded chunks, never buffered whole). Direct server-to-server copy is not implemented.

### Transfers

- Up to three files at once, with per-job and total progress, speed and ETA, plus cancel and retry.
- Data is written to `<name>.terax-part` and renamed into place when complete, so an interrupted transfer never leaves a truncated file under the real name. A leftover partial file is resumed.
- When the destination exists, a dialog offers overwrite, skip, rename or cancel, with an "apply to all" checkbox. The engine also has an "overwrite only if newer" policy, but the UI does not expose it yet.
- Symlinks inside a folder are skipped, not followed.
- Remote filenames are validated before anything is written locally: `..`, path separators and Windows reserved names are rejected.
- Transfers run in the Rust process, so closing the tab does not stop them. Quitting the app cancels them.

### Editing remote files

"Open in editor" downloads the file to a cache directory (keeping its original name) and opens it in the Terax editor. Saving in the editor uploads it back. If the file changed on the server since it was downloaded, the upload stops and asks before overwriting.

### SSH terminal

"Open SSH terminal" starts a regular Terax terminal tab and types the `ssh` command for the server (`-p`, `-i`, `-J` taken from the profile). This uses the system `ssh` binary and is the only part of the feature that does. Password authentication is entered at the terminal prompt, as with any `ssh` session.

On macOS and Linux the command also carries a remote command (`ssh -t ... 'env PROMPT_COMMAND=... "$SHELL" -l'`) that starts the server's login shell with a bash prompt hook. The hook is what lets the Explorer follow `cd` (below). Side effects of replacing the plain login: the server's motd and last-login banner are not shown. On Windows the plain `ssh` command is typed, so there is no follow.

### Explorer for SSH terminals

When the active terminal is an SSH session opened from the SSH panel and the sidebar is on **Files**, the Explorer shows that server's files instead of the local ones. The header shows the server's name and the folder being shown, with up, refresh, new file, new folder and a dotfiles toggle.

- **Browse:** folders expand in place; the tree is virtualized and keyboard driven (arrows, `Enter`, `F2`, `Delete`).
- **Open:** double click or `Enter` opens a file in the editor through the same download-and-sync-back flow as "Open in editor".
- **Change things:** New file, New folder, Rename, Delete (with confirmation), Copy path. "cd here in terminal" types `cd '<folder>'` into the terminal.
- **Follows `cd`:** on servers whose login shell is bash, each prompt reports the current folder as a terminal title (`terax-cwd:<path>`) and the tree re-roots there. The terminal's own OSC 7 handling is deliberately not used, because Terax ignores OSC 7 while a command (here `ssh`) is running. On zsh or fish servers the tree starts at the server's home (or the profile's default folder) and does not follow; up, refresh and "cd here" still work.
- **Connects itself:** the first time it is shown it connects with the profile (host key, password and passphrase prompts work as everywhere else), with Retry on failure.
- **Stops when ssh ends:** once the terminal's `ssh` has exited (checked every few seconds), or the tab is closed, the Explorer goes back to the local tree.
- **Refresh:** there is no remote file watcher, so listings refresh on window focus, after your own changes, and with the refresh button.

Not available in the remote tree: git status, content search, drag-to-move, and attaching files to the AI agent. The AI agent, the status bar and the window title keep using the local workspace. Terminals where you typed `ssh host` by hand are not detected.

### Servers, keys and known hosts

- **Servers:** name, host, port, user, authentication (agent, key file, or password; a saved password is optional), optional jump host (one hop), keepalive, color and tags. `~/.ssh/config` can be imported (`Host`, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, `Include`). `ProxyCommand` is never executed; it produces an import warning instead.
- **Keys:** list keys in `~/.ssh` with type and fingerprint, generate ed25519, RSA or ECDSA keys (optional passphrase), import, change passphrase, copy the public key, deploy a public key to a server's `authorized_keys`, delete.
- **Known hosts:** Terax keeps its own known-hosts file. An unknown host key requires an explicit trust decision showing the fingerprint. A changed key stops the connection and can only be replaced by an explicit action. Entries can be viewed and removed.
- **Port forwards:** local (`-L`), remote (`-R`) and dynamic SOCKS5 (`-D`, CONNECT only), per server, with optional autostart. Local listeners bind loopback unless "expose" is turned on.

## Security notes

- Private keys and passphrases never cross the IPC boundary or appear in logs. Key commands return metadata and public-key text only.
- Passwords and passphrases are stored through the app's existing secret store (service `terax-ssh-transfer`, account `<profileId>:password|passphrase`). On Linux without a keyring that store is a plaintext file with `0600` permissions, so treat saved passwords there accordingly. Leave the password field empty to be asked at connect time instead (nothing is stored then).
- Secrets handed to Rust are zeroized after use.
- The release build uses `panic = "abort"`, so the async SSH paths avoid `unwrap`/`expect`.
- No SSH command is registered as an AI tool and the AI deny-list is unchanged.

## Layout

| Path | Role |
|---|---|
| `src-tauri/crates/terax-ssh/` | Core: profiles, `ssh_config`, known hosts, keys, session, SFTP filesystem, transfer planner and engine, forwards, remote edit. No Tauri dependency, so it builds and tests anywhere |
| `src-tauri/crates/tauri-plugin-terax-ssh/` | Thin Tauri plugin (`terax-ssh`): 41 commands, state, event channels |
| `src-tauri/capabilities/ssh-transfer.json` | Grants the plugin's permissions to the main window |
| `src/modules/ssh-transfer/` | Frontend: stores, dual-pane view, dialogs, drag and drop, hook mounted from `App.tsx` |

The frontend is loaded lazily: `SshSidebarLazy`, `SshTransferStackLazy`, `SshExplorerLazy` and `SshOverlaysLazy` are the only components the app imports, and `eager-budget.test.ts` keeps them out of the startup graph. The remote Explorer's logic is in small pure modules (`remoteTree.ts`, `remoteCwd.ts`, `sshTerminals.ts`, `sshCommand.ts`).

Plugin commands are listed in three places that must agree (`build.rs`, `permissions/default.toml`, the `generate_handler!` list in `src/lib.rs`). A unit test in the plugin crate fails if they drift.

## What has and has not been verified

Verified by automated checks, run on Linux:

- `terax-ssh`: 160 tests, including an in-process SSH + SFTP server that exercises authentication, host-key trust and change, transfers (all three route kinds, resume, conflicts, cancel), forwards and remote edit.
- `tauri-plugin-terax-ssh`: command, permission and handler lists stay in step; wire shapes of events and errors.
- Frontend: type-check, lint, and unit tests for the pure logic (paths, sorting, selection, transfer planning, queue stats, drag-and-drop hit testing, form validation, the remote tree, the terminal registry and the folder-report parser). Full-app `cargo clippy --all-targets --locked -- -D warnings`. `pnpm build && pnpm size` within budget.
- Remote command: a test runs the generated `ssh` line through a real `sh` to prove the remote command arrives as one unchanged argument, and runs the prompt hook in a real interactive `bash` to prove it reports the folder on every prompt and after `cd` (skipped where `sh` or `bash` is missing, and on Windows).
- The Explorer, dual-pane view and dialogs were also driven in headless Chromium with the Tauri backend replaced by a mock (fake servers, files and terminal titles). That exercises the real React code, not a real server or terminal.

**Not verified:** the app was never run as a desktop window, so drag and drop, OS file drop, the real SSH terminal launch (including the remote command on real servers and shells), the follow-`cd` path through the real terminal, and the edit-and-sync round trip have had no end-to-end run, and nothing was tested against a real OpenSSH server or on Windows and macOS. Run this checklist on a developer machine with `pnpm tauri dev` and a local OpenSSH server (a container is fine):

1. Connect with a password, a key file and an agent.
2. Accept a new host key; change the server's key and confirm the connection is refused.
3. Drag a file and a folder local to server, server to local, and server to server.
4. Cancel a large transfer midway, then retry it and confirm it resumes.
5. Open a remote file in the editor, save, and confirm the server copy changed. Edit it on the server first and confirm the conflict prompt.
6. Open an SSH terminal from a server. On a bash server, switch the sidebar to Files and confirm the tree shows the server, then `cd` into another folder and confirm the tree follows. Create, rename and delete something from the tree, open a file, and use "cd here in terminal". Type `exit` and confirm the local tree returns within a few seconds.
7. Start a local forward and `curl` through it. Start a SOCKS5 forward and use it with `curl --socks5-hostname`.

## Size

The lazy chunks add about 53 kB gzipped (the remote Explorer is about 5 kB of that). The total client JS limit in `.size-limit.json` was raised from 1505 KB to 1560 KB to fit (see "Size budget" in `FORK.md`); about 12 kB of that limit is left. The Rust dependency tree also grows because `russh` pulls pre-release crypto crates; measure a release build in CI before publishing.

## Possible next steps

Direct server-to-server copy (scp/rsync), folder compare and sync with a dry run, bandwidth limits, checksum verification, keyboard-interactive/TOTP prompts, FIDO keys and SSH certificates, remembering the transfer tab across restarts, and dragging from the sidebar Explorer into a server pane.
