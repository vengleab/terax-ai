import { describe, expect, it } from "vitest";
import { commandShell } from "./commandShell";

describe("commandShell", () => {
  it("runs a command line with -c in a Unix shell", () => {
    expect(commandShell("/bin/bash", "linux").args("ls -la")).toEqual(["-c", "ls -la"]);
    expect(commandShell("/usr/bin/fish", "linux").args("ls")).toEqual(["-c", "ls"]);
  });

  it("uses a login shell on macOS so PATH is complete", () => {
    expect(commandShell("/bin/zsh", "darwin").args("brew list")).toEqual(["-l", "-c", "brew list"]);
    expect(commandShell("/opt/homebrew/bin/fish", "darwin").args("x")).toEqual(["-l", "-c", "x"]);
    expect(commandShell("/bin/sh", "darwin").args("x")).toEqual(["-c", "x"]);
  });

  it("starts PowerShell without a profile or prompts", () => {
    expect(commandShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32").args("Get-Date")).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Date",
    ]);
    expect(commandShell("powershell.exe", "win32").args("dir")[3]).toBe("-Command");
  });

  it("starts cmd.exe with /c", () => {
    expect(commandShell("C:\\Windows\\System32\\cmd.exe", "win32").args("dir")).toEqual(["/d", "/s", "/c", "dir"]);
  });

  it("passes the command as one argument, never split or interpreted by the extension", () => {
    const command = `echo "a b" && echo $HOME; rm -rf 'x y'`;
    expect(commandShell("/bin/bash", "linux").args(command)).toEqual(["-c", command]);
  });
});
