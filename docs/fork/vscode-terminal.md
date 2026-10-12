# Using Terax as VS Code's terminal

VS Code's **integrated terminal** (the panel at the bottom of the window) is part of VS Code and cannot be replaced by another app. What VS Code does offer is an **external terminal**: "Terminal: Open New External Terminal" (command `workbench.action.terminal.openNativeConsole`, usually Ctrl+Shift+C, Cmd+Shift+C on macOS; check Keyboard Shortcuts if yours differs) and "Open in External Terminal" in the Explorer's folder menu. You choose which app that opens, and Terax can be that app, opened in the folder you are working in.

## VS Code settings

Add the line for your system to VS Code's `settings.json`:

| System | Setting | What VS Code runs (read from VS Code's source) |
|---|---|---|
| macOS | `"terminal.external.osxExec": "Terax.app"` | `/usr/bin/open -a Terax.app <folder>` |
| Linux | `"terminal.external.linuxExec": "terax"` (or the full path of the installed binary) | the program, started in `<folder>` |
| Windows | `"terminal.external.windowsExec": "C:\\path\\to\\terax.exe"` | `cmd /c start /wait <exe> -d .`, started in `<folder>` |

To have right-click on a folder in the Explorer offer the external terminal, set `"terminal.explorerKind": "external"` (or `"both"`).

## How each system reaches Terax

- **Linux and Windows** needed no change. Terax already starts in the process's working directory, and on Windows it ignores the `-d` option and reads the `.` as the folder. Each launch opens a new Terax window, because Terax has no single-instance lock.
- **macOS** needed one. `open -a Terax.app <folder>` hands the folder to the app as an "open" event, not as an argument, and Terax only accepted files from that event, so the folder was dropped. The fork adds a small plugin, `tauri-plugin-terax-launch`, that takes the folders from that event, queues them until the window is ready, and wakes the frontend. The frontend allows the folder (`workspace_authorize`) and opens a **new terminal tab in it**, in the running Terax if there is one. On a cold start the tab is opened after the saved tabs are restored, so it is not lost.

## Limits

- **Not the integrated panel.** Ctrl+` still opens VS Code's own terminal. To make that key open Terax instead, bind it yourself: `{ "key": "ctrl+`", "command": "workbench.action.terminal.openNativeConsole" }`.
- **Debugging in an external terminal is not supported.** `launch.json` with `"console": "externalTerminal"` asks the terminal app to run a program, and Terax cannot be told to.
- **No VS Code integration beyond the folder.** Terax does not speak VS Code's `OSC 633` shell-integration protocol and VS Code does not watch an external terminal, so there is no command decoration or status in VS Code.
- **macOS opens a tab, not a window,** and always a new one, even if a tab is already in that folder.
- A path with spaces in `windowsExec` is passed to `start` as it is; this was not tried.

## What was and was not verified

- Verified here: the folder filtering (folders kept, files, missing paths and non-file URLs skipped, symlinks and duplicates resolved, odd characters in names) and the queue (drained once, no repeats, survives a poisoned lock) have Rust tests that pass; the plugin passes `clippy -D warnings` on Linux; the frontend controller (nothing opened before the app is ready, queued folders opened once, a bad folder skipped, canonical path used) has tests; the type check, lint, build and size budget pass. What VS Code runs per system comes from its source code, not from running VS Code.
- **Not verified: any run on a Mac.** This sandbox is Linux and cannot compile the macOS-only part (a dependency needs Apple's compiler), so the `Opened` handler was checked against Tauri's source and `fork-ci.yml` has a `launch-plugin` job on `macos-latest` that compiles and lints it. Whether macOS actually delivers a folder through `open -a` to an app that does not declare folders in its `Info.plist` is not confirmed. If pressing Ctrl+Shift+C in VS Code only brings Terax forward and opens no tab, that is the cause. The fix is a `public.folder` document type in `src-tauri/Info.plist` (merged with the existing file associations). It is an edit to an upstream file, so it was not made without evidence that it is needed.

## Checklist on a Mac

1. Install the build, add `"terminal.external.osxExec": "Terax.app"`, open a project in VS Code and press Cmd+Shift+C. Expect Terax to come forward with a new terminal tab whose directory is the project.
2. Quit Terax and repeat. Expect it to start, restore its tabs, and then show the new tab.
3. Right-click a folder in the Explorer (with `terminal.explorerKind` set to `external`) and choose Open in External Terminal.
4. Run `open -a Terax.app /tmp` in a terminal and confirm the tab opens in `/private/tmp`.

## Layout and seams

| Path | Role |
|---|---|
| `src-tauri/crates/tauri-plugin-terax-launch/` | macOS `Opened` event to a queue of folders, plus the `take_pending_folders` command |
| `src-tauri/capabilities/launch-folders.json` | Lets the main window call that command |
| `src/modules/launch-folders/` | Frontend hook and its controller |

Upstream files are touched only at `fork:launch-folders` lines, registered in `scripts/fork/seams.json`: `src-tauri/Cargo.toml` (1), `src-tauri/src/lib.rs` (1) and `src/app/App.tsx` (2: the import and the hook call). To remove the feature, delete the paths above and every line marked `fork:launch-folders`, then drop the crate from `Cargo.lock` with `cargo metadata`.
