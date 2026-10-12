import { describe, expect, it } from "vitest";
import {
  aiSettings,
  defaultBaseUrl,
  defaultModelFor,
  describeModel,
  effectiveModel,
  isSupportedProvider,
  modelsFor,
  isAiProvider,
  needsApiKey,
  needsModelName,
  providerLabel,
  SUPPORTED_PROVIDERS,
  splitVsCodeModel,
  VSCODE_LM,
} from "./settings";

const config =
  (values: Record<string, unknown>) =>
  <T>(section: string, fallback: T): T =>
    (section in values ? values[section] : fallback) as T;

describe("aiSettings", () => {
  it("uses VS Code's own models (GitHub Copilot) with sensible limits when nothing is set", () => {
    expect(aiSettings(config({}))).toEqual({ provider: "vscode-lm", model: "", baseUrl: "", maxSteps: 24, commandTimeoutSeconds: 60 });
  });

  it("reads what the person set, trimmed", () => {
    expect(aiSettings(config({ "terax.ai.provider": "anthropic", "terax.ai.model": "  claude-x ", "terax.ai.baseUrl": " http://h/v1 " }))).toMatchObject({
      provider: "anthropic",
      model: "claude-x",
      baseUrl: "http://h/v1",
    });
  });

  it("falls back to the default for a provider the chat cannot use", () => {
    expect(aiSettings(config({ "terax.ai.provider": "google-vertex" })).provider).toBe("vscode-lm");
    expect(aiSettings(config({ "terax.ai.provider": 5 })).provider).toBe("vscode-lm");
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

describe("VS Code's own models", () => {
  const base = { provider: VSCODE_LM, model: "", baseUrl: "", maxSteps: 1, commandTimeoutSeconds: 1 } as const;

  it("is a provider, needs no key or address, and has no fixed list", () => {
    expect(isAiProvider(VSCODE_LM)).toBe(true);
    expect(isSupportedProvider(VSCODE_LM)).toBe(false);
    expect(needsApiKey(VSCODE_LM)).toBe(false);
    expect(defaultBaseUrl(VSCODE_LM)).toBe("");
    expect(modelsFor(VSCODE_LM)).toEqual([]);
    expect(needsModelName(VSCODE_LM)).toBe(false);
    expect(providerLabel(VSCODE_LM)).toContain("GitHub Copilot");
  });

  it("reads and splits the model setting as vendor/id", () => {
    expect(splitVsCodeModel("copilot/gpt-4o")).toEqual({ vendor: "copilot", id: "gpt-4o" });
    expect(splitVsCodeModel("gpt-4o")).toEqual({ id: "gpt-4o" });
    expect(splitVsCodeModel("acme/org/model-1")).toEqual({ vendor: "acme", id: "org/model-1" });
  });

  it("describes the model for the chat's button", () => {
    expect(describeModel(base)).toBe("GitHub Copilot · default");
    expect(describeModel({ ...base, model: "copilot/gpt-4o" })).toBe("GitHub Copilot · gpt-4o");
    expect(describeModel({ ...base, model: "acme/fast" })).toBe("acme · fast");
  });
});
