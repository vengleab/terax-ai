import * as path from "node:path";

export type ShellEnvironment = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (file: string) => boolean;
};

export type ShellConfig = {
  shell: string;
  shellArgs: string[];
  /** The default terminal profile's path and arguments, when VS Code has one for this system. */
  profilePath?: string;
  profileArgs?: string[];
};

export type ShellChoice = { file: string; args: string[]; title: string };

function titleOf(file: string): string {
  // Either kind of separator, whatever system this runs on: the setting may name a Windows path.
  const name = file.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.exe$/i, "") || "shell";
}

function onPath(name: string, e: ShellEnvironment): string | undefined {
  const separator = e.platform === "win32" ? ";" : ":";
  for (const dir of (e.env.PATH ?? e.env.Path ?? "").split(separator)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (e.exists(candidate)) return candidate;
  }
  return undefined;
}

function defaultShell(e: ShellEnvironment): string {
  if (e.platform === "win32") {
    return onPath("pwsh.exe", e) ?? onPath("powershell.exe", e) ?? e.env.COMSPEC ?? "cmd.exe";
  }
  const fromEnv = e.env.SHELL;
  if (fromEnv && e.exists(fromEnv)) return fromEnv;
  if (e.platform === "darwin" && e.exists("/bin/zsh")) return "/bin/zsh";
  return e.exists("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** macOS starts shells as login shells, which is what VS Code's own terminal does there too. */
function defaultArgs(file: string, e: ShellEnvironment): string[] {
  if (e.platform !== "darwin") return [];
  return ["zsh", "bash", "fish"].includes(titleOf(file)) ? ["-l"] : [];
}

export function chooseShell(config: ShellConfig, e: ShellEnvironment): ShellChoice {
  const configured = config.shell.trim();
  if (configured) {
    return {
      file: configured,
      args: config.shellArgs.length > 0 ? config.shellArgs : defaultArgs(configured, e),
      title: titleOf(configured),
    };
  }
  if (config.profilePath && e.exists(config.profilePath)) {
    const args = config.shellArgs.length > 0 ? config.shellArgs : (config.profileArgs ?? []);
    return { file: config.profilePath, args, title: titleOf(config.profilePath) };
  }
  const file = defaultShell(e);
  return {
    file,
    args: config.shellArgs.length > 0 ? config.shellArgs : defaultArgs(file, e),
    title: titleOf(file),
  };
}

/** Where a new terminal starts: an explicit folder, then the setting, then the workspace, then home. */
export function chooseCwd(
  candidates: (string | undefined)[],
  home: string,
  exists: (dir: string) => boolean,
): string {
  for (const candidate of candidates) {
    if (candidate?.trim() && exists(candidate)) return candidate;
  }
  return home;
}

const DROPPED_VSCODE_VARIABLES = new Set([
  "VSCODE_NLS_CONFIG",
  "VSCODE_HANDLES_UNCAUGHT_ERRORS",
  "VSCODE_CODE_CACHE_PATH",
  "VSCODE_L10N_BUNDLE_LOCATION",
  "VSCODE_PID",
  "VSCODE_CWD",
  "VSCODE_AMD_ENTRYPOINT",
  "VSCODE_ESM_ENTRYPOINT",
  "VSCODE_PORTABLE",
  "VSCODE_DEV",
  "VSCODE_IPC_HOOK",
]);

/**
 * The environment the shells get. It starts from the extension host's, minus the settings VS Code
 * keeps for itself: `ELECTRON_RUN_AS_NODE` in particular would make any Electron app started from
 * the terminal behave as plain Node. `VSCODE_IPC_HOOK_CLI` is kept so `code file.txt` works.
 */
export function shellEnvironment(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.startsWith("ELECTRON_") || DROPPED_VSCODE_VARIABLES.has(key)) continue;
    out[key] = value;
  }
  out.TERM_PROGRAM = "Terax";
  Object.assign(out, extra);
  return out;
}

/** The default profile's path and arguments, from `terminal.integrated.profiles.<os>`. */
export function profileFor(
  profiles: unknown,
  name: unknown,
  exists: (file: string) => boolean,
): { path?: string; args?: string[] } {
  if (typeof name !== "string" || !profiles || typeof profiles !== "object") return {};
  const profile = (profiles as Record<string, unknown>)[name];
  if (!profile || typeof profile !== "object") return {};
  const { path: raw, args } = profile as { path?: unknown; args?: unknown };
  const candidates = Array.isArray(raw) ? raw : [raw];
  const found = candidates.find((c): c is string => typeof c === "string" && exists(c));
  return {
    path: found,
    args: Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : undefined,
  };
}
