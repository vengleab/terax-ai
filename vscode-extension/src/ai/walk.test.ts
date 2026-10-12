import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globToRegExp, matchesGlob, walkFiles } from "./walk";

describe("globToRegExp", () => {
  const m = (glob: string, p: string) => globToRegExp(glob).test(p);
  it("handles *, ** and ?", () => {
    expect(m("*.ts", "a.ts")).toBe(true);
    expect(m("*.ts", "src/a.ts")).toBe(false);
    expect(m("**/*.ts", "src/deep/a.ts")).toBe(true);
    expect(m("**/*.ts", "a.ts")).toBe(true);
    expect(m("src/**", "src/a/b.txt")).toBe(true);
    expect(m("a?c", "abc")).toBe(true);
    expect(m("a?c", "a/c")).toBe(false);
  });
  it("handles alternatives, classes and escaping", () => {
    expect(m("*.{ts,tsx}", "a.tsx")).toBe(true);
    expect(m("*.{ts,tsx}", "a.js")).toBe(false);
    expect(m("file[12].txt", "file2.txt")).toBe(true);
    expect(m("a.b", "axb")).toBe(false);
    expect(m("(x)+", "(x)+")).toBe(true);
  });
});

describe("matchesGlob", () => {
  it("matches a bare name anywhere and a path from the search folder", () => {
    expect(matchesGlob("package.json", `deep${path.sep}er${path.sep}package.json`)).toBe(true);
    expect(matchesGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/*.ts", "other/src/a.ts")).toBe(false);
  });
});

describe("walkFiles", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "terax-walk-"));
    for (const f of ["a.txt", "src/b.ts", "src/deep/c.ts", "node_modules/x/index.js", ".git/config", "dist/out.js", "target/debug/x"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "x");
    }
    try {
      fs.symlinkSync(dir, path.join(dir, "src", "loop"), "dir");
    } catch {
      // Links need a privilege on Windows; without one there is no link for the walk to skip.
    }
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lists files in order, skipping build and cache folders and not following links", async () => {
    const seen: string[] = [];
    for await (const f of walkFiles(dir)) seen.push(path.relative(dir, f).split(path.sep).join("/"));
    expect(seen).toEqual(["a.txt", "src/b.ts", "src/deep/c.ts"]);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const seen: string[] = [];
    for await (const f of walkFiles(dir, controller.signal)) seen.push(f);
    expect(seen).toEqual([]);
  });
});
