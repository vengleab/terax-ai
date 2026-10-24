/**
 * Keys that belong to VS Code even when the terminal has focus, like `terminal.integrated.commandsToSkipShell`
 * does for the built-in terminal. The page cannot ask VS Code which commands are bound to a key, so
 * this is a list of keys. Everything else, Ctrl+R and Ctrl+B included, goes to the shell.
 */
export const DEFAULT_SKIP_SHELL_KEYS = [
  "f1",
  "ctrl+shift+p",
  "ctrl+`",
  "ctrl+shift+`",
  "ctrl+tab",
  "ctrl+shift+tab",
  "ctrl+pageup",
  "ctrl+pagedown",
];

/** The parts of a keyboard event that matter here. A structural type, so this file needs no DOM types. */
export type KeyLike = {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

const ALIASES: Record<string, string> = {
  control: "ctrl",
  cmd: "meta",
  command: "meta",
  win: "meta",
  super: "meta",
  option: "alt",
  backquote: "`",
  esc: "escape",
  " ": "space",
};

function normalizeKey(raw: string): string {
  const key = raw.toLowerCase();
  return ALIASES[key] ?? key;
}

/** `ctrl+shift+p` style text for a key event: modifiers in a fixed order, then the key. */
export function keyCombo(event: KeyLike): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (event.metaKey) parts.push("meta");
  // Backquote is read from the physical key, since shifting it changes `event.key` to `~`.
  const key = event.code === "Backquote" ? "`" : normalizeKey(event.key);
  if (!["control", "alt", "shift", "meta", "ctrl"].includes(key)) parts.push(key);
  return parts.join("+");
}

/** Puts a user-written combination (`Ctrl+Shift+P`, `cmd+b`) in the same form as `keyCombo`. */
export function normalizeCombo(text: string): string {
  const parts = text
    .split("+")
    .map((p) => normalizeKey(p.trim()))
    .filter(Boolean);
  const key = parts.filter((p) => !["ctrl", "alt", "shift", "meta"].includes(p)).pop() ?? "";
  const ordered = (["ctrl", "alt", "shift", "meta"] as const).filter((m) => parts.includes(m));
  return [...ordered, key].filter(Boolean).join("+");
}

export function skipsShell(event: KeyLike, combos: readonly string[]): boolean {
  if (combos.length === 0) return false;
  const pressed = keyCombo(event);
  return combos.some((combo) => normalizeCombo(combo) === pressed);
}
