import { describe, expect, it } from "vitest";
import { systemPrompt } from "./prompt";

describe("systemPrompt", () => {
  it("names the workspace, system and shell", () => {
    const text = systemPrompt({ folders: ["/work/app", "/work/lib"], platform: "linux x64", shell: "zsh" });
    expect(text).toContain("/work/app, /work/lib");
    expect(text).toContain("linux x64");
    expect(text).toContain("zsh");
  });

  it("says so when no folder is open", () => {
    expect(systemPrompt({ folders: [], platform: "linux x64", shell: "sh" })).toContain("(none open)");
  });

  it("names every tool the agent has, so it never reaches for one that does not exist", () => {
    const text = systemPrompt({ folders: ["/w"], platform: "linux x64", shell: "sh" });
    for (const tool of ["read_file", "list_directory", "glob", "grep", "read_terminal", "write_file", "edit_file", "run_command"]) {
      expect(text).toContain(tool);
    }
  });

  it("tells the agent that the user is asked before it changes anything", () => {
    expect(systemPrompt({ folders: ["/w"], platform: "linux x64", shell: "sh" })).toMatch(/user is asked first/);
  });
});
