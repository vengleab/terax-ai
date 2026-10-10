import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getModelContextLimit,
  getProvider,
  MODELS,
  providerNeedsKey,
  providerSupportsKey,
  PROVIDERS,
  resolveModel,
} from "../../config";
import { EMPTY_PROVIDER_KEYS } from "../../lib/keyring";
import {
  GITHUB_MODELS,
  GITHUB_MODELS_BASE_URL,
  GITHUB_MODELS_CONTEXT_LIMITS,
  GITHUB_MODELS_ID,
  GITHUB_MODELS_PROVIDER,
} from "./data";

const createOpenAICompatible = vi.hoisted(() => vi.fn());

vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));

describe("GitHub Models registration", () => {
  it("is registered exactly once with its own key slot", () => {
    const matches = PROVIDERS.filter((p) => p.id === GITHUB_MODELS_ID);
    expect(matches).toHaveLength(1);
    expect(getProvider(GITHUB_MODELS_ID)).toBe(GITHUB_MODELS_PROVIDER);
    const accounts = PROVIDERS.map((p) => p.keyringAccount).filter(Boolean);
    expect(new Set(accounts).size).toBe(accounts.length);
    expect(GITHUB_MODELS_PROVIDER.keyringAccount).toBe("github-models-api-key");
  });

  it("needs an API key and has an empty slot in the key map", () => {
    expect(providerNeedsKey(GITHUB_MODELS_ID)).toBe(true);
    expect(providerSupportsKey(GITHUB_MODELS_ID)).toBe(true);
    expect(EMPTY_PROVIDER_KEYS[GITHUB_MODELS_ID]).toBeNull();
  });

  it("does not accept a key prefix that rejects either GitHub token style", () => {
    expect(GITHUB_MODELS_PROVIDER.keyPrefix).toBeNull();
  });
});

describe("GitHub Models catalog", () => {
  it("has unique model ids that cannot collide with other providers", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const mine = GITHUB_MODELS.map((m) => m.id);
    expect(new Set(mine).size).toBe(mine.length);
  });

  it("belongs to the provider and uses publisher-prefixed ids", () => {
    expect(GITHUB_MODELS.length).toBeGreaterThan(0);
    for (const m of GITHUB_MODELS) {
      expect(m.provider).toBe(GITHUB_MODELS_ID);
      expect(m.id).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9._-]+$/);
    }
  });

  it("appears in the shared registry and resolves by id", () => {
    for (const m of GITHUB_MODELS) {
      expect(MODELS.some((x) => x.id === m.id)).toBe(true);
      expect(resolveModel(m.id).provider).toBe(GITHUB_MODELS_ID);
    }
  });

  it("has a context limit for every model", () => {
    for (const m of GITHUB_MODELS) {
      expect(GITHUB_MODELS_CONTEXT_LIMITS[m.id]).toBeGreaterThan(0);
      expect(getModelContextLimit(m.id)).toBe(
        GITHUB_MODELS_CONTEXT_LIMITS[m.id],
      );
    }
  });
});

describe("buildGithubModelsModel", () => {
  beforeEach(() => {
    createOpenAICompatible.mockReset();
  });

  it("targets the GitHub Models endpoint with the key and API version", async () => {
    const model = { modelId: "stub" };
    const factory = vi.fn().mockReturnValue(model);
    createOpenAICompatible.mockReturnValue(factory);
    const { buildGithubModelsModel } = await import("./build");

    const built = await buildGithubModelsModel("github_pat_x", "openai/gpt-4.1");

    expect(built).toBe(model);
    expect(factory).toHaveBeenCalledWith("openai/gpt-4.1");
    const options = createOpenAICompatible.mock.calls[0][0];
    expect(options.baseURL).toBe(GITHUB_MODELS_BASE_URL);
    expect(options.baseURL).toBe("https://models.github.ai/inference");
    expect(options.apiKey).toBe("github_pat_x");
    expect(options.headers).toEqual({ "X-GitHub-Api-Version": "2022-11-28" });
    expect(options.name).toBe(GITHUB_MODELS_ID);
    expect(typeof options.fetch).toBe("function");
  });
});

describe("buildLanguageModel routing", () => {
  it("builds github-models through its provider case and demands a key", async () => {
    const model = { modelId: "routed" };
    createOpenAICompatible.mockReset();
    createOpenAICompatible.mockReturnValue(vi.fn().mockReturnValue(model));
    const { buildLanguageModel } = await import("../../lib/agent");

    await expect(
      buildLanguageModel(GITHUB_MODELS_ID, EMPTY_PROVIDER_KEYS, "openai/gpt-4.1"),
    ).rejects.toThrow(/No API key configured for github-models/);

    const built = await buildLanguageModel(
      GITHUB_MODELS_ID,
      { ...EMPTY_PROVIDER_KEYS, [GITHUB_MODELS_ID]: "ghp_routing" },
      "openai/gpt-4.1-mini",
    );
    expect(built).toBe(model);
    expect(createOpenAICompatible.mock.calls[0][0].apiKey).toBe("ghp_routing");
  });
});
