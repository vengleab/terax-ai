import { describe, expect, it } from "vitest";
import {
  applyClick,
  moveCursor,
  pruneSelection,
  selectAll,
  type SelectionState,
} from "./selection";

const order = ["/a", "/b", "/c", "/d", "/e"];
const empty: SelectionState = { selection: [], anchor: null, cursor: null };
const plain = { shift: false, mod: false };

describe("applyClick", () => {
  it("selects a single row on a plain click", () => {
    const s = applyClick(empty, order, "/b", plain);
    expect(s).toEqual({ selection: ["/b"], anchor: "/b", cursor: "/b" });
  });

  it("toggles with the modifier", () => {
    let s = applyClick(empty, order, "/b", plain);
    s = applyClick(s, order, "/d", { shift: false, mod: true });
    expect(s.selection).toEqual(["/b", "/d"]);
    s = applyClick(s, order, "/b", { shift: false, mod: true });
    expect(s.selection).toEqual(["/d"]);
  });

  it("selects a range from the anchor in either direction", () => {
    let s = applyClick(empty, order, "/b", plain);
    s = applyClick(s, order, "/d", { shift: true, mod: false });
    expect(s.selection).toEqual(["/b", "/c", "/d"]);
    s = applyClick(s, order, "/a", { shift: true, mod: false });
    expect(s.selection).toEqual(["/a", "/b"]);
    expect(s.anchor).toBe("/b");
  });

  it("falls back to a plain click when the anchor is gone", () => {
    const s = applyClick({ selection: ["/gone"], anchor: "/gone", cursor: "/gone" }, order, "/c", {
      shift: true,
      mod: false,
    });
    expect(s.selection).toEqual(["/c"]);
  });
});

describe("moveCursor", () => {
  it("steps and clamps", () => {
    let s = moveCursor(empty, order, 1, false);
    expect(s.cursor).toBe("/a");
    s = moveCursor(s, order, 1, false);
    expect(s.cursor).toBe("/b");
    s = moveCursor(s, order, -5, false);
    expect(s.cursor).toBe("/a");
    s = moveCursor(s, order, "end", false);
    expect(s.cursor).toBe("/e");
    s = moveCursor(s, order, 1, false);
    expect(s.cursor).toBe("/e");
    expect(moveCursor(s, order, "start", false).cursor).toBe("/a");
  });

  it("starts from the end when moving up with nothing focused", () => {
    expect(moveCursor(empty, order, -1, false).cursor).toBe("/e");
  });

  it("extends the selection with shift", () => {
    let s = moveCursor(empty, order, 1, false);
    s = moveCursor(s, order, 2, true);
    expect(s.selection).toEqual(["/a", "/b", "/c"]);
  });

  it("does nothing for an empty list", () => {
    expect(moveCursor(empty, [], 1, false)).toBe(empty);
  });
});

describe("selectAll / pruneSelection", () => {
  it("selects everything", () => {
    expect(selectAll(order).selection).toEqual(order);
    expect(selectAll([])).toEqual({ selection: [], anchor: null, cursor: null });
  });

  it("drops vanished paths and returns the same object when nothing changed", () => {
    const s: SelectionState = { selection: ["/a", "/zzz"], anchor: "/zzz", cursor: "/a" };
    const pruned = pruneSelection(s, order);
    expect(pruned.selection).toEqual(["/a"]);
    expect(pruned.anchor).toBeNull();
    expect(pruned.cursor).toBe("/a");
    const same: SelectionState = { selection: ["/a"], anchor: "/a", cursor: "/a" };
    expect(pruneSelection(same, order)).toBe(same);
  });
});
