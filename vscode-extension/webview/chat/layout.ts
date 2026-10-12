export type LayoutState = { chatHeight: number | null; collapsed: boolean };

export const MIN_CHAT_PX = 120;
export const MIN_TERMINAL_PX = 100;
export const HEADER_PX = 30;
export const DEFAULT_CHAT_FRACTION = 0.4;
const KEY_STEP_PX = 24;

/** Keeps the chat's height where both it and the terminal stay usable. */
export function clampChatHeight(height: number, available: number): number {
  const max = Math.max(MIN_CHAT_PX, available - MIN_TERMINAL_PX);
  return Math.round(Math.min(max, Math.max(MIN_CHAT_PX, height)));
}

export function defaultChatHeight(available: number): number {
  return clampChatHeight(available * DEFAULT_CHAT_FRACTION, available);
}

export function readLayout(saved: unknown): LayoutState {
  const o = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  const height = typeof o.chatHeight === "number" && Number.isFinite(o.chatHeight) && o.chatHeight > 0 ? o.chatHeight : null;
  return { chatHeight: height, collapsed: o.collapsed === true };
}

/**
 * Lets the person drag the line between the terminal and the chat. The height is applied through the
 * `--chat-height` variable on the app element, and saved when the drag ends.
 */
export function attachSplitter(opts: {
  app: HTMLElement;
  splitter: HTMLElement;
  state: LayoutState;
  save: (state: LayoutState) => void;
}): { setCollapsed: (collapsed: boolean) => void; apply: () => void } {
  const { app, splitter, state } = opts;

  const available = () => app.clientHeight;
  const apply = () => {
    app.classList.toggle("chat-collapsed", state.collapsed);
    const height = state.chatHeight ?? defaultChatHeight(available());
    app.style.setProperty("--chat-height", `${clampChatHeight(height, available())}px`);
    splitter.setAttribute("aria-valuenow", String(Math.round(clampChatHeight(height, available()))));
    splitter.hidden = state.collapsed;
  };
  const set = (height: number, persist: boolean) => {
    state.chatHeight = clampChatHeight(height, available());
    apply();
    if (persist) opts.save({ ...state });
  };

  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    app.classList.add("resizing");
    const move = (e: PointerEvent) => set(app.getBoundingClientRect().bottom - e.clientY, false);
    const end = () => {
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", end);
      splitter.removeEventListener("pointercancel", end);
      app.classList.remove("resizing");
      opts.save({ ...state });
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", end);
    splitter.addEventListener("pointercancel", end);
  });

  splitter.addEventListener("keydown", (event) => {
    const current = state.chatHeight ?? defaultChatHeight(available());
    if (event.key === "ArrowUp") set(current + KEY_STEP_PX, true);
    else if (event.key === "ArrowDown") set(current - KEY_STEP_PX, true);
    else return;
    event.preventDefault();
  });
  splitter.addEventListener("dblclick", () => {
    state.chatHeight = null;
    apply();
    opts.save({ ...state });
  });
  window.addEventListener("resize", apply);

  return {
    apply,
    setCollapsed: (collapsed) => {
      state.collapsed = collapsed;
      apply();
      opts.save({ ...state });
    },
  };
}
