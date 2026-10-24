import type { LanguageModel } from "ai";
import { proxyFetch } from "../../lib/proxyFetch";
import { authHeaders, sessionFor, type SessionManager } from "./copilotApi";
import { GITHUB_COPILOT_ID, GITHUB_COPILOT_MODEL_ID } from "./data";
import { copilotState } from "./selection";
import { rewriteModel } from "../requestBody";

export { rewriteModel };

export type CopilotFetchDeps = {
  fetchImpl?: typeof fetch;
  manager?: SessionManager;
  getModelId?: () => Promise<string | null>;
};

export function createCopilotFetch(
  oauthToken: string,
  deps: CopilotFetchDeps = {},
): typeof fetch {
  const fetchImpl = deps.fetchImpl ?? proxyFetch;
  const manager = deps.manager ?? sessionFor(oauthToken);
  const getModelId = deps.getModelId ?? (() => copilotState.getModelId());

  return async (input, init) => {
    const modelId = await getModelId();
    if (!modelId) {
      throw new Error(
        "GitHub Copilot: no model selected. Open Settings → Models and pick one.",
      );
    }
    const send = async (refresh: boolean): Promise<Response> => {
      if (refresh) manager.invalidate();
      const session = await manager.get();
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(authHeaders(session))) {
        headers.set(name, value);
      }
      return fetchImpl(input, {
        ...init,
        headers,
        body: rewriteModel(init?.body, modelId),
      });
    };
    const first = await send(false);
    if (first.status !== 401) return first;
    await first.body?.cancel().catch(() => {});
    return send(true);
  };
}

export async function buildGithubCopilotModel(
  oauthToken: string,
  deps: CopilotFetchDeps = {},
): Promise<LanguageModel> {
  const manager = deps.manager ?? sessionFor(oauthToken);
  const session = await manager.get();
  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  return createOpenAICompatible({
    name: GITHUB_COPILOT_ID,
    baseURL: session.apiBase,
    fetch: createCopilotFetch(oauthToken, { ...deps, manager }),
  })(GITHUB_COPILOT_MODEL_ID);
}
