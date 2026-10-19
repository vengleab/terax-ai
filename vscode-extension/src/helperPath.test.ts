import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findHelper, helperCandidates, helperFileName, missingHelperMessage } from "./helperPath";

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

describe("missing helper message", () => {
  it("names this system and the ones the package carries", () => {
    const message = missingHelperMessage("/ext", "linux", "x64", () => ["darwin-arm64"]);
    expect(message).toContain("linux-x64");
    expect(message).toContain("darwin-arm64");
    expect(message).toContain("Remote SSH");
  });

  it("copes with a package that has no bin folder", () => {
    const message = missingHelperMessage("/ext", "linux", "x64", () => {
      throw new Error("ENOENT");
    });
    expect(message).toContain("carries: none");
  });
});
