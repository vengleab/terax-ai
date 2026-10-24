import { describe, expect, it } from "vitest";
import { clampChatHeight, defaultChatHeight, MIN_CHAT_PX, MIN_TERMINAL_PX, readLayout } from "./layout";

describe("clampChatHeight", () => {
  it("leaves a height that fits alone", () => {
    expect(clampChatHeight(300, 800)).toBe(300);
  });

  it("keeps the chat at least its minimum", () => {
    expect(clampChatHeight(10, 800)).toBe(MIN_CHAT_PX);
  });

  it("keeps the terminal at least its minimum", () => {
    expect(clampChatHeight(790, 800)).toBe(800 - MIN_TERMINAL_PX);
  });

  it("copes with a panel too small for both", () => {
    expect(clampChatHeight(500, 150)).toBe(MIN_CHAT_PX);
  });
});

describe("defaultChatHeight", () => {
  it("is two fifths of the panel, so the terminal keeps the larger share", () => {
    expect(defaultChatHeight(1000)).toBe(400);
  });

  it("never goes below the minimum", () => {
    expect(defaultChatHeight(200)).toBe(MIN_CHAT_PX);
  });
});

describe("readLayout", () => {
  it("restores what was saved", () => {
    expect(readLayout({ chatHeight: 240, collapsed: true })).toEqual({ chatHeight: 240, collapsed: true });
  });

  it("ignores anything that is not a layout", () => {
    expect(readLayout(undefined)).toEqual({ chatHeight: null, collapsed: false });
    expect(readLayout({ chatHeight: "tall", collapsed: "yes" })).toEqual({ chatHeight: null, collapsed: false });
    expect(readLayout({ chatHeight: -5 })).toEqual({ chatHeight: null, collapsed: false });
    expect(readLayout({ chatHeight: Number.NaN })).toEqual({ chatHeight: null, collapsed: false });
  });
});
