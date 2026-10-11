import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSshCommand, REMOTE_CWD_COMMAND } from "./sshCommand";

describe("buildSshCommand", () => {
  it("leaves plain words alone", () => {
    expect(buildSshCommand(["-p", "2222", "deploy@example.com"], false)).toBe(
      "ssh -p 2222 deploy@example.com",
    );
  });

  it("quotes anything with spaces or shell metacharacters", () => {
    expect(
      buildSshCommand(["-i", "/home/me/my keys/id", "-J", "ops@[::1]:22", "u@h"], false),
    ).toBe("ssh -i '/home/me/my keys/id' -J 'ops@[::1]:22' u@h");
    expect(buildSshCommand(["-i", "/k/it's"], false)).toBe("ssh -i '/k/it'\\''s'");
    expect(buildSshCommand(["a;b", "$(x)"], false)).toBe("ssh 'a;b' '$(x)'");
  });

  it("uses powershell quoting on windows", () => {
    expect(buildSshCommand(["-i", "C:/Users/me/my key"], true)).toBe("ssh -i 'C:/Users/me/my key'");
  });

  it("asks for a terminal and appends a quoted remote command after the host", () => {
    expect(buildSshCommand(["deploy@h"], false, "echo 'hi' $HOME")).toBe(
      "ssh -t deploy@h 'echo '\\''hi'\\'' $HOME'",
    );
  });
});

const hasPosixShell = process.platform !== "win32" && spawnSync("sh", ["-c", "true"]).status === 0;
const hasBash = hasPosixShell && spawnSync("bash", ["--version"]).status === 0;

describe.skipIf(!hasPosixShell)("the remote command survives local shell quoting", () => {
  it("reaches ssh as one unchanged argument after the host", () => {
    const line = buildSshCommand(["-p", "2222", "-i", "/k ey/id", "deploy@example.com"], false, REMOTE_CWD_COMMAND);
    const out = execFileSync("sh", ["-c", `ssh() { printf '%s\\n' "$@"; }\n${line}`], {
      encoding: "utf8",
    });
    expect(out.split("\n").slice(0, -1)).toEqual([
      "-t",
      "-p",
      "2222",
      "-i",
      "/k ey/id",
      "deploy@example.com",
      REMOTE_CWD_COMMAND,
    ]);
  });
});

describe.skipIf(!hasBash)("the remote prompt hook", () => {
  it("reports the folder as a terminal title on every prompt and follows cd", () => {
    const dir = mkdtempSync(join(tmpdir(), "sshx-"));
    try {
      const shell = join(dir, "fake-login-shell");
      writeFileSync(shell, '#!/bin/sh\nexec bash --norc --noprofile -i\n');
      chmodSync(shell, 0o755);
      const target = mkdtempSync(join(tmpdir(), "sshx-target-"));
      const line = buildSshCommand(["deploy@example.com"], false, REMOTE_CWD_COMMAND);
      const script = `ssh() { shift; shift; sh -c "$1"; }\n${line}`;
      const out = execFileSync("sh", ["-c", script], {
        encoding: "utf8",
        input: `cd '${target}'\nexit\n`,
        env: { ...process.env, SHELL: shell, TERM: "dumb" },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const titles = [...out.matchAll(/\u001b\]2;terax-cwd:([^\u0007]*)\u0007/g)].map((m) => m[1]);
      expect(titles.length).toBeGreaterThanOrEqual(2);
      expect(titles[0]).toBe(process.cwd());
      expect(titles[titles.length - 1]).toBe(target);
      rmSync(target, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
