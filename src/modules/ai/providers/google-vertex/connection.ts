import { proxyFetch } from "../../lib/proxyFetch";
import { vertexBaseUrl, vertexModelName } from "./endpoint";
import { createTokenManager, type ServiceAccount, type TokenManager } from "./serviceAccount";
import type { VertexSettings } from "./settings";

export type ConnectionResult = { ok: true; detail: string } | { ok: false; message: string };

function brief(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

function googleError(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    const error = (first as { error?: { message?: unknown } } | undefined)?.error;
    if (typeof error?.message === "string") return error.message;
  } catch {
    // not JSON
  }
  return brief(text);
}

/** Signs in and asks the chosen model a one-word question, so a wrong project, location or model shows up in Settings. */
export async function testConnection(
  sa: ServiceAccount,
  settings: VertexSettings,
  deps: { fetchImpl?: typeof fetch; tokens?: TokenManager } = {},
): Promise<ConnectionResult> {
  const fetchImpl = deps.fetchImpl ?? proxyFetch;
  const tokens = deps.tokens ?? createTokenManager(sa);
  try {
    const project = settings.projectOverride || sa.projectId;
    const url = `${vertexBaseUrl(project, settings.location)}/chat/completions`;
    const model = vertexModelName(settings.modelId);
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await tokens.get()}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
        max_tokens: 16,
      }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}: ${googleError(text)}` };
    return { ok: true, detail: `${model} answered from ${project} (${settings.location}).` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
