import { type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { formatAiError } from "../../../src/modules/ai/lib/errors";
import type { ChatEvent } from "../../shared/chat";
import { summarizeCall } from "./tools";

export type AgentRun = {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  maxSteps: number;
  signal: AbortSignal;
  emit: (event: ChatEvent) => void;
};

export type AgentResult = {
  /** The assistant and tool messages this turn added, to append to the conversation. */
  messages: ModelMessage[];
  inputTokens?: number;
  outputTokens?: number;
  finished: boolean;
};

function isFailure(output: unknown): output is { error: unknown } {
  return !!output && typeof output === "object" && "error" in output;
}

/**
 * One turn of the agent: the model answers, calls tools, sees their results, and goes on until it
 * has nothing more to do (or the step limit). Everything it does is reported through `emit`, so the
 * chat can show it as it happens.
 */
export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const { emit } = run;
  // Stopped before the model was even asked (for example while the key was being read).
  if (run.signal.aborted) return { messages: [{ role: "assistant", content: "(stopped by the user)" }], finished: false };
  let streamError: unknown;
  const result = streamText({
    model: run.model,
    system: run.system,
    messages: run.messages,
    tools: run.tools,
    stopWhen: stepCountIs(run.maxSteps),
    abortSignal: run.signal,
    onError: ({ error }) => {
      streamError = error;
    },
  });

  let step = 0;
  let callsThisStep = 0;
  let lastStepCalled = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "start-step":
        step++;
        callsThisStep = 0;
        break;
      case "text-delta":
        emit({ type: "text", id: `${step}:${part.id}`, delta: part.text });
        break;
      case "reasoning-delta":
        emit({ type: "reasoning", id: `${step}:${part.id}`, delta: part.text });
        break;
      case "tool-call":
        callsThisStep++;
        emit({ type: "tool-call", id: part.toolCallId, name: part.toolName, summary: summarizeCall(part.toolName, part.input), input: part.input });
        break;
      case "tool-result": {
        const denied = !!part.output && typeof part.output === "object" && (part.output as { denied?: unknown }).denied === true;
        emit({ type: "tool-result", id: part.toolCallId, output: part.output, isError: isFailure(part.output), denied });
        break;
      }
      case "tool-error":
        emit({ type: "tool-result", id: part.toolCallId, output: { error: formatAiError(part.error) }, isError: true });
        break;
      case "finish-step":
        lastStepCalled = callsThisStep > 0;
        break;
      case "finish":
        inputTokens = part.totalUsage.inputTokens;
        outputTokens = part.totalUsage.outputTokens;
        break;
      default:
        break;
    }
  }

  if (run.signal.aborted) {
    return { messages: [{ role: "assistant", content: "(stopped by the user)" }], finished: false };
  }
  if (streamError) throw streamError;
  const response = await result.response;
  // The last step still wanted to use tools, so the limit cut the work short.
  if (lastStepCalled && step >= run.maxSteps) {
    emit({ type: "error", message: `Stopped after ${run.maxSteps} steps. Send another message to continue.` });
  }
  return { messages: response.messages, inputTokens, outputTokens, finished: true };
}
