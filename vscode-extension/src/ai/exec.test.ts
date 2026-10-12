import { describe, expect, it } from "vitest";
import { runCommand } from "./exec";

const run = (script: string, over: Partial<Parameters<typeof runCommand>[0]> = {}) =>
  runCommand({ file: "/bin/sh", args: ["-c", script], cwd: "/tmp", env: { PATH: process.env.PATH ?? "" }, timeoutMs: 5000, maxBytes: 100_000, ...over });

describe.skipIf(process.platform === "win32")("runCommand", () => {
  it("returns output and the exit code", async () => {
    const r = await run("echo out; echo err >&2; exit 3");
    expect(r).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n", timedOut: false, aborted: false, truncated: false });
  });

  it("runs in the folder it is given, with only the environment it is given", async () => {
    const r = await run("pwd; printf %s \"$ONLY\"", { cwd: "/usr", env: { PATH: process.env.PATH ?? "", ONLY: "x" } });
    expect(r.stdout).toBe("/usr\nx");
  });

  it("closes standard input, so a program that waits for input ends instead of hanging", async () => {
    const r = await run("cat; echo after-eof");
    expect(r.stdout).toBe("after-eof\n");
    expect(r.timedOut).toBe(false);
  });

  it("stops a command that runs too long, including what it started", async () => {
    const r = await run("sleep 30 & echo started; wait", { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toContain("started");
    expect(r.durationMs).toBeLessThan(5000);
  });

  it("stops a command that ignores the polite request", async () => {
    const r = await run("trap '' TERM; echo up; while true; do sleep 1; done", { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(6000);
  });

  it("stops when cancelled, and when already cancelled", async () => {
    const controller = new AbortController();
    const pending = run("sleep 30", { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    expect((await pending).aborted).toBe(true);
    const already = new AbortController();
    already.abort();
    expect((await run("sleep 30", { signal: already.signal })).aborted).toBe(true);
  });

  it("keeps the start of very long output and says it cut the rest", async () => {
    const r = await run("yes terax | head -c 500000", { maxBytes: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
    expect(r.stdout.startsWith("terax\n")).toBe(true);
  });

  it("reports a program that cannot be started", async () => {
    const r = await runCommand({ file: "/definitely/not/here", args: [], cwd: "/tmp", env: {}, timeoutMs: 1000, maxBytes: 1000 });
    expect(r.exitCode).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
  });
});
