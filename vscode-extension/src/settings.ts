import { DEFAULT_SKIP_SHELL_KEYS } from "../shared/keys";
import type { TerminalSettings } from "../shared/messages";

export type ConfigGetter = <T>(section: string, fallback: T) => T;

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/** Terax uses the settings people already have for VS Code's terminal, so the two look alike. */
export function terminalSettings(get: ConfigGetter): TerminalSettings {
  const family =
    get<string>("terminal.integrated.fontFamily", "") || get<string>("editor.fontFamily", "") || "monospace";
  const cursor = get<string>("terminal.integrated.cursorStyle", "block");
  const weight = get<string | number>("terminal.integrated.fontWeight", "normal");
  return {
    fontFamily: family,
    fontSize: clamp(get<number>("terminal.integrated.fontSize", 14), 6, 100),
    fontWeight: String(weight),
    lineHeight: clamp(get<number>("terminal.integrated.lineHeight", 1), 1, 3),
    letterSpacing: clamp(get<number>("terminal.integrated.letterSpacing", 0), 0, 10),
    cursorStyle: cursor === "line" ? "bar" : cursor === "underline" ? "underline" : "block",
    cursorBlink: get<boolean>("terminal.integrated.cursorBlinking", false),
    scrollback: Math.round(clamp(get<number>("terminal.integrated.scrollback", 1000), 200, 50_000)),
    skipShellKeys: get<string[]>("terax.skipShellKeys", DEFAULT_SKIP_SHELL_KEYS).filter((k) => typeof k === "string"),
  };
}
