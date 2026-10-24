// A language model provider for VS Code that plays back a script, so Terax's use of `vscode.lm` can be tested
// without GitHub Copilot. The test writes the script and reads what the model was asked:
//
//   $TERAX_E2E_LM_DIR/script.json     [{ text?, tool?, args?, delay?, hang? }, ...]  (default dir: /tmp/terax-e2e-lm)
//   $TERAX_E2E_LM_DIR/state.json      { next } the step the next request takes (delete it to start over)
//   $TERAX_E2E_LM_DIR/requests.jsonl  one line per request: the messages and tool names it was given
//   $TERAX_E2E_LM_DIR/cancelled.txt   one line each time VS Code cancelled a request
const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

const dir = () => process.env.TERAX_E2E_LM_DIR || "/tmp/terax-e2e-lm";
const readJson = (name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), name), "utf8"));
  } catch {
    return fallback;
  }
};

function describe(message) {
  return {
    role: message.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant",
    parts: message.content.map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) return { k: "text", value: part.value };
      if (part instanceof vscode.LanguageModelToolCallPart) return { k: "call", callId: part.callId, name: part.name, input: part.input };
      if (part instanceof vscode.LanguageModelToolResultPart) {
        return { k: "result", callId: part.callId, text: part.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : "")).join("") };
      }
      return { k: "other" };
    }),
  };
}

const provider = {
  provideLanguageModelChatInformation: async () => [
    {
      id: "fake-lm",
      name: "Fake LM",
      family: "fake",
      version: "1.0",
      maxInputTokens: 100000,
      maxOutputTokens: 4096,
      capabilities: { toolCalling: true },
    },
  ],
  provideTokenCount: async (_model, text) => Math.ceil((typeof text === "string" ? text : JSON.stringify(text)).length / 4),
  provideLanguageModelChatResponse: async (model, messages, options, progress, token) => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(
      path.join(dir(), "requests.jsonl"),
      `${JSON.stringify({ model: model.id, messages: messages.map(describe), tools: (options.tools ?? []).map((t) => t.name) })}\n`,
    );
    const script = readJson("script.json", []);
    const state = readJson("state.json", { next: 0 });
    const step = script[Math.min(state.next, script.length - 1)] ?? { text: "(no script)" };
    fs.writeFileSync(path.join(dir(), "state.json"), JSON.stringify({ next: state.next + 1 }));

    if (step.hang) {
      progress.report(new vscode.LanguageModelTextPart("thinking"));
      // Cancelled either by the event or, if that never fires, seen by looking at the token.
      await new Promise((resolve) => {
        token.onCancellationRequested(resolve);
        const poll = setInterval(() => {
          if (token.isCancellationRequested) {
            clearInterval(poll);
            resolve();
          }
        }, 100);
      });
      fs.appendFileSync(path.join(dir(), "cancelled.txt"), "cancelled\n");
      return;
    }
    if (step.delay) await new Promise((resolve) => setTimeout(resolve, step.delay));
    for (const word of (step.text ?? "").match(/\S+\s*/g) ?? []) progress.report(new vscode.LanguageModelTextPart(word));
    if (step.tool) progress.report(new vscode.LanguageModelToolCallPart(step.id ?? `fake-call-${state.next}`, step.tool, step.args ?? {}));
  },
};

exports.activate = (context) => {
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("terax-e2e", provider));
};
exports.deactivate = () => {};
