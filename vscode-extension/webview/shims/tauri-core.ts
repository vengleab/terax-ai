/**
 * Stand-in for `@tauri-apps/api/core`. Terax's terminal engine imports it for the desktop app; in a
 * VS Code webview there is no Tauri, and the engine checks `isTauri()` / `__TAURI_INTERNALS__`
 * before calling anything, so none of these are ever reached.
 */
export function isTauri(): boolean {
  return false;
}

export async function invoke<T>(command: string): Promise<T> {
  throw new Error(`Tauri command ${command} is not available in the VS Code webview`);
}

export class Channel<T> {
  onmessage: (message: T) => void = () => {};
}
