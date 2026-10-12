import { describe, expect, it } from "vitest";
import { ApiKeys, type SecretStore } from "./keys";

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k),
    store: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

describe("ApiKeys", () => {
  it("keeps a key per provider in the secret store", async () => {
    const store = memoryStore();
    const keys = new ApiKeys(store);
    await keys.set("openai", "sk-one");
    await keys.set("anthropic", "sk-two");
    expect(await keys.get("openai")).toBe("sk-one");
    expect(await keys.get("anthropic")).toBe("sk-two");
    expect([...store.data.keys()].sort()).toEqual(["terax.ai.key.anthropic", "terax.ai.key.openai"]);
  });

  it("trims what was pasted", async () => {
    const keys = new ApiKeys(memoryStore());
    await keys.set("openai", "  sk-one\n");
    expect(await keys.get("openai")).toBe("sk-one");
  });

  it("refuses an empty key instead of storing it", async () => {
    const store = memoryStore();
    await expect(new ApiKeys(store).set("openai", "  ")).rejects.toThrow(/empty/);
    expect(store.data.size).toBe(0);
  });

  it("forgets a key", async () => {
    const keys = new ApiKeys(memoryStore());
    await keys.set("openai", "sk-one");
    expect(await keys.has("openai")).toBe(true);
    await keys.clear("openai");
    expect(await keys.has("openai")).toBe(false);
    expect(await keys.get("openai")).toBeUndefined();
  });
});
