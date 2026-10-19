import {
  getProvider,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  MODELS,
  OLLAMA_DEFAULT_BASE_URL,
  type ProviderId,
  providerNeedsKey,
} from "../../../src/modules/ai/config";
import {
  DEFAULT_LOCATION as VERTEX_DEFAULT_LOCATION,
  DEFAULT_MODEL as VERTEX_DEFAULT_MODEL,
  MODEL_SUGGESTIONS as VERTEX_MODELS,
} from "../../../src/modules/ai/providers/google-vertex/endpoint";
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
  "google-vertex",
] as const satisfies readonly ProviderId[];

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

/**
 * The chat can also use the language models VS Code itself offers (`vscode.lm`): GitHub Copilot, and any
 * other extension that registers a model. VS Code owns the sign-in, so there is no key and no address.
 */
export const VSCODE_LM = "vscode-lm" as const;
export type AiProvider = SupportedProvider | typeof VSCODE_LM;

/** In the order they are offered: Copilot first, as most people with a subscription want it. */
export const AI_PROVIDERS: readonly AiProvider[] = [VSCODE_LM, ...SUPPORTED_PROVIDERS];

/** Google Vertex AI signs in with a service account key file, which stays where the person keeps it. */
export const GOOGLE_VERTEX = "google-vertex" as const;

export type VertexSettings = {
  /** The path of the service account .json file. Empty until one is chosen. */
  keyFile: string;
  location: string;
  /** A project to bill instead of the key file's own. */
  project: string;
};

export type AiSettings = {
  provider: AiProvider;
  /** Empty means the provider's first model in Terax's list. */
  model: string;
  baseUrl: string;
  maxSteps: number;
  commandTimeoutSeconds: number;
  vertex: VertexSettings;
};

export function isSupportedProvider(value: unknown): value is SupportedProvider {
  return typeof value === "string" && (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

export function isAiProvider(value: unknown): value is AiProvider {
  return value === VSCODE_LM || isSupportedProvider(value);
}

export function providerLabel(provider: AiProvider): string {
  return provider === VSCODE_LM ? "GitHub Copilot (and other VS Code models)" : getProvider(provider).label;
}

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;

export function aiSettings(get: ConfigGetter): AiSettings {
  const provider = get<string>("terax.ai.provider", VSCODE_LM);
  return {
    provider: isAiProvider(provider) ? provider : VSCODE_LM,
    model: get<string>("terax.ai.model", "").trim(),
    baseUrl: get<string>("terax.ai.baseUrl", "").trim(),
    maxSteps: clamp(get<number>("terax.ai.maxSteps", 24), 1, 100, 24),
    commandTimeoutSeconds: clamp(get<number>("terax.ai.commandTimeoutSeconds", 60), 1, 600, 60),
    vertex: {
      keyFile: get<string>("terax.ai.vertex.keyFile", "").trim(),
      location: get<string>("terax.ai.vertex.location", VERTEX_DEFAULT_LOCATION).trim() || VERTEX_DEFAULT_LOCATION,
      project: get<string>("terax.ai.vertex.project", "").trim(),
    },
  };
}

/**
 * Terax lists "Custom endpoint", "Ollama" and similar as models of the providers whose model name the
 * person supplies. Those ids stand for "your own model" and are not names a server would know.
 */
const PLACEHOLDER_MODEL = /-(custom|local)$/;

/** The models Terax knows by name for a provider. Empty for providers where you type the model's name. */
export function modelsFor(provider: AiProvider): { id: string; label: string; description: string }[] {
  if (provider === VSCODE_LM) return [];
  if (provider === GOOGLE_VERTEX) return VERTEX_MODELS.map((id) => ({ id, label: id, description: "Gemini on Vertex AI, billed to your Google Cloud project" }));
  return MODELS.filter((m) => m.provider === provider && !PLACEHOLDER_MODEL.test(m.id)).map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
  }));
}

/** Whether the person has to type the model's name, because Terax has no list for this provider. */
export function needsModelName(provider: AiProvider): boolean {
  return provider !== VSCODE_LM && modelsFor(provider).length === 0;
}

export function defaultModelFor(provider: AiProvider): string | undefined {
  return modelsFor(provider)[0]?.id;
}

/** The model that will answer: the chosen one, else the provider's first. Empty when there is none to pick. */
export function effectiveModel(settings: AiSettings): string {
  if (settings.provider === GOOGLE_VERTEX) return settings.model || VERTEX_DEFAULT_MODEL;
  return settings.model || defaultModelFor(settings.provider) || "";
}

/** Whether the provider signs in with a key file instead of an API key. */
export function needsKeyFile(provider: AiProvider): boolean {
  return provider === GOOGLE_VERTEX;
}

export function defaultBaseUrl(provider: AiProvider): string {
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

export function needsApiKey(provider: AiProvider): boolean {
  return provider !== VSCODE_LM && provider !== GOOGLE_VERTEX && providerNeedsKey(provider);
}

/** The VS Code model setting is "vendor/id" (as the picker saves it), or just an id. */
export function splitVsCodeModel(value: string): { vendor?: string; id: string } {
  const slash = value.indexOf("/");
  return slash > 0 ? { vendor: value.slice(0, slash), id: value.slice(slash + 1) } : { id: value };
}

/** "OpenAI · GPT-5.4 mini", for the chat's model button. */
export function describeModel(settings: AiSettings): string {
  if (settings.provider === VSCODE_LM) {
    if (!settings.model) return "GitHub Copilot · default";
    const { vendor, id } = splitVsCodeModel(settings.model);
    return !vendor || vendor === "copilot" ? `GitHub Copilot · ${id}` : `${vendor} · ${id}`;
  }
  const provider = getProvider(settings.provider).label;
  const id = effectiveModel(settings);
  const known = MODELS.find((m) => m.provider === settings.provider && m.id === id);
  return id ? `${provider} · ${known?.label ?? id}` : `${provider} · choose a model`;
}
