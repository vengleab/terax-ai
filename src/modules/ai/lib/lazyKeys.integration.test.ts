import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  calls: [] as { cmd: string; account?: string; accounts?: string[] }[],
  index: new Map<string, unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {},
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    tauri.calls.push({
      cmd,
      account: args?.account as string | undefined,
      accounts: args?.accounts as string[] | undefined,
    });
    switch (cmd) {
      case "secrets_get":
        return tauri.secrets.get(args?.account as string) ?? null;
      case "secrets_get_all": {
        const accounts = (args?.accounts ?? []) as string[];
        return accounts.map((a) => tauri.secrets.get(a) ?? null);
      }
      case "secrets_set":
        tauri.secrets.set(args?.account as string, args?.password as string);
        return null;
      case "secrets_delete":
        tauri.secrets.delete(args?.account as string);
        return null;
      default:
        return null;
    }
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get(key: string) {
      return tauri.index.get(key);
    }
    async set(key: string, value: unknown) {
      tauri.index.set(key, value);
    }
    async delete(key: string) {
      return tauri.index.delete(key);
    }
    async save() {}
  },
}));

const createOpenAI = vi.hoisted(() =>
  vi.fn((options: { apiKey: string }) => (modelId: string) => ({ modelId, apiKey: options.apiKey })),
);
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));

const secretCalls = () => tauri.calls.filter((c) => c.cmd.startsWith("secrets_"));

async function launch() {
  vi.resetModules();
  tauri.calls.length = 0;
  const [keyring, lazy, agent] = await Promise.all([
    import("./keyring"),
    import("./lazyKeys"),
    import("./agent"),
  ]);
  return { keyring, lazy, agent };
}

describe("launching and opening Settings", () => {
  beforeEach(() => {
    tauri.secrets.clear();
    tauri.index.clear();
    tauri.calls.length = 0;
    createOpenAI.mockClear();
  });

  it("learns which providers have keys on the first run, then never reads the secret store at launch", async () => {
    tauri.secrets.set("openai-api-key", "sk-real-openai");
    tauri.secrets.set("groq-api-key", "gsk_real");

    const first = await launch();
    const keys = await first.keyring.getAllKeys();
    expect(keys.openai).toBe(first.lazy.storedMarker("openai-api-key"));
    expect(keys.groq).toBe(first.lazy.storedMarker("groq-api-key"));
    expect(keys.anthropic).toBeNull();
    expect(first.keyring.hasAnyKey(keys)).toBe(true);
    expect(secretCalls().length).toBeGreaterThan(0);

    const second = await launch();
    const again = await second.keyring.getAllKeys();
    expect(again.openai).toBe(second.lazy.storedMarker("openai-api-key"));
    expect(second.keyring.hasAnyKey(again)).toBe(true);
    expect(secretCalls()).toHaveLength(0);
  });

  it("does the same for custom endpoints", async () => {
    tauri.secrets.set("compat-abc-api-key", "ep-real");
    const endpoints = [
      { id: "abc", name: "A", baseURL: "https://a", modelId: "m", contextLimit: 1000 },
      { id: "def", name: "B", baseURL: "https://b", modelId: "m", contextLimit: 1000 },
    ];
    const first = await launch();
    const got = await first.keyring.getAllCustomEndpointKeys(endpoints);
    expect(got.abc).toBe(first.lazy.storedMarker("compat-abc-api-key"));
    expect(got.def).toBeNull();

    const second = await launch();
    await second.keyring.getAllCustomEndpointKeys(endpoints);
    expect(secretCalls()).toHaveLength(0);
  });

  it("shows a key as connected right after it is saved, without reading it back", async () => {
    const first = await launch();
    await first.keyring.setKey("openai", "sk-new");
    const second = await launch();
    const keys = await second.keyring.getAllKeys();
    expect(keys.openai).toBe(second.lazy.storedMarker("openai-api-key"));
    expect(secretCalls().filter((c) => c.account === "openai-api-key")).toHaveLength(0);
    const third = await launch();
    await third.keyring.getAllKeys();
    expect(secretCalls()).toHaveLength(0);
  });
});

describe("using a saved key", () => {
  beforeEach(() => {
    tauri.secrets.clear();
    tauri.index.clear();
    tauri.calls.length = 0;
    createOpenAI.mockClear();
  });

  it("reads the real key only when a model is built, and sends that, never the marker", async () => {
    tauri.secrets.set("openai-api-key", "sk-real-openai");
    await launch().then((l) => l.keyring.getAllKeys());

    const { keyring, agent } = await launch();
    const keys = await keyring.getAllKeys();
    expect(secretCalls()).toHaveLength(0);

    const model = (await agent.buildLanguageModel("openai", keys, "gpt-5.4-mini")) as unknown as { apiKey: string };
    expect(model.apiKey).toBe("sk-real-openai");
    expect(secretCalls().map((c) => c.cmd)).toEqual(["secrets_get"]);

    await agent.buildLanguageModel("openai", keys, "gpt-5.4-nano");
    expect(secretCalls()).toHaveLength(1);
  });

  it("still accepts a plain key without touching the secret store", async () => {
    const { keyring, agent } = await launch();
    const model = (await agent.buildLanguageModel(
      "openai",
      { ...keyring.EMPTY_PROVIDER_KEYS, openai: "sk-typed-just-now" },
      "gpt-5.4-mini",
    )) as unknown as { apiKey: string };
    expect(model.apiKey).toBe("sk-typed-just-now");
    expect(secretCalls()).toHaveLength(0);
  });

  it("reports a missing key if the saved one was deleted behind the app's back", async () => {
    tauri.secrets.set("openai-api-key", "sk-real-openai");
    await launch().then((l) => l.keyring.getAllKeys());
    tauri.secrets.delete("openai-api-key");

    const { keyring, agent } = await launch();
    const keys = await keyring.getAllKeys();
    await expect(agent.buildLanguageModel("openai", keys, "gpt-5.4-mini")).rejects.toThrow(
      /No API key configured for openai/,
    );
    expect(createOpenAI).not.toHaveBeenCalled();
  });

  it("still refuses a provider with no key at all", async () => {
    const { keyring, agent } = await launch();
    await expect(
      agent.buildLanguageModel("openai", { ...keyring.EMPTY_PROVIDER_KEYS }, "gpt-5.4-mini"),
    ).rejects.toThrow(/No API key configured for openai/);
  });
});

describe("a Google Vertex service account key file", () => {
  beforeEach(() => {
    tauri.secrets.clear();
    tauri.index.clear();
    tauri.calls.length = 0;
  });

  const vertexCalls = () => secretCalls().filter((c) => c.account === "google-vertex-service-account" || c.accounts?.includes("google-vertex-service-account"));

  it("is saved, listed and removed as a plain path, with no keychain access at all", async () => {
    const first = await launch();
    await first.keyring.setKey("google-vertex", "/home/me/Downloads/key.json");

    const second = await launch();
    const keys = await second.keyring.getAllKeys();
    expect(keys["google-vertex"]).toBe("/home/me/Downloads/key.json");
    expect(second.keyring.hasAnyKey(keys)).toBe(true);
    expect(await second.keyring.getKey("google-vertex")).toBe("/home/me/Downloads/key.json");

    await second.keyring.clearKey("google-vertex");
    expect((await second.keyring.getAllKeys())["google-vertex"]).toBeNull();
    expect(vertexCalls()).toHaveLength(0);
    expect([...tauri.secrets.keys()]).toEqual([]);
  });

  it("does not disturb how the other providers are listed", async () => {
    tauri.secrets.set("openai-api-key", "sk-real-openai");
    const first = await launch();
    await first.keyring.setKey("google-vertex", "/k/key.json");
    const keys = await first.keyring.getAllKeys();
    expect(keys.openai).toBe(first.lazy.storedMarker("openai-api-key"));
    expect(keys["google-vertex"]).toBe("/k/key.json");
    expect(keys.anthropic).toBeNull();
    expect(vertexCalls()).toHaveLength(0);
  });
});
