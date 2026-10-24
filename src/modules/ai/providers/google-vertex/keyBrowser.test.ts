import { describe, expect, it } from "vitest";
import { chooserEntries, expandHome, joinPath, normalizePath, parentPath, startFolders } from "./keyBrowser";

describe("chooserEntries", () => {
  it("shows folders and .json files only, folders first, sorted without regard to case", () => {
    const shown = chooserEntries([
      { name: "notes.txt", kind: "file" },
      { name: "zeta", kind: "dir" },
      { name: "Key.JSON", kind: "file" },
      { name: "alpha", kind: "dir" },
      { name: "backup.json", kind: "file" },
      { name: "photo.png", kind: "file" },
    ]);
    expect(shown).toEqual([
      { name: "alpha", kind: "dir" },
      { name: "zeta", kind: "dir" },
      { name: "backup.json", kind: "file" },
      { name: "Key.JSON", kind: "file" },
    ]);
  });

  it("treats a .json link as a file and any other link as a folder", () => {
    expect(
      chooserEntries([
        { name: "latest.json", kind: "symlink" },
        { name: "projects", kind: "symlink" },
      ]),
    ).toEqual([
      { name: "projects", kind: "dir" },
      { name: "latest.json", kind: "file" },
    ]);
  });

  it("shows nothing for an empty folder", () => {
    expect(chooserEntries([])).toEqual([]);
  });
});

describe("paths", () => {
  it("joins and normalises", () => {
    expect(joinPath("/home/me", "a.json")).toBe("/home/me/a.json");
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(normalizePath("C:\\Users\\me\\Downloads")).toBe("C:/Users/me/Downloads");
  });

  it("goes up one folder and stops at the root", () => {
    expect(parentPath("/home/me/Downloads")).toBe("/home/me");
    expect(parentPath("/home/me/")).toBe("/home");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("C:/Users/me")).toBe("C:/Users");
    expect(parentPath("C:/Users")).toBe("C:/");
    expect(parentPath("C:/")).toBe("C:/");
  });

  it("expands a leading ~ in a typed path", () => {
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~/Downloads/k.json", "/home/me")).toBe("/home/me/Downloads/k.json");
    expect(expandHome("  /abs/k.json ", "/home/me")).toBe("/abs/k.json");
    expect(expandHome("~other/k.json", "/home/me")).toBe("~other/k.json");
  });
});

describe("startFolders", () => {
  it("prefers the last folder, then Downloads, then home, without repeats", () => {
    expect(startFolders("/data/keys", "/home/me")).toEqual(["/data/keys", "/home/me/Downloads", "/home/me"]);
    expect(startFolders(null, "/home/me")).toEqual(["/home/me/Downloads", "/home/me"]);
    expect(startFolders("/home/me/Downloads", "/home/me")).toEqual(["/home/me/Downloads", "/home/me"]);
  });

  it("copes with a Windows home folder", () => {
    expect(startFolders(null, "C:\\Users\\me")).toEqual(["C:/Users/me/Downloads", "C:/Users/me"]);
  });
});
