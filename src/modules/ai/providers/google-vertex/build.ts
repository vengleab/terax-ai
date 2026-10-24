import type { LanguageModel } from "ai";
import { proxyFetch } from "../../lib/proxyFetch";
import { rewriteModel } from "../requestBody";
import { GOOGLE_VERTEX_ID, GOOGLE_VERTEX_MODEL_ID } from "./data";
import { vertexBaseUrl, vertexModelName } from "./endpoint";
import { readServiceAccountFile } from "./keyFile";
import { createTokenCache, type ServiceAccount, type TokenCache } from "./serviceAccount";
import { type VertexSettings, vertexState } from "./settings";

/** The AI SDK needs a base URL up front; the real one depends on settings that can change, so it is filled in per request. */
export const PLACEHOLDER_BASE = "https://vertex.terax.invalid/v1";

export type VertexFetchDeps = {
  fetchImpl?: typeof fetch;
  tokens: TokenCache;
  /** Reads the key file. Called for every request, so a replaced or moved file is noticed straight away. */
  loadAccount: () => Promise<ServiceAccount>;
  getSettings?: () => Promise<VertexSettings>;
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

export function resolveRequest(
  sa: ServiceAccount,
  settings: VertexSettings,
  input: RequestInfo | URL,
): { url: string; model: string } {
  const original = requestUrl(input);
  if (!original.startsWith(PLACEHOLDER_BASE)) {
    throw new Error("Unexpected request URL for Google Vertex AI.");
  }
  const base = vertexBaseUrl(settings.projectOverride || sa.projectId, settings.location);
  return {
    url: `${base}${original.slice(PLACEHOLDER_BASE.length)}`,
    model: vertexModelName(settings.modelId),
  };
}

export function createVertexFetch(deps: VertexFetchDeps): typeof fetch {
  const fetchImpl = deps.fetchImpl ?? proxyFetch;
  const getSettings = deps.getSettings ?? (() => vertexState.getSettings());

  return async (input, init) => {
    const sa = await deps.loadAccount();
    const { url, model } = resolveRequest(sa, await getSettings(), input);
    const body = rewriteModel(init?.body, model);
    const send = async (): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${await deps.tokens.get(sa)}`);
      return fetchImpl(url, { ...init, headers, body });
    };
    const first = await send();
    if (first.status !== 401) return first;
    await first.body?.cancel().catch(() => {});
    deps.tokens.invalidate(sa);
    return send();
  };
}

/** `keyFilePath` is the service account JSON file the user chose in Settings. */
export async function buildGoogleVertexModel(keyFilePath: string): Promise<LanguageModel> {
  const loadAccount = () => readServiceAccountFile(keyFilePath);
  const tokens = createTokenCache();
  await tokens.get(await loadAccount());
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  return createOpenAICompatible({
    name: GOOGLE_VERTEX_ID,
    baseURL: PLACEHOLDER_BASE,
    fetch: createVertexFetch({ tokens, loadAccount }),
  })(GOOGLE_VERTEX_MODEL_ID);
}
