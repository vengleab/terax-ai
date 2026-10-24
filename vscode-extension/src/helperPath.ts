import * as path from "node:path";

export function helperFileName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "terax-vscode-pty.exe" : "terax-vscode-pty";
}

/**
 * Where the helper binary is. A packaged extension carries one per system under `bin/`; running from
 * the source tree uses whatever `cargo build` last produced.
 */
export function helperCandidates(
  extensionPath: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const name = helperFileName(platform);
  return [
    path.join(extensionPath, "bin", `${platform}-${arch}`, name),
    path.join(extensionPath, "helper", "target", "release", name),
    path.join(extensionPath, "helper", "target", "debug", name),
  ];
}

export function findHelper(
  extensionPath: string,
  platform: NodeJS.Platform,
  arch: string,
  exists: (file: string) => boolean,
): string | undefined {
  return helperCandidates(extensionPath, platform, arch).find(exists);
}

/** What to tell someone when no helper matches this system, naming the systems the package does carry. */
export function missingHelperMessage(
  extensionPath: string,
  platform: NodeJS.Platform,
  arch: string,
  listBin: (dir: string) => string[],
): string {
  let carried: string[] = [];
  try {
    carried = listBin(path.join(extensionPath, "bin"));
  } catch {
    // no bin folder at all
  }
  const have = carried.length > 0 ? carried.join(", ") : "none";
  return (
    `The Terax terminal helper is not included for ${platform}-${arch} (this package carries: ${have}). ` +
    `The extension runs on the machine that holds the workspace, so in a Remote SSH, WSL or container window it needs ` +
    `a helper built for that machine. Install a .vsix that carries it (node scripts/package.mjs --universal), ` +
    `or run "cargo build --release" in vscode-extension/helper on that machine.`
  );
}
