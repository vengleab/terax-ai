import * as os from "node:os";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { formatAiError } from "../../../src/modules/ai/lib/errors";
import { type ApprovalRequest, appendEvent, type ChatEvent } from "../../shared/chat";
import { ApprovalBroker } from "./approvals";
import { runAgent } from "./agent";
import { ChatSetupError } from "./model";
import { systemPrompt } from "./prompt";
import { type AiSettings, describeModel } from "./settings";
import type { ToolContext } from "./tools";

const MAX_HISTORY_MESSAGES = 80;

export type ChatDeps = {
  /** Sends an event to the page, if it is open. */
  post: (event: ChatEvent) => void;
  settings: () => AiSettings;
  apiKey: (settings: AiSettings) => PromiseLike<string | undefined>;
  buildModel: (settings: AiSettings, apiKey: string | undefined) => Promise<LanguageModel>;
  buildTools: (context: ToolContext) => ToolSet;
  /** Everything a tool needs besides the approval gate and the files it has read, which the chat owns. */
  toolContext: () => Omit<ToolContext, "approve" | "readFiles">;
  folders: () => string[];
  shellName: () => string;
  /** Brings the chat into view, so a question to the user is seen. */
  reveal: () => void;
};

/** Drops the oldest messages so the conversation stays within what a model can take, starting on a user message. */
export function trimHistory(messages: ModelMessage[], max = MAX_HISTORY_MESSAGES): ModelMessage[] {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && messages[start].role !== "user") start++;
  return start < messages.length ? messages.slice(start) : messages.slice(-1);
}

/**
 * One conversation. It lives in the extension host, so it survives the page being closed or reloaded:
 * the page is brought up to date by replaying `events`.
 */
export class ChatController {
  readonly events: ChatEvent[] = [];
  private history: ModelMessage[] = [];
  private readFiles = new Set<string>();
  private abort: AbortController | null = null;
  private counter = 0;
  /** Counts resets. A turn that was running when the chat was reset must not touch the new conversation. */
  private epoch = 0;
  private readonly approvals: ApprovalBroker;

  constructor(private readonly deps: ChatDeps) {
    this.approvals = new ApprovalBroker(
      (request) => this.emit({ type: "approval", request }),
      (id, approved) => this.emit({ type: "approval-done", id, approved }),
    );
  }

  get running(): boolean {
    return this.abort !== null;
  }

  get modelLabel(): string {
    return describeModel(this.deps.settings());
  }

  get pendingApprovals(): ApprovalRequest[] {
    return this.approvals.waiting;
  }

  private emit(event: ChatEvent): void {
    appendEvent(this.events, event);
    this.deps.post(event);
    if (event.type === "approval") this.deps.reveal();
  }

  async send(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) return;
    if (this.abort) {
      this.emit({ type: "error", message: "Terax is still working on the last message. Stop it first, or wait." });
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    const epoch = this.epoch;
    const current = () => epoch === this.epoch;
    const mark = this.history.length;
    this.emit({ type: "user", id: `u${++this.counter}`, text: prompt });
    this.emit({ type: "status", running: true });
    this.emit({ type: "assistant-start", id: `a${this.counter}` });
    try {
      const settings = this.deps.settings();
      const model = await this.deps.buildModel(settings, await this.deps.apiKey(settings));
      // The chat may have been reset while the key was being read.
      if (!current() || abort.signal.aborted) return;
      this.history.push({ role: "user", content: prompt });
      const tools = this.deps.buildTools({
        ...this.deps.toolContext(),
        readFiles: this.readFiles,
        approve: (request) => this.approvals.request(request, abort.signal),
      });
      const result = await runAgent({
        model,
        system: systemPrompt({ folders: this.deps.folders(), platform: `${os.platform()} ${os.arch()}`, shell: this.deps.shellName() }),
        messages: trimHistory(this.history),
        tools,
        maxSteps: settings.maxSteps,
        signal: abort.signal,
        emit: (event) => {
          if (current()) this.emit(event);
        },
      });
      if (!current()) return;
      this.history.push(...result.messages);
      this.emit({ type: "done", inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    } catch (error) {
      if (!current()) return;
      // The model never answered, so the message it was not able to answer is not kept either.
      this.history.length = mark;
      if (error instanceof ChatSetupError) this.emit({ type: "error", message: error.message, hint: error.hint });
      else this.emit({ type: "error", message: formatAiError(error) });
      this.emit({ type: "done" });
    } finally {
      if (current()) {
        this.approvals.cancelAll();
        this.abort = null;
        this.emit({ type: "status", running: false });
      }
    }
  }

  stop(): void {
    this.abort?.abort();
    this.approvals.cancelAll();
  }

  /** Starts a fresh conversation. A turn still winding down is left to finish unseen. */
  reset(): void {
    this.stop();
    this.epoch++;
    this.abort = null;
    this.history = [];
    this.readFiles = new Set();
    this.events.length = 0;
    this.deps.post({ type: "reset" });
  }

  answerApproval(id: string, approved: boolean): void {
    this.approvals.answer(id, approved);
  }
}
