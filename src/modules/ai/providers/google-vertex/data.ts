import type { ModelInfo, ProviderId, ProviderInfo } from "../../config";

export const GOOGLE_VERTEX_ID = "google-vertex" as const satisfies ProviderId;

export const GOOGLE_VERTEX_MODEL_ID = "google-vertex-custom" as const;

export const GOOGLE_VERTEX_ACCOUNT = "google-vertex-service-account";

export const GOOGLE_VERTEX_PROVIDER = {
  id: GOOGLE_VERTEX_ID,
  label: "Google Vertex AI",
  keyringAccount: GOOGLE_VERTEX_ACCOUNT,
  keyPrefix: null,
  consoleUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
} as const satisfies ProviderInfo;

export const GOOGLE_VERTEX_MODELS = [
  {
    id: GOOGLE_VERTEX_MODEL_ID,
    provider: GOOGLE_VERTEX_ID,
    label: "Google Vertex AI",
    hint: "Service account",
    description: "The Gemini model you pick in Settings, billed to your Google Cloud project.",
    capabilities: { intelligence: 4, speed: 3, cost: 3 },
    tags: ["vision", "tools", "coding"],
  },
] as const satisfies readonly ModelInfo[];

export const GOOGLE_VERTEX_CONTEXT_LIMITS = {
  [GOOGLE_VERTEX_MODEL_ID]: 1_000_000,
} satisfies Record<string, number>;
