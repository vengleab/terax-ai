import type { PageCommand } from "../../shared/chat";
import { button, el } from "./dom";
import { type Block, type Inline, parseMarkdown } from "./markdown";
import { formatTokens, type Message, summarizeResult, type ToolPart, toolTitle } from "./state";

/** What the rendered chat can ask the page to do. */
export type RenderHooks = {
  openLink: (uri: string) => void;
  copy: (text: string) => void;
  /** Puts text at the active terminal's prompt without running it. False when that is not safe or possible. */
  insertIntoTerminal: (text: string) => boolean;
  runCommand: (command: PageCommand) => void;
  /** Which tool cards the person has opened, so a redraw keeps them open. */
  openTools: Set<string>;
};

const MAX_BODY_CHARS = 20_000;

function inline(nodes: Inline[], hooks: RenderHooks): Node[] {
  return nodes.map((node): Node => {
    switch (node.t) {
      case "text":
        return document.createTextNode(node.text);
      case "code":
        return el("code", { class: "md-code", text: node.text });
      case "strong":
        return el("strong", {}, ...inline(node.children, hooks));
      case "em":
        return el("em", {}, ...inline(node.children, hooks));
      case "link": {
        const a = el("a", { title: node.href, attrs: { href: node.href, rel: "noreferrer noopener" } }, ...inline(node.children, hooks));
        a.addEventListener("click", (event) => {
          event.preventDefault();
          hooks.openLink(node.href);
        });
        return a;
      }
    }
  });
}

function codeBlock(block: Extract<Block, { t: "code" }>, hooks: RenderHooks): HTMLElement {
  const header = el("div", { class: "code-head" }, el("span", { class: "code-lang", text: block.lang || "text" }));
  if (!block.open) {
    const copy = button("Copy", "code-btn", () => {
      hooks.copy(block.text);
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.textContent = "Copy";
      }, 1200);
    });
    const insert = button(
      "Insert in terminal",
      "code-btn",
      () => {
        const inserted = hooks.insertIntoTerminal(block.text);
        // Several lines at a shell without bracketed paste would run as they arrive, so copy instead.
        if (!inserted) hooks.copy(block.text);
        insert.textContent = inserted ? "Inserted" : "Copied instead";
        setTimeout(() => {
          insert.textContent = "Insert in terminal";
        }, 1600);
      },
      "Put this at the terminal prompt without running it",
    );
    header.append(insert, copy);
  }
  return el("div", { class: "code-block" }, header, el("pre", {}, el("code", { text: block.text })));
}

export function renderMarkdown(source: string, hooks: RenderHooks): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(source)) {
    switch (block.t) {
      case "p":
        fragment.append(el("p", {}, ...inline(block.inlines, hooks)));
        break;
      case "h":
        fragment.append(el(block.level <= 2 ? "h3" : "h4", { class: "md-heading" }, ...inline(block.inlines, hooks)));
        break;
      case "code":
        fragment.append(codeBlock(block, hooks));
        break;
      case "list": {
        const list = el(block.ordered ? "ol" : "ul", {}, ...block.items.map((item) => el("li", {}, ...inline(item, hooks))));
        if (block.ordered && block.start !== 1) list.setAttribute("start", String(block.start));
        fragment.append(list);
        break;
      }
      case "quote":
        fragment.append(el("blockquote", {}, ...inline(block.inlines, hooks)));
        break;
      case "hr":
        fragment.append(el("hr"));
        break;
    }
  }
  return fragment;
}

const STATUS_TEXT: Record<string, string> = {
  running: "running…",
  waiting: "waiting for you",
  denied: "denied",
  stopped: "stopped",
};

function toolCard(part: ToolPart, hooks: RenderHooks): HTMLElement {
  const finished = part.status === "done" || part.status === "failed";
  const result = finished ? summarizeResult(part.name, part.output) : undefined;
  let body = result?.body;
  if (!body && part.status === "failed" && result && result.headline.length > 60) body = result.headline;
  if (body && body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n… output cut`;
  const statusText = STATUS_TEXT[part.status] ?? (result && result.headline.length <= 60 ? result.headline : "failed");

  const card = el(
    "details",
    { class: `tool tool-${part.status}`, attrs: { "data-tool": part.id } },
    el(
      "summary",
      {},
      el("span", { class: "tool-icon", attrs: { "aria-hidden": "true" } }),
      el("span", { class: "tool-title", text: toolTitle(part.name) }),
      part.summary ? el("code", { class: "tool-summary", text: part.summary, title: part.summary }) : null,
      el("span", { class: "tool-status", text: statusText }),
    ),
    body ? el("pre", { class: "tool-body", text: body }) : null,
  );
  card.open = body !== undefined && hooks.openTools.has(part.id);
  if (!body) card.classList.add("no-body");
  card.addEventListener("toggle", () => {
    if (card.open) hooks.openTools.add(part.id);
    else hooks.openTools.delete(part.id);
  });
  return card;
}

const HINT_ACTIONS: Record<string, { label: string; command: PageCommand }> = {
  "set-key": { label: "Set API key", command: "terax.ai.setApiKey" },
  "select-model": { label: "Select model", command: "terax.ai.selectModel" },
  "open-settings": { label: "Open settings", command: "terax.ai.openSettings" },
};

export function renderMessage(message: Message, hooks: RenderHooks): HTMLElement {
  switch (message.role) {
    case "user":
      return el("div", { class: "msg user", attrs: { "data-id": message.id } }, el("div", { class: "bubble", text: message.text }));
    case "error": {
      const action = message.hint ? HINT_ACTIONS[message.hint] : undefined;
      return el(
        "div",
        { class: "msg error", attrs: { "data-id": message.id, role: "alert" } },
        el("span", { class: "error-text", text: message.text }),
        action ? button(action.label, "msg-action", () => hooks.runCommand(action.command)) : null,
      );
    }
    case "assistant": {
      const node = el("div", { class: "msg assistant", attrs: { "data-id": message.id } });
      for (const part of message.parts) {
        if (part.kind === "tool") {
          node.append(toolCard(part, hooks));
        } else if (part.kind === "text") {
          node.append(el("div", { class: "md" }, renderMarkdown(part.text, hooks)));
        } else {
          node.append(el("details", { class: "reasoning" }, el("summary", { text: "Thinking" }), el("div", { class: "reasoning-text", text: part.text })));
        }
      }
      if (message.usage && (message.usage.input !== undefined || message.usage.output !== undefined)) {
        const used = [message.usage.input !== undefined ? `${formatTokens(message.usage.input)} in` : "", message.usage.output !== undefined ? `${formatTokens(message.usage.output)} out` : ""]
          .filter(Boolean)
          .join(" · ");
        node.append(el("div", { class: "usage", text: used }));
      }
      return node;
    }
  }
}
