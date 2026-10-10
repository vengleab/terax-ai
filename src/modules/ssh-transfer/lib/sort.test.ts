import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import { DEFAULT_VIEW, toggleSort, viewEntries } from "./sort";

const entry = (name: string, over: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/${name}`,
  kind: "file",
  size: 0,
  mtime: null,
  mode: null,
  linkTargetIsDir: null,
  ...over,
});

const names = (entries: FileEntry[]) => entries.map((e) => e.name);

describe("viewEntries", () => {
  const entries = [
    entry("b.txt", { size: 5, mtime: 100 }),
    entry("Zed", { kind: "dir" }),
    entry("a.txt", { size: 50, mtime: 300 }),
    entry(".hidden", { size: 1 }),
    entry("alpha", { kind: "dir" }),
    entry("link", { kind: "symlink", linkTargetIsDir: true }),
    entry("file10.txt"),
    entry("file2.txt"),
  ];

  it("puts folders first and sorts names naturally", () => {
    expect(names(viewEntries(entries, DEFAULT_VIEW))).toEqual([
      "alpha",
      "link",
      "Zed",
      "a.txt",
      "b.txt",
      "file2.txt",
      "file10.txt",
    ]);
  });

  it("hides dotfiles unless asked", () => {
    expect(names(viewEntries(entries, DEFAULT_VIEW))).not.toContain(".hidden");
    const shown = viewEntries(entries, { ...DEFAULT_VIEW, showHidden: true });
    expect(names(shown)).toContain(".hidden");
  });

  it("filters by a case-insensitive substring", () => {
    expect(names(viewEntries(entries, { ...DEFAULT_VIEW, filter: " ALP " }))).toEqual(["alpha"]);
    expect(names(viewEntries(entries, { ...DEFAULT_VIEW, filter: "txt" }))).toEqual([
      "a.txt",
      "b.txt",
      "file2.txt",
      "file10.txt",
    ]);
  });

  it("sorts by size and modified time, keeping folders first", () => {
    const bySize = viewEntries(entries, { ...DEFAULT_VIEW, sort: { key: "size", dir: "desc" } });
    const files = names(bySize).filter((n) => n.endsWith(".txt"));
    expect(files[0]).toBe("a.txt");
    expect(names(bySize)[0]).toBe("Zed");
    const byTime = viewEntries(entries, { ...DEFAULT_VIEW, sort: { key: "mtime", dir: "asc" } });
    const filesByTime = names(byTime).filter((n) => ["a.txt", "b.txt"].includes(n));
    expect(filesByTime).toEqual(["b.txt", "a.txt"]);
  });

  it("does not mutate the input", () => {
    const before = names(entries);
    viewEntries(entries, DEFAULT_VIEW);
    expect(names(entries)).toEqual(before);
  });
});

describe("toggleSort", () => {
  it("flips direction on the same key and picks a sensible default on a new one", () => {
    expect(toggleSort({ key: "name", dir: "asc" }, "name")).toEqual({ key: "name", dir: "desc" });
    expect(toggleSort({ key: "name", dir: "asc" }, "size")).toEqual({ key: "size", dir: "desc" });
    expect(toggleSort({ key: "size", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
  });
});
