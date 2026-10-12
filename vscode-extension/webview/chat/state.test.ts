import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ChatEvent } from "../../shared/chat";
import { ChatModel, formatTokens, summarizeResult, toolTitle } from "./state";

const request: ApprovalRequest = { id: "c1", kind: "command", title: "Run a command", detail: "npm test", cwd: "/w" };

function turn(...events: ChatEvent[]): ChatModel {
  const model = new ChatModel();
  for (const e of events) model.apply(e);
  return model;
}

const start: ChatEvent[] = [
  { type: "user", id: "u1", text: "run the tests" },
  { type: "status", running: true },
  { type: "assistant-start", id: "a1" },
];

describe("ChatModel", () => {
  it("builds the conversation from events", () => {
    const m = turn(...start, { type: "text", id: "0:t", delta: "Running " }, { type: "text", id: "0:t", delta: "now." });
    expect(m.messages).toEqual([
      { role: "user", id: "u1", text: "run the tests" },
      { role: "assistant", id: "a1", parts: [{ kind: "text", id: "0:t", text: "Running now." }] },
    ]);
    expect(m.running).toBe(true);
  });

  it("reports only what changed", () => {
    const m = turn(...start);
    expect(m.apply({ type: "text", id: "0:t", delta: "x" })).toEqual({ messages: ["a1"], approvals: false, status: false, reset: false });
    expect(m.apply({ type: "status", running: false })).toMatchObject({ status: true });
  });

  it("keeps a question and its tool call together, and follows them to the answer", () => {
    const m = turn(...start, { type: "tool-call", id: "c1", name: "run_command", summary: "npm test", input: {} });
    expect(m.messages[1]).toMatchObject({ parts: [{ kind: "tool", status: "running" }] });
    m.apply({ type: "approval", request });
    expect(m.approvals).toEqual([request]);
    expect((m.messages[1] as { parts: { status: string }[] }).parts[0].status).toBe("waiting");
    m.apply({ type: "approval-done", id: "c1", approved: true });
    expect(m.approvals).toEqual([]);
    expect((m.messages[1] as { parts: { status: string }[] }).parts[0].status).toBe("running");
    m.apply({ type: "tool-result", id: "c1", output: { exit_code: 0, stdout: "ok" }, isError: false });
    expect((m.messages[1] as { parts: { status: string }[] }).parts[0].status).toBe("done");
  });

  it("shows a refusal as denied", () => {
    const m = turn(...start, { type: "tool-call", id: "c1", name: "run_command", summary: "rm x", input: {} }, { type: "approval", request });
    m.apply({ type: "approval-done", id: "c1", approved: false });
    m.apply({ type: "tool-result", id: "c1", output: { denied: true, error: "no" }, isError: true, denied: true });
    expect((m.messages[1] as { parts: { status: string }[] }).parts[0].status).toBe("denied");
  });

  it("shows a tool's own failure as failed", () => {
    const m = turn(...start, { type: "tool-call", id: "c1", name: "read_file", summary: "x", input: {} });
    m.apply({ type: "tool-result", id: "c1", output: { error: "nope" }, isError: true });
    expect((m.messages[1] as { parts: { status: string }[] }).parts[0].status).toBe("failed");
  });

  it("does not ask twice for the same call", () => {
    const m = turn(...start, { type: "approval", request }, { type: "approval", request });
    expect(m.approvals).toHaveLength(1);
  });

  it("marks calls that never finished as stopped when the turn ends", () => {
    const m = turn(...start, { type: "tool-call", id: "c1", name: "run_command", summary: "sleep 99", input: {} }, { type: "approval", request });
    const change = m.apply({ type: "status", running: false });
    expect((m.messages[1] as { parts: { status: string }[] }).parts[0].status).toBe("stopped");
    expect(change.messages).toContain("a1");
  });

  it("records errors as their own messages, with the hint", () => {
    const m = turn(...start, { type: "error", message: "No API key", hint: "set-key" });
    expect(m.messages[m.messages.length - 1]).toEqual({ role: "error", id: "e1", text: "No API key", hint: "set-key" });
  });

  it("records token use on the answer", () => {
    const m = turn(...start, { type: "done", inputTokens: 1200, outputTokens: 80 });
    expect((m.messages[1] as { usage?: unknown }).usage).toEqual({ input: 1200, output: 80 });
  });

  it("starts over on reset", () => {
    const m = turn(...start, { type: "approval", request });
    expect(m.apply({ type: "reset" }).reset).toBe(true);
    expect(m.messages).toEqual([]);
    expect(m.approvals).toEqual([]);
    expect(m.running).toBe(false);
  });

  it("ignores text with no answer to attach it to", () => {
    const m = turn({ type: "text", id: "0:t", delta: "orphan" }, { type: "tool-call", id: "c", name: "x", summary: "", input: {} });
    expect(m.messages).toEqual([]);
  });

  describe("load", () => {
    const events: ChatEvent[] = [
      ...start,
      { type: "tool-call", id: "c1", name: "run_command", summary: "npm test", input: {} },
      { type: "approval", request },
    ];

    it("rebuilds a conversation that is still waiting for an answer", () => {
      const m = new ChatModel();
      m.load(events, true, "OpenAI · GPT");
      expect(m.approvals).toEqual([request]);
      expect(m.running).toBe(true);
      expect(m.model).toBe("OpenAI · GPT");
      expect((m.messages[1] as { parts: { status: string }[] }).parts[0].status).toBe("waiting");
    });

    it("replaces what the page had, so replayed events never double up", () => {
      const m = new ChatModel();
      m.apply({ type: "user", id: "u9", text: "old" });
      m.load(events, true, "x");
      expect(m.messages.filter((x) => x.role === "user")).toHaveLength(1);
    });

    it("does not leave a stale spinner when the turn is over", () => {
      const m = new ChatModel();
      m.load(events, false, "x");
      expect((m.messages[1] as { parts: { status: string }[] }).parts[0].status).toBe("stopped");
    });
  });
});

describe("summarizeResult", () => {
  it("says how a command ended and keeps its output", () => {
    expect(summarizeResult("run_command", { exit_code: 0, stdout: "ok\n", stderr: "" })).toEqual({ headline: "exit 0", body: "ok\n" });
    expect(summarizeResult("run_command", { exit_code: 2, stdout: "", stderr: "boom" })).toEqual({ headline: "exit 2", body: "boom" });
    expect(summarizeResult("run_command", { exit_code: null, timed_out: true, stdout: "", stderr: "" }).headline).toBe("timed out");
  });

  it("shows a refusal as its message", () => {
    expect(summarizeResult("read_file", { error: "Refused: outside the workspace" })).toEqual({ headline: "Refused: outside the workspace" });
  });

  it("describes reads, searches and edits briefly", () => {
    expect(summarizeResult("read_file", { start_line: 1, end_line: 20, total_lines: 99 }).headline).toBe("lines 1–20 of 99");
    expect(summarizeResult("glob", { matches: ["a.ts", "b.ts"] })).toEqual({ headline: "2 matches", body: "a.ts\nb.ts" });
    expect(summarizeResult("grep", { matches: [{ file: "a.ts", line: 3, text: "x" }] }).body).toBe("a.ts:3  x");
    expect(summarizeResult("edit_file", { replacements: 1 }).headline).toBe("1 replacement");
    expect(summarizeResult("write_file", { created: true }).headline).toBe("created");
    expect(summarizeResult("list_directory", { entries: [{ name: "src", type: "dir" }] }).headline).toBe("1 entry");
  });

  it("survives odd output", () => {
    expect(summarizeResult("run_command", null).headline).toBe("ended");
    expect(summarizeResult("mystery", undefined).headline).toBe("done");
  });
});

describe("labels", () => {
  it("titles each tool", () => {
    expect(toolTitle("run_command")).toBe("Run command");
    expect(toolTitle("unknown_tool")).toBe("unknown_tool");
  });

  it("shortens token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(25_000)).toBe("25k");
    expect(formatTokens(undefined)).toBe("");
  });
});
