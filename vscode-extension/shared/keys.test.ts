import { describe, expect, it } from "vitest";
import { DEFAULT_SKIP_SHELL_KEYS, keyCombo, normalizeCombo, skipsShell, type KeyLike } from "./keys";

const key = (over: Partial<KeyLike>): KeyLike => ({ key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over });

describe("keyCombo", () => {
  it("writes modifiers in a fixed order, then the key", () => {
    expect(keyCombo(key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+p");
    expect(keyCombo(key({ key: "x", code: "KeyX", metaKey: true, altKey: true, ctrlKey: true }))).toBe("ctrl+alt+meta+x");
    expect(keyCombo(key({ key: "F1", code: "F1" }))).toBe("f1");
  });

  it("does not count a modifier key as the key", () => {
    expect(keyCombo(key({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBe("ctrl");
  });

  it("reads the backquote from the physical key, shifted or not", () => {
    expect(keyCombo(key({ key: "`", code: "Backquote", ctrlKey: true }))).toBe("ctrl+`");
    expect(keyCombo(key({ key: "~", code: "Backquote", ctrlKey: true, shiftKey: true }))).toBe("ctrl+shift+`");
  });
});

describe("normalizeCombo", () => {
  it("accepts the ways people write a shortcut", () => {
    expect(normalizeCombo("Ctrl+Shift+P")).toBe("ctrl+shift+p");
    expect(normalizeCombo("shift+ctrl+p")).toBe("ctrl+shift+p");
    expect(normalizeCombo("Cmd+B")).toBe("meta+b");
    expect(normalizeCombo("Option+Left")).toBe("alt+left");
    expect(normalizeCombo(" ctrl + ` ")).toBe("ctrl+`");
    expect(normalizeCombo("ctrl+backquote")).toBe("ctrl+`");
    expect(normalizeCombo("")).toBe("");
  });
});

describe("skipsShell", () => {
  it("passes the keys VS Code keeps, and nothing the shell needs", () => {
    const passes = (e: Partial<KeyLike>) => skipsShell(key(e), DEFAULT_SKIP_SHELL_KEYS);
    expect(passes({ key: "F1", code: "F1" })).toBe(true);
    expect(passes({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(passes({ key: "`", code: "Backquote", ctrlKey: true })).toBe(true);
    expect(passes({ key: "Tab", code: "Tab", ctrlKey: true })).toBe(true);
    expect(passes({ key: "p", code: "KeyP", ctrlKey: true })).toBe(false);
    expect(passes({ key: "b", code: "KeyB", ctrlKey: true })).toBe(false);
    expect(passes({ key: "r", code: "KeyR", ctrlKey: true })).toBe(false);
    expect(passes({ key: "a", code: "KeyA" })).toBe(false);
  });

  it("follows a user's own list", () => {
    expect(skipsShell(key({ key: "b", code: "KeyB", ctrlKey: true }), ["Ctrl+B"])).toBe(true);
    expect(skipsShell(key({ key: "b", code: "KeyB", ctrlKey: true }), [])).toBe(false);
  });
});
