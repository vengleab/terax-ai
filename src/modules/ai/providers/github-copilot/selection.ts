import { LazyStore } from "@tauri-apps/plugin-store";
import type { CopilotModel } from "./copilotApi";

export type KeyValueStore = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  save(): Promise<void>;
};

const STORE_PATH = "terax-github-copilot.json";
const KEY_MODEL_ID = "modelId";
const KEY_MODELS = "models";

let defaultStore: KeyValueStore | null = null;

function lazyDefault(): KeyValueStore {
  defaultStore ??= new LazyStore(STORE_PATH, {
    defaults: {},
    autoSave: false,
  }) as unknown as KeyValueStore;
  return defaultStore;
}

export function createCopilotState(store: () => KeyValueStore = lazyDefault) {
  return {
    async getModelId(): Promise<string | null> {
      const v = await store().get<string>(KEY_MODEL_ID);
      return typeof v === "string" && v ? v : null;
    },
    async setModelId(id: string | null): Promise<void> {
      const s = store();
      if (id) await s.set(KEY_MODEL_ID, id);
      else await s.delete(KEY_MODEL_ID);
      await s.save();
    },
    async getModels(): Promise<CopilotModel[]> {
      const v = await store().get<CopilotModel[]>(KEY_MODELS);
      return Array.isArray(v) ? v : [];
    },
    async setModels(models: readonly CopilotModel[]): Promise<void> {
      const s = store();
      await s.set(KEY_MODELS, models);
      await s.save();
    },
    async clear(): Promise<void> {
      const s = store();
      await s.delete(KEY_MODEL_ID);
      await s.delete(KEY_MODELS);
      await s.save();
    },
  };
}

export const copilotState = createCopilotState();
