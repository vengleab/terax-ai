import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HelperClient } from "./helperClient";
import { findHelper } from "./helperPath";
import type { HelperEvents } from "./router";

const extensionRoot = path.resolve(__dirname, "..");
const helper = findHelper(extensionRoot, process.platform, process.arch, fs.existsSync);

type Seen = { events: string[]; output: Map<number, string>; waiters: Array<() => void> };

function listen(): { seen: Seen; events: HelperEvents } {
  const seen: Seen = { events: [], output: new Map(), waiters: [] };
  const wake = () => seen.waiters.splice(0).forEach((w) => w());
  return {
    seen,
    events: {
      spawned: (id) => (seen.events.push(`spawned ${id}`), wake()),
      data: (id, bytes) => (seen.output.set(id, (seen.output.get(id) ?? "") + Buffer.from(bytes).toString()), wake()),
      exit: (id, code) => (seen.events.push(`exit ${id} ${code}`), wake()),
      error: (id, message) => (seen.events.push(`error ${id} ${message}`), wake()),
    },
  };
}

async function until(seen: Seen, done: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) {
      const output = [...seen.output].map(([id, text]) => `${id}: ${JSON.stringify(text.slice(0, 120))} (${text.length} chars)`);
      throw new Error(`timed out; saw ${JSON.stringify(seen.events)} ${output.join(" | ")}`);
    }
    await new Promise<void>((resolve) => {
      seen.waiters.push(resolve);
      setTimeout(resolve, 100);
    });
  }
}

describe.skipIf(!helper || process.platform === "win32")("HelperClient with the real helper", () => {
  const make = () => {
    const logs: string[] = [];
    const client = new HelperClient({
      executable: () => helper as string,
      env: () => ({ ...process.env }),
      log: (_level, message) => logs.push(message),
    });
    const { seen, events } = listen();
    client.setListener(events);
    return { client, seen, logs };
  };
  const request = (script: string) => ({ file: "/bin/sh", args: ["-c", script], cwd: "/tmp", env: {}, cols: 80, rows: 24 });

  it("runs a shell, streams its output and reports how it ended", async () => {
    const { client, seen } = make();
    client.spawn(1, request("printf 'from the helper'; exit 5"));
    await until(seen, () => seen.events.some((e) => e.startsWith("exit 1")));
    expect(seen.events).toContain("spawned 1");
    expect(seen.events).toContain("exit 1 5");
    expect(seen.output.get(1)).toContain("from the helper");
    client.dispose();
  });

  it("sends input and resizes", async () => {
    const { client, seen } = make();
    client.spawn(1, request("stty size; read line; echo got:$line"));
    await until(seen, () => (seen.output.get(1) ?? "").includes("24 80"));
    client.resize(1, 120, 40);
    client.write(1, Buffer.from("hello\n"));
    await until(seen, () => (seen.output.get(1) ?? "").includes("got:hello"));
    client.kill(1);
    client.dispose();
  });

  it("splits a large paste into frames the helper accepts", async () => {
    const { client, seen } = make();
    // Raw mode: a terminal in line mode would cut a 300 kB line short, as any terminal does.
    client.spawn(1, request("stty raw -echo; echo ready-for-paste; head -c 300000 | wc -c"));
    await until(seen, () => (seen.output.get(1) ?? "").includes("ready-for-paste"));
    client.write(1, Buffer.alloc(300_000, "a"));
    await until(seen, () => /300000/.test(seen.output.get(1) ?? ""), 15000);
    client.dispose();
  }, 20000);

  it("reports a program that does not exist for that shell only", async () => {
    const { client, seen } = make();
    client.spawn(2, { ...request(""), file: "/definitely/not/here" });
    await until(seen, () => seen.events.some((e) => e.startsWith("error 2")));
    client.spawn(3, request("echo fine"));
    await until(seen, () => (seen.output.get(3) ?? "").includes("fine"));
    client.dispose();
  });

  it("restarts the helper after it has gone, telling the shells it took with it", async () => {
    const { client, seen } = make();
    client.spawn(1, request("sleep 30"));
    await until(seen, () => seen.events.includes("spawned 1"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).child.kill("SIGKILL");
    await until(seen, () => seen.events.some((e) => e.startsWith("error 1")));
    client.spawn(4, request("echo again"));
    await until(seen, () => (seen.output.get(4) ?? "").includes("again"));
    client.dispose();
  });

  it("does not throw for a session that never existed", () => {
    const { client } = make();
    client.write(9, Buffer.from("x"));
    client.resize(9, 10, 10);
    client.kill(9);
    client.dispose();
  });
});

describe("HelperClient without a helper", () => {
  it("reports why a shell could not start", () => {
    const client = new HelperClient({
      executable: () => {
        throw new Error("helper missing for this system");
      },
      env: () => ({}),
      log: () => undefined,
    });
    const { seen, events } = listen();
    client.setListener(events);
    client.spawn(1, { file: "/bin/sh", args: [], cwd: "/", env: {}, cols: 80, rows: 24 });
    expect(seen.events).toEqual(["error 1 helper missing for this system"]);
  });
});
