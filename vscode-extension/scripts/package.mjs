// Packages the extension as a .vsix.
//
//   node scripts/package.mjs              a .vsix for the system this runs on, helper built here
//   node scripts/package.mjs --universal  one .vsix for every system that has a helper in bin/
//
// Use --universal when the extension is installed somewhere other than where it is built, such as the
// remote machine of a Remote SSH window: the extension runs on the remote, so it needs the remote's
// helper. Put one helper per system in bin/<platform>-<arch>/ first (the "VS Code extension" workflow
// does this), then package.
//
// `vsce` is fetched on demand with npx, so the extension carries no packaging dependency.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

const vsce = ["--yes", "@vscode/vsce@3.6.0", "package", "--no-dependencies", "--skip-license"];
if (process.argv.includes("--universal")) {
  run("node", ["scripts/build.mjs", "--release", "--skip-helper"]);
  const bin = resolve(extensionRoot, "bin");
  const systems = existsSync(bin) ? readdirSync(bin) : [];
  if (systems.length === 0) {
    console.error("bin/ has no helpers: build one per system into bin/<platform>-<arch>/ first");
    process.exit(1);
  }
  console.log(`• helpers: ${systems.join(", ")}`);
  run("npx", [...vsce, "--out", "terax-terminal-universal.vsix"]);
} else {
  run("node", ["scripts/build.mjs", "--release"]);
  const target = `${process.platform}-${process.arch}`;
  run("npx", [...vsce, "--target", target]);
}
