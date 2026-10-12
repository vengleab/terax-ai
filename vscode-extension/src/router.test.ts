import { describe, expect, it, vi } from "vitest";
import type { HostMessage, TerminalSettings } from "../shared/messages";
import { type HelperEvents, type HelperPort, type LaunchPlan, SessionRouter } from "./router";

const SETTINGS: TerminalSettings = {
  fontFamily: "monospace",
  fontSize: 14,
  fontWeight: "normal",
  lineHeight: 1,
  letterSpacing: 0,
  cursorStyle: "block",
  cursorBlink: false,
  scrollback: 1000,
  skipShellKeys: [],
};

function setup(over: { launch?: (cwd?: string) => LaunchPlan; clipboardRead?: () => Promise<string> } = {}) {
  const posted: HostMessage[] = [];
  const calls: string[] = [];
  let listener!: HelperEvents;
  const helper: HelperPort = {
    setListener: (l) => {
      listener = l;
    },
    spawn: (id, request) => calls.push(`spawn ${id} ${request.file} ${request.args.join(" ")} cwd=${request.cwd} ${request.cols}x${request.rows}`),
    write: (id, bytes) => calls.push(`write ${id} ${Buffer.from(bytes).toString()}`),
    resize: (id, cols, rows) => calls.push(`resize ${id} ${cols}x${rows}`),
    kill: (id) => calls.push(`kill ${id}`),
    pause: (id) => calls.push(`pause ${id}`),
    resume: (id) => calls.push(`resume ${id}`),
    killAll: () => calls.push("killAll"),
  };
  const log = vi.fn();
  const openLink = vi.fn();
  const written: string[] = [];
  const launch = over.launch ?? ((cwd) => ({ file: "/bin/zsh", args: ["-l"], cwd: cwd ?? "/home/me", env: { A: "1" }, title: "zsh" }));
  const router = new SessionRouter({
    helper,
    post: (m) => posted.push(m),
    terminalSettings: () => SETTINGS,
    isMac: true,
    assets: () => ({ wasmUrl: "w", scalarWasmUrl: "s" }),
    launch,
    clipboard: { read: over.clipboardRead ?? (async () => "pasted"), write: async (t) => void written.push(t) },
    openLink,
    log,
  });
  return { router, posted, calls, helperEvents: () => listener, log, openLink, written };
}

const ofType = <T extends HostMessage["type"]>(posted: HostMessage[], type: T) =>
  posted.filter((m): m is Extract<HostMessage, { type: T }> => m.type === type);

describe("starting up", () => {
  it("answers ready with the settings and assets, after ending shells left from an earlier page", () => {
    const { router, posted, calls } = setup();
    router.receive({ type: "ready" });
    expect(calls).toEqual(["killAll"]);
    expect(posted).toEqual([{ type: "init", wasmUrl: "w", scalarWasmUrl: "s", settings: SETTINGS, isMac: true, cwd: undefined }]);
    expect(router.isReady).toBe(true);
  });

  it("uses the folder asked for before the page was up for its first terminal, once", () => {
    const { router, posted } = setup();
    router.newTerminal("/work/app");
    router.receive({ type: "ready" });
    router.receive({ type: "ready" });
    expect(ofType(posted, "init").map((m) => m.cwd)).toEqual(["/work/app", undefined]);
    expect(ofType(posted, "new")).toHaveLength(0);
  });

  it("asks a running page for a new terminal", () => {
    const { router, posted } = setup();
    router.receive({ type: "ready" });
    router.newTerminal("/x");
    expect(ofType(posted, "new")).toEqual([{ type: "new", cwd: "/x" }]);
  });

  it("does not talk to a page that is not up", () => {
    const { router, posted } = setup();
    router.settingsChanged();
    router.send({ type: "clear" });
    router.send({ type: "send-text", text: "ls\n" });
    expect(posted).toEqual([]);
  });

  it("gives a page that is still starting the focus it was asked for, once it is up", () => {
    const { router, posted } = setup();
    router.send({ type: "focus" });
    expect(posted).toEqual([]);
    router.receive({ type: "ready" });
    expect(posted.map((m) => m.type)).toEqual(["init", "focus"]);
    router.receive({ type: "ready" });
    expect(posted.map((m) => m.type)).toEqual(["init", "focus", "init"]);
  });
});

describe("shells", () => {
  it("starts a shell the way the launch plan says, at the size the page measured", () => {
    const { router, calls, posted, helperEvents } = setup();
    router.receive({ type: "spawn", id: 3, cols: 100, rows: 30, cwd: "/work" });
    expect(calls).toEqual(["spawn 3 /bin/zsh -l cwd=/work 100x30"]);
    helperEvents().spawned(3, 4242);
    expect(posted).toEqual([{ type: "spawned", id: 3, pid: 4242, title: "zsh" }]);
  });

  it("tells the page when a shell cannot be started", () => {
    const { router, posted, calls } = setup({
      launch: () => {
        throw new Error("no shell");
      },
    });
    router.receive({ type: "spawn", id: 1, cols: 80, rows: 24 });
    expect(calls).toEqual([]);
    expect(posted).toEqual([{ type: "error", id: 1, message: "no shell" }]);
  });

  it("carries input, resizes and kills to the helper", () => {
    const { router, calls } = setup();
    router.receive({ type: "input", id: 1, bytes: Uint8Array.from(Buffer.from("ls\r")) });
    router.receive({ type: "input", id: 1, bytes: [100, 102] as unknown as Uint8Array });
    router.receive({ type: "resize", id: 1, cols: 90, rows: 20 });
    router.receive({ type: "kill", id: 1 });
    expect(calls).toEqual(["write 1 ls\r", "write 1 df", "resize 1 90x20", "kill 1"]);
  });

  it("passes output and the end of a shell to the page", () => {
    const { router, posted, helperEvents } = setup();
    router.receive({ type: "spawn", id: 1, cols: 80, rows: 24 });
    helperEvents().data(1, Uint8Array.from([104, 105]));
    helperEvents().exit(1, 0);
    helperEvents().error(2, "boom");
    expect(posted.map((m) => m.type)).toEqual(["data", "exit", "error"]);
    expect((posted[1] as { code: number }).code).toBe(0);
  });
});

describe("keeping the shell from outrunning the page", () => {
  it("pauses after a lot of unacknowledged output and resumes once the page catches up", () => {
    const { router, calls, helperEvents } = setup();
    router.receive({ type: "spawn", id: 1, cols: 80, rows: 24 });
    calls.length = 0;
    const chunk = new Uint8Array(200 * 1024);
    for (let i = 0; i < 3; i++) helperEvents().data(1, chunk);
    expect(calls).toEqual(["pause 1"]);
    router.receive({ type: "ack", id: 1, bytes: 400 * 1024 });
    expect(calls).toEqual(["pause 1"]);
    router.receive({ type: "ack", id: 1, bytes: 200 * 1024 });
    expect(calls).toEqual(["pause 1", "resume 1"]);
  });

  it("stops counting a shell that has ended", () => {
    const { router, calls, helperEvents } = setup();
    helperEvents().data(1, new Uint8Array(600 * 1024));
    helperEvents().exit(1, 0);
    calls.length = 0;
    router.receive({ type: "ack", id: 1, bytes: 600 * 1024 });
    expect(calls).toEqual([]);
  });
});

describe("clipboard and links", () => {
  it("reads and writes the clipboard for the page", async () => {
    const { router, posted, written } = setup();
    router.receive({ type: "clipboard-read", requestId: 5 });
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toEqual([{ type: "clipboard-text", requestId: 5, text: "pasted" }]);
    router.receive({ type: "clipboard-write", text: "copied" });
    await Promise.resolve();
    expect(written).toEqual(["copied"]);
  });

  it("answers a clipboard read that fails with an empty string", async () => {
    const { router, posted } = setup({
      clipboardRead: async () => {
        throw new Error("denied");
      },
    });
    router.receive({ type: "clipboard-read", requestId: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual([{ type: "clipboard-text", requestId: 1, text: "" }]);
  });

  it("opens web links and refuses the rest", () => {
    const { router, openLink, log } = setup();
    router.receive({ type: "open-link", uri: "https://example.com" });
    router.receive({ type: "open-link", uri: "command:workbench.action.reloadWindow" });
    router.receive({ type: "open-link", uri: "file:///etc/passwd" });
    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink).toHaveBeenCalledWith("https://example.com");
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("passes the page's log lines on", () => {
    const { router, log } = setup();
    router.receive({ type: "log", level: "error", message: "surface lost" });
    expect(log).toHaveBeenCalledWith("error", "surface lost");
  });
});

describe("focus", () => {
  it("knows whether the page has keyboard focus, and forgets when it restarts or closes", () => {
    const { router } = setup();
    expect(router.isFocused).toBe(false);
    router.receive({ type: "focus-state", focused: true });
    expect(router.isFocused).toBe(true);
    router.receive({ type: "focus-state", focused: false });
    expect(router.isFocused).toBe(false);
    router.receive({ type: "focus-state", focused: true });
    router.receive({ type: "ready" });
    expect(router.isFocused).toBe(false);
    router.receive({ type: "focus-state", focused: true });
    router.pageClosed();
    expect(router.isFocused).toBe(false);
  });
});

describe("closing", () => {
  it("ends every shell when the page goes away", () => {
    const { router, calls } = setup();
    router.receive({ type: "ready" });
    calls.length = 0;
    router.pageClosed();
    expect(calls).toEqual(["killAll"]);
    expect(router.isReady).toBe(false);
  });
});
