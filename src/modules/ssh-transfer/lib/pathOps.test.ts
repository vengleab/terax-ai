import { describe, expect, it } from "vitest";
import {
  baseName,
  breadcrumbs,
  excludeNested,
  expandHome,
  isDirLike,
  joinPath,
  normalizeLocal,
  parentPath,
  validateNewName,
} from "./pathOps";

describe("joinPath / parentPath / baseName", () => {
  it("joins with a single slash", () => {
    expect(joinPath("/a", "b")).toBe("/a/b");
    expect(joinPath("/a/", "b")).toBe("/a/b");
    expect(joinPath("/", "b")).toBe("/b");
    expect(joinPath("", "b")).toBe("b");
    expect(joinPath("C:/", "x")).toBe("C:/x");
  });

  it("finds parents, stopping at roots", () => {
    expect(parentPath("/a/b")).toBe("/a");
    expect(parentPath("/a")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("/a/b/")).toBe("/a");
    expect(parentPath("C:/Users/me")).toBe("C:/Users");
    expect(parentPath("C:/Users")).toBe("C:/");
    expect(parentPath("C:/")).toBe("C:/");
    expect(parentPath("rel")).toBe(".");
  });

  it("returns the last segment", () => {
    expect(baseName("/a/b.txt")).toBe("b.txt");
    expect(baseName("/a/b/")).toBe("b");
    expect(baseName("/")).toBe("/");
    expect(baseName("name")).toBe("name");
  });

  it("normalizes backslashes from the OS", () => {
    expect(normalizeLocal("C:\\Users\\me")).toBe("C:/Users/me");
  });
});

describe("breadcrumbs", () => {
  it("lists every segment with its full path", () => {
    expect(breadcrumbs("/srv/app/logs")).toEqual([
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
      { label: "app", path: "/srv/app" },
      { label: "logs", path: "/srv/app/logs" },
    ]);
  });

  it("handles the root and windows drives", () => {
    expect(breadcrumbs("/")).toEqual([{ label: "/", path: "/" }]);
    expect(breadcrumbs("C:/Users/me")).toEqual([
      { label: "C:", path: "C:/" },
      { label: "Users", path: "C:/Users" },
      { label: "me", path: "C:/Users/me" },
    ]);
  });
});

describe("expandHome", () => {
  it("expands only a leading tilde", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/src", "/home/u")).toBe("/home/u/src");
    expect(expandHome("/a/~/b", "/home/u")).toBe("/a/~/b");
    expect(expandHome("  /tmp  ", "/home/u")).toBe("/tmp");
  });
});

describe("isDirLike", () => {
  it("treats symlinks to folders as folders", () => {
    expect(isDirLike({ kind: "dir", linkTargetIsDir: null })).toBe(true);
    expect(isDirLike({ kind: "symlink", linkTargetIsDir: true })).toBe(true);
    expect(isDirLike({ kind: "symlink", linkTargetIsDir: false })).toBe(false);
    expect(isDirLike({ kind: "symlink", linkTargetIsDir: null })).toBe(false);
    expect(isDirLike({ kind: "file", linkTargetIsDir: null })).toBe(false);
  });
});

describe("validateNewName", () => {
  it("accepts ordinary names", () => {
    expect(validateNewName("notes.txt")).toBeNull();
    expect(validateNewName(" spaced name ")).toBeNull();
  });

  it("rejects empty, relative and separator-bearing names", () => {
    for (const bad of ["", "  ", ".", "..", "a/b", "a\\b", "x".repeat(256)]) {
      expect(validateNewName(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
});

describe("excludeNested", () => {
  it("drops paths inside another selected folder", () => {
    expect(excludeNested(["/a", "/a/b", "/c", "/a/b/c"])).toEqual(["/a", "/c"]);
  });

  it("is segment aware and removes duplicates", () => {
    expect(excludeNested(["/a", "/ab"])).toEqual(["/a", "/ab"]);
    expect(excludeNested(["/a", "/a"])).toEqual(["/a"]);
    expect(excludeNested([])).toEqual([]);
  });

  it("keeps the caller's order", () => {
    expect(excludeNested(["/z", "/a", "/z/q"])).toEqual(["/z", "/a"]);
  });
});
