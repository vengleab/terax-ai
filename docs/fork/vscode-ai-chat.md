# Terax AI chat in VS Code

The Terax panel in VS Code (see `vscode-extension.md`) has a **chat below the terminal**. You talk to an AI agent there; it can read your project and your terminal on its own, and **a popup asks you before it runs a command or changes a file**.

```
┌ Terax ──────────────────────────────────────────┐
│ [bash] [+]                                       │   the terminal (Terax's engine)
│ $ npm test                                       │
│ ...                                              │
├──────────────── drag to resize ──────────────────┤
│ ▾ Terax AI  [OpenAI · GPT-5.4]        New chat   │
│  you: why does the test fail?                    │   the chat
│  ● Read terminal   terminal output   done        │
│  ● Run command  npm test -- --bail   waiting…    │
│ ┌ Ask Terax…                          ┐ [ Send ] │
└──────────────────────────────────────────────────┘
        ┌─────────────────────────────────┐
        │ Run command  Terax wants to ... │   the popup, over everything
        │ $ npm test -- --bail            │
        │ in /home/me/app                 │
        │ Esc to deny        [Deny] [Run] │
        └─────────────────────────────────┘
```

## Setting it up

**With GitHub Copilot** (the default): install and sign in to the GitHub Copilot Chat extension, open the Terax chat and send a message. VS Code asks once whether Terax may use the model; allow it. To pick a model, run **Terax: Select AI Model**, choose *GitHub Copilot*, then a model from the list VS Code gives. Nothing else to set up: no key, no token. Terax never sees your GitHub credentials; VS Code does the sign-in and the request.

**With another provider:**

1. Run **Terax: Select AI Model** from the command palette. Pick a provider, then a model (or type a model name; local and custom servers need one).
2. It asks for the **API key** if the provider needs one (or run **Terax: Set AI API Key** later). The key is kept in VS Code's secret storage on your computer. It is never written to a settings file, and the page (the web view) never sees it.
3. Click in the chat, type, press Enter.

Providers:

- **GitHub Copilot, and any other model VS Code offers** (`vscode-lm`), through VS Code's language model API. If another extension registers models, they appear in the same list as `vendor/id`.
- OpenAI, Anthropic, Google (Gemini), xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter, any OpenAI-compatible server (`terax.ai.baseUrl`), and the local servers LM Studio, MLX and Ollama (no key). These are the same providers, model lists and addresses as in the Terax app.
- **Google Vertex AI** (`google-vertex`): Gemini on Google Cloud, signed in with a **service account key file** instead of an API key. See below.
- **Not included:** The Terax app's own Copilot sign-in (a device login) is not used here: inside VS Code the language model API is the supported way and needs no token.

**With Google Vertex AI (a Google Cloud service account):**

1. In Google Cloud, enable the *Vertex AI API* for the project that should pay, create a service account with the *Vertex AI User* role, and download a **JSON key** for it.
2. Run **Terax: Select AI Model**, choose *Google Vertex AI*, then a Gemini model (the default is `gemini-2.5-flash`). It then asks for the key file: pick the `.json` you downloaded. Or run **Terax: Choose Google Service Account Key File** any time.
3. `terax.ai.vertex.location` (default `global`, or a region such as `us-central1`) and `terax.ai.vertex.project` (only to bill a different project than the key's own) are settings.

The key file is **not copied and not stored**: only its path is a setting (`terax.ai.vertex.keyFile`, user settings only), and the file is read from where it is for every request. Nothing goes to VS Code's secret storage or any keychain. If you move or delete the file, the chat says "Could not read <path>" with a **Choose key file** button. **Forget Google Service Account Key File** removes the setting and leaves the file alone. Anyone who can read the file can use the account, so keep it where only you can (for example `chmod 600`). It works through Vertex AI's OpenAI-compatible endpoint, with the same sign-in (a JWT signed with the file's key, exchanged at Google for an access token that is kept in memory and renewed a minute before it expires) and the same address rules as the Terax app: the token address in the file is only used if it is under `googleapis.com`, and the location and project are checked because they become part of the address. Only Gemini models are supported; Claude on Vertex uses a different API.

**Why `vscode.lm` and not a Copilot login of Terax's own:** it is the route VS Code offers extensions for exactly this, it uses the subscription and the sign-in you already have, and Terax holds no GitHub token. It needs **VS Code 1.95 or newer** (the version that added tools to the API) and the Copilot Chat extension.

## What the agent can do

| Tool | Asks first? | What it does |
|---|---|---|
| `read_file`, `list_directory`, `glob`, `grep` | no | Look at files in your workspace folders. |
| `read_terminal` | no | Read the last lines of the terminal you are looking at (up to 300), so "explain this error" works. |
| `write_file` | **yes** | Create a file or replace one. The popup shows what will be written. |
| `edit_file` | **yes** | Replace text in a file it has read. The popup shows the removed and added lines. |
| `run_command` | **yes** | Run one command with your shell and return its output. The popup shows the command and the folder. |

The popup covers the whole page and waits. **Run** or **Allow** goes ahead, **Deny** (or `Esc`) tells the agent you said no and it does not try again. `Ctrl/Cmd+Enter` allows. Plain `Enter` does nothing, so a stray key press while you are typing cannot allow anything. If the panel is hidden, it is shown (without taking your keyboard) and the tab gets a number. Stopping the chat, starting a new one, or reloading the window counts as "no" for anything still waiting.

Other things in the chat:

- Answers are drawn with formatting; code blocks have **Copy** and **Insert in terminal**. Insert puts the text at the prompt **without running it**; a block of several lines is only inserted when the shell has bracketed paste (otherwise the lines would run as they arrive), and is copied instead.
- Tool calls are cards with a status (running, waiting for you, done, denied, stopped); open one to see a command's output.
- **Stop** (or `Esc` in the message box) ends a turn; **New chat** starts over. `↑`/`↓` in the message box recall earlier messages.
- The line between the terminal and the chat can be dragged (double-click resets it); the arrow folds the chat away. The size is remembered.
- **Terax: Ask Terax AI About Selection** (editor context menu) puts the selected code and its file in the message box.

Commands: **Focus AI Chat**, **New AI Chat**, **Stop AI**, **Select AI Model**, **Set AI API Key**, **Remove AI API Key**, **Open AI Settings**, **Ask Terax AI About Selection**.

Settings (`terax.ai.*`): `provider` (default `vscode-lm`), `model` (for `vscode-lm`, `vendor/id` as the picker saves it; empty means the first Copilot model), `baseUrl` (user settings only, see below), `maxSteps` (24: the most steps for one message), `commandTimeoutSeconds` (60).

## How it works

```
page (chat UI)  <-- postMessage -->  extension host: ChatController -> agent loop -> provider (HTTPS)
                                                         |                |
                                                    ApprovalBroker      tools: files, shell, terminal text
```

The agent runs in the **extension host** (Node), not in the page: the host can call providers without browser CORS limits, keeps the API key away from the page, and keeps the conversation when the page is reloaded (the page is brought up to date by replaying the events). The host is bundled with Vite (`host.vite.config.mts`) so it can import from Terax's own code without touching it: the model list and provider addresses (`src/modules/ai/config.ts`), the deny-lists for secret files and dangerous commands (`lib/security.ts`), the secret redaction (`lib/redact.ts`) and the error messages (`lib/errors.ts`). The loop is the Vercel AI SDK (`streamText` with tools), the same SDK as the app.

| File | Role |
|---|---|
| `src/ai/chat.ts` | One conversation: history, events, running turn, stop and reset |
| `src/ai/agent.ts` | One turn of the loop: streams text, runs tools, reports each step |
| `src/ai/tools.ts` | The eight tools and what each asks |
| `src/ai/guard.ts` | Which files a tool may touch |
| `src/ai/approvals.ts` | Questions waiting for an answer |
| `src/ai/exec.ts`, `commandShell.ts` | Running one command: timeout, output limit, process group, the user's shell |
| `src/ai/diff.ts`, `walk.ts` | Previews of changes; a bounded folder walk for `glob` and `grep` |
| `src/ai/model.ts`, `settings.ts`, `keys.ts`, `prompt.ts` | Providers, settings, secret storage, the instructions the model gets |
| `src/ai/vertex.ts` | Google Vertex AI: reads the key file, signs in and builds the model with the app's own Vertex modules (`src/modules/ai/providers/google-vertex`), which the host imports; errors as chat messages with a **Choose key file** button |
| `src/ai/vscodeLm.ts`, `vscodeLmApi.ts` | The AI SDK model that talks to VS Code's language models (Copilot): messages, tools, streaming, errors, stop. `vscodeLmApi.ts` is the only file that touches `vscode.lm`; the rest is tested without VS Code |
| `src/ai/commands.ts`, `pickers.ts` | The commands and the pickers behind them |
| `shared/chat.ts` | The events between host and page |
| `webview/chat/` | The page's side: `state.ts` (events to view), `markdown.ts` (safe reader), `render.ts`, `approval.ts`, `panel.ts`, `layout.ts` |

## What keeps it safe

- **Only the workspace.** Every path is resolved against the open folders after symlinks are followed (so a link into `~/.ssh` is refused), and must pass Terax's own deny-list (`.env`, keys, `.git`, system folders). A secret file's content never reaches the model: `read_file`, `grep` and `glob` skip it.
- **Nothing changes without you.** Writes, edits and commands wait for the popup. An edit needs the file to have been read first, so the agent works from what is really there.
- **Commands** are checked against Terax's list of destructive patterns before you are even asked (`rm -rf /`, and so on, refused without a popup), run in the folder shown, with a timeout, with the standard input closed (a program that waits for input ends instead of hanging), with the output size capped and secrets in the output redacted, and the whole process group is stopped on timeout or Stop.
- **The page is only a web page.** It can ask the host for three commands (set the key, choose the model, open settings); anything else is refused and logged. Links in answers open only when they are `http`, `https` or `mailto`, through VS Code's own prompt. The reader never produces HTML: answers become elements built from text, so nothing a model writes can become script.
- **Where your prompts go.** `terax.ai.provider`, `model` and `baseUrl` are `machine`-scoped settings: a project's `.vscode/settings.json` cannot change them, so a repository cannot point your prompts, files and key at a server it chose. The shell settings (`terax.shell`, `shellArgs`, `cwd`, `env`) are declared restricted in an untrusted workspace; VS Code enforces that, and it was not tried here.

**What this is not.** It is not a sandbox. A command you approve runs with your full rights, and an agent can write a script (popup) and then run it (popup). Read what the popup shows. Text the agent reads (files, terminal output, command output) can contain instructions meant for it; the popups are what stand between that and your machine. And everything the agent reads (files, what `read_terminal` returns) is sent to the provider you chose; secrets matching Terax's patterns are redacted from terminal and command output, which is best effort and not a guarantee.

## Limits

- **One conversation**, kept in memory: it survives reloading the page ("Reload Webviews") but not restarting VS Code or the extension host. The last 80 messages are sent to the model; there is no summarising and no token counting beyond what the provider reports.
- No images, attachments or `@file` mentions; no multi-root choice of base folder (relative paths use the first workspace folder).
- Output of tools is capped: 2000 lines or 25 KB of a file, 300 listing entries, 200 `glob` or `grep` results, 60 KB of command output.
- `run_command` is for commands that finish. Servers, watchers and interactive programs are not what it is for; use the terminal above.
- Only the active Terax terminal can be read, and nothing is typed into it by the agent (it runs commands itself, in a separate process, so a running program in your terminal is never disturbed).

## What was verified, and what was not

- **Unit tests:** 197 for the host side (guard, tools, command execution, approvals, the loop with a scripted model, the chat controller, model creation for every provider, settings, keys, prompt, pickers, command shell, the VS Code language model adapter, Google Vertex AI), 46 for the page's side (the Markdown reader including hostile input, the event-to-view state, layout rules), 28 for the router.
- **End to end in real VS Code** (code-server 4.108 = VS Code 1.108 on the web, headless Chromium, `vscode-extension/e2e/chat.mjs`, 55 checks) against a **scripted fake OpenAI-compatible server**, so the whole path runs: page, host, the AI SDK's HTTP streaming and tool calls, tools, the popup, files and shell on disk. Checked: layout and the model name in the header; a reading tool runs without asking and the answer is drawn; the model is given the eight tools and the workspace; Insert in terminal does not run; a command is held until **Run**, with its folder shown, Enter alone does not approve, the panel tab shows a number and clears; output is shown and given to the model; **Deny**, **Esc**, **Ctrl+Enter**; write and edit show their changes before they are applied; an edit without a prior read, a write outside the workspace, a secrets file, and a destructive command are refused without a popup and the secret never reaches the model; the agent reads the terminal; **Stop** ends a turn and abandons the request, also while a question is open (from the palette); a question that arrives while the panel is **hidden** brings the panel back, with the popup showing and the command not yet run; a click on the dimmed area does not lose the keyboard; after **Reload Webviews** the conversation and a still-waiting question come back and answering it runs the command; dragging the splitter and folding the chat change the terminal's rows; the commands; **Set AI API Key** (hidden field) is kept in secret storage and sent as the bearer token, and is not in the settings file; **Select AI Model** changes the header at once and the next request's model; New chat leaves nothing from before for the model. The terminal-only e2e (`run.mjs`, 25 checks) still passes with the chat present.
- Bugs found by that test and fixed: clicking the dimmed area dropped keyboard focus out of the popup so `Esc` stopped working; and, **not related to the chat**, a webview reload made the old shells' late "exit" hit the new page's first terminal (ids restarted at 1), so the terminal looked dead. The host now tells each page which id to start from.
- **GitHub Copilot path** (`e2e/chat-lm.mjs`, 14 checks, in the same code-server): Copilot cannot run there, so a small provider extension (`e2e/fake-lm-extension/`) registers a scripted model through the same `vscode.lm` API Copilot uses, and Terax drives it as it would Copilot. Checked: the default is *GitHub Copilot* with no setup; **Select AI Model** lists *GitHub Copilot* first (no key needed) and then the models VS Code has; the choice is saved and the header follows; a turn goes through VS Code's API with Terax's instructions first, the question last and the eight tools; a tool's result goes back to the model as a result for the same call; the popup holds a command, **Run** runs it, **Deny** tells the model; **Stop** ends the turn at once even when the model never answers; the chat carries on afterwards. 26 unit tests cover the adapter (message and tool conversion, streaming, model choice, permission and blocked errors, cancellation, a model that ignores the cancellation).
- A real gap the e2e found and fixed: Stop first only cancelled VS Code's token and waited for the stream to end, which never happened with a stalled model; the adapter now stops waiting at once.
- **Google Vertex AI** (`e2e/chat-vertex.mjs`, 14 checks, same code-server; 20 unit tests in `src/ai/vertex.test.ts`): the unit tests sign with a **real RSA key** and check the JWT's signature and claims with the matching public key, check the exact Vertex address, model name (`google/gemini-2.5-flash`), project and location, the bearer token, the tool-call round trip, that a token is reused and renewed (and the request retried once) on a 401, that a key file that disappears between messages is reported, that the token address is only ever `googleapis.com`, and that no request carries the private key. The e2e covers the provider and model pickers, the file dialog (a non-service-account file is refused and nothing saved; a good one is accepted and its account and project shown), that only the path is saved, and what the chat says when sign-in fails. In the sandbox the sign-in reached the real Google token endpoint (through its proxy) and Google answered "Invalid grant: account not found" for the test's made-up account: that is a real response to a well-formed signed request, and it shows up in the chat with a **Choose key file** button.
- **Not verified:**
  - **A real Vertex AI call**: there is no real service account here, so the request to Vertex itself (Gemini's answers, streaming and tool calls through its OpenAI-compatible endpoint, which a Google-side change could break) has only run against a stand-in. Model names, regions and quotas change; the model field is free text and Google's own error message is shown. The Vertex request code is the app's, which has the same limit.
  - **GitHub Copilot itself was not used** (it cannot run in the sandbox, and there is no subscription). What is verified is Terax's side of the `vscode.lm` API with a stand-in provider. How real Copilot models behave is not: whether a model supports tools (one that does not will answer with an error), the size of its context (a long conversation or a big tool result can exceed it), its quota and rate limits, and the first-use consent prompt (it did not appear for the stand-in, so its wording and flow are unseen).
  - **Stopping does not always stop the model.** Terax cancels the request and stops waiting at once, but in VS Code 1.108 the model's extension was not told about the cancellation (the stand-in's token never fired), so a provider may keep generating, and counting against a quota, until it finishes. That is VS Code's behaviour, seen with the stand-in; it may differ for Copilot.
  - **No real AI provider was called** (no network or keys in the sandbox). The OpenAI-compatible wire path ran against the fake server; the native OpenAI, Anthropic, Google, xAI and other providers use the same SDK and are built in the unit tests, but no request to them was made. A provider changing its API, or a model that answers badly to tool calls, would show up only in real use.
  - **How well a real model uses the tools** (follows the instructions, picks sensible commands) was not assessed: the model in the tests is a script.
  - **The desktop VS Code (Electron), macOS and Windows.** The command shell choice for PowerShell, `cmd` and macOS login shells is unit-tested, not run. `fork-ci.yml` runs the unit tests on all three systems; the end-to-end test needs a code-server and is not in CI.
  - Remote development, multiple windows, and screen readers (the popup has dialog roles and a focus trap; it was not tried with one).

To remove the chat, delete `vscode-extension/src/ai/`, `webview/chat/`, `shared/chat.ts`, the chat parts of `router.ts`, `extension.ts`, `main.ts`, `index.css` and `html.ts`, the `terax.ai.*` entries of the manifest, and this file.
