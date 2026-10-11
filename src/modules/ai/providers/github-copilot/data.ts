import type { ModelInfo, ProviderId, ProviderInfo } from "../../config";

export const GITHUB_COPILOT_ID = "github-copilot" as const satisfies ProviderId;

export const GITHUB_COPILOT_MODEL_ID = "github-copilot-custom" as const;

export const GITHUB_COPILOT_PROVIDER = {
  id: GITHUB_COPILOT_ID,
  label: "GitHub Copilot",
  keyringAccount: "github-copilot-oauth-token",
  keyPrefix: null,
  consoleUrl: "https://github.com/features/copilot",
} as const satisfies ProviderInfo;

export const GITHUB_COPILOT_MODELS = [
  {
    id: GITHUB_COPILOT_MODEL_ID,
    provider: GITHUB_COPILOT_ID,
    label: "GitHub Copilot",
    hint: "Your plan",
    description: "The model you pick in Settings, from your Copilot plan.",
    capabilities: { intelligence: 4, speed: 3, cost: 3 },
    tags: ["tools", "coding"],
  },
] as const satisfies readonly ModelInfo[];

export const GITHUB_COPILOT_CONTEXT_LIMITS = {
  [GITHUB_COPILOT_MODEL_ID]: 128_000,
} satisfies Record<string, number>;
