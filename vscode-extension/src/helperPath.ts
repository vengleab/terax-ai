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
