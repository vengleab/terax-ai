# Terax Terminal for VS Code

A terminal panel for VS Code that is drawn by [Terax](https://github.com/crynta/terax-ai)'s own terminal
engine (libghostty-vt in WebAssembly, with a WebGL renderer) instead of VS Code's built-in terminal.

It adds a **Terax** tab to the bottom panel, next to Problems, Output and Terminal.

- Tabs, copy and paste, mouse selection, links, scrollback, full-screen programs, truecolor, wide characters.
- Follows your VS Code theme and the font, cursor and scrollback settings you already have for the terminal.
- `Ctrl+`` opens and hides the panel (like the built-in terminal); `terax.takeOverShortcuts` turns that off.
- Commands: **Terax: New Terminal**, **Focus Terminal**, **Toggle Terminal Panel**, **Kill / Clear Terminal**,
  **Run Selected Text in Terax Terminal**, and **Open in Terax Terminal** on a folder in the Explorer.

It does not replace VS Code's integrated terminal: tasks, debug sessions and other extensions keep using that.
See `docs/fork/vscode-extension.md` in the repository for what works, what was tested and the limits.

## Settings

| Setting | |
|---|---|
| `terax.shell`, `terax.shellArgs` | The shell to run. Empty: your default terminal profile, then `$SHELL`. |
| `terax.cwd` | Where new terminals start. Empty: the workspace folder, then your home folder. |
| `terax.env` | Extra environment variables. |
| `terax.takeOverShortcuts` | Make `Ctrl+`` and `Ctrl+Shift+`` use Terax. |
| `terax.skipShellKeys` | Keys VS Code keeps while the terminal has focus. Everything else goes to the shell. |

## Building

```sh
pnpm install                          # at the repository root
node vscode-extension/scripts/build.mjs    # webview, extension host and helper into dist/
node vscode-extension/scripts/package.mjs  # a .vsix for this system, with the helper included
```
