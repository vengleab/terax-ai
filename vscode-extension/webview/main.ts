import { GhosttyCoreRuntime } from "@/modules/terminal/ghostty/GhosttyCoreRuntime";
import {
  measureTerminalFont,
  readTerminalGpuTheme,
  type TerminalFontMetrics,
  type TerminalGpuTheme,
} from "@/modules/terminal/ghostty/gpu/terminalVisuals";
import { supportsWasmSimd, TeraxGhostty } from "@terax/ghostty-core/adapted";
import { type HostMessage, type TerminalSettings, toBytes } from "../shared/messages";
import { onHostMessage, post, resolveClipboard } from "./bridge";
import { TerminalSession } from "./TerminalSession";

const CLOSE_DELAY_MS = 600;
const THEME_DEBOUNCE_MS = 60;

const tabs = document.getElementById("tabs") as HTMLDivElement;
const stage = document.getElementById("stage") as HTMLDivElement;

let runtime: GhosttyCoreRuntime | null = null;
let settings: TerminalSettings | null = null;
let metrics: TerminalFontMetrics | null = null;
let theme: TerminalGpuTheme | null = null;
let isMac = false;
let nextId = 1;
let activeId: number | null = null;
const sessions = new Map<number, TerminalSession>();
const order: number[] = [];

function fontSpec(s: TerminalSettings) {
  return {
    family: s.fontFamily || "monospace",
    size: s.fontSize,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    weight: s.fontWeight,
  };
}

function log(level: "info" | "warn" | "error", message: string): void {
  post({ type: "log", level, message });
}

function renderTabs(): void {
  tabs.replaceChildren();
  for (const id of order) {
    const session = sessions.get(id);
    if (!session) continue;
    const tab = document.createElement("div");
    tab.className = `tab${id === activeId ? " active" : ""}${session.exited ? " exited" : ""}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(id === activeId));
    tab.dataset.id = String(id);
    const label = document.createElement("button");
    label.className = "tab-label";
    label.type = "button";
    label.textContent = session.title;
    label.title = session.title;
    label.addEventListener("click", () => activate(id));
    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Kill Terminal";
    close.setAttribute("aria-label", `Close ${session.title}`);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeSession(id);
    });
    tab.append(label, close);
    tabs.append(tab);
  }
  const add = document.createElement("button");
  add.className = "tab-add";
  add.type = "button";
  add.textContent = "+";
  add.title = "New Terminal";
  add.setAttribute("aria-label", "New Terminal");
  add.addEventListener("click", () => void newTerminal());
  tabs.append(add);
}

function activate(id: number): void {
  if (!sessions.has(id)) return;
  activeId = id;
  for (const [sid, session] of sessions) session.setActive(sid === id);
  renderTabs();
}

async function newTerminal(cwd?: string): Promise<void> {
  if (!runtime || !settings || !metrics || !theme) return;
  const id = nextId++;
  const session = new TerminalSession(
    id,
    {
    runtime,
    settings: () => settings as TerminalSettings,
    metrics: () => metrics as TerminalFontMetrics,
    theme: () => theme as TerminalGpuTheme,
    isMac,
    send: post,
    onTitle: () => renderTabs(),
    onEnded: (_id, code) => {
      renderTabs();
      if (code === 0) setTimeout(() => closeSession(id), CLOSE_DELAY_MS);
    },
    },
    cwd,
  );
  sessions.set(id, session);
  order.push(id);
  stage.append(session.element);
  activate(id);
  try {
    await session.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("error", `could not start a terminal: ${message}`);
    session.element.textContent = `Could not start the terminal: ${message}`;
    session.element.classList.add("failed");
  }
}

function closeSession(id: number): void {
  const session = sessions.get(id);
  if (!session) return;
  if (!session.exited) post({ type: "kill", id });
  session.dispose();
  sessions.delete(id);
  const index = order.indexOf(id);
  if (index >= 0) order.splice(index, 1);
  if (order.length === 0) {
    activeId = null;
    renderTabs();
    void newTerminal();
    return;
  }
  if (activeId === id) {
    activate(order[Math.min(index, order.length - 1)]);
  } else {
    renderTabs();
  }
}

async function applySettings(next: TerminalSettings): Promise<void> {
  settings = next;
  theme = readTerminalGpuTheme();
  metrics = await measureTerminalFont(fontSpec(next));
  for (const session of sessions.values()) session.applySettings();
}

let themeTimer: ReturnType<typeof setTimeout> | null = null;
function watchTheme(): void {
  const refresh = () => {
    if (themeTimer) clearTimeout(themeTimer);
    themeTimer = setTimeout(() => {
      if (!settings) return;
      theme = readTerminalGpuTheme();
      for (const session of sessions.values()) session.applySettings();
    }, THEME_DEBOUNCE_MS);
  };
  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
}

async function init(message: Extract<HostMessage, { type: "init" }>): Promise<void> {
  isMac = message.isMac;
  const wasmUrl = supportsWasmSimd() ? message.wasmUrl : message.scalarWasmUrl;
  runtime = new GhosttyCoreRuntime(() => TeraxGhostty.load(wasmUrl));
  await applySettings(message.settings);
  watchTheme();
  if (sessions.size === 0) await newTerminal(message.cwd);
}

function activeSession(): TerminalSession | undefined {
  return activeId === null ? undefined : sessions.get(activeId);
}

onHostMessage((message) => {
  switch (message.type) {
    case "init":
      void init(message).catch((error) => log("error", `init failed: ${String(error)}`));
      break;
    case "settings":
      void applySettings(message.settings);
      break;
    case "new":
      void newTerminal(message.cwd);
      break;
    case "spawned": {
      const session = sessions.get(message.id);
      if (session) {
        session.title = message.title;
        renderTabs();
      }
      break;
    }
    case "data":
      sessions.get(message.id)?.write(toBytes(message.bytes));
      break;
    case "exit":
      sessions.get(message.id)?.markExited(message.code);
      break;
    case "error": {
      const session = sessions.get(message.id);
      session?.markExited(1);
      log("error", message.message);
      break;
    }
    case "kill-active":
      if (activeId !== null) closeSession(activeId);
      break;
    case "focus":
      activeSession()?.focus();
      break;
    case "clear":
      activeSession()?.clear();
      break;
    case "send-text":
      activeSession()?.sendText(message.text);
      break;
    case "clipboard-text":
      resolveClipboard(message.requestId, message.text);
      break;
  }
});

window.addEventListener("focus", () => {
  post({ type: "focus-state", focused: true });
  activeSession()?.focus();
});
window.addEventListener("blur", () => post({ type: "focus-state", focused: false }));
post({ type: "ready" });
