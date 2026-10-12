import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

const here = import.meta.dirname;

/**
 * Bundles the extension host into one file. The AI agent uses the same AI SDK, model registry and
 * path-safety rules as the Terax app, which live in the app's own source tree and node_modules, so
 * the host is bundled rather than compiled file by file. Only `vscode` and Node itself stay outside.
 */
export default defineConfig({
  root: here,
  publicDir: false,
  build: {
    outDir: path.resolve(here, "dist/host"),
    emptyOutDir: true,
    target: "node20",
    minify: true,
    sourcemap: false,
    ssr: path.join(here, "src/extension.ts"),
    rolldownOptions: {
      external: ["vscode", ...builtinModules, /^node:/],
      output: { format: "cjs", entryFileNames: "extension.js", codeSplitting: false },
    },
  },
  ssr: { noExternal: true },
});
