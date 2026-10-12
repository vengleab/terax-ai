import { GhosttyCoreRuntime } from "@/modules/terminal/ghostty/GhosttyCoreRuntime";
import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import {
  type TerminalFontMetrics,
  type TerminalGpuTheme,
  rgbToInt,
} from "@/modules/terminal/ghostty/gpu/terminalVisuals";
import { GhosttyInputController } from "@/modules/terminal/ghostty/input/GhosttyInputController";
import { WebGlTerminalSurface } from "@/modules/terminal/ghostty/webgl/WebGlTerminalSurface";
import { skipsShell } from "../shared/keys";
import type { TerminalSettings, WebviewMessage } from "../shared/messages";

const ACK_DELAY_MS = 20;

export type SessionDeps = {
  runtime: GhosttyCoreRuntime;
  settings: () => TerminalSettings;
  metrics: () => TerminalFontMetrics;
  theme: () => TerminalGpuTheme;
  isMac: boolean;
  send: (message: WebviewMessage) => void;
  onTitle: (id: number, title: string) => void;
  onEnded: (id: number, code: number) => void;
};

function colors(theme: TerminalGpuTheme) {
  return {
    fgColor: rgbToInt(theme.foreground),
    bgColor: rgbToInt(theme.background),
    cursorColor: rgbToInt(theme.cursor),
    palette: theme.palette.map(rgbToInt),
  };
}

/** One shell: Terax's terminal model and WebGL surface, wired to the host over messages. */
export class TerminalSession {
  readonly element = document.createElement("div");
  title = "shell";
  exited = false;

  private model: GhosttyTerminalModelApi | null = null;
  private surface: WebGlTerminalSurface | null = null;
  private input: GhosttyInputController | null = null;
  private active = false;
  private pendingAck = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    readonly id: number,
    private readonly deps: SessionDeps,
    private readonly cwd?: string,
  ) {
    this.element.className = "terminal-host";
  }

  /** The element must already be in the document, so the surface can measure it. */
  async start(): Promise<void> {
    const { deps, id } = this;
    const settings = deps.settings();
    const theme = deps.theme();
    const model = await deps.runtime.createModel({
      leafId: id,
      backend: "ghostty-webgl",
      cols: 80,
      rows: 24,
      config: {
        scrollbackLimit: settings.scrollback,
        cursorStyle: settings.cursorStyle,
        cursorBlink: settings.cursorBlink,
        ...colors(theme),
      },
      onReply: (bytes) => this.sendInput(bytes),
      onEvent: (event) => {
        if (event.type === "title" && event.title) {
          this.title = event.title;
          deps.onTitle(id, event.title);
        }
      },
    });
    if (this.disposed) {
      model.dispose();
      return;
    }
    this.model = model;

    const surface = new WebGlTerminalSurface({
      model,
      metrics: deps.metrics(),
      theme,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      onResize: (cols, rows) => deps.send({ type: "resize", id, cols, rows }),
      onError: (error) =>
        deps.send({ type: "log", level: "error", message: `terminal surface: ${error.message}` }),
      onRequestFocus: () => this.focus(),
      onOpenLink: (uri) => deps.send({ type: "open-link", uri }),
    });
    this.surface = surface;
    surface.attach(this.element);
    this.watchLinkClicks(surface, model);
    // Registered before the input controller's own handler, so it sees keys first. Marking the event
    // as handled makes the controller leave it alone, and it still travels on up to VS Code.
    surface.inputElement().addEventListener("keydown", (event) => {
      if (skipsShell(event, deps.settings().skipShellKeys)) event.preventDefault();
    });
    this.input = new GhosttyInputController({
      model,
      input: surface.inputElement(),
      pointerTarget: surface.eventTarget(),
      cellSize: () => surface.cellSize(),
      isMac: deps.isMac,
      onData: (bytes) => this.sendInput(bytes),
      getSelection: () => surface.getSelection(),
      onCopy: () => {
        const text = surface.getSelection();
        if (!text) return false;
        deps.send({ type: "clipboard-write", text });
        return true;
      },
    });

    // attach() has fitted the model to the page, so the shell starts at the right size.
    deps.send({ type: "spawn", id, cols: model.cols, rows: model.rows, cwd: this.cwd });
    // The terminal was made active before its surface existed, so it could not take focus then.
    if (this.active) this.focus();
  }

  /**
   * Opens a link that is clicked. The surface does this itself from mouse events, but its selection
   * handling cancels `pointerdown`, and in Chromium that suppresses the mouse events that follow, so
   * from here the surface's own click never arrives. Pointer events are not suppressed.
   */
  private watchLinkClicks(surface: WebGlTerminalSurface, model: GhosttyTerminalModelApi): void {
    const target = surface.eventTarget();
    const linkAt = (event: PointerEvent): string | null => {
      if (model.modes().mouseTracking && !event.shiftKey) return null;
      const rect = target.getBoundingClientRect();
      const cell = surface.cellSize();
      const column = Math.floor((event.clientX - rect.left) / cell.width);
      const row = Math.floor((event.clientY - rect.top) / cell.height);
      if (column < 0 || row < 0 || column >= model.cols || row >= model.rows) return null;
      return model.hyperlinkAtViewportCell(row, column);
    };
    let pressed: { x: number; y: number; uri: string } | null = null;
    target.addEventListener("pointerdown", (event) => {
      const uri = event.button === 0 ? linkAt(event) : null;
      pressed = uri ? { x: event.clientX, y: event.clientY, uri } : null;
    });
    target.addEventListener("pointerup", (event) => {
      const start = pressed;
      pressed = null;
      if (!start || event.button !== 0) return;
      // A drag that ends on a link is a selection, not a click.
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      if (linkAt(event) === start.uri) this.deps.send({ type: "open-link", uri: start.uri });
    });
  }

  private sendInput(bytes: Uint8Array): void {
    if (this.exited || this.disposed) return;
    this.deps.send({ type: "input", id: this.id, bytes });
  }

  /** Output from the shell. */
  write(bytes: Uint8Array): void {
    if (!this.model || this.disposed) return;
    this.model.write(bytes);
    this.pendingAck += bytes.length;
    this.ackTimer ??= setTimeout(() => this.flushAck(), ACK_DELAY_MS);
  }

  private flushAck(): void {
    this.ackTimer = null;
    if (this.pendingAck === 0 || this.disposed) return;
    const bytes = this.pendingAck;
    this.pendingAck = 0;
    this.deps.send({ type: "ack", id: this.id, bytes });
  }

  /**
   * Text the host wants typed into the shell. It is sent as typed, not as a paste: a paste is wrapped
   * in bracketed-paste markers, and then a trailing newline would not run the command.
   */
  sendText(text: string): void {
    this.sendInput(new TextEncoder().encode(text));
  }

  focus(): void {
    this.surface?.focus();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.element.hidden = !active;
    this.surface?.setVisible(active);
    this.surface?.setFocused(active);
    if (active) this.focus();
  }

  clear(): void {
    this.model?.clear();
  }

  /**
   * Puts text at the prompt for the person to look at, without running it. A text with several lines
   * is only inserted when the shell has bracketed paste, which keeps the lines from running as they
   * arrive; otherwise nothing is inserted and the caller says so.
   */
  insertText(text: string): boolean {
    const body = text.replace(/\r?\n$/, "");
    if (!this.model || !this.input || this.exited) return false;
    if (body.includes("\n") && !this.model.modes().bracketedPaste) return false;
    this.input.paste(body);
    return true;
  }

  /** The last `lines` lines of the terminal, scrollback included, for the AI to read. */
  readText(lines: number): string {
    try {
      return this.model?.readText(lines) ?? "";
    } catch {
      return "";
    }
  }

  applySettings(): void {
    const { surface, model, deps } = this;
    if (!surface || !model) return;
    const settings = deps.settings();
    const theme = deps.theme();
    model.setCursorOptions(settings.cursorStyle, settings.cursorBlink);
    const { fgColor, bgColor, cursorColor, palette } = colors(theme);
    model.setColors(fgColor, bgColor, cursorColor, palette);
    surface.setTheme(theme);
    surface.setFontMetrics(deps.metrics());
  }

  /** The shell has ended. The window stays so the last output can be read. */
  markExited(code: number): void {
    if (this.exited) return;
    this.exited = true;
    const text = `\r\n\x1b[2m[Process exited with code ${code}]\x1b[0m\r\n`;
    this.model?.write(new TextEncoder().encode(text));
    this.deps.onEnded(this.id, code);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.input?.dispose();
    this.surface?.dispose();
    this.model?.dispose();
    this.element.remove();
  }
}
