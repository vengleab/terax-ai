// Builds everything the extension needs into dist/ and bin/.
//
//   node scripts/build.mjs [--skip-helper] [--release]
//
// Run from anywhere. The webview bundle uses the app's Vite, so `pnpm install` must have been run at
// the repository root first.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const repoRoot = resolve(extensionRoot, "..");
const args = new Set(process.argv.slice(2));

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`\n${command} ${commandArgs.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}

const dist = join(extensionRoot, "dist");
rmSync(dist, { recursive: true, force: true });

console.log("• webview");
run("pnpm", ["exec", "vite", "build", "-c", "vscode-extension/webview/vite.config.mts"], repoRoot);
const webview = join(dist, "webview");
copyFileSync(join(extensionRoot, "webview", "index.css"), join(webview, "index.css"));
for (const name of ["ghostty-vt.wasm", "ghostty-vt-scalar.wasm"]) {
  copyFileSync(join(repoRoot, "packages", "ghostty-core", "adapted", name), join(webview, name));
}

console.log("• extension host");
run("pnpm", ["exec", "tsc", "-p", "vscode-extension/tsconfig.host.json"], repoRoot);

if (args.has("--skip-helper")) {
  console.log("• helper skipped");
} else {
  console.log("• helper");
  const profile = args.has("--release") ? ["--release"] : [];
  run("cargo", ["build", ...profile], join(extensionRoot, "helper"));
  if (args.has("--release")) {
    const name = process.platform === "win32" ? "terax-vscode-pty.exe" : "terax-vscode-pty";
    const built = join(extensionRoot, "helper", "target", "release", name);
    if (!existsSync(built)) throw new Error(`${built} was not produced`);
    const target = join(extensionRoot, "bin", `${process.platform}-${process.arch}`);
    mkdirSync(target, { recursive: true });
    copyFileSync(built, join(target, name));
    console.log(`  → bin/${process.platform}-${process.arch}/${name}`);
  }
}
console.log("done");
