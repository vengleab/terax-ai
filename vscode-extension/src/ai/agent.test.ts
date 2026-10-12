import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChatEvent } from "../../shared/chat";
import { runAgent } from "./agent";
import { callTool, failingModel, hangingModel, say, scriptedModel } from "./testing";

const echo = tool({ description: "echo", inputSchema: z.object({ text: z.string() }), execute: async ({ text }) => ({ echoed: text }) });
const broken = tool({
  description: "fails",
  inputSchema: z.object({}),
  execute: async () => {
    throw new Error("tool blew up");
  },
});
const refusing = tool({ description: "refuses", inputSchema: z.object({}), execute: async () => ({ error: "nope" }) });
const denying = tool({ description: "denied", inputSchema: z.object({}), execute: async () => ({ denied: true, error: "The user denied this action." }) });

function run(model: ReturnType<typeof scriptedModel>["model"], tools = { echo, broken, refusing, denying }, maxSteps = 10, signal = new AbortController().signal) {
  const events: ChatEvent[] = [];
  const promise = runAgent({
    model,
    system: "sys",
    messages: [{ role: "user", content: "go" }],
    tools,
    maxSteps,
    signal,
    emit: (e) => events.push(e),
  });
  return { events, promise };
}

describe("runAgent", () => {
  it("streams the answer as it arrives", async () => {
    const { model } = scriptedModel([say("Hello "), []]);
    const { events, promise } = run(model);
    const result = await promise;
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toContain("Hello");
    expect(result.finished).toBe(true);
    expect(result.messages[0]).toMatchObject({ role: "assistant" });
  });

  it("calls a tool, reports the call and the result, and carries on with the result in hand", async () => {
    const { model, seen } = scriptedModel([callTool("c1", "echo", { text: "hi" }), say("All done.")]);
    const { events, promise } = run(model);
    const result = await promise;
    const call = events.find((e) => e.type === "tool-call");
    expect(call).toMatchObject({ id: "c1", name: "echo", input: { text: "hi" } });
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ id: "c1", output: { echoed: "hi" }, isError: false });
    expect(JSON.stringify(seen[1])).toContain("echoed");
    expect(result.messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
  });

  it("marks a tool's own refusal as an error, and a user denial as denied", async () => {
    const a = run(scriptedModel([callTool("c1", "refusing", {}), say("ok")]).model);
    await a.promise;
    expect(a.events.find((e) => e.type === "tool-result")).toMatchObject({ isError: true, denied: false });
    const b = run(scriptedModel([callTool("c2", "denying", {}), say("ok")]).model);
    await b.promise;
    expect(b.events.find((e) => e.type === "tool-result")).toMatchObject({ isError: true, denied: true });
  });

  it("reports a tool that throws, without ending the turn", async () => {
    const { events, promise } = run(scriptedModel([callTool("c1", "broken", {}), say("recovered")]).model);
    const result = await promise;
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ id: "c1", isError: true });
    expect(result.finished).toBe(true);
  });

  it("numbers text blocks per step, so two steps never share a block", async () => {
    const { model } = scriptedModel([[...say("first", "0"), ...callTool("c1", "echo", { text: "x" })], say("second", "0")]);
    const { events, promise } = run(model);
    await promise;
    const ids = events.filter((e) => e.type === "text").map((e) => (e as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });

  it("reports token use", async () => {
    const result = await run(scriptedModel([say("hi")]).model).promise;
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  it("stops at the step limit and says so", async () => {
    const { model } = scriptedModel([callTool("c", "echo", { text: "again" })]);
    const { events, promise } = run(model, undefined, 2);
    await promise;
    expect(events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("Stopped after 2 steps") });
  });

  it("throws what the provider throws, for the caller to show", async () => {
    const { promise } = run(failingModel(new Error("provider is down")));
    await expect(promise).rejects.toThrow(/provider is down/);
  });

  it("stops when cancelled, and leaves a note for the next turn", async () => {
    const controller = new AbortController();
    const { promise } = run(hangingModel(), undefined, 5, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.finished).toBe(false);
    expect(result.messages).toEqual([{ role: "assistant", content: "(stopped by the user)" }]);
  });
});
