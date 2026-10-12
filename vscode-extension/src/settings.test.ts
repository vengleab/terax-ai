import { describe, expect, it } from "vitest";
import { terminalSettings } from "./settings";

const from = (values: Record<string, unknown>) => <T>(section: string, fallback: T): T =>
  (section in values ? values[section] : fallback) as T;

describe("terminalSettings", () => {
  it("uses VS Code's terminal defaults when nothing is set", () => {
    expect(terminalSettings(from({}))).toEqual({
      fontFamily: "monospace",
      fontSize: 14,
      fontWeight: "normal",
      lineHeight: 1,
      letterSpacing: 0,
      cursorStyle: "block",
      cursorBlink: false,
      scrollback: 1000,
      skipShellKeys: ["f1", "ctrl+shift+p", "ctrl+`", "ctrl+shift+`", "ctrl+tab", "ctrl+shift+tab", "ctrl+pageup", "ctrl+pagedown"],
    });
  });

  it("follows the terminal's own font, then the editor's", () => {
    expect(terminalSettings(from({ "terminal.integrated.fontFamily": "Fira Code", "editor.fontFamily": "Menlo" })).fontFamily).toBe("Fira Code");
    expect(terminalSettings(from({ "editor.fontFamily": "Menlo" })).fontFamily).toBe("Menlo");
  });

  it("maps VS Code's cursor names to the engine's", () => {
    const style = (value: string) => terminalSettings(from({ "terminal.integrated.cursorStyle": value })).cursorStyle;
    expect([style("block"), style("line"), style("underline")]).toEqual(["block", "bar", "underline"]);
  });

  it("keeps numbers in a sane range", () => {
    const s = terminalSettings(
      from({
        "terminal.integrated.fontSize": 1,
        "terminal.integrated.scrollback": 10_000_000,
        "terminal.integrated.lineHeight": 99,
        "terminal.integrated.letterSpacing": -4,
      }),
    );
    expect([s.fontSize, s.scrollback, s.lineHeight, s.letterSpacing]).toEqual([6, 50_000, 3, 0]);
    expect(terminalSettings(from({ "terminal.integrated.fontSize": Number.NaN })).fontSize).toBe(6);
  });

  it("turns a numeric font weight into text", () => {
    expect(terminalSettings(from({ "terminal.integrated.fontWeight": 500 })).fontWeight).toBe("500");
  });

  it("takes the user's list of keys to keep for VS Code, ignoring anything that is not text", () => {
    expect(terminalSettings(from({ "terax.skipShellKeys": ["ctrl+b", 5, null, "f1"] })).skipShellKeys).toEqual(["ctrl+b", "f1"]);
    expect(terminalSettings(from({ "terax.skipShellKeys": [] })).skipShellKeys).toEqual([]);
  });
});
