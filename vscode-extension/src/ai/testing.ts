import type { LanguageModel } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

type Chunk = Record<string, unknown>;

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } };

/** A step in which the model says something. */
export const say = (text: string, id = "t"): Chunk[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
];

/** A step in which the model calls a tool. */
export const callTool = (toolCallId: string, toolName: string, input: unknown): Chunk[] => [
  { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
];

/**
 * A model that plays back a script: each call to it takes the next step. A step ending in a tool call
 * finishes with "tool-calls", so the agent runs the tool and asks again; any other step ends the turn.
 * `seen` records the messages each call was given.
 */
export function scriptedModel(steps: Chunk[][]): { model: LanguageModel; seen: unknown[][] } {
  const seen: unknown[][] = [];
  let call = 0;
  const model = new MockLanguageModelV3({
    doStream: async (options: { prompt: unknown[] }) => {
      seen.push(options.prompt);
      const step = steps[Math.min(call++, steps.length - 1)];
      const calling = step.some((c) => c.type === "tool-call");
      // The chunks follow the AI SDK's stream protocol; its types are stricter than this test script needs.
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            ...step,
            { type: "finish", finishReason: { unified: calling ? "tool-calls" : "stop", raw: calling ? "tool_calls" : "stop" }, usage },
          ],
        }),
      } as never;
    },
  });
  return { model: model as unknown as LanguageModel, seen };
}

/** A model whose stream fails. */
export function failingModel(error: Error): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => {
      throw error;
    },
  }) as unknown as LanguageModel;
}

/** A model that never answers until it is cancelled. */
export function hangingModel(): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async (options: { abortSignal?: AbortSignal }) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          const cancel = () => controller.error(new DOMException("aborted", "AbortError"));
          if (options.abortSignal?.aborted) cancel();
          else options.abortSignal?.addEventListener("abort", cancel, { once: true });
        },
      }),
    }),
  }) as unknown as LanguageModel;
}
