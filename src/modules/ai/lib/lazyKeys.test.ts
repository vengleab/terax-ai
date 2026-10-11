import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  accountOfMarker,
  createLazyKeys,
  type ExternalSecret,
  isStoredSecret,
  type KeyValueStore,
  storedMarker,
} from "./lazyKeys";

const SERVICE = "terax-ai";

function memoryStore(data = new Map<string, unknown>()): KeyValueStore & { data: Map<string, unknown> } {
  return {
    data,
    get: async <T,>(key: string) => data.get(key) as T | undefined,
    set: async (key, value) => void data.set(key, value),
    save: async () => {},
  };
}

type Setup = ReturnType<typeof setup>;

function setup(
  secrets: Record<string, string | undefined>,
  options: { store?: KeyValueStore; denied?: Set<string>; external?: Map<string, ExternalSecret> } = {},
) {
  const calls: { cmd: string; account?: string }[] = [];
  const denied = options.denied ?? new Set<string>();
  const real = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, account: args?.account as string | undefined });
    const account = args?.account as string;
    switch (cmd) {
      case "secrets_get":
        if (denied.has(account)) throw new Error("denied");
        return secrets[account] ?? null;
      case "secrets_get_all": {
        const accounts = (args?.accounts ?? []) as string[];
        return accounts.map((a) => secrets[a] ?? null);
      }
      case "secrets_set":
        secrets[account] = args?.password as string;
        return null;
      case "secrets_delete":
        delete secrets[account];
        return null;
      default:
        return `passthrough:${cmd}`;
    }
  });
  const memory = memoryStore();
  const store = options.store ?? memory;
  const listeners: (() => void)[] = [];
  const keys = createLazyKeys({
    invoke: real as never,
    store: () => store,
    service: SERVICE,
    onKeysChanged: (callback) => listeners.push(callback),
    external: options.external,
  });
  const getAll = (accounts: string[]) =>
    keys.invoke<(string | null)[]>("secrets_get_all", { service: SERVICE, accounts });
  return { keys, real, calls, store, memory, listeners, getAll, secrets };
}

const secretReads = (s: Setup) => s.calls.filter((c) => c.cmd.startsWith("secrets_"));

describe("markers", () => {
  it("round-trips an account and is easy to recognise", () => {
    const marker = storedMarker("openai-api-key");
    expect(isStoredSecret(marker)).toBe(true);
    expect(accountOfMarker(marker)).toBe("openai-api-key");
    expect(isStoredSecret("sk-real-key")).toBe(false);
    expect(isStoredSecret(null)).toBe(false);
    expect(marker.startsWith("\u0000")).toBe(true);
  });
});

describe("the first run after the update", () => {
  it("reads each account once, one at a time, and answers with markers", async () => {
    const s = setup({ a: "key-a", c: "key-c" });
    const result = await s.getAll(["a", "b", "c"]);
    expect(result).toEqual([storedMarker("a"), null, storedMarker("c")]);
    expect(s.calls.map((c) => [c.cmd, c.account])).toEqual([
      ["secrets_get", "a"],
      ["secrets_get", "b"],
      ["secrets_get", "c"],
    ]);
  });

  it("reads each account only once when two callers ask at the same time", async () => {
    const s = setup({ a: "key-a" });
    const [one, two] = await Promise.all([s.getAll(["a", "b"]), s.getAll(["a", "b"])]);
    expect(one).toEqual([storedMarker("a"), null]);
    expect(two).toEqual(one);
    expect(secretReads(s).map((c) => c.account)).toEqual(["a", "b"]);
  });

  it("never asks the secret store again on later launches", async () => {
    const store = memoryStore();
    const first = setup({ a: "key-a" }, { store });
    await first.getAll(["a", "b"]);
    expect(secretReads(first)).toHaveLength(2);

    const second = setup({ a: "key-a" }, { store });
    const result = await second.getAll(["a", "b"]);
    expect(result).toEqual([storedMarker("a"), null]);
    expect(second.real).not.toHaveBeenCalled();
  });

  it("only probes accounts it has not seen, such as a newly added provider", async () => {
    const store = memoryStore();
    await setup({ a: "key-a" }, { store }).getAll(["a"]);
    const later = setup({ a: "key-a", b: "key-b" }, { store });
    expect(await later.getAll(["a", "b"])).toEqual([storedMarker("a"), storedMarker("b")]);
    expect(secretReads(later).map((c) => c.account)).toEqual(["b"]);
  });

  it("does not treat a denied read as a missing key", async () => {
    const store = memoryStore();
    const denied = setup({ a: "key-a" }, { store, denied: new Set(["a"]) });
    expect(await denied.getAll(["a"])).toEqual([null]);

    const allowed = setup({ a: "key-a" }, { store });
    expect(await allowed.getAll(["a"])).toEqual([storedMarker("a")]);
    expect(secretReads(allowed)).toHaveLength(1);
  });
});

describe("single lookups", () => {
  it("answers secrets_get with a marker or null and does not return the key", async () => {
    const s = setup({ a: "key-a" });
    expect(await s.keys.invoke("secrets_get", { service: SERVICE, account: "a" })).toBe(storedMarker("a"));
    expect(await s.keys.invoke("secrets_get", { service: SERVICE, account: "b" })).toBeNull();
  });
});

describe("saving and removing", () => {
  it("remembers a saved key without a later read", async () => {
    const store = memoryStore();
    const s = setup({}, { store });
    await s.keys.invoke("secrets_set", { service: SERVICE, account: "a", password: "new-key" });
    expect(s.secrets.a).toBe("new-key");

    const relaunch = setup({ a: "new-key" }, { store });
    expect(await relaunch.getAll(["a"])).toEqual([storedMarker("a")]);
    expect(relaunch.real).not.toHaveBeenCalled();
    expect(await s.keys.resolveSecret(storedMarker("a"))).toBe("new-key");
    expect(secretReads(s).filter((c) => c.cmd === "secrets_get")).toHaveLength(0);
  });

  it("forgets a removed key", async () => {
    const store = memoryStore();
    const s = setup({ a: "key-a" }, { store });
    await s.getAll(["a"]);
    await s.keys.invoke("secrets_delete", { service: SERVICE, account: "a" });
    const relaunch = setup({}, { store });
    expect(await relaunch.getAll(["a"])).toEqual([null]);
    expect(relaunch.real).not.toHaveBeenCalled();
  });

  it("still fails loudly when the real save fails", async () => {
    const s = setup({});
    s.real.mockRejectedValueOnce(new Error("keychain locked"));
    await expect(
      s.keys.invoke("secrets_set", { service: SERVICE, account: "a", password: "k" }),
    ).rejects.toThrow("keychain locked");
  });
});

describe("resolveSecret", () => {
  it("passes plain keys and empty values through without touching the store", async () => {
    const s = setup({});
    expect(await s.keys.resolveSecret("sk-live")).toBe("sk-live");
    expect(await s.keys.resolveSecret("")).toBeNull();
    expect(await s.keys.resolveSecret(null)).toBeNull();
    expect(await s.keys.resolveSecret(undefined)).toBeNull();
    expect(s.real).not.toHaveBeenCalled();
  });

  it("reads a marker from the secret store once and then remembers it", async () => {
    const store = memoryStore();
    await setup({ a: "key-a" }, { store }).getAll(["a"]);
    const s = setup({ a: "key-a" }, { store });
    expect(await s.keys.resolveSecret(storedMarker("a"))).toBe("key-a");
    expect(await s.keys.resolveSecret(storedMarker("a"))).toBe("key-a");
    expect(secretReads(s)).toHaveLength(1);
  });

  it("reads again after the keys-changed event", async () => {
    const store = memoryStore();
    await setup({ a: "old" }, { store }).getAll(["a"]);
    const s = setup({ a: "old" }, { store });
    expect(await s.keys.resolveSecret(storedMarker("a"))).toBe("old");
    s.secrets.a = "new";
    for (const listener of s.listeners) listener();
    expect(await s.keys.resolveSecret(storedMarker("a"))).toBe("new");
    expect(secretReads(s)).toHaveLength(2);
  });

  it("explains a refused read and does not cache it", async () => {
    const store = memoryStore();
    await setup({ a: "key-a" }, { store }).getAll(["a"]);
    const denied = new Set(["a"]);
    const s = setup({ a: "key-a" }, { store, denied });
    await expect(s.keys.resolveSecret(storedMarker("a"))).rejects.toThrow(
      "Could not read the saved key from your keychain: denied",
    );
    denied.clear();
    expect(await s.keys.resolveSecret(storedMarker("a"))).toBe("key-a");
  });

  it("returns null for a key that was deleted outside the app and forgets it", async () => {
    const store = memoryStore();
    await setup({ a: "key-a" }, { store }).getAll(["a"]);
    const s = setup({}, { store });
    expect(await s.keys.resolveSecret(storedMarker("a"))).toBeNull();
    expect(await s.getAll(["a"])).toEqual([null]);
  });
});

describe("everything else", () => {
  it("passes other services and commands straight through", async () => {
    const s = setup({});
    expect(await s.keys.invoke("secrets_get", { service: "terax-ssh-transfer", account: "p:password" })).toBeNull();
    expect(await s.keys.invoke("some_other_command", { x: 1 })).toBe("passthrough:some_other_command");
    expect(s.memory.data.size).toBe(0);
  });

  it("falls back to the real secret store if the index cannot be read", async () => {
    const broken: KeyValueStore = {
      get: async () => {
        throw new Error("store unavailable");
      },
      set: async () => {},
      save: async () => {},
    };
    const s = setup({ a: "key-a" }, { store: broken });
    expect(await s.getAll(["a", "b"])).toEqual(["key-a", null]);
    expect(await s.keys.invoke("secrets_get", { service: SERVICE, account: "a" })).toBe("key-a");
  });

  it("uses the same event name as the settings store", () => {
    const store = readFileSync(join(process.cwd(), "src/modules/settings/store.ts"), "utf8");
    const mine = readFileSync(join(process.cwd(), "src/modules/ai/lib/lazyKeys.ts"), "utf8");
    const name = /KEYS_CHANGED_EVENT = "([^"]+)"/.exec(store)?.[1];
    expect(name).toBeTruthy();
    expect(mine).toContain(`"${name}"`);
  });
});

describe("external accounts", () => {
  function fileBacked(initial: string | null = null) {
    const state = { value: initial, reads: 0 };
    const backend: ExternalSecret = {
      get: async () => {
        state.reads++;
        return state.value;
      },
      set: async (v) => {
        state.value = v;
      },
      delete: async () => {
        state.value = null;
      },
    };
    return { state, backend };
  }
  const EXTERNAL = "vertex-account";

  it("answers a single lookup with the value itself, never touching the secret store or the index", async () => {
    const { backend } = fileBacked("/k/key.json");
    const s = setup({}, { external: new Map([[EXTERNAL, backend]]) });
    expect(await s.keys.invoke("secrets_get", { service: SERVICE, account: EXTERNAL })).toBe("/k/key.json");
    expect(s.real).not.toHaveBeenCalled();
    expect(s.memory.data.size).toBe(0);
  });

  it("keeps the order in a mixed batch and only sends the other accounts to the keychain path", async () => {
    const { backend } = fileBacked("/k/key.json");
    const s = setup({ a: "key-a", c: "key-c" }, { external: new Map([[EXTERNAL, backend]]) });
    const result = await s.getAll(["a", EXTERNAL, "b", "c"]);
    expect(result).toEqual([storedMarker("a"), "/k/key.json", null, storedMarker("c")]);
    expect(secretReads(s).map((c) => c.account)).toEqual(["a", "b", "c"]);
  });

  it("answers an all-external batch without any secret store call, and null when nothing is chosen", async () => {
    const { backend } = fileBacked(null);
    const s = setup({}, { external: new Map([[EXTERNAL, backend]]) });
    expect(await s.getAll([EXTERNAL])).toEqual([null]);
    expect(s.real).not.toHaveBeenCalled();
  });

  it("treats a failing backend as no value instead of failing the whole batch", async () => {
    const broken: ExternalSecret = {
      get: async () => {
        throw new Error("settings unavailable");
      },
      set: async () => {},
      delete: async () => {},
    };
    const s = setup({ a: "key-a" }, { external: new Map([[EXTERNAL, broken]]) });
    expect(await s.getAll(["a", EXTERNAL])).toEqual([storedMarker("a"), null]);
  });

  it("saves and removes through the backend, not the secret store, and leaves the index alone", async () => {
    const { backend, state } = fileBacked();
    const s = setup({}, { external: new Map([[EXTERNAL, backend]]) });
    await s.keys.invoke("secrets_set", { service: SERVICE, account: EXTERNAL, password: "/k/key.json" });
    expect(state.value).toBe("/k/key.json");
    await s.keys.invoke("secrets_delete", { service: SERVICE, account: EXTERNAL });
    expect(state.value).toBeNull();
    expect(s.real).not.toHaveBeenCalled();
    expect(s.memory.data.size).toBe(0);
  });

  it("lets a failing save through to the caller", async () => {
    const failing: ExternalSecret = {
      get: async () => null,
      set: async () => {
        throw new Error("disk full");
      },
      delete: async () => {},
    };
    const s = setup({}, { external: new Map([[EXTERNAL, failing]]) });
    await expect(
      s.keys.invoke("secrets_set", { service: SERVICE, account: EXTERNAL, password: "/k/key.json" }),
    ).rejects.toThrow("disk full");
  });

  it("returns the path as a plain value, so resolveSecret passes it straight through", async () => {
    const { backend } = fileBacked("/k/key.json");
    const s = setup({}, { external: new Map([[EXTERNAL, backend]]) });
    const [value] = await s.getAll([EXTERNAL]);
    expect(isStoredSecret(value)).toBe(false);
    expect(await s.keys.resolveSecret(value)).toBe("/k/key.json");
    expect(s.real).not.toHaveBeenCalled();
  });

  it("treats other accounts and other services exactly as before", async () => {
    const { backend, state } = fileBacked("/k/key.json");
    const s = setup({ a: "key-a" }, { external: new Map([[EXTERNAL, backend]]) });
    expect(await s.keys.invoke("secrets_get", { service: SERVICE, account: "a" })).toBe(storedMarker("a"));
    expect(await s.keys.invoke("secrets_get", { service: "terax-ssh-transfer", account: EXTERNAL })).toBeNull();
    expect(state.reads).toBe(0);
  });
});
