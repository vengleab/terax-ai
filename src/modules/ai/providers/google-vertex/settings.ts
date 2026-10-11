import { LazyStore } from "@tauri-apps/plugin-store";
import { DEFAULT_LOCATION, DEFAULT_MODEL } from "./endpoint";

export type KeyValueStore = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  save(): Promise<void>;
};

export type VertexSettings = {
  location: string;
  modelId: string;
  projectOverride: string;
};

/** Non-secret facts about the saved key, kept so Settings can show them without reading the keychain. */
export type VertexAccountMeta = {
  clientEmail: string;
  projectId: string;
  parts: number;
};

const STORE_PATH = "terax-google-vertex.json";
const KEY_SETTINGS = "settings";
const KEY_ACCOUNT = "account";

export const DEFAULT_SETTINGS: VertexSettings = {
  location: DEFAULT_LOCATION,
  modelId: DEFAULT_MODEL,
  projectOverride: "",
};

let defaultStore: KeyValueStore | null = null;

function lazyDefault(): KeyValueStore {
  defaultStore ??= new LazyStore(STORE_PATH, {
    defaults: {},
    autoSave: false,
  }) as unknown as KeyValueStore;
  return defaultStore;
}

export function createVertexState(store: () => KeyValueStore = lazyDefault) {
  const getSettings = async (): Promise<VertexSettings> => {
    const saved = await store().get<Partial<VertexSettings>>(KEY_SETTINGS);
    return {
      location: saved?.location?.trim() || DEFAULT_SETTINGS.location,
      modelId: saved?.modelId?.trim() || DEFAULT_SETTINGS.modelId,
      projectOverride: saved?.projectOverride?.trim() ?? "",
    };
  };
  return {
    getSettings,
    async setSettings(patch: Partial<VertexSettings>): Promise<VertexSettings> {
      const next = { ...(await getSettings()), ...patch };
      const s = store();
      await s.set(KEY_SETTINGS, next);
      await s.save();
      return next;
    },
    async getAccount(): Promise<VertexAccountMeta | null> {
      const v = await store().get<VertexAccountMeta>(KEY_ACCOUNT);
      return v && typeof v.clientEmail === "string" && typeof v.parts === "number" ? v : null;
    },
    async setAccount(meta: VertexAccountMeta | null): Promise<void> {
      const s = store();
      if (meta) await s.set(KEY_ACCOUNT, meta);
      else await s.delete(KEY_ACCOUNT);
      await s.save();
    },
  };
}

export const vertexState = createVertexState();
