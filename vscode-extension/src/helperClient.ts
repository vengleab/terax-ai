import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { encodeFrame, encodeResize, FrameError, FrameParser, Kind } from "./frames";
import type { HelperEvents, HelperPort, SpawnRequest } from "./router";

const WRITE_CHUNK = 64 * 1024;

type Options = {
  /** The helper binary to run. */
  executable: () => string;
  env: () => NodeJS.ProcessEnv;
  log: (level: "info" | "warn" | "error", message: string) => void;
};

/** Runs the helper process and speaks its frames. It is started when the first shell is, and again if it dies. */
export class HelperClient implements HelperPort {
  private child: ChildProcess | null = null;
  private listener: HelperEvents | null = null;
  private readonly live = new Set<number>();

  constructor(private readonly options: Options) {}

  setListener(listener: HelperEvents): void {
    this.listener = listener;
  }

  private start(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const executable = this.options.executable();
    if (process.platform !== "win32") {
      // A packaged file can lose its executable bit on the way out of the archive.
      try {
        fs.chmodSync(executable, 0o755);
      } catch {
        // already fine, or not ours to change
      }
    }
    const child = spawn(executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env(),
      windowsHide: true,
    });
    const parser = new FrameParser();
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const frame of parser.push(chunk)) this.handle(frame.kind, frame.session, frame.payload);
      } catch (error) {
        if (error instanceof FrameError) {
          this.options.log("error", `the terminal helper sent a bad frame: ${error.message}`);
          child.kill();
        } else {
          throw error;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => this.options.log("warn", `helper: ${chunk.toString().trim()}`));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => this.ended(child, `could not run the terminal helper (${executable}): ${error.message}`));
    child.on("exit", (code, signal) => this.ended(child, `the terminal helper stopped (${signal ?? code})`));
    this.child = child;
    return child;
  }

  /** The helper is gone: every shell it had is gone with it. */
  private ended(child: ChildProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    const ids = [...this.live];
    this.live.clear();
    for (const id of ids) this.listener?.error(id, reason);
  }

  private handle(kind: number, session: number, payload: Buffer): void {
    switch (kind) {
      case Kind.Ready:
        break;
      case Kind.Spawned:
        this.listener?.spawned(session, payload.length >= 4 ? payload.readUInt32LE(0) : 0);
        break;
      case Kind.Data:
        this.listener?.data(session, new Uint8Array(payload));
        break;
      case Kind.Exit:
        this.live.delete(session);
        this.listener?.exit(session, payload.length >= 4 ? payload.readInt32LE(0) : -1);
        break;
      case Kind.Error:
        this.live.delete(session);
        this.listener?.error(session, payload.toString("utf8"));
        break;
    }
  }

  private send(kind: number, session: number, payload?: Uint8Array): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return;
    stdin.write(encodeFrame(kind, session, payload));
  }

  spawn(id: number, request: SpawnRequest): void {
    let child: ChildProcess;
    try {
      child = this.start();
    } catch (error) {
      this.listener?.error(id, error instanceof Error ? error.message : String(error));
      return;
    }
    if (!child.stdin?.writable) {
      this.listener?.error(id, "the terminal helper is not accepting commands");
      return;
    }
    this.live.add(id);
    this.send(Kind.Spawn, id, Buffer.from(JSON.stringify(request)));
  }

  write(id: number, bytes: Uint8Array): void {
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) {
      this.send(Kind.Write, id, bytes.subarray(offset, offset + WRITE_CHUNK));
    }
  }

  resize(id: number, cols: number, rows: number): void {
    this.send(Kind.Resize, id, encodeResize(cols, rows));
  }

  kill(id: number): void {
    this.send(Kind.Kill, id);
  }

  pause(id: number): void {
    this.send(Kind.Pause, id);
  }

  resume(id: number): void {
    this.send(Kind.Resume, id);
  }

  killAll(): void {
    for (const id of this.live) this.send(Kind.Kill, id);
    this.live.clear();
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.live.clear();
    // Closing stdin is how the helper learns to hang up every shell.
    child?.stdin?.end();
    setTimeout(() => child?.kill(), 3000).unref();
  }
}
