/**
 * The messages between the extension host (Node) and the webview (the Terax terminal engine).
 * Both sides import this file, so the two can not drift apart without a type error.
 */

export type CursorStyle = "block" | "underline" | "bar";

export type TerminalSettings = {
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  /** Key combinations VS Code keeps for itself while the terminal has focus. */
  skipShellKeys: string[];
};

export type HostMessage =
  | {
      type: "init";
      wasmUrl: string;
      scalarWasmUrl: string;
      settings: TerminalSettings;
      isMac: boolean;
      /** Where the first terminal starts, when it was asked for with a folder. */
      cwd?: string;
    }
  | { type: "settings"; settings: TerminalSettings }
  /** The user asked for a new terminal (command, button or keybinding). */
  | { type: "new"; cwd?: string }
  | { type: "spawned"; id: number; pid: number; title: string }
  | { type: "data"; id: number; bytes: Uint8Array }
  | { type: "exit"; id: number; code: number }
  | { type: "error"; id: number; message: string }
  | { type: "kill-active" }
  | { type: "focus" }
  | { type: "clear" }
  | { type: "send-text"; text: string }
  | { type: "clipboard-text"; requestId: number; text: string };

export type WebviewMessage =
  | { type: "ready" }
  /** Whether the page has keyboard focus. VS Code does not give it back after the command palette closes. */
  | { type: "focus-state"; focused: boolean }
  | { type: "spawn"; id: number; cols: number; rows: number; cwd?: string }
  | { type: "input"; id: number; bytes: Uint8Array }
  | { type: "resize"; id: number; cols: number; rows: number }
  /** The page has parsed `bytes` more output. Lets the host slow the shell down when the page lags. */
  | { type: "ack"; id: number; bytes: number }
  | { type: "kill"; id: number }
  | { type: "clipboard-read"; requestId: number }
  | { type: "clipboard-write"; text: string }
  | { type: "open-link"; uri: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export const VIEW_ID = "terax.terminalView";

/** Output the page has not yet acknowledged before the shell is paused, and the level it resumes at. */
export const FLOW_HIGH_WATER = 512 * 1024;
export const FLOW_LOW_WATER = 128 * 1024;

/** Links the page may ask the host to open. Anything else (command:, file:, ...) is refused. */
export function isOpenableLink(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

/** Binary data crosses `postMessage` as a typed array, an ArrayBuffer, or (older hosts) a plain array. */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return Uint8Array.from((value as { data: number[] }).data);
  }
  return new Uint8Array(0);
}
