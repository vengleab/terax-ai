import { describe, expect, it } from "vitest";
import { previewChange } from "./diff";

describe("previewChange", () => {
  it("shows the changed lines with a little context around them", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "D", "e", "f", "g", "h"].join("\n");
    expect(previewChange(before, after).lines).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "ctx", text: "b" },
      { kind: "ctx", text: "c" },
      { kind: "del", text: "d" },
      { kind: "add", text: "D" },
      { kind: "ctx", text: "e" },
      { kind: "ctx", text: "f" },
      { kind: "ctx", text: "g" },
    ]);
  });

  it("shows a new file as all additions", () => {
    expect(previewChange("", "one\ntwo").lines).toEqual([
      { kind: "del", text: "" },
      { kind: "add", text: "one" },
      { kind: "add", text: "two" },
    ]);
  });

  it("shows nothing for an identical file", () => {
    expect(previewChange("same\n", "same\n").lines).toEqual([]);
  });

  it("caps a huge change, and says so", () => {
    const after = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const result = previewChange("", after);
    expect(result.truncated).toBe(true);
    expect(result.lines.length).toBe(160);
  });
});
