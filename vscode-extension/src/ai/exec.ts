import { spawn } from "node:child_process";

export type ExecOptions = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Most output kept, in bytes, across both streams. The rest is dropped and `truncated` is set. */
  maxBytes: number;
  signal?: AbortSignal;
};

export type ExecResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  durationMs: number;
};

const KILL_GRACE_MS = 2000;

/**
 * Runs one command to completion. Standard input is closed, so a program that waits for input ends
 * instead of hanging the agent; the whole process group is stopped on timeout or cancel.
 */
export function runCommand(options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const unix = process.platform !== "win32";
    const child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: unix,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let kept = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let done = false;

    const collect = (chunk: Buffer, into: "out" | "err") => {
      const room = options.maxBytes - kept;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      kept += piece.length;
      if (into === "out") stdout += piece.toString("utf8");
      else stderr += piece.toString("utf8");
    };
    child.stdout?.on("data", (c: Buffer) => collect(c, "out"));
    child.stderr?.on("data", (c: Buffer) => collect(c, "err"));

    const stop = (hard: boolean) => {
      const pid = child.pid;
      if (!pid) return;
      try {
        if (unix) process.kill(-pid, hard ? "SIGKILL" : "SIGTERM");
        else child.kill();
      } catch {
        // already gone
      }
    };
    const terminate = () => {
      stop(false);
      setTimeout(() => stop(true), KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // A descendant that is still running would keep a timed-out or cancelled command alive.
      if (timedOut || aborted) stop(true);
      resolve({ exitCode, signal, stdout, stderr, timedOut, aborted, truncated, durationMs: Date.now() - started });
    };
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}
