import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../../shared/chat";
import { ChatController, type ChatDeps, trimHistory } from "./chat";
import { WorkspaceGuard } from "./guard";
import { ChatSetupError } from "./model";
import type { AiSettings } from "./settings";
import { callTool, failingModel, hangingModel, say, scriptedModel } from "./testing";
import { buildTools } from "./tools";

const settings: AiSettings = { provider: "openai", model: "gpt-test", baseUrl: "", maxSteps: 10, commandTimeoutSeconds: 10 };

let dir: string;
let posted: ChatEvent[];
let revealed: number;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "terax-chat-")));
  posted = [];
  revealed = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeChat(model: Awaited<ReturnType<ChatDeps["buildModel"]>> | (() => Promise<never>), ...later: Awaited<ReturnType<ChatDeps["buildModel"]>>[]): ChatController {
  const queue = [model, ...later];
  return new ChatController({
    post: (event) => posted.push(event),
    settings: () => settings,
    apiKey: async () => "key",
    buildModel: async () => {
      const next = queue.length > 1 ? (queue.shift() as (typeof queue)[number]) : queue[0];
      return typeof next === "function" ? next() : next;
    },
    buildTools,
    toolContext: () => ({
      guard: new WorkspaceGuard(() => [dir]),
      readTerminal: async () => "$ ls",
      shell: () => ({ file: "/bin/sh", args: (c: string) => ["-c", c], env: { PATH: process.env.PATH ?? "" } }),
      commandTimeoutSeconds: () => 10,
    }),
    folders: () => [dir],
    shellName: () => "sh",
    reveal: () => {
      revealed++;
    },
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const types = (chat: ChatController) => chat.events.map((e) => e.type);

describe("ChatController", () => {
  it("shows a turn from the question to the answer, in order", async () => {
    const chat = makeChat(scriptedModel([say("Hi there")]).model);
    await chat.send("hello");
    expect(types(chat)).toEqual(["user", "status", "assistant-start", "text", "done", "status"]);
    expect(chat.events[0]).toMatchObject({ type: "user", text: "hello" });
    expect(chat.events.find((e) => e.type === "text")).toMatchObject({ delta: "Hi there" });
    expect(chat.events.at(-1)).toEqual({ type: "status", running: false });
    expect(chat.running).toBe(false);
  });

  it("posts every event to the page as it happens", async () => {
    const chat = makeChat(scriptedModel([say("Hi")]).model);
    await chat.send("hello");
    expect(posted.map((e) => e.type)).toContain("assistant-start");
    expect(posted.filter((e) => e.type === "text")).toHaveLength(1);
  });

  it("ignores an empty message", async () => {
    const chat = makeChat(scriptedModel([say("x")]).model);
    await chat.send("   ");
    expect(chat.events).toEqual([]);
  });

  it("remembers the conversation for the next message", async () => {
    const { model, seen } = scriptedModel([say("first answer"), say("second answer")]);
    const chat = makeChat(model);
    await chat.send("one");
    await chat.send("two");
    const second = JSON.stringify(seen[1]);
    expect(second).toContain("one");
    expect(second).toContain("first answer");
    expect(second).toContain("two");
  });

  it("gives the agent the workspace folder and shell in its instructions", async () => {
    const { model, seen } = scriptedModel([say("ok")]);
    await makeChat(model).send("hi");
    const system = JSON.stringify(seen[0]);
    expect(system).toContain(dir.replaceAll("\\", "\\\\"));
  });

  it("refuses a second message while one is running", async () => {
    const chat = makeChat(hangingModel());
    const first = chat.send("one");
    await until(() => chat.running, "the turn to start");
    await chat.send("two");
    expect(chat.events.filter((e) => e.type === "user")).toHaveLength(1);
    expect(chat.events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("still working") });
    chat.stop();
    await first;
  });

  it("stops a turn that is waiting on the model", async () => {
    const chat = makeChat(hangingModel());
    const turn = chat.send("one");
    await until(() => chat.running, "the turn to start");
    chat.stop();
    await turn;
    expect(chat.running).toBe(false);
    expect(chat.events.at(-1)).toEqual({ type: "status", running: false });
  });

  describe("asking before acting", () => {
    it.skipIf(process.platform === "win32")("runs a command only after the person approves it", async () => {
      const { model } = scriptedModel([callTool("c1", "run_command", { command: "echo ran > proof.txt" }), say("Done.")]);
      const chat = makeChat(model);
      const turn = chat.send("do it");
      await until(() => chat.pendingApprovals.length === 1, "the approval");
      expect(fs.existsSync(path.join(dir, "proof.txt"))).toBe(false);
      expect(chat.pendingApprovals[0]).toMatchObject({ id: "c1", kind: "command", detail: "echo ran > proof.txt" });
      expect(revealed).toBe(1);
      chat.answerApproval("c1", true);
      await turn;
      expect(fs.readFileSync(path.join(dir, "proof.txt"), "utf8").trim()).toBe("ran");
      expect(chat.events.find((e) => e.type === "approval-done")).toMatchObject({ id: "c1", approved: true });
      expect(chat.events.find((e) => e.type === "tool-result")).toMatchObject({ id: "c1", isError: false });
    });

    it("does not run it when the person says no, and tells the model", async () => {
      const { model, seen } = scriptedModel([callTool("c1", "run_command", { command: "echo ran > proof.txt" }), say("Understood.")]);
      const chat = makeChat(model);
      const turn = chat.send("do it");
      await until(() => chat.pendingApprovals.length === 1, "the approval");
      chat.answerApproval("c1", false);
      await turn;
      expect(fs.existsSync(path.join(dir, "proof.txt"))).toBe(false);
      expect(chat.events.find((e) => e.type === "tool-result")).toMatchObject({ isError: true, denied: true });
      expect(JSON.stringify(seen[1])).toContain("denied");
    });

    it("writes a new file only after approval, showing what it will contain", async () => {
      const { model } = scriptedModel([callTool("w1", "write_file", { path: "notes.md", content: "# Notes\n" }), say("Created.")]);
      const chat = makeChat(model);
      const turn = chat.send("make notes");
      await until(() => chat.pendingApprovals.length === 1, "the approval");
      expect(chat.pendingApprovals[0]).toMatchObject({ kind: "write", title: "Create a file" });
      expect(chat.pendingApprovals[0].diff?.some((l) => l.kind === "add" && l.text.includes("# Notes"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "notes.md"))).toBe(false);
      chat.answerApproval("w1", true);
      await turn;
      expect(fs.readFileSync(path.join(dir, "notes.md"), "utf8")).toBe("# Notes\n");
    });

    it("reads files without asking", async () => {
      fs.writeFileSync(path.join(dir, "a.txt"), "hello");
      const { model } = scriptedModel([callTool("r1", "read_file", { path: "a.txt" }), say("It says hello.")]);
      const chat = makeChat(model);
      await chat.send("what is in a.txt");
      expect(chat.pendingApprovals).toEqual([]);
      expect(chat.events.find((e) => e.type === "approval")).toBeUndefined();
      expect(chat.events.find((e) => e.type === "tool-result")).toMatchObject({ id: "r1", isError: false });
    });

    it("refuses what is outside the workspace without asking", async () => {
      const { model } = scriptedModel([callTool("w1", "write_file", { path: "/etc/terax-test", content: "x" }), say("Sorry.")]);
      const chat = makeChat(model);
      await chat.send("write outside");
      expect(chat.events.find((e) => e.type === "approval")).toBeUndefined();
      expect(chat.events.find((e) => e.type === "tool-result")).toMatchObject({ isError: true });
    });

    it("counts a pending question as refused when the turn is stopped", async () => {
      const { model } = scriptedModel([callTool("c1", "run_command", { command: "echo ran > proof.txt" }), say("never")]);
      const chat = makeChat(model);
      const turn = chat.send("do it");
      await until(() => chat.pendingApprovals.length === 1, "the approval");
      chat.stop();
      await turn;
      expect(chat.pendingApprovals).toEqual([]);
      expect(chat.events.find((e) => e.type === "approval-done")).toMatchObject({ id: "c1", approved: false });
      expect(fs.existsSync(path.join(dir, "proof.txt"))).toBe(false);
    });

    it("ignores an answer for a question that is not waiting", async () => {
      const chat = makeChat(scriptedModel([say("hi")]).model);
      await chat.send("hello");
      const before = chat.events.length;
      chat.answerApproval("nope", true);
      expect(chat.events.length).toBe(before);
    });
  });

  describe("when something is wrong", () => {
    it("points to the fix for a missing key", async () => {
      const chat = makeChat(async () => {
        throw new ChatSetupError("No API key for OpenAI.", "set-key");
      });
      await chat.send("hello");
      expect(chat.events.find((e) => e.type === "error")).toMatchObject({ message: "No API key for OpenAI.", hint: "set-key" });
      expect(chat.running).toBe(false);
      expect(chat.events.at(-1)).toEqual({ type: "status", running: false });
    });

    it("does not keep a message the model never saw", async () => {
      const { model, seen } = scriptedModel([say("fine")]);
      let fail = true;
      const chat = makeChat(async () => {
        if (fail) throw new ChatSetupError("No API key.", "set-key");
        return model as never;
      });
      await chat.send("first try");
      fail = false;
      await chat.send("second try");
      expect(JSON.stringify(seen[0])).not.toContain("first try");
    });

    it("shows a provider error in words, with no secrets", async () => {
      const chat = makeChat(failingModel(new Error("401 Unauthorized: invalid key sk-abcdefghijklmnopqrstuvwxyz123456")));
      await chat.send("hello");
      const error = chat.events.find((e) => e.type === "error") as { message: string };
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
      expect(chat.running).toBe(false);
    });

    it("does not keep a message the provider failed to answer", async () => {
      const { model, seen } = scriptedModel([say("fine")]);
      const chat = makeChat(failingModel(new Error("boom")), model);
      await chat.send("first message");
      await chat.send("second message");
      expect(JSON.stringify(seen[0])).not.toContain("first message");
      expect(JSON.stringify(seen[0])).toContain("second message");
    });

    it("can be used again after an error", async () => {
      const chat = makeChat(failingModel(new Error("boom")));
      await chat.send("one");
      await chat.send("two");
      expect(chat.events.filter((e) => e.type === "user")).toHaveLength(2);
    });
  });

  describe("reset", () => {
    it("clears the conversation, tells the page, and forgets the history", async () => {
      const { model, seen } = scriptedModel([say("answer one"), say("answer two")]);
      const chat = makeChat(model);
      await chat.send("secret topic");
      posted = [];
      chat.reset();
      expect(chat.events).toEqual([]);
      expect(posted).toEqual([{ type: "reset" }]);
      await chat.send("fresh start");
      expect(JSON.stringify(seen[1])).not.toContain("secret topic");
    });

    it("forgets which files were read, so an edit needs a fresh read", async () => {
      fs.writeFileSync(path.join(dir, "a.txt"), "hello");
      const { model } = scriptedModel([callTool("r1", "read_file", { path: "a.txt" }), say("read"), callTool("e1", "edit_file", { path: "a.txt", old_string: "hello", new_string: "bye" }), say("x")]);
      const chat = makeChat(model);
      await chat.send("read it");
      chat.reset();
      await chat.send("edit it");
      expect(chat.events.find((e) => e.type === "approval")).toBeUndefined();
      expect(chat.events.find((e) => e.type === "tool-result")).toMatchObject({ isError: true });
    });

    it("lets a new conversation start at once, with nothing leaking from the turn that was cut off", async () => {
      const { model, seen } = scriptedModel([say("fresh answer")]);
      const chat = makeChat(hangingModel(), model);
      const old = chat.send("old topic");
      await until(() => chat.running, "the turn to start");
      chat.reset();
      expect(chat.running).toBe(false);
      await chat.send("new topic");
      await old;
      expect(chat.events.filter((e) => e.type === "user")).toEqual([{ type: "user", id: expect.any(String), text: "new topic" }]);
      expect(chat.events.filter((e) => e.type === "error")).toEqual([]);
      const shown = JSON.stringify(seen[0]);
      expect(shown).toContain("new topic");
      expect(shown).not.toContain("old topic");
      expect(shown).not.toContain("stopped by the user");
      expect(chat.running).toBe(false);
    });

    it("stops a running turn and refuses its pending question", async () => {
      const { model } = scriptedModel([callTool("c1", "run_command", { command: "echo hi" }), say("never")]);
      const chat = makeChat(model);
      const turn = chat.send("do it");
      await until(() => chat.pendingApprovals.length === 1, "the approval");
      chat.reset();
      await turn;
      expect(chat.pendingApprovals).toEqual([]);
      expect(chat.running).toBe(false);
    });
  });

  it("keeps stored text events joined, so a long answer replays from a few events", async () => {
    const chat = makeChat(scriptedModel([[...say("a"), { type: "text-delta", id: "t", delta: "b" }, { type: "text-delta", id: "t", delta: "c" }]]).model);
    await chat.send("x");
    const text = chat.events.filter((e) => e.type === "text");
    expect(text).toHaveLength(1);
    expect(text[0]).toMatchObject({ delta: "abc" });
  });
});

describe("trimHistory", () => {
  const turn = (n: number): ModelMessage[] => [
    { role: "user", content: `q${n}` },
    { role: "assistant", content: `a${n}` },
  ];

  it("leaves a short conversation alone", () => {
    const messages = [...turn(1), ...turn(2)];
    expect(trimHistory(messages, 10)).toBe(messages);
  });

  it("drops the oldest messages and starts on a user message", () => {
    const messages = [...turn(1), ...turn(2), ...turn(3)];
    const trimmed = trimHistory(messages, 3);
    expect(trimmed[0].role).toBe("user");
    expect(trimmed).toEqual(turn(3));
  });

  it("never starts on a tool result whose call was cut off", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "x", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "x", output: { type: "text", value: "r" } }] },
      { role: "assistant", content: "done" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ];
    const trimmed = trimHistory(messages, 4);
    expect(trimmed[0]).toEqual({ role: "user", content: "q2" });
  });

  it("keeps the last message when nothing starts on a user turn", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "c" },
    ];
    expect(trimHistory(messages, 2)).toEqual([{ role: "assistant", content: "c" }]);
  });
});
