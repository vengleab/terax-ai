import { quoteShellArg } from "@/lib/shellQuote";

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Builds the line typed into a terminal to open an interactive session. Only unsafe words are quoted. */
export function buildSshCommand(args: string[], windows?: boolean): string {
  const words = args.map((arg) => (SAFE.test(arg) ? arg : quoteShellArg(arg, windows)));
  return ["ssh", ...words].join(" ");
}
