import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkspaceGuard } from "./guard";

let dir: string;
let outside: string;
let guard: WorkspaceGuard;
// Links need a privilege on Windows, so the tests about links run where they can be made.
let links = false;

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "terax-guard-")));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "terax-outside-")));
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  try {
    fs.symlinkSync(outside, path.join(dir, "link-out"), "dir");
    fs.symlinkSync(path.join(dir, "a.txt"), path.join(dir, "link-in"));
    links = true;
  } catch {
    links = false;
  }
  guard = new WorkspaceGuard(() => [dir]);
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const ok = async (input: string, access: "read" | "write" = "read") => guard.resolve(input, access);

describe("WorkspaceGuard", () => {
  it("allows files inside the workspace, relative or absolute, and returns the real path", async () => {
    expect(await ok("a.txt")).toEqual({ ok: true, path: path.join(dir, "a.txt") });
    expect(await ok(path.join(dir, "sub"))).toEqual({ ok: true, path: path.join(dir, "sub") });
    expect(await ok(".")).toEqual({ ok: true, path: dir });
  });

  it("allows a file that does not exist yet, for writing", async () => {
    expect(await ok("sub/new/deeper.txt", "write")).toEqual({ ok: true, path: path.join(dir, "sub", "new", "deeper.txt") });
  });

  it("refuses anything outside the workspace folders", async () => {
    for (const input of ["../escape.txt", outside, path.join(outside, "secret.txt"), "/etc/hostname", "sub/../../x"]) {
      const result = await ok(input);
      expect(result.ok, input).toBe(false);
    }
  });

  it("refuses a link that leads out of the workspace, for reading and writing", async (context) => {
    if (!links) context.skip();
    expect((await ok("link-out/secret.txt")).ok).toBe(false);
    expect((await ok("link-out/new.txt", "write")).ok).toBe(false);
  });

  it("follows a link that stays inside", async (context) => {
    if (!links) context.skip();
    expect(await ok("link-in")).toEqual({ ok: true, path: path.join(dir, "a.txt") });
  });

  it("applies Terax's deny-list for secret files, inside the workspace too", async () => {
    const result = await ok(".env");
    expect(result.ok).toBe(false);
    expect((await ok("id_rsa")).ok).toBe(false);
    expect((await ok("keys/server.pem", "write")).ok).toBe(false);
    expect((await ok(".git/config")).ok).toBe(false);
  });

  it("says why there is nothing to work on when no folder is open", async () => {
    const empty = new WorkspaceGuard(() => []);
    const result = await empty.resolve("a.txt", "read");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/No folder is open/);
  });

  it("rejects an empty path", async () => {
    expect((await ok("  ")).ok).toBe(false);
  });

  it("resolves against another base folder, still inside the workspace", async () => {
    expect(await guard.resolve("x.txt", "write", path.join(dir, "sub"))).toEqual({ ok: true, path: path.join(dir, "sub", "x.txt") });
    expect((await guard.resolve("../../x.txt", "write", path.join(dir, "sub"))).ok).toBe(false);
  });

  it("works with several workspace folders", async () => {
    const two = new WorkspaceGuard(() => [dir, outside]);
    expect((await two.resolve(path.join(outside, "secret.txt"), "read")).ok).toBe(true);
  });
});
