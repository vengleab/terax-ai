import { describe, expect, it, vi } from "vitest";
import {
  CopilotAuthError,
  createSessionManager,
  exchangeToken,
  listModels,
  parseModels,
  parseSession,
  pickDefaultModel,
  safeApiBase,
  type CopilotModel,
} from "./copilotApi";

const NOW = 1_800_000_000_000;

const res = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const sessionBody = (overrides: Record<string, unknown> = {}) => ({
  token: "tid=abc;exp=1",
  expires_at: Math.floor(NOW / 1000) + 1800,
  endpoints: { api: "https://api.individual.githubcopilot.com" },
  ...overrides,
});

describe("safeApiBase", () => {
  it("accepts only https githubcopilot.com hosts", () => {
    expect(safeApiBase("https://api.individual.githubcopilot.com/")).toBe(
      "https://api.individual.githubcopilot.com",
    );
    expect(safeApiBase("https://api.githubcopilot.com")).toBe("https://api.githubcopilot.com");
    for (const bad of [
      "http://api.githubcopilot.com",
      "https://evil.example.com",
      "https://githubcopilot.com.evil.example.com",
      "https://notgithubcopilot.com",
      "not a url",
      undefined,
      42,
    ]) {
      expect(safeApiBase(bad)).toBe("https://api.githubcopilot.com");
    }
  });
});

describe("parseSession", () => {
  it("reads token, api base and expiry in seconds", () => {
    expect(parseSession(sessionBody(), NOW)).toEqual({
      token: "tid=abc;exp=1",
      apiBase: "https://api.individual.githubcopilot.com",
      expiresAtMs: NOW + 1_800_000,
    });
  });

  it("copes with a millisecond expiry or a missing one", () => {
    expect(parseSession(sessionBody({ expires_at: NOW + 5 }), NOW).expiresAtMs).toBe(NOW + 5);
    expect(parseSession(sessionBody({ expires_at: undefined }), NOW).expiresAtMs).toBeGreaterThan(NOW);
  });

  it("requires a token", () => {
    expect(() => parseSession({}, NOW)).toThrow(CopilotAuthError);
  });
});

describe("exchangeToken", () => {
  it("sends the sign-in token with editor headers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(sessionBody()));
    const session = await exchangeToken("gho_abc", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(session.token).toBe("tid=abc;exp=1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/copilot_internal/v2/token");
    expect(init.headers.Authorization).toBe("token gho_abc");
    expect(init.headers["Editor-Version"]).toMatch(/^vscode\//);
    expect(init.headers["Copilot-Integration-Id"]).toBe("vscode-chat");
  });

  it.each([
    [401, "signed_out"],
    [403, "no_access"],
    [404, "rejected"],
    [500, "failed"],
  ] as const)("explains HTTP %i", async (status, kind) => {
    const fetchImpl = vi.fn().mockResolvedValue(res("x", status));
    await expect(
      exchangeToken("t", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "CopilotAuthError", kind });
  });
});

describe("createSessionManager", () => {
  it("caches until shortly before expiry, then refreshes", async () => {
    let clock = NOW;
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => res(sessionBody({ expires_at: Math.floor(clock / 1000) + 600 })));
    const manager = createSessionManager("t", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });
    await manager.get();
    await manager.get();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 9 * 60_000 + 30_000;
    await manager.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one exchange between concurrent callers and can be invalidated", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => res(sessionBody()));
    const manager = createSessionManager("t", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    await Promise.all([manager.get(), manager.get(), manager.get()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    manager.invalidate();
    await manager.get();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

const entry = (over: Record<string, unknown> = {}) => ({
  id: "gpt-4.1",
  name: "GPT-4.1",
  vendor: "Azure OpenAI",
  model_picker_enabled: true,
  preview: false,
  capabilities: {
    type: "chat",
    supports: { tool_calls: true },
    limits: { max_context_window_tokens: 128000, max_output_tokens: 16384 },
  },
  ...over,
});

describe("parseModels", () => {
  it("keeps chat models that can call tools and sorts them by name", () => {
    const models = parseModels({
      data: [
        entry({ id: "z", name: "Zeta" }),
        entry({ id: "a", name: "Alpha" }),
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["a", "z"]);
    expect(models[0]).toEqual({
      id: "a",
      name: "Alpha",
      vendor: "Azure OpenAI",
      contextWindow: 128000,
      maxOutput: 16384,
      preview: false,
    });
  });

  it("drops embeddings, tool-less, disabled, hidden and non chat-completions models", () => {
    const models = parseModels({
      data: [
        entry({ id: "ok" }),
        entry({ id: "emb", capabilities: { type: "embeddings" } }),
        entry({ id: "notools", capabilities: { type: "chat", supports: { tool_calls: false } } }),
        entry({ id: "off", policy: { state: "disabled" } }),
        entry({ id: "hidden", model_picker_enabled: false }),
        entry({ id: "resp", supported_endpoints: ["/responses"] }),
        entry({ id: "both", supported_endpoints: ["/chat/completions", "/responses"] }),
        entry({ id: "ok" }),
      ],
    });
    expect(models.map((m) => m.id).sort()).toEqual(["both", "ok"]);
  });

  it("ignores the picker flag when it would hide everything", () => {
    const models = parseModels({
      data: [entry({ id: "a", model_picker_enabled: false }), entry({ id: "b", model_picker_enabled: false })],
    });
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list for junk", () => {
    expect(parseModels(null)).toEqual([]);
    expect(parseModels({ data: "x" })).toEqual([]);
    expect(parseModels({ data: [1, "x", {}] })).toEqual([]);
  });
});

describe("pickDefaultModel", () => {
  const m = (id: string, preview = false): CopilotModel => ({
    id,
    name: id,
    vendor: null,
    contextWindow: null,
    maxOutput: null,
    preview,
  });

  it("prefers a known cheap default, then the first stable model", () => {
    expect(pickDefaultModel([m("x"), m("gpt-4.1"), m("gpt-5-mini")])).toBe("gpt-4.1");
    expect(pickDefaultModel([m("p", true), m("stable")])).toBe("stable");
    expect(pickDefaultModel([m("only", true)])).toBe("only");
    expect(pickDefaultModel([])).toBeNull();
  });
});

describe("listModels", () => {
  it("asks the account's own API host with the Copilot token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(sessionBody()))
      .mockResolvedValueOnce(res({ data: [entry()] }));
    const models = await listModels("gho_abc", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-4.1"]);
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe("https://api.individual.githubcopilot.com/models");
    expect(init.headers.Authorization).toBe("Bearer tid=abc;exp=1");
  });

  it("reports an expired sign-in", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(sessionBody()))
      .mockResolvedValueOnce(res("no", 401));
    await expect(
      listModels("t", { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW }),
    ).rejects.toMatchObject({ kind: "signed_out" });
  });
});
