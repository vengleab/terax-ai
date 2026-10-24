import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, PageCommand } from "../shared/chat";
import type { HostMessage, TerminalSettings } from "../shared/messages";
import { type ChatPort, type HelperEvents, type HelperPort, type LaunchPlan, SessionRouter } from "./router";

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
  const chatCalls: string[] = [];
  const chatEvents: ChatEvent[] = [];
  const pageCommands: PageCommand[] = [];
  const chat: ChatPort = {
    events: chatEvents,
    running: false,
    modelLabel: "OpenAI · GPT",
    send: async (text) => void chatCalls.push(`send ${text}`),
    stop: () => void chatCalls.push("stop"),
    reset: () => void chatCalls.push("reset"),
    answerApproval: (id, approved) => void chatCalls.push(`approval ${id} ${approved}`),
  };
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
    chat,
    runPageCommand: (command) => void pageCommands.push(command),
  });
  return { router, posted, calls, helperEvents: () => listener, log, openLink, written, chatCalls, chatEvents, pageCommands };
}

const ofType = <T extends HostMessage["type"]>(posted: HostMessage[], type: T) =>
  posted.filter((m): m is Extract<HostMessage, { type: T }> => m.type === type);

describe("starting up", () => {
  it("answers ready with the settings and assets, after ending shells left from an earlier page", () => {
    const { router, posted, calls } = setup();
    router.receive({ type: "ready" });
    expect(calls).toEqual(["killAll"]);
    expect(posted).toEqual([
      { type: "init", wasmUrl: "w", scalarWasmUrl: "s", settings: SETTINGS, isMac: true, cwd: undefined, firstId: 1 },
      { type: "chat-sync", events: [], model: "OpenAI · GPT", running: false },
    ]);
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
    expect(posted.map((m) => m.type)).toEqual(["init", "chat-sync", "focus"]);
    router.receive({ type: "ready" });
    expect(posted.map((m) => m.type)).toEqual(["init", "chat-sync", "focus", "init", "chat-sync"]);
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

describe("the AI chat", () => {
  it("brings a page that starts up to date with the conversation", () => {
    const { router, posted, chatEvents } = setup();
    chatEvents.push({ type: "user", id: "u1", text: "hi" });
    router.receive({ type: "ready" });
    expect(ofType(posted, "chat-sync")).toEqual([{ type: "chat-sync", events: [{ type: "user", id: "u1", text: "hi" }], model: "OpenAI · GPT", running: false }]);
  });

  it("passes the page's questions and answers on to the chat", () => {
    const { router, chatCalls } = setup();
    router.receive({ type: "ready" });
    router.receive({ type: "chat-send", text: "run the tests" });
    router.receive({ type: "chat-approval", id: "c1", approved: true });
    router.receive({ type: "chat-approval", id: "c2", approved: false });
    router.receive({ type: "chat-stop" });
    router.receive({ type: "chat-new" });
    expect(chatCalls).toEqual(["send run the tests", "approval c1 true", "approval c2 false", "stop", "reset"]);
  });

  it("counts anything but a plain yes as a no", () => {
    const { router, chatCalls } = setup();
    router.receive({ type: "chat-approval", id: "c1", approved: "yes" as unknown as boolean });
    expect(chatCalls).toEqual(["approval c1 false"]);
  });

  it("runs the commands the page may ask for, and refuses all others", () => {
    const { router, pageCommands, log } = setup();
    router.receive({ type: "chat-command", command: "terax.ai.setApiKey" });
    router.receive({ type: "chat-command", command: "workbench.action.terminal.new" as unknown as PageCommand });
    expect(pageCommands).toEqual(["terax.ai.setApiKey"]);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("workbench.action.terminal.new"));
  });

  it("tells the page when the model changes, once it is up", () => {
    const { router, posted } = setup();
    router.modelChanged();
    expect(ofType(posted, "chat-model")).toEqual([]);
    router.receive({ type: "ready" });
    router.modelChanged();
    expect(ofType(posted, "chat-model")).toEqual([{ type: "chat-model", model: "OpenAI · GPT" }]);
  });

  it("asks the page for the terminal's text and hands the answer to the agent", async () => {
    const { router, posted } = setup();
    router.receive({ type: "ready" });
    const text = router.readTerminalText(40);
    const [request] = ofType(posted, "terminal-text-request");
    expect(request.lines).toBe(40);
    router.receive({ type: "terminal-text", requestId: request.requestId, text: "$ npm test\nFAIL" });
    await expect(text).resolves.toBe("$ npm test\nFAIL");
  });

  it("gives an empty answer when there is no page, or the page does not reply", async () => {
    vi.useFakeTimers();
    try {
      const { router, posted } = setup();
      await expect(router.readTerminalText(10)).resolves.toBe("");
      router.receive({ type: "ready" });
      const text = router.readTerminalText(10);
      expect(ofType(posted, "terminal-text-request")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3500);
      await expect(text).resolves.toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a waiting request when the page goes away", async () => {
    const { router } = setup();
    router.receive({ type: "ready" });
    const text = router.readTerminalText(10);
    router.pageClosed();
    await expect(text).resolves.toBe("");
  });

  it("holds a chat focus or prefill until the page is up", () => {
    const { router, posted } = setup();
    router.send({ type: "chat-prefill", text: "explain this" });
    router.send({ type: "chat-focus" });
    expect(ofType(posted, "chat-prefill")).toEqual([]);
    router.receive({ type: "ready" });
    const order = posted.map((m) => m.type).filter((t) => t === "chat-sync" || t === "chat-prefill" || t === "chat-focus");
    expect(order).toEqual(["chat-sync", "chat-prefill", "chat-focus"]);
  });

  it("sends a chat focus straight away when the page is up", () => {
    const { router, posted } = setup();
    router.receive({ type: "ready" });
    router.send({ type: "chat-focus" });
    expect(ofType(posted, "chat-focus")).toHaveLength(1);
  });
});

describe("terminal ids across pages", () => {
  it("starts each new page above every id an earlier page used", () => {
    const { router, posted } = setup();
    router.receive({ type: "ready" });
    router.receive({ type: "spawn", id: 1, cols: 80, rows: 24 });
    router.receive({ type: "spawn", id: 2, cols: 80, rows: 24 });
    router.receive({ type: "ready" });
    router.receive({ type: "spawn", id: 3, cols: 80, rows: 24 });
    router.receive({ type: "ready" });
    expect(ofType(posted, "init").map((m) => m.firstId)).toEqual([1, 3, 4]);
  });
});
