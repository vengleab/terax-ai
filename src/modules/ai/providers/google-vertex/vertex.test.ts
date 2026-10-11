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
import { createVertexFetch, PLACEHOLDER_BASE, resolveRequest } from "./build";
import { testConnection } from "./connection";
import { makePointer } from "./credentialStore";
import {
  GOOGLE_VERTEX_ACCOUNT,
  GOOGLE_VERTEX_ID,
  GOOGLE_VERTEX_MODEL_ID,
  GOOGLE_VERTEX_PROVIDER,
} from "./data";
import { parseServiceAccount, type TokenManager } from "./serviceAccount";
import { createVertexState, DEFAULT_SETTINGS, type KeyValueStore, type VertexSettings } from "./settings";
import { makeTestAccount } from "./testKey";

const createOpenAICompatible = vi.hoisted(() => vi.fn());
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));

const proxyFetch = vi.hoisted(() => vi.fn());
vi.mock("../../lib/proxyFetch", () => ({ proxyFetch, createProxyFetch: () => proxyFetch }));

const credentials = vi.hoisted(() => ({ text: "" }));
vi.mock("./credentialStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentialStore")>();
  return { ...actual, loadAccountText: vi.fn(async () => credentials.text) };
});

const settings = (over: Partial<VertexSettings> = {}): VertexSettings => ({ ...DEFAULT_SETTINGS, ...over });

function fakeTokens(...tokens: string[]): TokenManager & { invalidated: number } {
  let i = 0;
  const manager = {
    invalidated: 0,
    get: async () => tokens[Math.min(i, tokens.length - 1)],
    invalidate() {
      manager.invalidated++;
      i++;
    },
  };
  return manager;
}

describe("registration", () => {
  it("registers one provider with its own key slot and a placeholder model", () => {
    expect(PROVIDERS.filter((p) => p.id === GOOGLE_VERTEX_ID)).toHaveLength(1);
    expect(getProvider(GOOGLE_VERTEX_ID)).toBe(GOOGLE_VERTEX_PROVIDER);
    const accounts = PROVIDERS.map((p) => p.keyringAccount).filter(Boolean);
    expect(new Set(accounts).size).toBe(accounts.length);
    expect(GOOGLE_VERTEX_PROVIDER.keyringAccount).toBe(GOOGLE_VERTEX_ACCOUNT);
    expect(providerNeedsKey(GOOGLE_VERTEX_ID)).toBe(true);
    expect(EMPTY_PROVIDER_KEYS[GOOGLE_VERTEX_ID]).toBeNull();
    expect(resolveModel(GOOGLE_VERTEX_MODEL_ID).provider).toBe(GOOGLE_VERTEX_ID);
    expect(MODELS.filter((m) => m.provider === GOOGLE_VERTEX_ID)).toHaveLength(1);
    expect(getModelContextLimit(GOOGLE_VERTEX_MODEL_ID)).toBeGreaterThan(0);
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("resolveRequest", () => {
  it("swaps the placeholder base for the project and location and names the model", async () => {
    const sa = parseServiceAccount((await makeTestAccount()).json);
    const out = resolveRequest(sa, settings({ location: "us-central1" }), `${PLACEHOLDER_BASE}/chat/completions`);
    expect(out.url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project-123/locations/us-central1/endpoints/openapi/chat/completions",
    );
    expect(out.model).toBe("google/gemini-2.5-flash");
  });

  it("prefers a project override, rejects bad settings and foreign URLs", async () => {
    const sa = parseServiceAccount((await makeTestAccount()).json);
    expect(
      resolveRequest(sa, settings({ projectOverride: "other-proj" }), new URL(`${PLACEHOLDER_BASE}/chat/completions`)).url,
    ).toContain("/projects/other-proj/");
    expect(() => resolveRequest(sa, settings({ location: "evil.com" }), `${PLACEHOLDER_BASE}/x`)).toThrow(/valid Google Cloud location/);
    expect(() => resolveRequest(sa, settings(), "https://evil.example.com/chat/completions")).toThrow(/Unexpected request URL/);
  });
});

describe("createVertexFetch", () => {
  it("sends the bearer token to the real endpoint with the chosen model", async () => {
    const sa = parseServiceAccount((await makeTestAccount()).json);
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const f = createVertexFetch(sa, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tokens: fakeTokens("ya29.one"),
      getSettings: async () => settings({ modelId: "gemini-2.5-pro" }),
    });
    await f(`${PLACEHOLDER_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: GOOGLE_VERTEX_MODEL_ID, stream: true }),
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/demo-project-123/locations/global/endpoints/openapi/chat/completions",
    );
    expect((init.headers as Headers).get("authorization")).toBe("Bearer ya29.one");
    expect((init.headers as Headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ model: "google/gemini-2.5-pro", stream: true });
  });

  it("picks up a changed location on the next request", async () => {
    const sa = parseServiceAccount((await makeTestAccount()).json);
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("ok"));
    let current = settings();
    const f = createVertexFetch(sa, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tokens: fakeTokens("t"),
      getSettings: async () => current,
    });
    await f(`${PLACEHOLDER_BASE}/chat/completions`, { method: "POST", body: "{}" });
    current = settings({ location: "europe-west4" });
    await f(`${PLACEHOLDER_BASE}/chat/completions`, { method: "POST", body: "{}" });
    expect(fetchImpl.mock.calls[0][0]).toContain("//aiplatform.googleapis.com/");
    expect(fetchImpl.mock.calls[1][0]).toContain("//europe-west4-aiplatform.googleapis.com/");
  });

  it("retries once with a fresh token after a 401 and then gives up", async () => {
    const sa = parseServiceAccount((await makeTestAccount()).json);
    const tokens = fakeTokens("old", "new");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const f = createVertexFetch(sa, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tokens,
      getSettings: async () => settings(),
    });
    const res = await f(`${PLACEHOLDER_BASE}/chat/completions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(tokens.invalidated).toBe(1);
    expect((fetchImpl.mock.calls[1][1].headers as Headers).get("authorization")).toBe("Bearer new");

    const always401 = vi.fn().mockImplementation(async () => new Response("no", { status: 401 }));
    const g = createVertexFetch(sa, {
      fetchImpl: always401 as unknown as typeof fetch,
      tokens: fakeTokens("a", "b"),
      getSettings: async () => settings(),
    });
    expect((await g(`${PLACEHOLDER_BASE}/chat/completions`, { method: "POST", body: "{}" })).status).toBe(401);
    expect(always401).toHaveBeenCalledTimes(2);
  });
});

describe("building the model", () => {
  beforeEach(() => {
    createOpenAICompatible.mockReset();
    proxyFetch.mockReset();
  });

  it("loads the key file, signs in, and builds a client against the placeholder base", async () => {
    const account = await makeTestAccount();
    credentials.text = account.json;
    proxyFetch.mockResolvedValue(new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3600 })));
    const model = { modelId: "built" };
    const factory = vi.fn().mockReturnValue(model);
    createOpenAICompatible.mockReturnValue(factory);

    const { buildGoogleVertexModel } = await import("./build");
    const built = await buildGoogleVertexModel(makePointer(3, "0123456789ab"));

    expect(built).toBe(model);
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(proxyFetch.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
    expect(factory).toHaveBeenCalledWith(GOOGLE_VERTEX_MODEL_ID);
    const options = createOpenAICompatible.mock.calls[0][0];
    expect(options.baseURL).toBe(PLACEHOLDER_BASE);
    expect(options.name).toBe(GOOGLE_VERTEX_ID);
    expect(typeof options.fetch).toBe("function");
  });

  it("is chosen by buildLanguageModel and needs a saved account", async () => {
    const { buildLanguageModel } = await import("../../lib/agent");
    await expect(buildLanguageModel(GOOGLE_VERTEX_ID, EMPTY_PROVIDER_KEYS, GOOGLE_VERTEX_MODEL_ID)).rejects.toThrow(
      /No API key configured for google-vertex/,
    );

    const account = await makeTestAccount();
    credentials.text = account.json;
    proxyFetch.mockResolvedValue(new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3600 })));
    const model = { modelId: "routed" };
    createOpenAICompatible.mockReturnValue(vi.fn().mockReturnValue(model));
    const built = await buildLanguageModel(
      GOOGLE_VERTEX_ID,
      { ...EMPTY_PROVIDER_KEYS, [GOOGLE_VERTEX_ID]: makePointer(3, "aaaaaaaaaaaa") },
      GOOGLE_VERTEX_MODEL_ID,
    );
    expect(built).toBe(model);
  });
});

describe("testConnection", () => {
  it("reports success with the model and project", async () => {
    const sa = parseServiceAccount((await makeTestAccount()).json);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] })));
    const result = await testConnection(sa, settings(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tokens: fakeTokens("tok"),
    });
    expect(result).toEqual({ ok: true, detail: "google/gemini-2.5-flash answered from demo-project-123 (global)." });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/\/endpoints\/openapi\/chat\/completions$/);
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body).model).toBe("google/gemini-2.5-flash");
  });

  it("shows Google's own message for a failure such as a disabled API", async () => {
    const sa = parseServiceAccount((await makeTestAccount()).json);
    const body = { error: { code: 403, message: "Vertex AI API has not been used in project demo-project-123 before." } };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 403 }));
    const result = await testConnection(sa, settings(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tokens: fakeTokens("tok"),
    });
    expect(result).toEqual({
      ok: false,
      message: "HTTP 403: Vertex AI API has not been used in project demo-project-123 before.",
    });
  });

  it("reports bad settings and sign-in problems without throwing", async () => {
    const sa = parseServiceAccount((await makeTestAccount()).json);
    const fetchImpl = vi.fn();
    const bad = await testConnection(sa, settings({ location: "nope!" }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      tokens: fakeTokens("tok"),
    });
    expect(bad.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    const failingTokens: TokenManager = {
      get: async () => {
        throw new Error("Google rejected the service account: Invalid JWT Signature.");
      },
      invalidate() {},
    };
    const rejected = await testConnection(sa, settings(), { fetchImpl: fetchImpl as unknown as typeof fetch, tokens: failingTokens });
    expect(rejected).toEqual({ ok: false, message: "Google rejected the service account: Invalid JWT Signature." });
  });
});

describe("settings state", () => {
  function memory(): KeyValueStore {
    const data = new Map<string, unknown>();
    return {
      get: async <T,>(k: string) => data.get(k) as T | undefined,
      set: async (k, v) => void data.set(k, v),
      delete: async (k) => data.delete(k),
      save: async () => {},
    };
  }

  it("has sensible defaults, keeps changes and remembers the saved account", async () => {
    const store = memory();
    const state = createVertexState(() => store);
    expect(await state.getSettings()).toEqual({ location: "global", modelId: "gemini-2.5-flash", projectOverride: "" });
    await state.setSettings({ location: "us-east5" });
    await state.setSettings({ modelId: "gemini-2.5-pro" });
    expect(await state.getSettings()).toEqual({ location: "us-east5", modelId: "gemini-2.5-pro", projectOverride: "" });

    expect(await state.getAccount()).toBeNull();
    await state.setAccount({ clientEmail: "a@b.iam.gserviceaccount.com", projectId: "p", parts: 3 });
    expect((await state.getAccount())?.parts).toBe(3);
    await state.setAccount(null);
    expect(await state.getAccount()).toBeNull();
  });
});
