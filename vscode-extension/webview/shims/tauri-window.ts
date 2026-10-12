/** Stand-in for `@tauri-apps/api/window`; see `tauri-core.ts`. */
export function getCurrentWindow(): never {
  throw new Error("Tauri windows are not available in the VS Code webview");
}
