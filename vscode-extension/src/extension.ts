import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";
import { VIEW_ID } from "../shared/messages";
import { ChatController } from "./ai/chat";
import { commandShell } from "./ai/commandShell";
import { registerAiCommands, runPageCommand } from "./ai/commands";
import { WorkspaceGuard } from "./ai/guard";
import { ApiKeys } from "./ai/keys";
import { createModel } from "./ai/model";
import { aiSettings, VSCODE_LM } from "./ai/settings";
import { buildTools } from "./ai/tools";
import { vscodeLm } from "./ai/vscodeLmApi";
import { buildHtml, makeNonce } from "./html";
import { findHelper, missingHelperMessage } from "./helperPath";
import { HelperClient } from "./helperClient";
import { SessionRouter } from "./router";
import { chooseCwd, chooseShell, profileFor, shellEnvironment } from "./shell";
import { type ConfigGetter, terminalSettings } from "./settings";

const CONTEXT_TAKE_OVER = "terax.takeOverShortcuts";

const getConfig: ConfigGetter = (section, fallback) => {
  const dot = section.lastIndexOf(".");
  return vscode.workspace.getConfiguration(section.slice(0, dot)).get(section.slice(dot + 1), fallback);
};

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
}

function osKey(platform: NodeJS.Platform): "windows" | "osx" | "linux" {
  return platform === "win32" ? "windows" : platform === "darwin" ? "osx" : "linux";
}

class TerminalViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private assetUrls = { wasmUrl: "", scalarWasmUrl: "" };
  private readonly router: SessionRouter;
  private readonly helper: HelperClient;
  private readonly output = vscode.window.createOutputChannel("Terax Terminal");
  readonly keys: ApiKeys;
  readonly chat: ChatController;

  constructor(private readonly context: vscode.ExtensionContext) {
    const log = (level: "info" | "warn" | "error", message: string) =>
      this.output.appendLine(`[${level}] ${message}`);
    this.helper = new HelperClient({
      executable: () => {
        const found = findHelper(context.extensionPath, process.platform, process.arch, fs.existsSync);
        if (!found) {
          throw new Error(
            missingHelperMessage(context.extensionPath, process.platform, process.arch, (dir) => fs.readdirSync(dir)),
          );
        }
        return found;
      },
      env: () => shellEnvironment(process.env, {}),
      log,
    });
    this.keys = new ApiKeys(context.secrets);
    const guard = new WorkspaceGuard(workspacePaths);
    this.chat = new ChatController({
      post: (event) => {
        if (this.router.isReady) void this.view?.webview.postMessage({ type: "chat", event });
        this.showPendingBadge();
      },
      settings: () => aiSettings(getConfig),
      apiKey: async (settings) => (settings.provider === VSCODE_LM ? undefined : this.keys.get(settings.provider)),
      buildModel: (settings, key) => createModel(settings, key, vscodeLm),
      buildTools,
      toolContext: () => ({
        guard,
        readTerminal: (lines) => this.router.readTerminalText(lines),
        shell: () => {
          const plan = this.launchPlan();
          return { file: plan.file, args: commandShell(plan.file, process.platform).args, env: plan.env };
        },
        commandTimeoutSeconds: () => aiSettings(getConfig).commandTimeoutSeconds,
      }),
      folders: workspacePaths,
      shellName: () => this.launchPlan().title,
      // Shown without taking the keyboard, so a question is seen but typing is not interrupted.
      reveal: () => this.view?.show(true),
    });
    this.router = new SessionRouter({
      helper: this.helper,
      post: (message) => void this.view?.webview.postMessage(message),
      terminalSettings: () =>
        terminalSettings((section, fallback) => {
          const dot = section.lastIndexOf(".");
          return vscode.workspace.getConfiguration(section.slice(0, dot)).get(section.slice(dot + 1), fallback);
        }),
      isMac: process.platform === "darwin",
      assets: () => this.assetUrls,
      launch: (cwd) => this.launchPlan(cwd),
      clipboard: {
        read: async () => vscode.env.clipboard.readText(),
        write: async (text) => vscode.env.clipboard.writeText(text),
      },
      openLink: (uri) => void vscode.env.openExternal(vscode.Uri.parse(uri)),
      log,
      chat: this.chat,
      runPageCommand,
    });
  }

  /** A number on the panel's icon while the agent waits for an answer, in case the panel is hidden. */
  private showPendingBadge(): void {
    if (!this.view) return;
    const waiting = this.chat.pendingApprovals.length;
    // A badge of 0 is not drawn. Unsetting it with `undefined` left the old number showing in VS Code 1.108.
    this.view.badge = {
      value: waiting,
      tooltip: waiting === 1 ? "Terax AI is waiting for your answer" : waiting > 1 ? `Terax AI is waiting for ${waiting} answers` : "",
    };
  }

  private launchPlan(cwdFromPage?: string) {
    const shellConfig = vscode.workspace.getConfiguration("terax");
    const terminalConfig = vscode.workspace.getConfiguration("terminal.integrated");
    const exists = fs.existsSync;
    const profile = profileFor(
      terminalConfig.get(`profiles.${osKey(process.platform)}`),
      terminalConfig.get(`defaultProfile.${osKey(process.platform)}`),
      exists,
    );
    const choice = chooseShell(
      {
        shell: shellConfig.get<string>("shell", ""),
        shellArgs: shellConfig.get<string[]>("shellArgs", []),
        profilePath: profile.path,
        profileArgs: profile.args,
      },
      { platform: process.platform, env: process.env, home: os.homedir(), exists },
    );
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const configuredCwd = shellConfig.get<string>("cwd", "").replace("${workspaceFolder}", workspaceFolder ?? "");
    return {
      ...choice,
      cwd: chooseCwd([cwdFromPage, configuredCwd, workspaceFolder], os.homedir(), exists),
      env: shellEnvironment(process.env, shellConfig.get<Record<string, string>>("env", {})),
    };
  }

  get resolved(): boolean {
    return this.view !== undefined;
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  get routerApi(): SessionRouter {
    return this.router;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const uri = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(root, name)).toString();

    this.assetUrls = {
      wasmUrl: uri("ghostty-vt.wasm"),
      scalarWasmUrl: uri("ghostty-vt-scalar.wasm"),
    };

    view.webview.html = buildHtml({
      nonce: makeNonce((n) => crypto.randomBytes(n)),
      cspSource: view.webview.cspSource,
      scriptUri: uri("main.js"),
      styleUri: uri("index.css"),
    });
    view.webview.onDidReceiveMessage((message) => this.router.receive(message));
    this.showPendingBadge();
    view.onDidDispose(() => {
      this.view = undefined;
      this.router.pageClosed();
    });
  }

  dispose(): void {
    this.chat.stop();
    this.router.pageClosed();
    this.helper.dispose();
    this.output.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TerminalViewProvider(context);
  const setTakeOver = () =>
    void vscode.commands.executeCommand(
      "setContext",
      CONTEXT_TAKE_OVER,
      vscode.workspace.getConfiguration("terax").get<boolean>("takeOverShortcuts", true),
    );
  setTakeOver();

  const focus = async () => {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  };

  const focusChat = async (prefill?: string) => {
    if (prefill !== undefined) provider.routerApi.send({ type: "chat-prefill", text: prefill });
    await focus();
    provider.routerApi.send({ type: "chat-focus" });
  };
  registerAiCommands(context, { keys: provider.keys, chat: provider.chat, focusChat });

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("terax.takeOverShortcuts")) setTakeOver();
      if (event.affectsConfiguration("terax.ai")) provider.routerApi.modelChanged();
      if (
        event.affectsConfiguration("terminal.integrated") ||
        event.affectsConfiguration("editor.fontFamily")
      ) {
        provider.routerApi.settingsChanged();
      }
    }),
    vscode.commands.registerCommand("terax.terminal.focus", async () => {
      await focus();
      provider.routerApi.send({ type: "focus" });
    }),
    vscode.commands.registerCommand("terax.terminal.toggle", async () => {
      // Like VS Code's own terminal: hide the panel only when the terminal has focus. Visible but
      // unfocused (for example after the command palette closed) means "take me back to it".
      if (provider.visible && provider.routerApi.isFocused) {
        await vscode.commands.executeCommand("workbench.action.closePanel");
      } else {
        await focus();
        provider.routerApi.send({ type: "focus" });
      }
    }),
    vscode.commands.registerCommand("terax.terminal.new", async () => {
      // The first terminal is made when the page starts, so a not-yet-opened view needs no extra one.
      const first = !provider.resolved;
      await focus();
      if (!first) provider.routerApi.newTerminal();
    }),
    vscode.commands.registerCommand("terax.terminal.newInFolder", async (uri?: vscode.Uri) => {
      const folder = uri?.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const first = !provider.resolved;
      if (first) provider.routerApi.newTerminal(folder);
      await focus();
      if (!first) provider.routerApi.newTerminal(folder);
    }),
    vscode.commands.registerCommand("terax.terminal.kill", () => provider.routerApi.send({ type: "kill-active" })),
    vscode.commands.registerCommand("terax.terminal.clear", () => provider.routerApi.send({ type: "clear" })),
    vscode.commands.registerCommand("terax.terminal.sendText", async (args?: { text?: string; addNewLine?: boolean }) => {
      if (!args?.text) return;
      await focus();
      provider.routerApi.send({ type: "send-text", text: args.addNewLine === false ? args.text : `${args.text}\n` });
    }),
    vscode.commands.registerCommand("terax.terminal.runSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.selection.isEmpty
        ? editor.document.lineAt(editor.selection.active.line).text
        : editor.document.getText(editor.selection);
      await focus();
      provider.routerApi.send({ type: "send-text", text: `${text}\n` });
    }),
  );
}

export function deactivate(): void {}
