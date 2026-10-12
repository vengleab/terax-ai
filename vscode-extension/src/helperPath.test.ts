import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findHelper, helperCandidates, helperFileName } from "./helperPath";

describe("helper location", () => {
  it("names the file for the system", () => {
    expect(helperFileName("win32")).toBe("terax-vscode-pty.exe");
    expect(helperFileName("linux")).toBe("terax-vscode-pty");
  });

  it("looks in the packaged folder for this system first, then the build output", () => {
    expect(helperCandidates("/ext", "darwin", "arm64")).toEqual([
      path.join("/ext", "bin", "darwin-arm64", "terax-vscode-pty"),
      path.join("/ext", "helper", "target", "release", "terax-vscode-pty"),
      path.join("/ext", "helper", "target", "debug", "terax-vscode-pty"),
    ]);
  });

  it("uses the first one that exists, or none", () => {
    const debug = path.join("/ext", "helper", "target", "debug", "terax-vscode-pty");
    expect(findHelper("/ext", "linux", "x64", (f) => f === debug)).toBe(debug);
    expect(findHelper("/ext", "linux", "x64", () => false)).toBeUndefined();
  });
});
