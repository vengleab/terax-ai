import { tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ChatEvent } from "../../shared/chat";
import { runAgent } from "./agent";
import { ChatSetupError } from "./model";
import { createVsCodeLmModel, type LmApi, type LmModel, pickModel, toLmMessages } from "./vscodeLm";

type Part = { k: "text"; value: string } | { k: "call"; callId: string; name: string; input: object } | { k: "result"; callId: string; text: string };
type Msg = { role: "user" | "assistant"; parts: Part[] };

/** What a model sends back for one request: parts, or an error thrown part-way. */
type Reply = { parts: Part[]; throwAfter?: unknown; throwOnSend?: unknown; hang?: boolean; deaf?: boolean };

function fakeModel(over: Partial<LmModel> & { replies?: Reply[] } = {}) {
  const requests: { messages: Msg[]; tools?: unknown; justification: string; token: { cancelled: boolean } }[] = [];
  let call = 0;
  const model: LmModel = {
    id: "gpt-4o",
    vendor: "copilot",
    family: "gpt-4o",
    name: "GPT-4o",
    maxInputTokens: 64000,
    send: async (messages, options, token) => {
      const reply = (over.replies ?? [{ parts: [{ k: "text", value: "ok" }] }])[Math.min(call++, (over.replies?.length ?? 1) - 1)];
      requests.push({ messages: messages as Msg[], tools: options.tools, justification: options.justification, token: token as { cancelled: boolean } });
      if (reply.throwOnSend) throw reply.throwOnSend;
      return (async function* () {
        for (const part of reply.parts) yield part;
        if (reply.deaf) await new Promise(() => undefined);
        if (reply.hang) {
          await new Promise<void>((resolve) => {
            const t = token as { cancelled: boolean; onCancel?: () => void };
            t.onCancel = resolve;
          });
          throw Object.assign(new Error("cancelled"), { cancelled: true });
        }
        if (reply.throwAfter) throw reply.throwAfter;
      })();
    },
    ...over,
  };
  return { model, requests };
}

function fakeApi(models: LmModel[]): LmApi & { sources: { token: { cancelled: boolean; onCancel?: () => void }; disposed: boolean }[] } {
  const sources: { token: { cancelled: boolean; onCancel?: () => void }; disposed: boolean }[] = [];
  return {
    sources,
    models: async (selector) => models.filter((m) => (!selector?.vendor || m.vendor === selector.vendor) && (!selector?.id || m.id === selector.id)),
    user: (parts) => ({ role: "user", parts }),
    assistant: (parts) => ({ role: "assistant", parts }),
    text: (value) => ({ k: "text", value }),
    toolCall: (callId, name, input) => ({ k: "call", callId, name, input }),
    toolResult: (callId, text) => ({ k: "result", callId, text }),
    classify: (part) => {
      const p = part as Part;
      return p.k === "text" ? { kind: "text", value: p.value } : p.k === "call" ? { kind: "tool-call", callId: p.callId, name: p.name, input: p.input } : { kind: "other" };
    },
    cancellation: () => {
      const entry = { token: { cancelled: false } as { cancelled: boolean; onCancel?: () => void }, disposed: false };
      sources.push(entry);
      return {
        token: entry.token,
        cancel: () => {
          entry.token.cancelled = true;
          entry.token.onCancel?.();
        },
        dispose: () => {
          entry.disposed = true;
        },
      };
    },
    classifyError: (error) => {
      const e = error as { code?: string; cancelled?: boolean; message?: string };
      const message = e?.message ?? String(error);
      if (e?.cancelled) return { kind: "cancelled", message };
      if (e?.code === "NoPermissions") return { kind: "permission", message };
      if (e?.code === "Blocked") return { kind: "blocked", message };
      if (e?.code === "NotFound") return { kind: "not-found", message };
      return { kind: "other", message };
    },
  };
}

const echo = tool({ description: "echo a word", inputSchema: z.object({ text: z.string() }), execute: async ({ text }) => ({ echoed: text }) });

function run(api: LmApi, messages = [{ role: "user" as const, content: "hello" }], signal = new AbortController().signal, setting = "") {
  const events: ChatEvent[] = [];
  const promise = runAgent({
    model: createVsCodeLmModel(api, { model: setting }),
    system: "You are a test.",
    messages,
    tools: { echo },
    maxSteps: 5,
    signal,
    emit: (e) => events.push(e),
  });
  return { events, promise };
}

describe("pickModel", () => {
  const copilot = fakeModel({ id: "gpt-4o", vendor: "copilot" }).model;
  const copilot2 = fakeModel({ id: "claude", vendor: "copilot", name: "Claude" }).model;
  const other = fakeModel({ id: "fast", vendor: "acme", name: "Acme" }).model;

  it("prefers a Copilot model when none is chosen, even if another vendor comes first", async () => {
    expect(await pickModel(fakeApi([other, copilot, copilot2]), "")).toBe(copilot);
  });

  it("takes the first model there is when Copilot is not installed", async () => {
    expect(await pickModel(fakeApi([other]), "")).toBe(other);
  });

  it("finds a model by vendor and id, or by id alone", async () => {
    const api = fakeApi([copilot, copilot2, other]);
    expect(await pickModel(api, "copilot/claude")).toBe(copilot2);
    expect(await pickModel(api, "fast")).toBe(other);
  });

  it("does not mix up vendors that share an id", async () => {
    const a = fakeModel({ id: "x", vendor: "a" }).model;
    const b = fakeModel({ id: "x", vendor: "b" }).model;
    expect(await pickModel(fakeApi([a, b]), "b/x")).toBe(b);
  });

  it("says what to do when there are no models at all", async () => {
    await expect(pickModel(fakeApi([]), "")).rejects.toMatchObject({ hint: "select-model", message: expect.stringContaining("GitHub Copilot Chat") });
  });

  it("says so when the chosen model has gone", async () => {
    const error = await pickModel(fakeApi([copilot]), "copilot/retired").catch((e) => e);
    expect(error).toBeInstanceOf(ChatSetupError);
    expect(error.message).toContain("copilot/retired");
  });
});

describe("toLmMessages", () => {
  const api = fakeApi([]);

  it("sends the instructions as a first user message, since VS Code has no system role", () => {
    const out = toLmMessages(api, [
      { role: "system", content: "Be terse." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]) as Msg[];
    expect(out).toEqual([
      { role: "user", parts: [{ k: "text", value: "Be terse." }] },
      { role: "user", parts: [{ k: "text", value: "hi" }] },
    ]);
  });

  it("carries tool calls in assistant messages and their results back as user messages", () => {
    const out = toLmMessages(api, [
      { role: "user", content: [{ type: "text", text: "run it" }] },
      { role: "assistant", content: [{ type: "text", text: "Running." }, { type: "tool-call", toolCallId: "c1", toolName: "run_command", input: { command: "ls" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "run_command", output: { type: "json", value: { exit_code: 0 } } }] },
    ]) as Msg[];
    expect(out[1]).toEqual({ role: "assistant", parts: [{ k: "text", value: "Running." }, { k: "call", callId: "c1", name: "run_command", input: { command: "ls" } }] });
    expect(out[2]).toEqual({ role: "user", parts: [{ k: "result", callId: "c1", text: '{"exit_code":0}' }] });
  });

  it("puts every result of one step in one message", () => {
    const out = toLmMessages(api, [
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "a", toolName: "x", output: { type: "text", value: "one" } },
          { type: "tool-result", toolCallId: "b", toolName: "x", output: { type: "error-text", value: "two" } },
        ],
      },
    ]) as Msg[];
    expect(out).toHaveLength(1);
    expect(out[0].parts.map((p) => (p as { text: string }).text)).toEqual(["one", "two"]);
  });

  it("reads tool input that arrived as a JSON string, and survives broken JSON", () => {
    const out = toLmMessages(api, [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "x", input: '{"n":1}' }, { type: "tool-call", toolCallId: "b", toolName: "x", input: "{oops" }] },
    ]) as Msg[];
    expect(out[0].parts).toEqual([
      { k: "call", callId: "a", name: "x", input: { n: 1 } },
      { k: "call", callId: "b", name: "x", input: {} },
    ]);
  });

  it("drops empty messages and attachments it cannot send", () => {
    const out = toLmMessages(api, [
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "file", data: "x" }] },
    ]) as Msg[];
    expect(out).toHaveLength(1);
    expect((out[0].parts[0] as { value: string }).value).toContain("left out");
  });
});

describe("the model, driven by the agent loop", () => {
  it("streams the answer", async () => {
    const { model } = fakeModel({ replies: [{ parts: [{ k: "text", value: "Hello " }, { k: "text", value: "there." }] }] });
    const { events, promise } = run(fakeApi([model]));
    const result = await promise;
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Hello there.");
    expect(result.finished).toBe(true);
    expect(result.messages[0]).toMatchObject({ role: "assistant" });
  });

  it("tells VS Code the model is used by Terax, and what tools it has", async () => {
    const { model, requests } = fakeModel();
    await run(fakeApi([model])).promise;
    expect(requests[0].justification).toContain("Terax");
    expect(requests[0].tools).toEqual([expect.objectContaining({ name: "echo", description: "echo a word", inputSchema: expect.objectContaining({ type: "object" }) })]);
    expect((requests[0].messages[0].parts[0] as { value: string }).value).toBe("You are a test.");
  });

  it("calls a tool, then answers with its result in hand", async () => {
    const { model, requests } = fakeModel({
      replies: [{ parts: [{ k: "text", value: "Let me check." }, { k: "call", callId: "call-1", name: "echo", input: { text: "pong" } }] }, { parts: [{ k: "text", value: "It said pong." }] }],
    });
    const { events, promise } = run(fakeApi([model]));
    const result = await promise;
    expect(events.find((e) => e.type === "tool-call")).toMatchObject({ id: "call-1", name: "echo", input: { text: "pong" } });
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ id: "call-1", output: { echoed: "pong" }, isError: false });
    expect(requests).toHaveLength(2);
    const second = requests[1].messages;
    expect(second.some((m) => m.role === "assistant" && m.parts.some((p) => p.k === "call" && p.callId === "call-1"))).toBe(true);
    expect(second.some((m) => m.role === "user" && m.parts.some((p) => p.k === "result" && p.callId === "call-1" && p.text.includes("pong")))).toBe(true);
    expect(result.messages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
  });

  it("ignores parts it does not understand and keeps going", async () => {
    const { model } = fakeModel({ replies: [{ parts: [{ k: "result", callId: "x", text: "?" }, { k: "text", value: "fine" }] }] });
    const { events, promise } = run(fakeApi([model]));
    await promise;
    expect(events.filter((e) => e.type === "text")).toHaveLength(1);
  });

  it("uses the model the setting names", async () => {
    const a = fakeModel({ id: "a", vendor: "copilot" });
    const b = fakeModel({ id: "b", vendor: "copilot" });
    await run(fakeApi([a.model, b.model]), undefined, undefined, "copilot/b").promise;
    expect(a.requests).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
  });

  it("reports the model as unavailable instead of failing obscurely", async () => {
    await expect(run(fakeApi([]), undefined).promise).rejects.toMatchObject({ hint: "select-model" });
  });

  describe("errors", () => {
    it("explains a declined permission, and points to the model picker", async () => {
      const { model } = fakeModel({ replies: [{ parts: [], throwOnSend: Object.assign(new Error("no"), { code: "NoPermissions" }) }] });
      const error = await run(fakeApi([model])).promise.catch((e) => e);
      expect(error).toBeInstanceOf(ChatSetupError);
      expect(error.message).toContain("Allow it when VS Code asks");
      expect(error.hint).toBe("select-model");
    });

    it("explains a blocked request with the reason", async () => {
      const { model } = fakeModel({ replies: [{ parts: [], throwOnSend: Object.assign(new Error("quota exceeded"), { code: "Blocked" }) }] });
      const error = await run(fakeApi([model])).promise.catch((e) => e);
      expect(error.message).toContain("quota exceeded");
    });

    it("passes any other failure on, with its message", async () => {
      const { model } = fakeModel({ replies: [{ parts: [], throwOnSend: new Error("rate limited") }] });
      await expect(run(fakeApi([model])).promise).rejects.toThrow(/rate limited/);
    });

    it("reports a failure that happens part-way through the answer", async () => {
      const { model } = fakeModel({ replies: [{ parts: [{ k: "text", value: "Start" }], throwAfter: new Error("connection lost") }] });
      await expect(run(fakeApi([model])).promise).rejects.toThrow(/connection lost/);
    });

    it("lets go of VS Code's cancellation source, whatever happens", async () => {
      const ok = fakeApi([fakeModel().model]);
      await run(ok).promise;
      expect(ok.sources.every((s) => s.disposed)).toBe(true);
      const bad = fakeApi([fakeModel({ replies: [{ parts: [], throwOnSend: new Error("x") }] }).model]);
      await run(bad).promise.catch(() => undefined);
      expect(bad.sources.every((s) => s.disposed)).toBe(true);
    });
  });

  it("cancels the request in VS Code when the turn is stopped", async () => {
    const { model, requests } = fakeModel({ replies: [{ parts: [{ k: "text", value: "thinking" }], hang: true }] });
    const api = fakeApi([model]);
    const controller = new AbortController();
    const { promise } = run(api, undefined, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await promise;
    expect(result.finished).toBe(false);
    expect(requests[0].token.cancelled).toBe(true);
    expect(api.sources.every((s) => s.disposed)).toBe(true);
  });

  it("ends the turn when stopped even if the model never reacts to the cancellation", async () => {
    const { model, requests } = fakeModel({ replies: [{ parts: [{ k: "text", value: "thinking" }], deaf: true }] });
    const api = fakeApi([model]);
    const controller = new AbortController();
    const { promise } = run(api, undefined, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await Promise.race([promise, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000))]);
    expect(result).not.toBe("hung");
    expect((result as { finished: boolean }).finished).toBe(false);
    expect(requests[0].token.cancelled).toBe(true);
    expect(api.sources.every((s) => s.disposed)).toBe(true);
  });

  it("does not start a request that was already stopped", async () => {
    const { model, requests } = fakeModel();
    const controller = new AbortController();
    controller.abort();
    const result = await run(fakeApi([model]), undefined, controller.signal).promise;
    expect(result.finished).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe("doGenerate", () => {
  it("collects a whole answer, for callers that do not stream", async () => {
    const { model } = fakeModel({ replies: [{ parts: [{ k: "text", value: "Hi " }, { k: "text", value: "all" }, { k: "call", callId: "c", name: "echo", input: { text: "x" } }] }] });
    const lm = createVsCodeLmModel(fakeApi([model]), { model: "" }) as unknown as { doGenerate: (o: unknown) => Promise<{ content: { type: string; text?: string; toolName?: string }[]; finishReason: { unified: string } }> };
    const out = await lm.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    expect(out.content[0]).toEqual({ type: "text", text: "Hi all" });
    expect(out.content[1]).toMatchObject({ type: "tool-call", toolName: "echo" });
    expect(out.finishReason.unified).toBe("tool-calls");
  });
});
