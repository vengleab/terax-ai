import { describe, expect, it, vi } from "vitest";
import { createKeyFileBackend } from "./fileBackend";
import { createVertexState, type KeyValueStore } from "./settings";

vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {} }));

function memory(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => data.get(k) as T | undefined,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => data.delete(k),
    save: async () => {},
  };
}

describe("key file backend", () => {
  it("answers with the chosen path, or nothing", async () => {
    const store = memory();
    const state = createVertexState(() => store);
    const backend = createKeyFileBackend(state);
    expect(await backend.get()).toBeNull();
    await state.setAccount({ keyFilePath: "/k/key.json", clientEmail: "a@b", projectId: "p" });
    expect(await backend.get()).toBe("/k/key.json");
  });

  it("keeps the email and project when the same path is saved again", async () => {
    const store = memory();
    const state = createVertexState(() => store);
    const backend = createKeyFileBackend(state);
    await state.setAccount({ keyFilePath: "/k/key.json", clientEmail: "a@b", projectId: "p" });
    await backend.set("/k/key.json");
    expect(await state.getAccount()).toEqual({ keyFilePath: "/k/key.json", clientEmail: "a@b", projectId: "p" });
  });

  it("stores a path that has no details yet, and forgets it on delete", async () => {
    const store = memory();
    const state = createVertexState(() => store);
    const backend = createKeyFileBackend(state);
    await backend.set("/other/key.json");
    expect(await state.getAccount()).toEqual({ keyFilePath: "/other/key.json", clientEmail: "", projectId: "" });
    await backend.delete();
    expect(await backend.get()).toBeNull();
  });
});
