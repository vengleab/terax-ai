# FORK.md

This repository is a fork of `crynta/terax-ai`. This file is the fork's own doc: how fork-only work is kept apart from upstream so that merging upstream stays cheap. `TERAX.md` remains the architecture doc and wins on any conflict.

## Rules

1. New code goes in new files and directories owned by the fork (listed below). Upstream files are edited only at registered seams.
2. A seam is a small hunk (usually one to five lines) in an upstream file that delegates into fork-owned code. Every seam carries the marker `fork:ssh-transfer` in a comment, so it can be found with `git grep fork:ssh-transfer`.
3. Every seam is registered in `scripts/fork/seams.json` with the file and the minimum marker count. `node scripts/fork/check-seams.mjs` fails if a registered seam disappears (for example after a bad merge) or if an unregistered marker shows up.
4. No new npm dependencies. New Rust dependencies live in the fork crates, never in the root `src-tauri/Cargo.toml`.
5. Do not edit `TERAX.md`, `docs/README.md`, `.github/workflows/ci.yml`, `package.json`, `pnpm-lock.yaml` or `.size-limit.json`. Fork docs live in `FORK.md` and `docs/fork/`; fork CI lives in `.github/workflows/fork-ci.yml`.
6. Everything the fork adds is namespaced `ssh-transfer`: tab kind, sidebar view id, plugin id `terax-ssh`, store file `terax-ssh-transfer.json`, keychain service `terax-ssh-transfer`, localStorage keys `terax.sshx.*`, DOM attributes `data-sshx-*`. Upstream's roadmap lists its own SSH work, and the namespace keeps the two from colliding.

## Fork-owned paths

| Path | Purpose |
|---|---|
| `src-tauri/crates/terax-ssh/` | SSH/SFTP core, no Tauri dependency, tested without a display |
| `src-tauri/crates/tauri-plugin-terax-ssh/` | Thin Tauri plugin: commands, state, event channels |
| `src-tauri/capabilities/ssh-transfer.json` | Grants the plugin's permissions to the main window |
| `src/modules/ssh-transfer/` | Frontend module, lazy-loaded |
| `docs/fork/` | Fork docs, start at `docs/fork/ssh-transfer.md` |
| `scripts/fork/` | Sync and seam tooling |
| `.github/workflows/fork-ci.yml` | Fork CI |

## Seams

The authoritative list is `scripts/fork/seams.json`. Summary:

| File | What the seam does |
|---|---|
| `src-tauri/Cargo.toml` | One path dependency on the plugin crate |
| `src-tauri/src/lib.rs` | One `.plugin(...)` call |
| `src/modules/tabs/lib/useTabs.ts` | `SshTransferTab` joins the `Tab` union |
| `src/modules/tabs/lib/tabLabel.ts` | Label for the new tab kind |
| `src/modules/tabs/TabBar.tsx` | Icon for the new tab kind |
| `src/app/components/WorkspaceSurface.tsx` | Renders the new tab kind |
| `src/modules/sidebar/types.ts`, `SidebarRail.tsx`, `useSidebarPanel.ts` | New sidebar view |
| `src/app/App.tsx` | Mounts the module hook and the sidebar panel, adds palette items |

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

- `docs/fork/ssh-transfer.md`: the SSH File Transfer feature
