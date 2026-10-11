import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getModelContextLimit,
  getProvider,
  MODELS,
  providerNeedsKey,
  PROVIDERS,
  resolveModel,
} from "../../config";
import { EMPTY_PROVIDER_KEYS } from "../../lib/keyring";
import { createCopilotFetch, rewriteModel } from "./build";
import type { CopilotSession, SessionManager } from "./copilotApi";
import {
  GITHUB_COPILOT_ID,
  GITHUB_COPILOT_MODEL_ID,
  GITHUB_COPILOT_PROVIDER,
} from "./data";
import { createCopilotState, type KeyValueStore } from "./selection";

const createOpenAICompatible = vi.hoisted(() => vi.fn());
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));

const session = (token: string): CopilotSession => ({
  token,
  apiBase: "https://api.individual.githubcopilot.com",
  expiresAtMs: Date.now() + 3_600_000,
});

function fakeManager(tokens: string[]): SessionManager & { invalidated: number } {
  let i = 0;
  const manager = {
    invalidated: 0,
    get: async () => session(tokens[Math.min(i, tokens.length - 1)]),
    invalidate() {
      manager.invalidated++;
      i++;
    },
  };
  return manager;
}

describe("registration", () => {
  it("registers one provider with its own key slot and a placeholder model", () => {
    expect(PROVIDERS.filter((p) => p.id === GITHUB_COPILOT_ID)).toHaveLength(1);
    expect(getProvider(GITHUB_COPILOT_ID)).toBe(GITHUB_COPILOT_PROVIDER);
    const accounts = PROVIDERS.map((p) => p.keyringAccount).filter(Boolean);
    expect(new Set(accounts).size).toBe(accounts.length);
    expect(providerNeedsKey(GITHUB_COPILOT_ID)).toBe(true);
    expect(EMPTY_PROVIDER_KEYS[GITHUB_COPILOT_ID]).toBeNull();
    expect(resolveModel(GITHUB_COPILOT_MODEL_ID).provider).toBe(GITHUB_COPILOT_ID);
    expect(MODELS.filter((m) => m.provider === GITHUB_COPILOT_ID)).toHaveLength(1);
    expect(getModelContextLimit(GITHUB_COPILOT_MODEL_ID)).toBeGreaterThan(0);
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("rewriteModel", () => {
  it("swaps the model in a JSON body and leaves everything else", () => {
    const out = rewriteModel(
      JSON.stringify({ model: "placeholder", stream: true, messages: [{ role: "user" }] }),
      "gpt-4.1",
    ) as string;
    expect(JSON.parse(out)).toEqual({
      model: "gpt-4.1",
      stream: true,
      messages: [{ role: "user" }],
    });
  });

  it("passes non-JSON and non-string bodies through", () => {
    expect(rewriteModel("not json", "m")).toBe("not json");
    expect(rewriteModel("[1,2]", "m")).toBe("[1,2]");
    expect(rewriteModel(null, "m")).toBeNull();
    expect(rewriteModel(undefined, "m")).toBeUndefined();
  });
});

describe("createCopilotFetch", () => {
  it("sets auth and editor headers and the currently selected model", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const manager = fakeManager(["tok1"]);
    const f = createCopilotFetch("oauth", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      manager,
      getModelId: async () => "claude-haiku-4.5",
    });
    await f("https://api.individual.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "ai-sdk/x" },
      body: JSON.stringify({ model: GITHUB_COPILOT_MODEL_ID, stream: true }),
    });
    const [, init] = fetchImpl.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer tok1");
    expect(headers.get("editor-version")).toMatch(/^vscode\//);
    expect(headers.get("user-agent")).toMatch(/^GitHubCopilotChat\//);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body).model).toBe("claude-haiku-4.5");
  });

  it("refuses to send without a selected model", async () => {
    const fetchImpl = vi.fn();
    const f = createCopilotFetch("oauth", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      manager: fakeManager(["t"]),
      getModelId: async () => null,
    });
    await expect(f("https://x/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(
      /no model selected/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries once with a fresh token after a 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const manager = fakeManager(["old", "new"]);
    const f = createCopilotFetch("oauth", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      manager,
      getModelId: async () => "m",
    });
    const res = await f("https://x/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(manager.invalidated).toBe(1);
    expect((fetchImpl.mock.calls[0][1].headers as Headers).get("authorization")).toBe("Bearer old");
    expect((fetchImpl.mock.calls[1][1].headers as Headers).get("authorization")).toBe("Bearer new");
  });

  it("returns a second 401 instead of looping", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("no", { status: 401 }));
    const f = createCopilotFetch("oauth", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      manager: fakeManager(["a", "b"]),
      getModelId: async () => "m",
    });
    const res = await f("https://x/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("buildLanguageModel routing", () => {
  beforeEach(() => createOpenAICompatible.mockReset());

  it("builds the Copilot model against the account's API host and needs sign-in", async () => {
    const model = { modelId: "routed" };
    const factory = vi.fn().mockReturnValue(model);
    createOpenAICompatible.mockReturnValue(factory);
    const { buildGithubCopilotModel } = await import("./build");

    const built = await buildGithubCopilotModel("oauth", {
      manager: fakeManager(["tok"]),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(built).toBe(model);
    expect(factory).toHaveBeenCalledWith(GITHUB_COPILOT_MODEL_ID);
    const options = createOpenAICompatible.mock.calls[0][0];
    expect(options.baseURL).toBe("https://api.individual.githubcopilot.com");
    expect(options.name).toBe(GITHUB_COPILOT_ID);
    expect(typeof options.fetch).toBe("function");

    const { buildLanguageModel } = await import("../../lib/agent");
    await expect(
      buildLanguageModel(GITHUB_COPILOT_ID, EMPTY_PROVIDER_KEYS, GITHUB_COPILOT_MODEL_ID),
    ).rejects.toThrow(/No API key configured for github-copilot/);
  });
});

describe("copilot state", () => {
  function memory(): KeyValueStore {
    const data = new Map<string, unknown>();
    return {
      get: async <T,>(k: string) => data.get(k) as T | undefined,
      set: async (k, v) => void data.set(k, v),
      delete: async (k) => data.delete(k),
      save: async () => {},
    };
  }

  it("remembers the model and the model list, and clears them on sign-out", async () => {
    const store = memory();
    const state = createCopilotState(() => store);
    expect(await state.getModelId()).toBeNull();
    expect(await state.getModels()).toEqual([]);
    await state.setModelId("gpt-4.1");
    await state.setModels([
      { id: "gpt-4.1", name: "GPT-4.1", vendor: null, contextWindow: null, maxOutput: null, preview: false },
    ]);
    expect(await state.getModelId()).toBe("gpt-4.1");
    expect((await state.getModels())[0].id).toBe("gpt-4.1");
    await state.clear();
    expect(await state.getModelId()).toBeNull();
    expect(await state.getModels()).toEqual([]);
  });
});
