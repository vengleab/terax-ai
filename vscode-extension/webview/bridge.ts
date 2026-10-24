import type { HostMessage, WebviewMessage } from "../shared/messages";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  api.postMessage(message);
}

/** What the page keeps across reloads: the chat's height and whether it is folded. */
export function savedState(): unknown {
  try {
    return api.getState();
  } catch {
    return undefined;
  }
}

export function saveState(state: unknown): void {
  try {
    api.setState(state);
  } catch {
    // Keeping the layout is a convenience; the page works without it.
  }
}

export function onHostMessage(handler: (message: HostMessage) => void): void {
  window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
    if (event.data && typeof event.data.type === "string") handler(event.data);
  });
}

let nextRequest = 1;
const clipboardRequests = new Map<number, (text: string) => void>();

/** Called by the message handler when the host answers a clipboard read. */
export function resolveClipboard(requestId: number, text: string): void {
  clipboardRequests.get(requestId)?.(text);
  clipboardRequests.delete(requestId);
}

const CLIPBOARD_TIMEOUT_MS = 3000;

export function readClipboard(): Promise<string> {
  return new Promise((resolve) => {
    const requestId = nextRequest++;
    const timer = setTimeout(() => {
      clipboardRequests.delete(requestId);
      resolve("");
    }, CLIPBOARD_TIMEOUT_MS);
    clipboardRequests.set(requestId, (text) => {
      clearTimeout(timer);
      resolve(text);
    });
    post({ type: "clipboard-read", requestId });
  });
}

export function writeClipboard(text: string): void {
  post({ type: "clipboard-write", text });
}
