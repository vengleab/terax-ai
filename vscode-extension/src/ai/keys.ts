import type { ProviderId } from "../../../src/modules/ai/config";

/** The part of VS Code's SecretStorage this needs. Keys live there, never in settings or on disk. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

const name = (provider: ProviderId) => `terax.ai.key.${provider}`;

export class ApiKeys {
  constructor(private readonly secrets: SecretStore) {}

  get(provider: ProviderId): PromiseLike<string | undefined> {
    return this.secrets.get(name(provider));
  }

  async set(provider: ProviderId, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) throw new Error("The API key is empty.");
    await this.secrets.store(name(provider), trimmed);
  }

  async clear(provider: ProviderId): Promise<void> {
    await this.secrets.delete(name(provider));
  }

  async has(provider: ProviderId): Promise<boolean> {
    return !!(await this.get(provider));
  }
}
