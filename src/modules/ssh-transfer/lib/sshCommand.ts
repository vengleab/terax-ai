import { quoteShellArg } from "@/lib/shellQuote";
import { REMOTE_CWD_PREFIX } from "./remoteCwd";

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Starts the server's login shell with a bash prompt hook that reports the current folder as a
 * terminal title (`terax-cwd:<path>`), which the Explorer follows. Other shells ignore it.
 */
export const REMOTE_CWD_COMMAND = `env PROMPT_COMMAND='printf "\\033]2;${REMOTE_CWD_PREFIX}%s\\007" "\${PWD//[[:cntrl:]]/}"' "$SHELL" -l`;

/**
 * Builds the line typed into a terminal to open an interactive session. Only unsafe words are
 * quoted. A remote command makes ssh request a terminal and run it instead of the plain login.
 */
export function buildSshCommand(
  args: string[],
  windows?: boolean,
  remoteCommand?: string,
): string {
  const words = args.map((arg) => (SAFE.test(arg) ? arg : quoteShellArg(arg, windows)));
  if (!remoteCommand) return ["ssh", ...words].join(" ");
  return ["ssh", "-t", ...words, quoteShellArg(remoteCommand, windows)].join(" ");
}
