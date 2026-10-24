import { readClipboard, writeClipboard } from "../bridge";

/**
 * Replaces `@/modules/terminal/lib/terminalClipboard`. A webview may not read the clipboard directly,
 * so both directions go through the extension host.
 */
export function readTerminalClipboard(): Promise<string> {
  return readClipboard();
}

export async function writeTerminalClipboard(text: string): Promise<void> {
  writeClipboard(text);
}
