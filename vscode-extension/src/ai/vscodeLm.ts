import type { LanguageModel } from "ai";
import { ChatSetupError } from "./model";
import { type AiSettings, splitVsCodeModel } from "./settings";

/**
 * Lets the chat use the language models VS Code offers (`vscode.lm`): GitHub Copilot, and any model another
 * extension registers. VS Code owns the sign-in and asks the person once to allow Terax to use a model, so
 * Terax never sees a token. This file is written against the small interface below instead of `vscode`, so
 * it can be tested without VS Code; `vscodeLmApi.ts` connects it to the real thing.
 */

export type LmTool = { name: string; description: string; inputSchema?: object };
export type LmPart = unknown;
export type LmMessage = unknown;

export type LmClassified =
  | { kind: "text"; value: string }
  | { kind: "tool-call"; callId: string; name: string; input: object }
  | { kind: "other" };

export interface LmModel {
  readonly id: string;
  readonly vendor: string;
  readonly family: string;
  readonly name: string;
  readonly maxInputTokens: number;
  send(messages: LmMessage[], options: { justification: string; tools?: LmTool[] }, token: unknown): PromiseLike<AsyncIterable<unknown>>;
}

export interface LmApi {
  models(selector?: { vendor?: string; id?: string }): PromiseLike<readonly LmModel[]>;
  user(parts: LmPart[]): LmMessage;
  assistant(parts: LmPart[]): LmMessage;
  text(value: string): LmPart;
  toolCall(callId: string, name: string, input: object): LmPart;
  toolResult(callId: string, text: string): LmPart;
  classify(part: unknown): LmClassified;
  cancellation(): { token: unknown; cancel(): void; dispose(): void };
  /** `permission`, `blocked`, `not-found`, `cancelled`, or `other` for what VS Code threw. */
  classifyError(error: unknown): { kind: "permission" | "blocked" | "not-found" | "cancelled" | "other"; message: string };
}

const JUSTIFICATION = "Terax AI chat, in the Terax panel";
const COPILOT = "copilot";

const NONE_AVAILABLE =
  'No language models are available in VS Code. Install GitHub Copilot Chat and sign in to it, then run "Terax: Select AI Model".';

/** Picks the model the setting names, else a Copilot one. */
export async function pickModel(api: LmApi, setting: string): Promise<LmModel> {
  const all = await api.models();
  if (all.length === 0) throw new ChatSetupError(NONE_AVAILABLE, "select-model");
  if (!setting) return all.find((m) => m.vendor === COPILOT) ?? all[0];
  const { vendor, id } = splitVsCodeModel(setting);
  const found = all.find((m) => m.id === id && (!vendor || m.vendor === vendor)) ?? all.find((m) => m.family === id && (!vendor || m.vendor === vendor));
  if (!found) {
    throw new ChatSetupError(`The model "${setting}" is not available in VS Code any more. Run "Terax: Select AI Model" to choose another.`, "select-model");
  }
  return found;
}

type AnyPart = { type: string; [key: string]: unknown };
type AnyMessage = { role: string; content: string | AnyPart[] };

function resultText(output: unknown): string {
  const o = (output && typeof output === "object" ? output : {}) as { type?: string; value?: unknown };
  switch (o.type) {
    case "text":
    case "error-text":
      return String(o.value ?? "");
    case "json":
    case "error-json":
      return JSON.stringify(o.value);
    case "execution-denied":
      return `The user denied this action.${typeof o.value === "string" ? ` ${o.value}` : ""}`;
    case "content":
      return Array.isArray(o.value) ? o.value.map((v) => (v && typeof v === "object" && "text" in v ? String((v as { text: unknown }).text) : "")).join("") : "";
    default:
      return typeof output === "string" ? output : JSON.stringify(output ?? null);
  }
}

function asObject(input: unknown): object {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return input && typeof input === "object" ? input : {};
}

/**
 * The AI SDK's conversation, in VS Code's two roles. VS Code has no system role, so the instructions go in
 * as the first user message; tool results are user messages made of result parts, as VS Code expects.
 */
export function toLmMessages(api: LmApi, prompt: readonly unknown[]): LmMessage[] {
  const out: LmMessage[] = [];
  for (const raw of prompt as AnyMessage[]) {
    if (raw.role === "system") {
      if (typeof raw.content === "string" && raw.content.trim()) out.push(api.user([api.text(raw.content)]));
    } else if (raw.role === "user") {
      const parts = (Array.isArray(raw.content) ? raw.content : []).map((p) => api.text(p.type === "text" ? String(p.text ?? "") : "[an attachment that cannot be sent here was left out]"));
      if (parts.length) out.push(api.user(parts));
    } else if (raw.role === "assistant") {
      const parts: LmPart[] = [];
      for (const p of Array.isArray(raw.content) ? raw.content : []) {
        if (p.type === "text" && String(p.text ?? "")) parts.push(api.text(String(p.text)));
        else if (p.type === "tool-call") parts.push(api.toolCall(String(p.toolCallId), String(p.toolName), asObject(p.input)));
      }
      if (parts.length) out.push(api.assistant(parts));
    } else if (raw.role === "tool") {
      const parts = (Array.isArray(raw.content) ? raw.content : []).filter((p) => p.type === "tool-result").map((p) => api.toolResult(String(p.toolCallId), resultText(p.output)));
      if (parts.length) out.push(api.user(parts));
    }
  }
  return out;
}

type CallOptions = { prompt: readonly unknown[]; tools?: { type: string; name?: string; description?: string; inputSchema?: object }[]; abortSignal?: AbortSignal };

const EMPTY_USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

type StreamPart = Record<string, unknown>;

/** The model, as the AI SDK sees it. */
export function createVsCodeLmModel(api: LmApi, settings: Pick<AiSettings, "model">): LanguageModel {
  async function doStream(options: CallOptions): Promise<{ stream: ReadableStream<StreamPart> }> {
    const model = await pickModel(api, settings.model);
    const source = api.cancellation();
    const cancel = () => source.cancel();
    if (options.abortSignal?.aborted) cancel();
    else options.abortSignal?.addEventListener("abort", cancel, { once: true });

    const tools: LmTool[] = (options.tools ?? [])
      .filter((t) => t.type === "function" && t.name)
      .map((t) => ({ name: t.name as string, description: t.description ?? "", inputSchema: t.inputSchema }));

    let iterable: AsyncIterable<unknown>;
    try {
      iterable = await model.send(toLmMessages(api, options.prompt), { justification: JUSTIFICATION, tools: tools.length ? tools : undefined }, source.token);
    } catch (error) {
      source.dispose();
      throw describeError(api, error, model);
    }

    // Stopping must end the turn even if VS Code, or the model's extension, is slow to react to the
    // cancellation: the loop below stops waiting for the next part as soon as the signal fires.
    const stopped = new Promise<"stopped">((resolve) => {
      if (options.abortSignal?.aborted) resolve("stopped");
      else options.abortSignal?.addEventListener("abort", () => resolve("stopped"), { once: true });
    });

    const stream = new ReadableStream<StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        let open: string | null = null;
        let blocks = 0;
        let calls = 0;
        const closeText = () => {
          if (open) controller.enqueue({ type: "text-end", id: open });
          open = null;
        };
        const iterator = iterable[Symbol.asyncIterator]();
        try {
          for (;;) {
            const pending = iterator.next();
            pending.catch(() => undefined);
            const next = await Promise.race([pending, stopped]);
            if (next === "stopped") {
              // Breaking out of the loop is the other way VS Code documents for cancelling a request.
              void Promise.resolve(iterator.return?.()).catch(() => undefined);
              controller.error(abortError());
              return;
            }
            if (next.done) break;
            const c = api.classify(next.value);
            if (c.kind === "text") {
              if (!c.value) continue;
              if (!open) {
                open = `t${blocks++}`;
                controller.enqueue({ type: "text-start", id: open });
              }
              controller.enqueue({ type: "text-delta", id: open, delta: c.value });
            } else if (c.kind === "tool-call") {
              closeText();
              calls++;
              controller.enqueue({ type: "tool-call", toolCallId: c.callId, toolName: c.name, input: JSON.stringify(c.input ?? {}) });
            }
          }
          closeText();
          controller.enqueue({ type: "finish", finishReason: { unified: calls ? "tool-calls" : "stop", raw: calls ? "tool-calls" : "stop" }, usage: EMPTY_USAGE });
          controller.close();
        } catch (error) {
          controller.error(options.abortSignal?.aborted ? abortError() : describeError(api, error, model));
        } finally {
          source.dispose();
        }
      },
      cancel() {
        cancel();
      },
    });
    return { stream };
  }

  async function doGenerate(options: CallOptions) {
    const { stream } = await doStream(options);
    const content: StreamPart[] = [];
    let text = "";
    let finishReason: unknown = { unified: "stop", raw: "stop" };
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-delta") text += String(value.delta);
      else if (value.type === "tool-call") content.push(value);
      else if (value.type === "finish") finishReason = value.finishReason;
    }
    if (text) content.unshift({ type: "text", text });
    return { content, finishReason, usage: EMPTY_USAGE, warnings: [] };
  }

  const model = {
    specificationVersion: "v3" as const,
    provider: "vscode-lm",
    modelId: settings.model || "default",
    supportedUrls: {},
    doStream,
    doGenerate,
  };
  return model as unknown as LanguageModel;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function describeError(api: LmApi, error: unknown, model: LmModel): Error {
  const known = api.classifyError(error);
  switch (known.kind) {
    case "permission":
      return new ChatSetupError(`VS Code did not let Terax use ${model.name}. Allow it when VS Code asks, or run "Terax: Select AI Model" to choose another model.`, "select-model");
    case "not-found":
      return new ChatSetupError(`VS Code could not find ${model.name}. Run "Terax: Select AI Model" to choose another model.`, "select-model");
    case "blocked":
      return new Error(`${model.name} blocked the request${known.message ? `: ${known.message}` : "."}`);
    case "cancelled":
      return abortError();
    default:
      return error instanceof Error ? error : new Error(known.message || String(error));
  }
}
