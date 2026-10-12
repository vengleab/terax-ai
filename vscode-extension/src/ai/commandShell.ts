export type CommandShell = {
  file: string;
  args: (command: string) => string[];
};

function nameOf(file: string): string {
  return (file.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
}

/**
 * How the agent runs one command line with the shell the person already uses, so `run_command` sees the
 * same tools and syntax as their terminal. macOS apps start with a short PATH, so a login shell is
 * used there, as the terminal does.
 */
export function commandShell(file: string, platform: NodeJS.Platform): CommandShell {
  const name = nameOf(file);
  if (name === "cmd") return { file, args: (command) => ["/d", "/s", "/c", command] };
  if (name === "pwsh" || name === "powershell") {
    return { file, args: (command) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  }
  const login = platform === "darwin" && ["zsh", "bash", "fish"].includes(name);
  return { file, args: (command) => (login ? ["-l", "-c", command] : ["-c", command]) };
}
