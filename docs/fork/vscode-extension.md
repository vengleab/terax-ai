# Terax terminal panel for VS Code

`vscode-extension/` is a VS Code extension that adds a **Terax** tab to VS Code's bottom panel. The terminal in it is Terax's own engine (libghostty-vt in WebAssembly with the WebGL renderer, the same code the desktop app uses), not VS Code's.

**New:** below the terminal there is an **AI chat** with a popup that asks before the agent runs a command or changes a file. It can use GitHub Copilot through VS Code. It has its own page: `vscode-ai-chat.md`. (The extension now needs VS Code 1.95 or newer, for the language model API's tools.)

## What it is, and what it is not

VS Code does not let an extension replace its integrated terminal, so this is a **second terminal that sits next to it**, not a replacement:

- **Works the same as in Terax:** the screen, scrollback, mouse selection, copy and paste, links, colours, wide characters and emoji, full-screen programs (`less` was tried), tabs.
- **Follows VS Code:** colours come from the active theme and change live; font, size, line height, cursor and scrollback come from your `terminal.integrated.*` settings.
- **Stays with VS Code's built-in terminal:** tasks, debug sessions ("integratedTerminal"), "Run Python file in terminal" and other extensions' terminal features, environment variables other extensions add to terminals (virtualenv activation, git askpass), command decorations, terminal splits, terminal find. Those APIs only exist for VS Code's own terminals.
- **Commands and keys that make it feel like the terminal:** `Ctrl+`` shows, focuses and hides the panel the way the built-in one does; **Terax: New Terminal**, **Kill**, **Clear**, **Run Selected Text in Terax Terminal** (editor context menu) and **Open in Terax Terminal** (Explorer, on a folder).

## How it works

```
VS Code webview (Terax engine)  <-- postMessage -->  extension host (Node)  <-- stdin/stdout frames -->  helper (Rust)  <--> PTY <--> shell
```

| Part | Where | Role |
|---|---|---|
| Webview | `vscode-extension/webview/` | Runs Terax's terminal model and WebGL surface (`src/modules/terminal/ghostty`, `packages/ghostty-core`) **unmodified**, draws the tab bar, sends keystrokes and receives output. |
| Extension host | `vscode-extension/src/` | Registers the view and commands, picks the shell and folder, starts the helper, carries messages, slows a shell down when the page falls behind, does the clipboard and opens links. |
| Helper | `vscode-extension/helper/` | A small Rust program (`portable-pty`, the same crate as the app) that owns the pseudo-terminals. It exists because an extension cannot use VS Code's own `node-pty`, and a native Node module would have to be built for every Electron version. Its own Cargo workspace; it does not touch the app's `Cargo.toml`. |

How the engine is reused without editing upstream files: the webview build (`webview/vite.config.mts`) aliases the three Tauri modules the engine imports (`@tauri-apps/api/core`, `@tauri-apps/api/window`, the clipboard helper) to small stand-ins; the engine already checks `"__TAURI_INTERNALS__" in window` before using Tauri, so they are never called. A one-line build plugin keeps the engine's default WebAssembly address from being inlined as base64 (1.9 MB), since the page always passes the real one. The page is 160 kB (46 kB gzip, chat included) plus two WebAssembly files of about 680 kB.

## Keyboard

Keys go to the shell, because that is what a terminal is for: Ctrl+R, Ctrl+B, Ctrl+P, Ctrl+E and the rest do not trigger VS Code while the Terax terminal has focus (the same keys do trigger VS Code from the editor; both were checked). VS Code's built-in terminal does the opposite for some of them.

- **Keys VS Code keeps** are listed in `terax.skipShellKeys`: `F1`, `Ctrl+Shift+P`, `Ctrl+``, `Ctrl+Shift+``, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+PageUp/PageDown`. The page cannot ask VS Code which commands a key is bound to, so this is a list of keys; add your own (for example `ctrl+b`).
- **On macOS** every `Cmd` shortcut goes to VS Code (as in the Terax app).
- **Focus after the command palette:** VS Code leaves keyboard focus on the page body when the palette closes, for every webview view. `Ctrl+`` then returns to the terminal if the panel is showing, and only hides the panel when the terminal already has focus.
- **Taking over `Ctrl+``:** set `terax.takeOverShortcuts` to `false` to leave VS Code's own `Ctrl+`` alone.

## Install and settings

```sh
pnpm install                                # at the repository root
node vscode-extension/scripts/package.mjs   # builds everything and writes vscode-extension/terax-terminal-<system>-0.1.0.vsix
code --install-extension vscode-extension/terax-terminal-<system>-0.1.0.vsix
```

`vscode-extension/package.json` (the extension's own, outside the app's pnpm workspace) lists the settings: `terax.shell`, `terax.shellArgs`, `terax.cwd`, `terax.env`, `terax.takeOverShortcuts`, `terax.skipShellKeys`, and the chat's `terax.ai.*`. A shell is chosen from `terax.shell`, then the default terminal profile of VS Code, then `$SHELL` (PowerShell, then `COMSPEC` on Windows). The environment is the extension host's with `ELECTRON_*` and VS Code's internal variables removed, so an Electron app started from the terminal does not run as plain Node; `VSCODE_IPC_HOOK_CLI` is kept so `code file.txt` works.

The `.vsix` is built per system (`--target`) because it carries the helper binary: about 970 kB for Linux x64 (the extension host is one 795 kB file with the AI SDK and its providers inside).

## Limits and decisions

- **Terminals do not survive reloading the window.** The built-in terminal can restore them; this one starts fresh. While the panel is hidden the page is kept alive (`retainContextWhenHidden`), which costs memory but keeps the shells and their screens.
- **WebGL only.** The desktop app prefers WebGPU; WebGL is what a webview can rely on.
- **Links:** web links and OSC 8 hyperlinks open (through VS Code's own "open external website" prompt). `file:line` links to open in the editor are not implemented. Only `http`, `https` and `mailto` are passed on; the page cannot ask the host to open a `command:` or `file:` link.
- **No shell integration:** no command markers, no sticky scroll, no "run recent command".
- **Link clicks use pointer events.** The engine's own link handler listens for mouse events, and its selection code cancels `pointerdown`, which in Chromium suppresses them, so a click on a link did nothing. The webview detects the click itself from pointer events with the same lookup the engine uses.
- **Remote development:** the extension runs where the workspace is, so a Remote-SSH window starts shells on the remote machine. That needs the helper for the remote's system, which a per-system `.vsix` gives. Not tried.
- Version `0.1.0`, private, not published to a marketplace.

## What was verified

- **Unit tests (about 300, including the chat's, see `vscode-ai-chat.md`):** frame parser and encoder, flow control, shell and folder choice, environment cleaning, settings mapping, the page's HTML and its content security policy, the message router with fakes (start-up, shells, back-pressure, clipboard, links, focus, closing), the key matcher, and the helper client against the real helper.
- **Helper (Rust, 18 tests):** frames, and the real binary against real pseudo-terminals: output and exit codes, input and echo, resize, environment and working folder, kill (including a shell that ignores hangup), several shells at once, pause and resume, bad requests, and shells being taken down with the host. A bug found this way (a shell that ignores hangup survived "kill") was fixed.
- **End to end in real VS Code (25 checks in `vscode-extension/e2e/run.mjs`, plus 55 for the chat in `chat.mjs`):** code-server 4.108 (the web build of VS Code 1.108, with a Node extension host) with the `.vsix` installed, driven by headless Chromium. It checks that the panel opens and takes focus without a click; typing reaches a real shell; 200,000 lines of output are handled; shell keys do not leak to VS Code and the keys VS Code keeps do reach it; `Ctrl+`` in both directions and after the palette; the shell follows a panel resize; tabs; copy and paste through the clipboard; link clicks; running editor text and opening a folder; a live light/dark switch; `less`. Bugs found this way and fixed: new terminals did not take keyboard focus, "run selected text" was sent as a bracketed paste so the newline did not run it, links did not open (see above), and keyboard focus was lost after the command palette. Later, the chat's test found that after a webview reload the old shells' late "exit" reached the new page's first terminal (ids restarted at 1) and made it look dead; the host now gives each page the id to start from.
- **Not verified:** the **desktop** VS Code (Electron) and **macOS and Windows** at all. The web build shares the workbench and webview code with the desktop build, but key handling, clipboard and focus can differ. The helper compiles and passes `clippy -D warnings` for the macOS and Windows targets (cross-checked from Linux, which found one Windows-only warning that was fixed), but it was never run there: ConPTY through `portable-pty` and the Windows shell choice are untested. `fork-ci.yml` builds and tests the helper on Ubuntu, macOS and Windows and packages the extension on each, which will show how it really behaves. IME and composition input, WebGL on real GPUs, multi-window use and Remote development were not tried.

## Layout

| Path | Role |
|---|---|
| `vscode-extension/package.json`, `README.md`, `media/` | The extension manifest (commands, keys, settings), its readme and icon |
| `vscode-extension/src/` | Extension host (`extension.ts`, `router.ts`, `helperClient.ts`, `frames.ts`, `flow.ts`, `shell.ts`, `settings.ts`, `html.ts`, `helperPath.ts`) and its tests; `src/ai/` is the chat's agent |
| `vscode-extension/shared/` | Message types, the chat's events and the key matcher, used by both the host and the page |
| `vscode-extension/webview/` | The page: `main.ts` (tabs), `TerminalSession.ts`, `bridge.ts`, `index.css`, `shims/`, `vite.config.mts`; `chat/` is the chat's side |
| `vscode-extension/host.vite.config.mts` | Bundles the host into one file, so it can use Terax's AI code and the AI SDK without a `node_modules` in the `.vsix` |
| `vscode-extension/helper/` | The Rust helper and its tests |
| `vscode-extension/scripts/`, `e2e/` | Build and package scripts; the end-to-end test and how to run it |

There are **no seams**: nothing in an upstream file changed (the host only *imports* Terax's AI modules, it does not edit them). To remove the feature, delete `vscode-extension/`, this file, `vscode-ai-chat.md`, and the `vscode-extension` entries in `scripts/fork/seams.json`, `FORK.md` and `.github/workflows/fork-ci.yml`.
