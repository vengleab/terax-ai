import { type ChatEvent, isPageCommand, type PageCommand } from "../shared/chat";
import {
  type HostMessage,
  isOpenableLink,
  type TerminalSettings,
  toBytes,
  type WebviewMessage,
} from "../shared/messages";
import { FlowControl } from "./flow";

export type SpawnRequest = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
};

export type HelperEvents = {
  spawned(id: number, pid: number): void;
  data(id: number, bytes: Uint8Array): void;
  exit(id: number, code: number): void;
  error(id: number, message: string): void;
};

/** What the router needs from the process that owns the shells. */
export interface HelperPort {
  setListener(listener: HelperEvents): void;
  spawn(id: number, request: SpawnRequest): void;
  write(id: number, bytes: Uint8Array): void;
  resize(id: number, cols: number, rows: number): void;
  kill(id: number): void;
  pause(id: number): void;
  resume(id: number): void;
  killAll(): void;
}

/** What the router needs from the AI chat. The chat lives in the host and outlives the page. */
export interface ChatPort {
  readonly events: ChatEvent[];
  readonly running: boolean;
  readonly modelLabel: string;
  send(text: string): Promise<void>;
  stop(): void;
  reset(): void;
  answerApproval(id: string, approved: boolean): void;
}

export type LaunchPlan = { file: string; args: string[]; cwd: string; env: Record<string, string>; title: string };

export type RouterDeps = {
  helper: HelperPort;
  post(message: HostMessage): void;
  terminalSettings(): TerminalSettings;
  isMac: boolean;
  /** Addresses of the engine's WebAssembly files as the page sees them. */
  assets(): { wasmUrl: string; scalarWasmUrl: string };
  launch(cwd?: string): LaunchPlan;
  clipboard: { read(): Promise<string>; write(text: string): Promise<void> };
  openLink(uri: string): void;
  log(level: "info" | "warn" | "error", message: string): void;
  chat: ChatPort;
  /** Runs one of the few commands the chat page may ask for (set the key, choose the model, ...). */
  runPageCommand(command: PageCommand): void;
};

/** How long the agent waits for the page to hand over the terminal's text. */
const TERMINAL_TEXT_TIMEOUT_MS = 3000;

/**
 * Sits between the page and the helper: starts shells when the page asks, carries their input and
 * output, and slows a shell down when the page falls behind. It knows nothing about VS Code itself,
 * so it can be tested with fakes.
 */
export class SessionRouter {
  private readonly flow: FlowControl;
  private readonly titles = new Map<number, string>();
  private ready = false;
  private firstCwd: string | undefined;
  /** The highest terminal id any page has used, so each new page can start above it. */
  private highestId = 0;
  private focusWhenReady = false;
  private chatFocusWhenReady = false;
  private prefillWhenReady: string | undefined;
  private focused = false;
  private nextRequest = 1;
  private readonly terminalTextRequests = new Map<number, (text: string) => void>();

  constructor(private readonly deps: RouterDeps) {
    this.flow = new FlowControl({
      pause: (id) => deps.helper.pause(id),
      resume: (id) => deps.helper.resume(id),
    });
    deps.helper.setListener({
      spawned: (id, pid) => deps.post({ type: "spawned", id, pid, title: this.titles.get(id) ?? "shell" }),
      data: (id, bytes) => {
        this.flow.sent(id, bytes.length);
        deps.post({ type: "data", id, bytes });
      },
      exit: (id, code) => {
        this.flow.forget(id);
        this.titles.delete(id);
        deps.post({ type: "exit", id, code });
      },
      error: (id, message) => {
        this.flow.forget(id);
        this.titles.delete(id);
        deps.post({ type: "error", id, message });
      },
    });
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Whether the page has keyboard focus. */
  get isFocused(): boolean {
    return this.focused;
  }

  receive(message: WebviewMessage): void {
    const { helper } = this.deps;
    switch (message.type) {
      case "ready":
        // A page that (re)starts has no terminals, so shells left from an earlier page are ended.
        helper.killAll();
        this.flow.clear();
        this.titles.clear();
        this.ready = true;
        this.focused = false;
        this.deps.post({
          type: "init",
          ...this.deps.assets(),
          settings: this.deps.terminalSettings(),
          isMac: this.deps.isMac,
          cwd: this.firstCwd,
          firstId: this.highestId + 1,
        });
        this.syncChat();
        this.firstCwd = undefined;
        if (this.focusWhenReady) this.deps.post({ type: "focus" });
        this.focusWhenReady = false;
        if (this.prefillWhenReady !== undefined) this.deps.post({ type: "chat-prefill", text: this.prefillWhenReady });
        this.prefillWhenReady = undefined;
        if (this.chatFocusWhenReady) this.deps.post({ type: "chat-focus" });
        this.chatFocusWhenReady = false;
        break;
      case "focus-state":
        this.focused = message.focused;
        break;
      case "spawn": {
        this.highestId = Math.max(this.highestId, message.id);
        try {
          const plan = this.deps.launch(message.cwd);
          this.titles.set(message.id, plan.title);
          helper.spawn(message.id, {
            file: plan.file,
            args: plan.args,
            cwd: plan.cwd,
            env: plan.env,
            cols: message.cols,
            rows: message.rows,
          });
        } catch (error) {
          this.deps.post({
            type: "error",
            id: message.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }
      case "input":
        helper.write(message.id, toBytes(message.bytes));
        break;
      case "resize":
        helper.resize(message.id, message.cols, message.rows);
        break;
      case "ack":
        this.flow.acknowledged(message.id, message.bytes);
        break;
      case "kill":
        this.flow.forget(message.id);
        this.titles.delete(message.id);
        helper.kill(message.id);
        break;
      case "clipboard-read":
        void this.deps.clipboard.read().then(
          (text) => this.deps.post({ type: "clipboard-text", requestId: message.requestId, text }),
          () => this.deps.post({ type: "clipboard-text", requestId: message.requestId, text: "" }),
        );
        break;
      case "clipboard-write":
        void this.deps.clipboard.write(message.text).catch(() => undefined);
        break;
      case "open-link":
        if (isOpenableLink(message.uri)) this.deps.openLink(message.uri);
        else this.deps.log("warn", `refused to open a link that is not http, https or mailto: ${message.uri.slice(0, 80)}`);
        break;
      case "log":
        this.deps.log(message.level, message.message);
        break;
      case "chat-send":
        void this.deps.chat.send(message.text);
        break;
      case "chat-stop":
        this.deps.chat.stop();
        break;
      case "chat-new":
        this.deps.chat.reset();
        break;
      case "chat-approval":
        this.deps.chat.answerApproval(message.id, message.approved === true);
        break;
      case "chat-command":
        // The page is only a web page: it may ask for the few commands on the list, nothing else.
        if (isPageCommand(message.command)) this.deps.runPageCommand(message.command);
        else this.deps.log("warn", `refused a command from the chat page: ${String(message.command).slice(0, 80)}`);
        break;
      case "terminal-text":
        this.terminalTextRequests.get(message.requestId)?.(message.text);
        this.terminalTextRequests.delete(message.requestId);
        break;
    }
  }

  /** Brings a page that has just started up to date with the conversation. */
  syncChat(): void {
    const { chat } = this.deps;
    this.deps.post({ type: "chat-sync", events: [...chat.events], model: chat.modelLabel, running: chat.running });
  }

  /** The chosen model changed. */
  modelChanged(): void {
    if (this.ready) this.deps.post({ type: "chat-model", model: this.deps.chat.modelLabel });
  }

  /** The last lines of the active terminal, as the page shows them. Empty when there is no page. */
  readTerminalText(lines: number): Promise<string> {
    if (!this.ready) return Promise.resolve("");
    return new Promise((resolve) => {
      const requestId = this.nextRequest++;
      const timer = setTimeout(() => {
        this.terminalTextRequests.delete(requestId);
        resolve("");
      }, TERMINAL_TEXT_TIMEOUT_MS);
      this.terminalTextRequests.set(requestId, (text) => {
        clearTimeout(timer);
        resolve(text);
      });
      this.deps.post({ type: "terminal-text-request", requestId, lines });
    });
  }

  /** Asks the page for a new terminal. Before the page is up, the folder is used for its first one. */
  newTerminal(cwd?: string): void {
    if (!this.ready) {
      this.firstCwd = cwd;
      return;
    }
    this.deps.post({ type: "new", cwd });
  }

  settingsChanged(): void {
    if (this.ready) this.deps.post({ type: "settings", settings: this.deps.terminalSettings() });
  }

  send(
    message: Extract<
      HostMessage,
      { type: "kill-active" | "focus" | "clear" | "send-text" | "chat-focus" | "chat-prefill" }
    >,
  ): void {
    if (this.ready) this.deps.post(message);
    // A page that is still starting gets the focus once it is up; the other commands need a terminal.
    else if (message.type === "focus") this.focusWhenReady = true;
    else if (message.type === "chat-focus") this.chatFocusWhenReady = true;
    else if (message.type === "chat-prefill") this.prefillWhenReady = message.text;
  }

  /** The page went away: its shells have nobody to talk to. */
  pageClosed(): void {
    this.ready = false;
    this.focused = false;
    this.deps.helper.killAll();
    this.flow.clear();
    this.titles.clear();
    for (const answer of this.terminalTextRequests.values()) answer("");
    this.terminalTextRequests.clear();
  }
}
