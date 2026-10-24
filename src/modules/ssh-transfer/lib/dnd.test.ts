import { describe, expect, it } from "vitest";
import {
  dragStarted,
  resolveDropTarget,
  targetEquals,
  toViewportPoint,
} from "./dnd";

type Node = {
  attrs: Record<string, string>;
  parent: Node | null;
};

function node(attrs: Record<string, string>, parent: Node | null = null): Node {
  return { attrs, parent };
}

function asHit(n: Node) {
  const self = {
    closest(selector: string) {
      const name = selector.slice(1, -1);
      for (let cur: Node | null = n; cur; cur = cur.parent) {
        if (name in cur.attrs) return asHit(cur);
      }
      return null;
    },
    getAttribute: (name: string) => n.attrs[name] ?? null,
    contains(other: unknown) {
      const target = (other as { __node?: Node }).__node;
      for (let cur: Node | null = target ?? null; cur; cur = cur.parent) {
        if (cur === n) return true;
      }
      return false;
    },
    __node: n,
  };
  return self;
}

describe("resolveDropTarget", () => {
  const pane = node({ "data-sshx-pane": "right" });
  const dirRow = node({ "data-sshx-dir": "1", "data-sshx-path": "/srv/app" }, pane);
  const fileRow = node({ "data-sshx-path": "/srv/a.txt" }, pane);

  it("returns the pane for empty space", () => {
    expect(resolveDropTarget(asHit(pane))).toEqual({ pane: "right", dir: null });
    expect(resolveDropTarget(asHit(fileRow))).toEqual({ pane: "right", dir: null });
  });

  it("returns the folder row under the pointer", () => {
    const inner = node({}, dirRow);
    expect(resolveDropTarget(asHit(inner))).toEqual({ pane: "right", dir: "/srv/app" });
  });

  it("ignores everything outside a pane and unknown pane ids", () => {
    expect(resolveDropTarget(null)).toBeNull();
    expect(resolveDropTarget(asHit(node({})))).toBeNull();
    expect(resolveDropTarget(asHit(node({ "data-sshx-pane": "middle" })))).toBeNull();
  });
});

describe("drag helpers", () => {
  it("starts after the threshold in any direction", () => {
    expect(dragStarted(0, 0)).toBe(false);
    expect(dragStarted(3, 3)).toBe(false);
    expect(dragStarted(5, 0)).toBe(true);
    expect(dragStarted(-4, 4)).toBe(true);
  });

  it("compares targets by pane and folder", () => {
    expect(targetEquals(null, null)).toBe(true);
    expect(targetEquals({ pane: "left", dir: null }, null)).toBe(false);
    expect(targetEquals({ pane: "left", dir: "/a" }, { pane: "left", dir: "/a" })).toBe(true);
    expect(targetEquals({ pane: "left", dir: "/a" }, { pane: "right", dir: "/a" })).toBe(false);
  });

  it("scales only out-of-viewport drop points", () => {
    const viewport = { width: 1000, height: 800, dpr: 2 };
    expect(toViewportPoint(500, 400, viewport)).toEqual({ x: 500, y: 400 });
    expect(toViewportPoint(1800, 600, viewport)).toEqual({ x: 900, y: 300 });
    expect(toViewportPoint(10, 1700, { ...viewport, dpr: 0 })).toEqual({ x: 10, y: 1700 });
  });
});
