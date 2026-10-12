# End-to-end test

`run.mjs` drives a real VS Code (code-server, the web build of VS Code with a Node extension host) that has the
extension installed, using Playwright and a headless Chromium. It checks the things that only a real VS Code
can show: the panel, focus, which keys reach the shell, the clipboard, links, tabs, the theme, full-screen
programs and the commands.

```sh
node vscode-extension/scripts/package.mjs                      # builds the .vsix
code-server --install-extension vscode-extension/terax-terminal-<system>-0.1.0.vsix --force \
  --user-data-dir /tmp/e2e/ud --extensions-dir /tmp/e2e/ext
code-server --bind-addr 127.0.0.1:8090 --auth none --disable-workspace-trust \
  --user-data-dir /tmp/e2e/ud --extensions-dir /tmp/e2e/ext /tmp/e2e/work &
TERAX_E2E_WORKSPACE=/tmp/e2e/work PLAYWRIGHT_NODE_MODULES=/path/to/node_modules node vscode-extension/e2e/run.mjs /tmp/e2e/shots
```

`chat.mjs` tests the AI chat the same way, against a scripted fake OpenAI-compatible server (`fake-openai.mjs`), so no
provider or key is needed. It also needs the code-server's user settings file, which it overwrites (before the page
loads) to point the chat at the fake server, and deletes `Machine/settings.json` next to its `User` folder: the chat's
provider, model and address are machine-scoped settings, and choosing a model through the palette (which the test does)
stores it there, where it would win over the file on the next run. The code-server must be started with that user data folder:

```sh
TERAX_E2E_WORKSPACE=/tmp/e2e/work TERAX_E2E_SETTINGS=/tmp/e2e/ud/User/settings.json \
  PLAYWRIGHT_NODE_MODULES=/path/to/node_modules node vscode-extension/e2e/chat.mjs /tmp/e2e/shots
```

It needs `playwright` with a Chromium (`CHROMIUM_PATH` if Playwright's own is not installed) and Linux or macOS, because
the checks use `stty`, `less` and files in `/tmp`.

It was developed against code-server 4.108 (VS Code 1.108), run in a sandbox without access to GitHub. There
the npm package could not install as it is: its VS Code dependencies include a fork of the file watcher fetched
from GitHub, and `@vscode/ripgrep` downloads its binary from GitHub, so both were left out (and `kerberos`, which
needs system headers). VS Code starts without them; file search and file watching do not work. On a normal
machine `npm install -g code-server` or the install script is enough.

This is the web build of VS Code. The desktop build (Electron) shares the same workbench and webview code but
has not been tested.
