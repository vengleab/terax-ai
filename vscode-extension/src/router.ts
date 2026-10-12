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
};

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
  private focusWhenReady = false;
  private focused = false;

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
        });
        this.firstCwd = undefined;
        if (this.focusWhenReady) this.deps.post({ type: "focus" });
        this.focusWhenReady = false;
        break;
      case "focus-state":
        this.focused = message.focused;
        break;
      case "spawn": {
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
    }
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

  send(message: Extract<HostMessage, { type: "kill-active" | "focus" | "clear" | "send-text" }>): void {
    if (this.ready) this.deps.post(message);
    // A page that is still starting gets the focus once it is up; the other commands need a terminal.
    else if (message.type === "focus") this.focusWhenReady = true;
  }

  /** The page went away: its shells have nobody to talk to. */
  pageClosed(): void {
    this.ready = false;
    this.focused = false;
    this.deps.helper.killAll();
    this.flow.clear();
    this.titles.clear();
  }
}
