import path from "node:path";
import { defineConfig, type Plugin } from "vite";

const here = import.meta.dirname;
const repoRoot = path.resolve(here, "../..");

/**
 * The engine's default WASM location is `new URL("...wasm", import.meta.url)`, which a library build
 * would inline as base64 (1.9 MB) and which means nothing inside a webview. The page always passes
 * the real address, so the default is reduced to a plain file name.
 */
function plainWasmNames(): Plugin {
  return {
    name: "terax-plain-wasm-names",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/TeraxGhostty.ts")) return null;
      return code.replace(
        /new URL\("\.\.\/\.\.\/adapted\/(ghostty-vt(?:-scalar)?\.wasm)", import\.meta\.url\)\.href/g,
        '"$1"',
      );
    },
  };
}

/**
 * Builds the page that runs inside the VS Code webview. It reuses Terax's terminal engine from
 * `src/modules/terminal` and `packages/ghostty-core` as they are, and stands in for the few Tauri
 * modules that engine imports.
 */
export default defineConfig({
  root: here,
  base: "./",
  publicDir: false,
  plugins: [plainWasmNames()],
  resolve: {
    alias: [
      {
        find: /^@\/modules\/terminal\/lib\/terminalClipboard$/,
        replacement: path.join(here, "shims/terminalClipboard.ts"),
      },
      { find: /^@tauri-apps\/api\/core$/, replacement: path.join(here, "shims/tauri-core.ts") },
      { find: /^@tauri-apps\/api\/window$/, replacement: path.join(here, "shims/tauri-window.ts") },
      { find: /^@\//, replacement: `${path.join(repoRoot, "src")}/` },
    ],
  },
  build: {
    outDir: path.resolve(here, "../dist/webview"),
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    sourcemap: false,
    lib: {
      entry: path.join(here, "main.ts"),
      formats: ["iife"],
      name: "TeraxWebview",
      fileName: () => "main.js",
    },
  },
});
