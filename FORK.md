# FORK.md

This repository is a fork of `crynta/terax-ai`. This file is the fork's own doc: how fork-only work is kept apart from upstream so that merging upstream stays cheap. `TERAX.md` remains the architecture doc and wins on any conflict.

## Rules

1. New code goes in new files and directories owned by the fork (listed below). Upstream files are edited only at registered seams.
2. A seam is a small hunk (usually one to five lines) in an upstream file that delegates into fork-owned code. Every seam carries its feature's marker in a comment (`fork:ssh-transfer`, `fork:github-copilot`, `fork:lazy-keys`, `fork:google-vertex`, `fork:launch-folders`), so it can be found with `git grep fork:`.
3. Every seam is registered in `scripts/fork/seams.json` with the file, its marker (default: the first listed in `markers`) and the exact marker count. `node scripts/fork/check-seams.mjs` fails if a registered seam disappears (for example after a bad merge) or if an unregistered marker shows up.
4. No new npm dependencies. New Rust dependencies live in the fork crates, never in the root `src-tauri/Cargo.toml`.
5. Do not edit `TERAX.md`, `docs/README.md`, `.github/workflows/ci.yml`, `package.json` or `pnpm-lock.yaml`. The one exception is `.size-limit.json` (see Size budget). Fork docs live in `FORK.md` and `docs/fork/`; fork CI lives in `.github/workflows/fork-ci.yml`.
6. Everything the fork adds is namespaced `ssh-transfer`: tab kind, sidebar view id, plugin id `terax-ssh`, store file `terax-ssh-transfer.json`, keychain service `terax-ssh-transfer`, localStorage keys `terax.sshx.*`, DOM attributes `data-sshx-*`. Upstream's roadmap lists its own SSH work, and the namespace keeps the two from colliding.

## Fork-owned paths

| Path | Purpose |
|---|---|
| `src-tauri/crates/terax-ssh/` | SSH/SFTP core, no Tauri dependency, tested without a display |
| `src-tauri/crates/tauri-plugin-terax-ssh/` | Thin Tauri plugin: commands, state, event channels |
| `src-tauri/capabilities/ssh-transfer.json` | Grants the plugin's permissions to the main window |
| `src/modules/ssh-transfer/` | Frontend module, lazy-loaded |
| `src/modules/ai/providers/github-copilot/` | GitHub Copilot AI provider (see `docs/fork/github-copilot.md`) |
| `src/modules/ai/providers/google-vertex/`, `providers/requestBody.ts` | Google Vertex AI provider with service account auth; the user picks the key file and Terax reads it from disk, no keychain (see `docs/fork/google-vertex.md`) |
| `src/modules/ai/lib/lazyKeys.ts` (and its tests) | Reads API keys from the OS secret store only when used, not at launch; also serves "external" key slots such as Vertex's key file path (see `docs/fork/lazy-keys.md`) |
| `src-tauri/crates/tauri-plugin-terax-launch/`, `src-tauri/capabilities/launch-folders.json`, `src/modules/launch-folders/` | Lets Terax be VS Code's external terminal: folders handed over by macOS `open -a Terax <folder>` open a terminal tab (see `docs/fork/vscode-terminal.md`) |
| `vscode-extension/` | A VS Code extension that adds a Terax terminal panel, drawn by Terax's own terminal engine. No seams: it touches no upstream file (see `docs/fork/vscode-extension.md`) |
| `docs/fork/` | Fork docs, start at `docs/fork/ssh-transfer.md` |
| `scripts/fork/` | Sync and seam tooling |
| `.github/workflows/fork-ci.yml` | Fork CI |

## Seams

The authoritative list is `scripts/fork/seams.json`. Summary:

| File | What the seam does |
|---|---|
| `src-tauri/Cargo.toml` | One path dependency on the plugin crate |
| `src-tauri/src/lib.rs` | One `.plugin(...)` call |
| `src/modules/tabs/lib/useTabs.ts` | `SshTransferTab` type import and `Tab` union member |
| `src/modules/tabs/lib/tabLabel.ts` | Label for the new tab kind |
| `src/modules/tabs/TabBar.tsx` | Icon for the new tab kind |
| `src/modules/sidebar/types.ts`, `SidebarRail.tsx`, `useSidebarPanel.ts` | New sidebar view id, rail button, persisted-view allow-list |
| `src/modules/ai/config.ts`, `lib/agent.ts`, `lib/keyring.ts`, `src/settings/components/ProviderIcon.tsx`, `src/modules/ai/components/AiStatusBarControls.tsx`, `src/settings/sections/ModelsSection.tsx` | `fork:github-copilot`: provider id, registry spreads, one `case`, key slot, icon entries, one settings card branch |
| `src/modules/ai/config.ts`, `lib/agent.ts`, `lib/keyring.ts`, `src/settings/components/ProviderIcon.tsx`, `src/modules/ai/components/AiStatusBarControls.tsx`, `src/settings/sections/ModelsSection.tsx` | `fork:google-vertex`: the same shape as the Copilot seams (provider id, registry spreads, one `case`, key slot, icon entries, one settings card branch) |
| `src/modules/ai/lib/keyring.ts`, `lib/agent.ts`, `lib/stt.ts`, `src/settings/components/ProviderKeyCard.tsx`, `src/settings/sections/ModelsSection.tsx` | `fork:lazy-keys`: the `invoke` import in `keyring.ts`, key resolution before models and voice input use a key, and the "Saved in your keychain" label |
| `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src/app/App.tsx` | `fork:launch-folders`: one path dependency, one `.plugin(...)` call, and in `App.tsx` the import and one hook call |
| `.size-limit.json` | Total client JS limit raised from 1505 KB to 1560 KB (guarded by `budgets`, see Size budget) |
| `src/app/App.tsx` | `fork:ssh-transfer`, seven small hunks: import, `useSshTransfer` call, palette items, sidebar branch (also swaps in the remote Explorer), tab surface layer, overlays |
| `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts` | One line: forwards terminal title changes as a `window` event, which the fork uses to follow the server's folder |

### Size budget

The module adds about 48 kB gzipped across three lazy chunks (`Overlays`, `SshTransferStack`, `SshSidebar`), which does not fit upstream's headroom under the `total client JS` limit (1505 KB). The fork raises that one number to 1560 KB in `.size-limit.json`. JSON cannot carry a marker comment, so the guard is the `budgets` entry in `scripts/fork/seams.json`: `check-seams.mjs` fails if the limit drops below 1560 KB, which is what an upstream merge reverting the value would do. When that happens, re-apply the number. The eager startup budget (540 KB) is untouched, and `eager-budget.test.ts` keeps the module out of the startup graph.

`WorkspaceSurface.tsx` is deliberately untouched: the transfer tab renders as a sibling layer from `App.tsx`.

To remove the feature: delete the fork-owned paths, delete every line marked `fork:ssh-transfer` (and the now-unused imports), and delete the entry from `Cargo.lock` with `cargo metadata`.

## Syncing with upstream

One-time setup (the script also does this):

```sh
git remote add upstream https://github.com/crynta/terax-ai
git config rerere.enabled true
git config rerere.autoupdate true
```

Branch model: `main` is a pure mirror of upstream (fast-forward only). Work happens on feature branches. Merge upstream in often, weekly at least, so each merge is small.

```sh
scripts/fork/sync-upstream.sh --ff-main
```

The script fetches upstream, fast-forwards local `main`, merges `upstream/main` into the current branch, resolves lockfile conflicts, and runs the seam check. Pushing is left to you. Note that the fork's `main` on GitHub may be behind: after the script, `git push origin main` (fast-forward) brings it level, or use GitHub's "Sync fork" button.

### Lockfile conflicts

- `src-tauri/Cargo.lock`: take upstream's file, then run `cargo metadata` (or any cargo command without `--locked`). Cargo re-adds the fork's packages and applies the few minimum-version bumps they need (for example `chrono`, `thiserror`, `tokio-util`), and keeps every other upstream version. Never run `cargo update` to resolve a conflict.
- `pnpm-lock.yaml`: the fork changes no npm dependencies, so always take upstream's.

### Dependabot

Upstream's Dependabot config groups all cargo updates. The fork crates pin `russh` and `russh-sftp` to exact versions because `russh` itself pins pre-release `ssh-key` and `rsa` crates. Review bumps of those two by hand and re-run `cargo test -p terax-ssh`.

## Further reading

- `docs/fork/github-copilot.md`: the GitHub Copilot AI provider
- `docs/fork/lazy-keys.md`: lazy API key reads (no secret-store reads at launch)
- `docs/fork/google-vertex.md`: the Google Vertex AI provider (service account key file, no keychain)
- `docs/fork/vscode-extension.md`: the Terax terminal panel inside VS Code
- `docs/fork/vscode-terminal.md`: using Terax as VS Code's external terminal
- `docs/fork/ssh-transfer.md`: the SSH File Transfer feature
