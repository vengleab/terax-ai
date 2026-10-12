import type { LanguageModel } from "ai";
import type { ChatErrorHint } from "../../shared/chat";
import { getProvider } from "../../../src/modules/ai/config";
import { type AiSettings, defaultBaseUrl, effectiveModel, needsApiKey } from "./settings";

/** Something the person has to fix in their setup, with where to fix it. */
export class ChatSetupError extends Error {
  constructor(
    message: string,
    readonly hint: ChatErrorHint,
  ) {
    super(message);
    this.name = "ChatSetupError";
  }
}

const OPENAI_COMPATIBLE: Partial<Record<string, { name: string; baseURL: string; headers?: Record<string, string> }>> = {
  deepseek: { name: "deepseek", baseURL: "https://api.deepseek.com" },
  mistral: { name: "mistral", baseURL: "https://api.mistral.ai/v1" },
  openrouter: {
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    headers: { "HTTP-Referer": "https://terax.ai", "X-Title": "Terax" },
  },
};

/**
 * Builds the AI SDK model for the chosen provider. The same providers, base addresses and headers as
 * the Terax app, without its Tauri-only network proxy: the extension host can call the providers
 * directly. Each provider package is loaded only when it is used.
 */
export async function createModel(settings: AiSettings, apiKey: string | undefined): Promise<LanguageModel> {
  const provider = settings.provider;
  const label = getProvider(provider).label;
  const modelId = effectiveModel(settings);
  if (!modelId) {
    throw new ChatSetupError(`Choose a model for ${label}: run "Terax AI: Select Model".`, "select-model");
  }
  const key = apiKey?.trim() ?? "";
  if (needsApiKey(provider) && !key) {
    throw new ChatSetupError(`No API key for ${label}: run "Terax AI: Set API Key".`, "set-key");
  }

  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: key })(modelId);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey: key })(modelId);
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey: key })(modelId);
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      return createXai({ apiKey: key })(modelId);
    }
    case "cerebras": {
      const { createCerebras } = await import("@ai-sdk/cerebras");
      return createCerebras({ apiKey: key })(modelId);
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      return createGroq({ apiKey: key })(modelId);
    }
    case "deepseek":
    case "mistral":
    case "openrouter": {
      const spec = OPENAI_COMPATIBLE[provider] as { name: string; baseURL: string; headers?: Record<string, string> };
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({ ...spec, apiKey: key })(modelId);
    }
    case "openai-compatible":
    case "lmstudio":
    case "mlx":
    case "ollama": {
      const baseURL = settings.baseUrl || defaultBaseUrl(provider);
      if (!baseURL) {
        throw new ChatSetupError(`Set the server address for ${label} in the setting "terax.ai.baseUrl".`, "open-settings");
      }
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({ name: provider, baseURL, apiKey: key || undefined })(modelId);
    }
  }
}
