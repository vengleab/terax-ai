import * as vscode from "vscode";
import type { LmApi, LmClassified, LmMessage, LmModel, LmPart } from "./vscodeLm";

type Content = (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[];

/** Connects the chat to VS Code's language model API. */
export const vscodeLm: LmApi = {
  async models(selector) {
    const found = await vscode.lm.selectChatModels(selector);
    return found.map(
      (m): LmModel => ({
        id: m.id,
        vendor: m.vendor,
        family: m.family,
        name: m.name,
        maxInputTokens: m.maxInputTokens,
        send: async (messages: LmMessage[], options, token) =>
          (
            await m.sendRequest(
              messages as vscode.LanguageModelChatMessage[],
              { justification: options.justification, tools: options.tools },
              token as vscode.CancellationToken,
            )
          ).stream,
      }),
    );
  },
  user: (parts: LmPart[]) => vscode.LanguageModelChatMessage.User(parts as Content),
  assistant: (parts: LmPart[]) =>
    vscode.LanguageModelChatMessage.Assistant(parts as (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[]),
  text: (value) => new vscode.LanguageModelTextPart(value),
  toolCall: (callId, name, input) => new vscode.LanguageModelToolCallPart(callId, name, input),
  toolResult: (callId, text) => new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(text)]),
  classify(part): LmClassified {
    if (part instanceof vscode.LanguageModelTextPart) return { kind: "text", value: part.value };
    if (part instanceof vscode.LanguageModelToolCallPart) return { kind: "tool-call", callId: part.callId, name: part.name, input: part.input };
    return { kind: "other" };
  },
  cancellation() {
    const source = new vscode.CancellationTokenSource();
    return { token: source.token, cancel: () => source.cancel(), dispose: () => source.dispose() };
  },
  classifyError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof vscode.CancellationError) return { kind: "cancelled", message };
    if (error instanceof vscode.LanguageModelError) {
      const code = error.code.toLowerCase();
      if (code.includes("nopermissions")) return { kind: "permission", message };
      if (code.includes("blocked")) return { kind: "blocked", message };
      if (code.includes("notfound")) return { kind: "not-found", message };
    }
    return { kind: "other", message };
  },
};
