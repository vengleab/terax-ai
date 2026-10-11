import { describe, expect, it } from "vitest";
import { parseRemoteCwdTitle, readTitleEvent } from "./remoteCwd";

describe("parseRemoteCwdTitle", () => {
  it("reads a folder reported with the private prefix", () => {
    expect(parseRemoteCwdTitle("terax-cwd:/home/deploy/app")).toBe("/home/deploy/app");
    expect(parseRemoteCwdTitle("terax-cwd:/")).toBe("/");
    expect(parseRemoteCwdTitle("terax-cwd:/srv/with space/日本語")).toBe("/srv/with space/日本語");
  });

  it("trims trailing slashes", () => {
    expect(parseRemoteCwdTitle("terax-cwd:/var/log/")).toBe("/var/log");
    expect(parseRemoteCwdTitle("terax-cwd://")).toBe("/");
  });

  it("ignores ordinary titles and anything that is not an absolute path", () => {
    expect(parseRemoteCwdTitle("deploy@host: ~")).toBeNull();
    expect(parseRemoteCwdTitle("terax-cwd:relative/path")).toBeNull();
    expect(parseRemoteCwdTitle("terax-cwd:")).toBeNull();
    expect(parseRemoteCwdTitle("xterax-cwd:/etc")).toBeNull();
  });

  it("rejects control characters and absurd lengths", () => {
    expect(parseRemoteCwdTitle("terax-cwd:/etc/\u001b[2J")).toBeNull();
    expect(parseRemoteCwdTitle("terax-cwd:/etc\u0007/x")).toBeNull();
    expect(parseRemoteCwdTitle(`terax-cwd:/${"a".repeat(5000)}`)).toBeNull();
  });
});

describe("readTitleEvent", () => {
  it("accepts a well-formed event and rejects junk", () => {
    expect(
      readTitleEvent(new CustomEvent("terax:terminal-title", { detail: { leafId: 3, title: "t" } })),
    ).toEqual({ leafId: 3, title: "t" });
    expect(readTitleEvent(new CustomEvent("x", { detail: null }))).toBeNull();
    expect(readTitleEvent(new CustomEvent("x", { detail: { leafId: "3", title: "t" } }))).toBeNull();
    expect(readTitleEvent(new CustomEvent("x", { detail: { leafId: 3 } }))).toBeNull();
  });
});
