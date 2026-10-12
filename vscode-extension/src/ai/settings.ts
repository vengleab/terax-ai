import {
  getProvider,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  MODELS,
  OLLAMA_DEFAULT_BASE_URL,
  type ProviderId,
  providerNeedsKey,
} from "../../../src/modules/ai/config";
import type { ConfigGetter } from "../settings";

/** The providers the VS Code chat can use: those that need only an API key or a server address. */
export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "xai",
  "cerebras",
  "groq",
  "deepseek",
  "mistral",
  "openrouter",
  "openai-compatible",
  "lmstudio",
  "mlx",
  "ollama",
] as const satisfies readonly ProviderId[];

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export type AiSettings = {
  provider: SupportedProvider;
  /** Empty means the provider's first model in Terax's list. */
  model: string;
  baseUrl: string;
  maxSteps: number;
  commandTimeoutSeconds: number;
};

export function isSupportedProvider(value: unknown): value is SupportedProvider {
  return typeof value === "string" && (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;

export function aiSettings(get: ConfigGetter): AiSettings {
  const provider = get<string>("terax.ai.provider", "openai");
  return {
    provider: isSupportedProvider(provider) ? provider : "openai",
    model: get<string>("terax.ai.model", "").trim(),
    baseUrl: get<string>("terax.ai.baseUrl", "").trim(),
    maxSteps: clamp(get<number>("terax.ai.maxSteps", 24), 1, 100, 24),
    commandTimeoutSeconds: clamp(get<number>("terax.ai.commandTimeoutSeconds", 60), 1, 600, 60),
  };
}

/**
 * Terax lists "Custom endpoint", "Ollama" and similar as models of the providers whose model name the
 * person supplies. Those ids stand for "your own model" and are not names a server would know.
 */
const PLACEHOLDER_MODEL = /-(custom|local)$/;

/** The models Terax knows by name for a provider. Empty for providers where you type the model's name. */
export function modelsFor(provider: ProviderId): { id: string; label: string; description: string }[] {
  return MODELS.filter((m) => m.provider === provider && !PLACEHOLDER_MODEL.test(m.id)).map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
  }));
}

/** Whether the person has to type the model's name, because Terax has no list for this provider. */
export function needsModelName(provider: ProviderId): boolean {
  return modelsFor(provider).length === 0;
}

export function defaultModelFor(provider: ProviderId): string | undefined {
  return modelsFor(provider)[0]?.id;
}

/** The model that will answer: the chosen one, else the provider's first. Empty when there is none to pick. */
export function effectiveModel(settings: AiSettings): string {
  return settings.model || defaultModelFor(settings.provider) || "";
}

export function defaultBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case "lmstudio":
      return LMSTUDIO_DEFAULT_BASE_URL;
    case "mlx":
      return MLX_DEFAULT_BASE_URL;
    case "ollama":
      return OLLAMA_DEFAULT_BASE_URL;
    default:
      return "";
  }
}

export function needsApiKey(provider: ProviderId): boolean {
  return providerNeedsKey(provider);
}

/** "OpenAI · GPT-5.4 mini", for the chat's model button. */
export function describeModel(settings: AiSettings): string {
  const provider = getProvider(settings.provider).label;
  const id = effectiveModel(settings);
  const known = MODELS.find((m) => m.provider === settings.provider && m.id === id);
  return id ? `${provider} · ${known?.label ?? id}` : `${provider} · choose a model`;
}
