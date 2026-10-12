import type { PageCommand } from "../../shared/chat";
import type { HostMessage, WebviewMessage } from "../../shared/messages";
import { ApprovalPopup } from "./approval";
import { button, el } from "./dom";
import { attachSplitter, type LayoutState } from "./layout";
import { renderMessage, type RenderHooks } from "./render";
import { type Change, ChatModel } from "./state";

const NEAR_BOTTOM_PX = 56;
const MAX_COMPOSER_PX = 160;
const HISTORY_LIMIT = 50;

const SUGGESTIONS = [
  "Explain the last error in my terminal",
  "Give me a quick tour of this project",
  "Run the tests and fix what fails",
];

export type PanelOptions = {
  app: HTMLElement;
  splitter: HTMLElement;
  root: HTMLElement;
  popupHost: HTMLElement;
  layout: LayoutState;
  saveLayout: (state: LayoutState) => void;
  post: (message: WebviewMessage) => void;
  insertIntoTerminal: (text: string) => boolean;
};

/** The chat below the terminal: header, conversation, message box, and the popup that asks first. */
export class ChatPanel {
  private readonly model = new ChatModel();
  private readonly hooks: RenderHooks;
  private readonly popup: ApprovalPopup;
  private readonly layout: ReturnType<typeof attachSplitter>;
  private readonly messages = el("div", { class: "messages", attrs: { role: "log", "aria-label": "Conversation", "aria-live": "polite" } });
  private readonly empty: HTMLElement;
  private readonly working = el("div", { class: "working", attrs: { hidden: "", "aria-live": "polite" } });
  private readonly input = el("textarea", { class: "composer-input", attrs: { rows: "1", placeholder: "Ask Terax…", "aria-label": "Message to Terax", spellcheck: "true" } });
  private readonly send = el("button", { class: "composer-send", attrs: { type: "button" } });
  private readonly modelChip: HTMLButtonElement;
  private readonly toggle: HTMLButtonElement;
  private readonly nodes = new Map<string, HTMLElement>();
  private dirty = new Set<string>();
  private clearPending = false;
  private frame = 0;
  private stick = true;
  private readonly sent: string[] = [];
  private historyIndex = -1;
  private draft = "";

  constructor(private readonly opts: PanelOptions) {
    const { post } = opts;
    this.hooks = {
      openLink: (uri) => post({ type: "open-link", uri }),
      copy: (text) => post({ type: "clipboard-write", text }),
      insertIntoTerminal: (text) => opts.insertIntoTerminal(text),
      runCommand: (command: PageCommand) => post({ type: "chat-command", command }),
      openTools: new Set(),
    };

    this.popup = new ApprovalPopup(opts.popupHost, (id, approved) => post({ type: "chat-approval", id, approved }));

    this.toggle = button("", "chat-toggle", () => this.setCollapsed(!opts.layout.collapsed), "Show or hide the chat");
    this.toggle.setAttribute("aria-controls", "chat-body");
    this.modelChip = button("", "chat-model", () => this.hooks.runCommand("terax.ai.selectModel"), "Change the model");
    const newChat = button("New chat", "chat-new", () => post({ type: "chat-new" }), "Clear this conversation and start again");
    const head = el("div", { class: "chat-head" }, this.toggle, el("span", { class: "chat-title", text: "Terax AI" }), this.modelChip, el("span", { class: "spacer" }), newChat);

    this.empty = this.buildEmpty();

    this.send.addEventListener("click", () => (this.model.running ? post({ type: "chat-stop" }) : this.submit()));
    const composer = el("form", { class: "composer" }, this.input, this.send);
    composer.addEventListener("submit", (event) => event.preventDefault());
    this.input.addEventListener("input", () => this.autosize());
    this.input.addEventListener("keydown", (event) => this.onKey(event));

    const body = el("div", { class: "chat-body", attrs: { id: "chat-body" } }, this.empty, this.messages, this.working, composer);
    opts.root.replaceChildren(head, body);

    this.messages.addEventListener("scroll", () => {
      this.stick = this.nearBottom();
    });
    this.layout = attachSplitter({ app: opts.app, splitter: opts.splitter, state: opts.layout, save: opts.saveLayout });
    this.layout.apply();
    this.messages.hidden = true;
    this.refreshChrome();
  }

  private buildEmpty(): HTMLElement {
    const chips = el("div", { class: "suggestions" });
    for (const text of SUGGESTIONS) chips.append(button(text, "suggestion", () => this.sendText(text)));
    return el(
      "div",
      { class: "empty" },
      el("p", { class: "empty-title", text: "Ask Terax about your terminal and your code." }),
      el("p", { class: "empty-note", text: "It can read files and your terminal on its own. It asks you before it runs a command or changes a file." }),
      chips,
      el("div", { class: "empty-actions" }, button("Select model", "msg-action", () => this.hooks.runCommand("terax.ai.selectModel")), button("Set API key", "msg-action", () => this.hooks.runCommand("terax.ai.setApiKey"))),
    );
  }

  private nearBottom(): boolean {
    const m = this.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight <= NEAR_BOTTOM_PX;
  }

  private autosize(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, MAX_COMPOSER_PX)}px`;
  }

  private onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.submit();
    } else if (event.key === "Escape" && this.model.running) {
      event.preventDefault();
      this.opts.post({ type: "chat-stop" });
    } else if (event.key === "ArrowUp" && this.input.selectionStart === 0 && this.input.selectionEnd === 0) {
      this.recall(1, event);
    } else if (event.key === "ArrowDown" && this.historyIndex >= 0 && this.input.selectionStart === this.input.value.length) {
      this.recall(-1, event);
    }
  }

  /** Steps through earlier messages, like a shell's history. */
  private recall(direction: 1 | -1, event: KeyboardEvent): void {
    const next = this.historyIndex + direction;
    if (next >= this.sent.length || next < -1) return;
    event.preventDefault();
    if (this.historyIndex === -1) this.draft = this.input.value;
    this.historyIndex = next;
    this.input.value = next === -1 ? this.draft : this.sent[this.sent.length - 1 - next];
    this.autosize();
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text || this.model.running) return;
    this.input.value = "";
    this.historyIndex = -1;
    this.autosize();
    this.sendText(text);
  }

  private sendText(text: string): void {
    if (this.model.running) return;
    this.sent.push(text);
    if (this.sent.length > HISTORY_LIMIT) this.sent.shift();
    this.stick = true;
    this.opts.post({ type: "chat-send", text });
  }

  private setCollapsed(collapsed: boolean): void {
    this.layout.setCollapsed(collapsed);
    this.refreshChrome();
  }

  focusComposer(): void {
    if (this.opts.layout.collapsed) this.setCollapsed(false);
    this.input.focus();
  }

  /** Whether the keyboard focus is somewhere in the chat. */
  hasFocus(): boolean {
    const active = document.activeElement;
    return !!active && (this.opts.root.contains(active) || this.opts.popupHost.contains(active));
  }

  /** Brings the page up to date with one message from the host. Returns false for messages that are not the chat's. */
  handle(message: HostMessage): boolean {
    switch (message.type) {
      case "chat":
        this.apply(this.model.apply(message.event));
        return true;
      case "chat-sync":
        this.model.load(message.events, message.running, message.model);
        this.nodes.clear();
        this.hooks.openTools.clear();
        this.clearPending = true;
        this.dirty = new Set(this.model.messages.map((m) => m.id));
        this.popup.update(this.model.approvals);
        this.refreshChrome();
        this.schedule();
        return true;
      case "chat-model":
        this.model.model = message.model;
        this.refreshChrome();
        return true;
      case "chat-prefill": {
        const current = this.input.value;
        this.input.value = current.trim() ? `${current.trimEnd()}\n\n${message.text}` : message.text;
        this.autosize();
        if (this.opts.layout.collapsed) this.setCollapsed(false);
        return true;
      }
      case "chat-focus":
        this.focusComposer();
        return true;
      default:
        return false;
    }
  }

  private apply(change: Change): void {
    if (change.reset) {
      this.clearPending = true;
      this.dirty.clear();
      this.hooks.openTools.clear();
      this.nodes.clear();
    }
    for (const id of change.messages) this.dirty.add(id);
    if (change.approvals) {
      this.popup.update(this.model.approvals);
      if (this.model.approvals.length > 0 && this.opts.layout.collapsed) this.setCollapsed(false);
    }
    if (change.status || change.approvals || change.reset) this.refreshChrome();
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.flush();
    });
  }

  private flush(): void {
    const wasNearBottom = this.stick;
    if (this.clearPending) {
      this.clearPending = false;
      this.messages.replaceChildren();
      this.nodes.clear();
    }
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const message = this.model.messages.find((m) => m.id === id);
      if (!message) continue;
      const node = renderMessage(message, this.hooks);
      const old = this.nodes.get(id);
      if (old?.isConnected) old.replaceWith(node);
      else this.messages.append(node);
      this.nodes.set(id, node);
    }
    const none = this.model.messages.length === 0;
    this.messages.hidden = none;
    this.empty.hidden = !none;
    if (wasNearBottom) this.messages.scrollTop = this.messages.scrollHeight;
  }

  private refreshChrome(): void {
    const { running, approvals, model } = this.model;
    this.modelChip.textContent = model || "Choose a model";
    const collapsed = this.opts.layout.collapsed;
    this.toggle.textContent = collapsed ? "▸" : "▾";
    this.toggle.setAttribute("aria-expanded", String(!collapsed));
    this.send.textContent = running ? "Stop" : "Send";
    this.send.classList.toggle("is-stop", running);
    this.send.title = running ? "Stop (Escape)" : "Send (Enter)";
    this.working.hidden = !running;
    this.working.textContent = approvals.length > 0 ? "Waiting for your answer…" : "Working…";
    this.opts.app.classList.toggle("chat-running", running);
  }
}
