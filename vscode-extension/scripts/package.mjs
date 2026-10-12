// Packages the extension as a .vsix for the system this runs on.
//
//   node scripts/package.mjs
//
// `vsce` is fetched on demand with npx, so the extension carries no packaging dependency.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: extensionRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run("node", ["scripts/build.mjs", "--release"]);
const target = `${process.platform}-${process.arch}`;
run("npx", ["--yes", "@vscode/vsce@3.6.0", "package", "--no-dependencies", "--target", target, "--skip-license"]);
