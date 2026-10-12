import { describe, expect, it } from "vitest";
import {
  aiSettings,
  defaultBaseUrl,
  defaultModelFor,
  describeModel,
  effectiveModel,
  isSupportedProvider,
  modelsFor,
  needsApiKey,
  needsModelName,
  SUPPORTED_PROVIDERS,
} from "./settings";

const config =
  (values: Record<string, unknown>) =>
  <T>(section: string, fallback: T): T =>
    (section in values ? values[section] : fallback) as T;

describe("aiSettings", () => {
  it("uses OpenAI with sensible limits when nothing is set", () => {
    expect(aiSettings(config({}))).toEqual({ provider: "openai", model: "", baseUrl: "", maxSteps: 24, commandTimeoutSeconds: 60 });
  });

  it("reads what the person set, trimmed", () => {
    expect(aiSettings(config({ "terax.ai.provider": "anthropic", "terax.ai.model": "  claude-x ", "terax.ai.baseUrl": " http://h/v1 " }))).toMatchObject({
      provider: "anthropic",
      model: "claude-x",
      baseUrl: "http://h/v1",
    });
  });

  it("falls back to OpenAI for a provider the chat cannot use", () => {
    expect(aiSettings(config({ "terax.ai.provider": "google-vertex" })).provider).toBe("openai");
    expect(aiSettings(config({ "terax.ai.provider": 5 })).provider).toBe("openai");
  });

  it("keeps the limits in range", () => {
    expect(aiSettings(config({ "terax.ai.maxSteps": 5000, "terax.ai.commandTimeoutSeconds": 0 }))).toMatchObject({ maxSteps: 100, commandTimeoutSeconds: 1 });
    expect(aiSettings(config({ "terax.ai.maxSteps": Number.NaN })).maxSteps).toBe(24);
  });
});

describe("providers and models", () => {
  it("only offers providers that need nothing but a key or an address", () => {
    expect(isSupportedProvider("openai")).toBe(true);
    expect(isSupportedProvider("google-vertex")).toBe(false);
    expect(isSupportedProvider("copilot")).toBe(false);
    for (const p of SUPPORTED_PROVIDERS) expect(typeof needsApiKey(p)).toBe("boolean");
  });

  it("lists real model names for hosted providers", () => {
    expect(modelsFor("openai").length).toBeGreaterThan(0);
    expect(defaultModelFor("openai")).toBe(modelsFor("openai")[0].id);
    expect(needsModelName("openai")).toBe(false);
  });

  it("never offers a placeholder such as ollama-local as a model name", () => {
    for (const p of ["ollama", "lmstudio", "mlx", "openai-compatible", "openrouter"] as const) {
      expect(modelsFor(p).every((m) => !/-(custom|local)$/.test(m.id))).toBe(true);
    }
    expect(needsModelName("ollama")).toBe(true);
    expect(defaultModelFor("ollama")).toBeUndefined();
  });

  it("answers with the chosen model, else the provider's first, else nothing", () => {
    const base = { provider: "openai", model: "", baseUrl: "", maxSteps: 1, commandTimeoutSeconds: 1 } as const;
    expect(effectiveModel({ ...base, model: "my-model" })).toBe("my-model");
    expect(effectiveModel(base)).toBe(defaultModelFor("openai"));
    expect(effectiveModel({ ...base, provider: "ollama" })).toBe("");
  });

  it("describes the model for the chat's button", () => {
    const base = { provider: "openai", model: "", baseUrl: "", maxSteps: 1, commandTimeoutSeconds: 1 } as const;
    expect(describeModel(base)).toMatch(/^OpenAI · /);
    expect(describeModel({ ...base, model: "gpt-unknown" })).toBe("OpenAI · gpt-unknown");
    expect(describeModel({ ...base, provider: "ollama" })).toMatch(/choose a model$/);
  });

  it("knows the local servers' usual addresses", () => {
    expect(defaultBaseUrl("ollama")).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):11434/);
    expect(defaultBaseUrl("lmstudio")).toMatch(/^http/);
    expect(defaultBaseUrl("openai")).toBe("");
    expect(needsApiKey("ollama")).toBe(false);
    expect(needsApiKey("openai")).toBe(true);
  });
});
