import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import {
  dropSubtree,
  flattenTree,
  foldersToRefresh,
  isUnder,
  type TreeState,
} from "./remoteTree";
import { DEFAULT_VIEW } from "./sort";

const entry = (name: string, kind: FileEntry["kind"] = "file", over: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: name,
  kind,
  size: 1,
  mtime: 0,
  mode: 0o644,
  linkTargetIsDir: null,
  ...over,
});

const view = { ...DEFAULT_VIEW, showHidden: true };

describe("isUnder", () => {
  it("is segment aware", () => {
    expect(isUnder("/a/b", "/a")).toBe(true);
    expect(isUnder("/a", "/a")).toBe(true);
    expect(isUnder("/ab", "/a")).toBe(false);
    expect(isUnder("/x", "/")).toBe(true);
  });
});

describe("flattenTree", () => {
  const nodes: TreeState = {
    "/r": { status: "loaded", entries: [entry("b.txt"), entry("src", "dir"), entry("a.txt")] },
    "/r/src": { status: "loaded", entries: [entry("main.rs"), entry("lib", "dir")] },
    "/r/src/lib": { status: "loading" },
  };

  it("lists folders first and descends only into expanded folders", () => {
    const rows = flattenTree("/r", nodes, new Set(["/r/src"]), view);
    expect(rows.map((r) => (r.kind === "entry" ? `${"  ".repeat(r.depth)}${r.entry.name}` : r.text))).toEqual([
      "src",
      "  lib",
      "  main.rs",
      "a.txt",
      "b.txt",
    ]);
    const src = rows[0];
    expect(src.kind === "entry" && src.expanded).toBe(true);
  });

  it("shows a loading row for a folder whose listing has not arrived", () => {
    const rows = flattenTree("/r", nodes, new Set(["/r/src", "/r/src/lib"]), view);
    expect(rows.some((r) => r.kind === "status" && r.text === "Loading…" && r.depth === 2)).toBe(true);
  });

  it("shows errors and empty folders as status rows", () => {
    expect(
      flattenTree("/r", { "/r": { status: "error", message: "Permission denied" } }, new Set(), view),
    ).toMatchObject([{ kind: "status", text: "Permission denied", tone: "error" }]);
    expect(
      flattenTree("/r", { "/r": { status: "loaded", entries: [] } }, new Set(), view),
    ).toMatchObject([{ kind: "status", text: "Empty folder" }]);
    expect(flattenTree("/r", {}, new Set(), view)).toMatchObject([{ kind: "status", text: "Loading…" }]);
  });

  it("hides dotfiles unless asked to show them", () => {
    const hidden: TreeState = { "/r": { status: "loaded", entries: [entry(".env"), entry("app")] } };
    const names = (showHidden: boolean) =>
      flattenTree("/r", hidden, new Set(), { ...DEFAULT_VIEW, showHidden }).map(
        (r) => r.kind === "entry" && r.entry.name,
      );
    expect(names(false)).toEqual(["app"]);
    expect(names(true)).toEqual([".env", "app"]);
  });

  it("treats a symlink to a folder as a folder", () => {
    const linked: TreeState = {
      "/r": { status: "loaded", entries: [entry("link", "symlink", { linkTargetIsDir: true })] },
    };
    const [row] = flattenTree("/r", linked, new Set(), view);
    expect(row.kind === "entry" && row.isDir).toBe(true);
  });
});

describe("dropSubtree", () => {
  it("forgets a renamed or deleted folder and everything below it", () => {
    const nodes: TreeState = {
      "/r": { status: "loaded", entries: [] },
      "/r/a": { status: "loaded", entries: [] },
      "/r/a/b": { status: "loaded", entries: [] },
      "/r/ab": { status: "loaded", entries: [] },
    };
    const out = dropSubtree(nodes, new Set(["/r/a", "/r/a/b", "/r/ab"]), "/r/a");
    expect(Object.keys(out.nodes).sort()).toEqual(["/r", "/r/ab"]);
    expect([...out.expanded]).toEqual(["/r/ab"]);
  });
});

describe("foldersToRefresh", () => {
  it("returns the root and loaded expanded folders, parents first", () => {
    const nodes: TreeState = {
      "/r": { status: "loaded", entries: [] },
      "/r/a": { status: "loaded", entries: [] },
      "/r/a/b": { status: "loaded", entries: [] },
    };
    expect(foldersToRefresh("/r", nodes, new Set(["/r/a/b", "/r/a", "/elsewhere", "/r/gone"]))).toEqual([
      "/r",
      "/r/a",
      "/r/a/b",
    ]);
  });
});
