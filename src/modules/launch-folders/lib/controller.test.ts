import { describe, expect, it, vi } from "vitest";
import { createLaunchFolders, normalizeFolders } from "./controller";

function setup(initial: string[] = []) {
  const queue = [...initial];
  const opened: string[] = [];
  const deps = {
    takePending: vi.fn(async () => queue.splice(0, queue.length)),
    authorize: vi.fn(async (path: string) => path),
    openFolder: vi.fn((path: string) => void opened.push(path)),
  };
  return { queue, opened, deps, folders: createLaunchFolders(deps) };
}

describe("normalizeFolders", () => {
  it("trims, converts backslashes, drops blanks and repeats", () => {
    expect(normalizeFolders([" /a ", "", "/a", "C:\\Users\\me\\app", "  "])).toEqual(["/a", "C:/Users/me/app"]);
  });
});

describe("createLaunchFolders", () => {
  it("opens nothing before the app is ready, then opens what was queued meanwhile", async () => {
    const s = setup(["/Users/me/project"]);
    await s.folders.wake();
    expect(s.deps.takePending).not.toHaveBeenCalled();
    expect(s.opened).toEqual([]);
    await s.folders.setReady(true);
    expect(s.opened).toEqual(["/Users/me/project"]);
  });

  it("opens a folder that arrives after the app is ready, once", async () => {
    const s = setup();
    await s.folders.setReady(true);
    s.queue.push("/Users/me/other");
    await Promise.all([s.folders.wake(), s.folders.wake()]);
    expect(s.opened).toEqual(["/Users/me/other"]);
  });

  it("allows each folder before opening it and opens the canonical path", async () => {
    const s = setup(["/tmp/work"]);
    s.deps.authorize.mockResolvedValueOnce("/private/tmp/work");
    await s.folders.setReady(true);
    expect(s.deps.authorize).toHaveBeenCalledWith("/tmp/work");
    expect(s.opened).toEqual(["/private/tmp/work"]);
  });

  it("skips a folder that cannot be authorized and still opens the rest", async () => {
    const s = setup(["/gone", "/fine"]);
    s.deps.authorize.mockRejectedValueOnce(new Error("not allowed"));
    await s.folders.setReady(true);
    expect(s.opened).toEqual(["/fine"]);
  });

  it("treats a failing backend as nothing pending", async () => {
    const s = setup();
    s.deps.takePending.mockRejectedValueOnce(new Error("no plugin"));
    await expect(s.folders.setReady(true)).resolves.toBeUndefined();
    expect(s.opened).toEqual([]);
  });

  it("stops after dispose", async () => {
    const s = setup(["/a"]);
    await s.folders.setReady(true);
    s.folders.dispose();
    s.queue.push("/b");
    await s.folders.wake();
    expect(s.opened).toEqual(["/a"]);
  });
});
