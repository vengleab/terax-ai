import { describe, expect, it } from "vitest";
import type { EndpointRef } from "../types";
import { buildTransfer, transferTitle } from "./transferPlan";

const local: EndpointRef = { kind: "local" };
const remote: EndpointRef = { kind: "remote", profileId: "p1" };
const label = (e: EndpointRef) => (e.kind === "local" ? "This computer" : "prod");

describe("buildTransfer", () => {
  it("builds an upload with labels and sensible defaults", () => {
    const built = buildTransfer({
      src: { endpoint: local, path: "/home/me" },
      dst: { endpoint: remote, path: "/srv" },
      paths: ["/home/me/a.txt", "/home/me/dir"],
      mode: "copy",
      label,
    });
    expect(built).toEqual({
      ok: true,
      request: {
        src: local,
        dst: remote,
        sources: ["/home/me/a.txt", "/home/me/dir"],
        dstDir: "/srv",
        mode: "copy",
        conflict: "ask",
        resume: true,
      },
      title: "Copy 2 items",
      from: "This computer",
      to: "prod",
    });
  });

  it("targets a folder under the cursor when given one", () => {
    const built = buildTransfer({
      src: { endpoint: local, path: "/a" },
      dst: { endpoint: remote, path: "/srv" },
      paths: ["/a/x"],
      mode: "copy",
      dstDir: "/srv/uploads",
      label,
    });
    expect(built.ok && built.request.dstDir).toBe("/srv/uploads");
  });

  it("removes nested selections so nothing is copied twice", () => {
    const built = buildTransfer({
      src: { endpoint: local, path: "/a" },
      dst: { endpoint: remote, path: "/srv" },
      paths: ["/a/d", "/a/d/inner.txt"],
      mode: "copy",
      label,
    });
    expect(built.ok && built.request.sources).toEqual(["/a/d"]);
    expect(built.ok && built.title).toBe("Copy d");
  });

  it("refuses an empty selection", () => {
    const built = buildTransfer({
      src: { endpoint: local, path: "/a" },
      dst: { endpoint: remote, path: "/srv" },
      paths: [],
      mode: "copy",
      label,
    });
    expect(built).toEqual({ ok: false, reason: "Select something first" });
  });

  it("refuses a destination that is not resolved yet", () => {
    const built = buildTransfer({
      src: { endpoint: local, path: "/a" },
      dst: { endpoint: remote, path: "" },
      paths: ["/a/x"],
      mode: "copy",
      label,
    });
    expect(built.ok).toBe(false);
  });

  it("refuses no-op and self-containing transfers inside one endpoint", () => {
    const base = { src: { endpoint: local, path: "/a" }, dst: { endpoint: local, path: "/a" }, label };
    const noop = buildTransfer({ ...base, paths: ["/a/x"], mode: "move" });
    expect(noop).toEqual({ ok: false, reason: "Those items are already in this folder" });
    const inside = buildTransfer({ ...base, paths: ["/a/d"], mode: "move", dstDir: "/a/d/sub" });
    expect(inside).toEqual({ ok: false, reason: "Cannot put d inside itself" });
    const onto = buildTransfer({ ...base, paths: ["/a/d"], mode: "copy", dstDir: "/a/d" });
    expect(onto.ok).toBe(false);
    const sibling = buildTransfer({ ...base, paths: ["/a/d"], mode: "copy", dstDir: "/a/dd" });
    expect(sibling.ok).toBe(true);
  });

  it("allows the same paths between different servers", () => {
    const built = buildTransfer({
      src: { endpoint: remote, path: "/srv" },
      dst: { endpoint: { kind: "remote", profileId: "p2" }, path: "/srv" },
      paths: ["/srv/x"],
      mode: "copy",
      label,
    });
    expect(built.ok).toBe(true);
  });
});

describe("transferTitle", () => {
  it("names a single item and counts several", () => {
    expect(transferTitle("copy", ["/a/b.txt"])).toBe("Copy b.txt");
    expect(transferTitle("move", ["/a", "/b"])).toBe("Move 2 items");
  });
});
