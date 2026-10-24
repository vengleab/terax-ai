import { describe, expect, it } from "vitest";
import { chooseCwd, chooseShell, profileFor, shellEnvironment, type ShellEnvironment } from "./shell";

const env = (over: Partial<ShellEnvironment> = {}, present: string[] = []): ShellEnvironment => ({
  platform: "linux",
  env: {},
  home: "/home/me",
  exists: (file) => present.includes(file),
  ...over,
});

const none = { shell: "", shellArgs: [] };

describe("chooseShell", () => {
  it("prefers the Terax setting, with its own arguments", () => {
    expect(chooseShell({ shell: "/usr/bin/fish", shellArgs: ["-i"] }, env())).toEqual({
      file: "/usr/bin/fish",
      args: ["-i"],
      title: "fish",
    });
  });

  it("then the default terminal profile of VS Code", () => {
    const choice = chooseShell(
      { ...none, profilePath: "/bin/zsh", profileArgs: ["-l"] },
      env({ env: { SHELL: "/bin/bash" } }, ["/bin/zsh", "/bin/bash"]),
    );
    expect(choice).toEqual({ file: "/bin/zsh", args: ["-l"], title: "zsh" });
  });

  it("ignores a profile whose program is not there", () => {
    const choice = chooseShell({ ...none, profilePath: "/gone" }, env({ env: { SHELL: "/bin/bash" } }, ["/bin/bash"]));
    expect(choice.file).toBe("/bin/bash");
  });

  it("then $SHELL, then common shells", () => {
    expect(chooseShell(none, env({ env: { SHELL: "/usr/bin/zsh" } }, ["/usr/bin/zsh"])).file).toBe("/usr/bin/zsh");
    expect(chooseShell(none, env({}, ["/bin/bash"])).file).toBe("/bin/bash");
    expect(chooseShell(none, env()).file).toBe("/bin/sh");
    expect(chooseShell(none, env({ platform: "darwin" }, ["/bin/zsh"])).file).toBe("/bin/zsh");
  });

  it("starts zsh, bash and fish as login shells on macOS only", () => {
    const mac = env({ platform: "darwin", env: { SHELL: "/bin/zsh" } }, ["/bin/zsh"]);
    expect(chooseShell(none, mac).args).toEqual(["-l"]);
    expect(chooseShell({ shell: "/usr/local/bin/nu", shellArgs: [] }, mac).args).toEqual([]);
    expect(chooseShell(none, env({ env: { SHELL: "/bin/zsh" } }, ["/bin/zsh"])).args).toEqual([]);
    expect(chooseShell({ shell: "/bin/zsh", shellArgs: ["-i"] }, mac).args).toEqual(["-i"]);
  });

  it("on Windows looks for PowerShell on the PATH, then COMSPEC", () => {
    const win = (present: string[], vars: NodeJS.ProcessEnv) =>
      env({ platform: "win32", env: vars }, present);
    const pwsh = String.raw`C:\Tools\pwsh.exe`;
    expect(chooseShell(none, win([pwsh.replace(/\\/g, "/")], { PATH: "C:\\Tools" })).title).toBeTruthy();
    expect(chooseShell(none, win([], { COMSPEC: String.raw`C:\Windows\system32\cmd.exe` })).title).toBe("cmd");
    expect(chooseShell(none, win([], {})).file).toBe("cmd.exe");
  });
});

describe("chooseCwd", () => {
  const exists = (dirs: string[]) => (dir: string) => dirs.includes(dir);
  it("takes the first folder that exists", () => {
    expect(chooseCwd(["/a", "/b", "/c"], "/home/me", exists(["/b", "/c"]))).toBe("/b");
  });
  it("skips blanks and missing folders, ending at home", () => {
    expect(chooseCwd([undefined, "", "  ", "/gone"], "/home/me", exists([]))).toBe("/home/me");
  });
});

describe("shellEnvironment", () => {
  it("drops what VS Code keeps for itself and keeps the rest", () => {
    const out = shellEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/me",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        VSCODE_NLS_CONFIG: "{}",
        VSCODE_PID: "5",
        VSCODE_IPC_HOOK_CLI: "/run/user/1000/vscode-ipc.sock",
        VSCODE_GIT_ASKPASS_NODE: "/x",
      },
      {},
    );
    expect(out.PATH).toBe("/usr/bin");
    expect(out.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(out.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(out.VSCODE_NLS_CONFIG).toBeUndefined();
    expect(out.VSCODE_PID).toBeUndefined();
    expect(out.VSCODE_IPC_HOOK_CLI).toBe("/run/user/1000/vscode-ipc.sock");
    expect(out.VSCODE_GIT_ASKPASS_NODE).toBe("/x");
  });

  it("names the terminal and lets the user's own variables win", () => {
    const out = shellEnvironment({ TERM_PROGRAM: "other", A: "1" }, { A: "2", B: "3" });
    expect(out.TERM_PROGRAM).toBe("Terax");
    expect(out.A).toBe("2");
    expect(out.B).toBe("3");
  });

  it("skips undefined values", () => {
    expect("X" in shellEnvironment({ X: undefined }, {})).toBe(false);
  });
});

describe("profileFor", () => {
  const exists = (file: string) => file === "/bin/zsh";
  it("finds the default profile's program and arguments", () => {
    expect(profileFor({ zsh: { path: "/bin/zsh", args: ["-l"] } }, "zsh", exists)).toEqual({ path: "/bin/zsh", args: ["-l"] });
  });
  it("takes the first path of a list that exists", () => {
    expect(profileFor({ p: { path: ["/gone", "/bin/zsh"] } }, "p", exists).path).toBe("/bin/zsh");
  });
  it("copes with missing or odd settings", () => {
    expect(profileFor(undefined, "zsh", exists)).toEqual({});
    expect(profileFor({ zsh: null }, "zsh", exists)).toEqual({});
    expect(profileFor({ zsh: { source: "PowerShell" } }, "zsh", exists)).toEqual({ path: undefined, args: undefined });
    expect(profileFor({ zsh: { path: "/bin/zsh" } }, 5, exists)).toEqual({});
  });
});
