import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { KEYRING_SERVICE } from "../config";
import { GOOGLE_VERTEX_ACCOUNT } from "../providers/google-vertex/data";
import { vertexKeyFileBackend } from "../providers/google-vertex/fileBackend";

/**
 * Opening the app or Settings used to read every saved API key from the OS secret store, which on
 * macOS asks for Keychain permission once per key. This keeps a small index of which accounts hold
 * a key (account names only, never the keys) so those screens can show "connected" without touching
 * the secret store. The key itself is read when a request actually needs it.
 */

export const STORED_PREFIX = "\u0000terax-keychain:";
export const STORED_LABEL = "Saved in your keychain";

const KEYS_CHANGED_EVENT = "terax://ai-keys-changed";
const STORE_PATH = "terax-key-index.json";
const KEY_PROBED = "probed";
const KEY_PRESENT = "present";

export function storedMarker(account: string): string {
  return `${STORED_PREFIX}${account}`;
}

export function isStoredSecret(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(STORED_PREFIX);
}

export function accountOfMarker(value: string): string {
  return value.slice(STORED_PREFIX.length);
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export type KeyValueStore = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  save(): Promise<void>;
};

type Index = { probed: Set<string>; present: Set<string> };

class IndexUnavailable extends Error {}

/** An account whose value lives outside the OS secret store (for example a key file path in plain settings). */
export type ExternalSecret = {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
};

export type LazyKeysDeps = {
  invoke: Invoke;
  store: () => KeyValueStore;
  service: string;
  onKeysChanged?: (callback: () => void) => void;
  external?: ReadonlyMap<string, ExternalSecret>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLazyKeys(deps: LazyKeysDeps) {
  const cache = new Map<string, string>();
  let writes: Promise<unknown> = Promise.resolve();
  let listening = false;

  const watchForChanges = () => {
    if (listening) return;
    listening = true;
    deps.onKeysChanged?.(() => cache.clear());
  };

  const readIndex = async (): Promise<Index> => {
    try {
      const kv = deps.store();
      const [probed, present] = await Promise.all([
        kv.get<string[]>(KEY_PROBED),
        kv.get<string[]>(KEY_PRESENT),
      ]);
      return { probed: new Set(probed ?? []), present: new Set(present ?? []) };
    } catch (error) {
      throw new IndexUnavailable(message(error));
    }
  };

  const writeIndex = async (index: Index): Promise<void> => {
    const kv = deps.store();
    await kv.set(KEY_PROBED, [...index.probed].sort());
    await kv.set(KEY_PRESENT, [...index.present].sort());
    await kv.save();
  };

  const update = (change: (index: Index) => void): Promise<void> => {
    const next = writes
      .catch(() => undefined)
      .then(async () => {
        const index = await readIndex();
        change(index);
        await writeIndex(index);
      });
    writes = next;
    return next;
  };

  /** Learns whether accounts hold a key by reading them once. A failed read leaves the account unknown. */
  const probe = async (accounts: string[], index: Index): Promise<boolean> => {
    let changed = false;
    for (const account of accounts) {
      try {
        const value = await deps.invoke<string | null>("secrets_get", {
          service: deps.service,
          account,
        });
        index.probed.add(account);
        if (value && value.length > 0) {
          index.present.add(account);
          cache.set(account, value);
        } else {
          index.present.delete(account);
        }
        changed = true;
      } catch {
        // unreadable right now (for example permission denied): look again next time
      }
    }
    return changed;
  };

  let probing: Promise<unknown> = Promise.resolve();

  const markersFor = async (accounts: string[]): Promise<(string | null)[]> => {
    watchForChanges();
    let index = await readIndex();
    if (accounts.some((a) => !index.probed.has(a))) {
      // First-time reads run one batch at a time, so two callers asking at once do not read twice.
      const run = probing
        .catch(() => undefined)
        .then(async () => {
          const fresh = await readIndex();
          const unknown = accounts.filter((a) => !fresh.probed.has(a));
          if (unknown.length > 0 && (await probe(unknown, fresh))) {
            await writeIndex(fresh).catch(() => undefined);
          }
          return fresh;
        });
      probing = run;
      index = await run;
    }
    return accounts.map((a) => (index.present.has(a) ? storedMarker(a) : null));
  };

  const noteStored = (account: string, secret: string) => {
    cache.set(account, secret);
    return update((index) => {
      index.probed.add(account);
      index.present.add(account);
    });
  };

  const noteRemoved = (account: string) => {
    cache.delete(account);
    return update((index) => {
      index.probed.add(account);
      index.present.delete(account);
    });
  };

  /** Saved-key lookups answered from the index, with the secret store as the fallback. */
  const keychainInvoke: Invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (args?.service !== deps.service) return deps.invoke<T>(cmd, args);
    const account = args.account as string;
    try {
      switch (cmd) {
        case "secrets_get_all":
          return (await markersFor(args.accounts as string[])) as T;
        case "secrets_get":
          return (await markersFor([account]))[0] as T;
        default:
      }
    } catch (error) {
      if (!(error instanceof IndexUnavailable)) throw error;
      return deps.invoke<T>(cmd, args);
    }
    const result = await deps.invoke<T>(cmd, args);
    if (cmd === "secrets_set") {
      await noteStored(account, args.password as string).catch(() => undefined);
    } else if (cmd === "secrets_delete") {
      await noteRemoved(account).catch(() => undefined);
    }
    return result;
  };

  const external = deps.external ?? new Map<string, ExternalSecret>();

  /**
   * Drop-in for Tauri's `invoke`. Accounts registered as external are answered by their own backend
   * and never reach the secret store or the index; everything else goes through the keychain path.
   */
  const invoke: Invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (external.size === 0 || args?.service !== deps.service) return keychainInvoke<T>(cmd, args);
    const backend = typeof args.account === "string" ? external.get(args.account) : undefined;
    switch (cmd) {
      case "secrets_get":
        if (backend) return (await backend.get()) as T;
        break;
      case "secrets_set":
        if (backend) {
          await backend.set(args.password as string);
          return undefined as T;
        }
        break;
      case "secrets_delete":
        if (backend) {
          await backend.delete();
          return undefined as T;
        }
        break;
      case "secrets_get_all": {
        const accounts = args.accounts as string[];
        if (!accounts.some((a) => external.has(a))) break;
        const rest = accounts.filter((a) => !external.has(a));
        const restValues =
          rest.length > 0
            ? await keychainInvoke<(string | null)[]>(cmd, { ...args, accounts: rest })
            : [];
        const fromKeychain = new Map(rest.map((a, i) => [a, restValues[i] ?? null]));
        const values = await Promise.all(
          accounts.map((a) => {
            const own = external.get(a);
            return own ? own.get().catch(() => null) : (fromKeychain.get(a) ?? null);
          }),
        );
        return values as T;
      }
      default:
    }
    return keychainInvoke<T>(cmd, args);
  };

  /** Turns a lookup result into the real key: plain strings pass through, markers are read on demand. */
  const resolveSecret = async (value: string | null | undefined): Promise<string | null> => {
    if (!value) return null;
    if (!isStoredSecret(value)) return value;
    watchForChanges();
    const account = accountOfMarker(value);
    const cached = cache.get(account);
    if (cached !== undefined) return cached;
    let real: string | null;
    try {
      real = await deps.invoke<string | null>("secrets_get", { service: deps.service, account });
    } catch (error) {
      throw new Error(`Could not read the saved key from your keychain: ${message(error)}`);
    }
    if (real && real.length > 0) {
      cache.set(account, real);
      return real;
    }
    await noteRemoved(account).catch(() => undefined);
    return null;
  };

  return { invoke, resolveSecret, clearCache: () => cache.clear() };
}

let defaultStore: KeyValueStore | null = null;

function lazyDefaultStore(): KeyValueStore {
  defaultStore ??= new LazyStore(STORE_PATH, {
    defaults: {},
    autoSave: false,
  }) as unknown as KeyValueStore;
  return defaultStore;
}

const instance = createLazyKeys({
  invoke: tauriInvoke as Invoke,
  store: lazyDefaultStore,
  service: KEYRING_SERVICE,
  onKeysChanged: (callback) => {
    void listen(KEYS_CHANGED_EVENT, callback).catch(() => undefined);
  },
  external: new Map([[GOOGLE_VERTEX_ACCOUNT, vertexKeyFileBackend]]),
});

export const invoke = instance.invoke;
export const resolveSecret = instance.resolveSecret;
