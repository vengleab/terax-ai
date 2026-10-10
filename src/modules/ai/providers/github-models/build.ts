import type { LanguageModel } from "ai";
import { proxyFetch } from "../../lib/proxyFetch";
import { GITHUB_MODELS_BASE_URL, GITHUB_MODELS_ID } from "./data";

export async function buildGithubModelsModel(
  apiKey: string,
  modelId: string,
): Promise<LanguageModel> {
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  return createOpenAICompatible({
    name: GITHUB_MODELS_ID,
    baseURL: GITHUB_MODELS_BASE_URL,
    apiKey,
    headers: { "X-GitHub-Api-Version": "2022-11-28" },
    fetch: proxyFetch,
  })(modelId);
}
