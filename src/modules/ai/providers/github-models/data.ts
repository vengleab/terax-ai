import type { ModelInfo, ProviderId, ProviderInfo } from "../../config";

export const GITHUB_MODELS_ID = "github-models" as const satisfies ProviderId;

export const GITHUB_MODELS_BASE_URL = "https://models.github.ai/inference";

export const GITHUB_MODELS_PROVIDER = {
  id: GITHUB_MODELS_ID,
  label: "GitHub Models",
  keyringAccount: "github-models-api-key",
  keyPrefix: null,
  consoleUrl: "https://github.com/settings/personal-access-tokens/new",
} as const satisfies ProviderInfo;

export const GITHUB_MODELS = [
  {
    id: "openai/gpt-4.1",
    provider: GITHUB_MODELS_ID,
    label: "GPT-4.1 (GitHub)",
    hint: "Balanced",
    description: "Strong general model for code and tool use.",
    capabilities: { intelligence: 4, speed: 4, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
  {
    id: "openai/gpt-4.1-mini",
    provider: GITHUB_MODELS_ID,
    label: "GPT-4.1 mini (GitHub)",
    hint: "Fast",
    description: "Quick and cheap with solid tool use.",
    capabilities: { intelligence: 3, speed: 4, cost: 4 },
    tags: ["vision", "tools"],
  },
  {
    id: "openai/gpt-4.1-nano",
    provider: GITHUB_MODELS_ID,
    label: "GPT-4.1 nano (GitHub)",
    hint: "Fastest",
    description: "Tiny and instant, good for autocomplete.",
    capabilities: { intelligence: 2, speed: 5, cost: 5 },
    tags: ["tools"],
  },
  {
    id: "deepseek/DeepSeek-V3-0324",
    provider: GITHUB_MODELS_ID,
    label: "DeepSeek V3 (GitHub)",
    hint: "Open",
    description: "Open-weight general model that is strong at code.",
    capabilities: { intelligence: 4, speed: 3, cost: 4 },
    tags: ["tools", "coding"],
  },
  {
    id: "meta/Llama-3.3-70B-Instruct",
    provider: GITHUB_MODELS_ID,
    label: "Llama 3.3 70B (GitHub)",
    hint: "Open",
    description: "Open-weight instruction model, broadly capable.",
    capabilities: { intelligence: 3, speed: 4, cost: 4 },
    tags: ["tools"],
  },
  {
    id: "xai/grok-3",
    provider: GITHUB_MODELS_ID,
    label: "Grok 3 (GitHub)",
    hint: "Flagship",
    description: "xAI's general model served through GitHub Models.",
    capabilities: { intelligence: 4, speed: 3, cost: 2 },
    tags: ["tools", "coding"],
  },
  {
    id: "mistral-ai/Codestral-2501",
    provider: GITHUB_MODELS_ID,
    label: "Codestral (GitHub)",
    hint: "Coding",
    description: "Mistral's code-focused model.",
    capabilities: { intelligence: 3, speed: 4, cost: 4 },
    tags: ["coding"],
  },
] as const satisfies readonly ModelInfo[];

export const GITHUB_MODELS_CONTEXT_LIMITS: Record<string, number> = {
  "openai/gpt-4.1": 128_000,
  "openai/gpt-4.1-mini": 128_000,
  "openai/gpt-4.1-nano": 128_000,
  "deepseek/DeepSeek-V3-0324": 128_000,
  "meta/Llama-3.3-70B-Instruct": 128_000,
  "xai/grok-3": 128_000,
  "mistral-ai/Codestral-2501": 256_000,
};
