import { describe, expect, it } from "vitest";
import { ChatSetupError, createModel } from "./model";
import type { AiSettings } from "./settings";

const base: AiSettings = { provider: "openai", model: "", baseUrl: "", maxSteps: 10, commandTimeoutSeconds: 10 };

async function failure(settings: AiSettings, key: string | undefined): Promise<ChatSetupError> {
  try {
    await createModel(settings, key);
  } catch (error) {
    expect(error).toBeInstanceOf(ChatSetupError);
    return error as ChatSetupError;
  }
  throw new Error("expected createModel to throw");
}

describe("createModel", () => {
  it("builds a hosted model from the provider's first model when none is chosen", async () => {
    const model = (await createModel(base, "sk-test")) as { modelId: string; provider: string };
    expect(model.modelId).toBeTruthy();
    expect(model.provider).toContain("openai");
  });

  it("uses the chosen model name", async () => {
    const model = (await createModel({ ...base, model: "gpt-custom-name" }, "sk-test")) as { modelId: string };
    expect(model.modelId).toBe("gpt-custom-name");
  });

  it.each(["anthropic", "google", "xai", "cerebras", "groq", "deepseek", "mistral", "openrouter"] as const)("builds a %s model", async (provider) => {
    const model = (await createModel({ ...base, provider, model: "some-model" }, "key")) as { modelId: string };
    expect(model.modelId).toBe("some-model");
  });

  it("asks for a key rather than calling a hosted provider without one", async () => {
    const error = await failure(base, undefined);
    expect(error.hint).toBe("set-key");
    expect(error.message).toContain("OpenAI");
    expect((await failure(base, "   ")).hint).toBe("set-key");
  });

  it("asks for a model name where Terax has no list", async () => {
    const error = await failure({ ...base, provider: "ollama" }, undefined);
    expect(error.hint).toBe("select-model");
  });

  it("needs no key for a local server, and uses its usual address", async () => {
    const model = (await createModel({ ...base, provider: "ollama", model: "llama3" }, undefined)) as { modelId: string; config?: { url?: (o: { path: string }) => string } };
    expect(model.modelId).toBe("llama3");
    expect(model.config?.url?.({ path: "/chat/completions" })).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):11434/);
  });

  it("uses the address from the setting for a custom endpoint", async () => {
    const model = (await createModel({ ...base, provider: "openai-compatible", model: "m", baseUrl: "http://gateway.test/v1" }, undefined)) as {
      config?: { url?: (o: { path: string }) => string };
    };
    expect(model.config?.url?.({ path: "/chat/completions" })).toBe("http://gateway.test/v1/chat/completions");
  });

  it("says where to set the address of a custom endpoint when it is missing", async () => {
    const error = await failure({ ...base, provider: "openai-compatible", model: "m" }, undefined);
    expect(error.hint).toBe("open-settings");
    expect(error.message).toContain("terax.ai.baseUrl");
  });

  it("does not put the key in an error message", async () => {
    const error = await failure({ ...base, provider: "ollama" }, "sk-secret-value-123456");
    expect(error.message).not.toContain("sk-secret-value-123456");
  });
});
