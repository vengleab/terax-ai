import * as vscode from "vscode";
import { getProvider } from "../../../src/modules/ai/config";
import type { PageCommand } from "../../shared/chat";
import type { ChatController } from "./chat";
import type { ApiKeys } from "./keys";
import { modelItems, OTHER_MODEL, providerItems, selectionPrompt } from "./pickers";
import { aiSettings, defaultBaseUrl, needsApiKey, SUPPORTED_PROVIDERS, type SupportedProvider } from "./settings";

export type AiCommandApi = {
  keys: ApiKeys;
  chat: ChatController;
  /** Shows the Terax panel and puts the cursor in the chat's message box, with `prefill` typed in it. */
  focusChat: (prefill?: string) => Promise<void>;
};

const config = () => vscode.workspace.getConfiguration("terax.ai");
const settings = () => aiSettings((section, fallback) => vscode.workspace.getConfiguration().get(section, fallback));

async function setApiKey(api: AiCommandApi): Promise<void> {
  const provider = settings().provider;
  const label = getProvider(provider).label;
  const key = await vscode.window.showInputBox({
    title: `Terax AI: API key for ${label}`,
    prompt: needsApiKey(provider)
      ? "Kept in VS Code's secret storage on this computer, never in settings files."
      : `${label} usually needs no key. Enter one only if your server asks for it.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Paste the key, or press Escape to cancel."),
  });
  if (key === undefined) return;
  await api.keys.set(provider, key);
  void vscode.window.showInformationMessage(`Terax AI: the ${label} key is saved.`);
}

async function clearApiKey(api: AiCommandApi): Promise<void> {
  const provider = settings().provider;
  await api.keys.clear(provider);
  void vscode.window.showInformationMessage(`Terax AI: the ${getProvider(provider).label} key was removed.`);
}

async function selectModel(api: AiCommandApi): Promise<void> {
  const current = settings();
  const saved = new Set<string>();
  for (const provider of SUPPORTED_PROVIDERS) if (await api.keys.has(provider)) saved.add(provider);

  const chosenProvider = await vscode.window.showQuickPick(providerItems((p) => saved.has(p), current.provider), {
    title: "Terax AI: choose a provider (1 of 2)",
    placeHolder: "Which service should answer?",
  });
  if (!chosenProvider) return;
  const provider: SupportedProvider = chosenProvider.value;

  const picked = await vscode.window.showQuickPick(modelItems(provider, provider === current.provider ? current.model : ""), {
    title: `Terax AI: choose a model for ${getProvider(provider).label} (2 of 2)`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  let model: string;
  if (picked.value === OTHER_MODEL) {
    const typed = await vscode.window.showInputBox({
      title: `Terax AI: model name for ${getProvider(provider).label}`,
      prompt: "The model id exactly as the provider names it.",
      value: provider === current.provider ? current.model : "",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : "Enter a model name, or press Escape to cancel."),
    });
    if (typed === undefined) return;
    model = typed.trim();
  } else {
    model = picked.value;
  }

  let baseUrl: string | undefined;
  if (provider === "openai-compatible" && !current.baseUrl) {
    baseUrl = await vscode.window.showInputBox({
      title: "Terax AI: server address",
      prompt: "The OpenAI-compatible base URL, for example https://my-gateway.example.com/v1",
      ignoreFocusOut: true,
      validateInput: (value) => (/^https?:\/\/\S+$/.test(value.trim()) ? undefined : "Enter an address starting with http:// or https://"),
    });
    if (baseUrl === undefined) return;
  }

  const target = vscode.ConfigurationTarget.Global;
  await config().update("provider", provider, target);
  await config().update("model", model, target);
  if (baseUrl) await config().update("baseUrl", baseUrl.trim(), target);
  else if (provider !== current.provider && defaultBaseUrl(provider) === "") await config().update("baseUrl", undefined, target);

  if (needsApiKey(provider) && !(await api.keys.has(provider))) await setApiKey(api);
}

async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:terax-fork.terax-terminal terax.ai");
}

async function askAboutSelection(api: AiCommandApi): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return;
  const file = vscode.workspace.asRelativePath(editor.document.uri, false);
  const text = editor.document.getText(editor.selection);
  await api.focusChat(selectionPrompt(file, editor.document.languageId, text, editor.selection.start.line + 1));
}

/** The commands the chat page itself may ask for. Everything else it sends is refused by the router. */
export function runPageCommand(command: PageCommand): void {
  void vscode.commands.executeCommand(command);
}

export function registerAiCommands(context: vscode.ExtensionContext, api: AiCommandApi): void {
  const guard =
    <A extends unknown[]>(fn: (...args: A) => Promise<void> | void) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(`Terax AI: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  context.subscriptions.push(
    vscode.commands.registerCommand("terax.ai.focusChat", guard(() => api.focusChat())),
    vscode.commands.registerCommand("terax.ai.newChat", guard(() => api.chat.reset())),
    vscode.commands.registerCommand("terax.ai.stop", guard(() => api.chat.stop())),
    vscode.commands.registerCommand("terax.ai.setApiKey", guard(() => setApiKey(api))),
    vscode.commands.registerCommand("terax.ai.clearApiKey", guard(() => clearApiKey(api))),
    vscode.commands.registerCommand("terax.ai.selectModel", guard(() => selectModel(api))),
    vscode.commands.registerCommand("terax.ai.openSettings", guard(() => openSettings())),
    vscode.commands.registerCommand("terax.ai.askAboutSelection", guard(() => askAboutSelection(api))),
  );
}
