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

/**
 * Which key file is in use. The file itself stays where the user keeps it and is read from there;
 * the email and project are copied here only so Settings can show them without opening the file.
 */
export type VertexAccountMeta = {
  keyFilePath: string;
  clientEmail: string;
  projectId: string;
};

const STORE_PATH = "terax-google-vertex.json";
const KEY_SETTINGS = "settings";
const KEY_ACCOUNT = "account";
const KEY_LAST_DIR = "lastDirectory";

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
  const getAccount = async (): Promise<VertexAccountMeta | null> => {
    const v = await store().get<Partial<VertexAccountMeta>>(KEY_ACCOUNT);
    if (!v || typeof v.keyFilePath !== "string" || !v.keyFilePath) return null;
    return {
      keyFilePath: v.keyFilePath,
      clientEmail: typeof v.clientEmail === "string" ? v.clientEmail : "",
      projectId: typeof v.projectId === "string" ? v.projectId : "",
    };
  };
  const setAccount = async (meta: VertexAccountMeta | null): Promise<void> => {
    const s = store();
    if (meta) await s.set(KEY_ACCOUNT, meta);
    else await s.delete(KEY_ACCOUNT);
    await s.save();
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
    getAccount,
    setAccount,
    async getLastDirectory(): Promise<string | null> {
      const v = await store().get<string>(KEY_LAST_DIR);
      return typeof v === "string" && v ? v : null;
    },
    async setLastDirectory(path: string): Promise<void> {
      const s = store();
      await s.set(KEY_LAST_DIR, path);
      await s.save();
    },
  };
}

export type VertexState = ReturnType<typeof createVertexState>;

export const vertexState = createVertexState();
