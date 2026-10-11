import { proxyFetch } from "../../lib/proxyFetch";
import {
  COPILOT_API_FALLBACK,
  COPILOT_TOKEN_URL,
  SESSION_REFRESH_SKEW_MS,
  editorHeaders,
} from "./constants";

export type CopilotSession = {
  token: string;
  apiBase: string;
  expiresAtMs: number;
};

export type CopilotAuthFailure =
  | "signed_out"
  | "no_access"
  | "rejected"
  | "failed";

export class CopilotAuthError extends Error {
  constructor(
    readonly kind: CopilotAuthFailure,
    message: string,
  ) {
    super(message);
    this.name = "CopilotAuthError";
  }
}

export type ApiDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

const FALLBACK_LIFETIME_MS = 25 * 60_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function safeApiBase(candidate: unknown): string {
  if (typeof candidate !== "string") return COPILOT_API_FALLBACK;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const trusted = host === "githubcopilot.com" || host.endsWith(".githubcopilot.com");
    if (url.protocol !== "https:" || !trusted) return COPILOT_API_FALLBACK;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return COPILOT_API_FALLBACK;
  }
}

export function parseSession(json: unknown, nowMs: number): CopilotSession {
  const o = asRecord(json);
  const token = o?.token;
  if (typeof token !== "string" || !token) {
    throw new CopilotAuthError(
      "failed",
      "GitHub did not return a Copilot token for this account.",
    );
  }
  const rawExpiry = o?.expires_at;
  const expiresAtMs =
    typeof rawExpiry === "number" && rawExpiry > 0
      ? rawExpiry > 1e12
        ? rawExpiry
        : rawExpiry * 1000
      : nowMs + FALLBACK_LIFETIME_MS;
  const endpoints = asRecord(o?.endpoints);
  return { token, apiBase: safeApiBase(endpoints?.api), expiresAtMs };
}

export async function exchangeToken(
  oauthToken: string,
  deps: ApiDeps = {},
): Promise<CopilotSession> {
  const fetchImpl = deps.fetchImpl ?? proxyFetch;
  const now = deps.now ?? Date.now;
  const res = await fetchImpl(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      ...editorHeaders(),
      Accept: "application/json",
      Authorization: `token ${oauthToken}`,
    },
  });
  if (res.status === 401) {
    throw new CopilotAuthError(
      "signed_out",
      "Your GitHub sign-in has expired. Sign in again in Settings → Models.",
    );
  }
  if (res.status === 403) {
    throw new CopilotAuthError(
      "no_access",
      "This GitHub account has no active Copilot access.",
    );
  }
  if (res.status === 404) {
    throw new CopilotAuthError(
      "rejected",
      "GitHub rejected the Copilot sign-in (token endpoint returned 404). This unofficial sign-in may have changed.",
    );
  }
  if (!res.ok) {
    throw new CopilotAuthError(
      "failed",
      `GitHub returned HTTP ${res.status} while getting a Copilot token.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new CopilotAuthError("failed", "GitHub returned an unreadable Copilot token response.");
  }
  return parseSession(json, now());
}

export function authHeaders(session: CopilotSession): Record<string, string> {
  return { ...editorHeaders(), Authorization: `Bearer ${session.token}` };
}

export type SessionManager = {
  get(): Promise<CopilotSession>;
  invalidate(): void;
};

export function createSessionManager(
  oauthToken: string,
  deps: ApiDeps = {},
): SessionManager {
  const now = deps.now ?? Date.now;
  let cached: CopilotSession | null = null;
  let inflight: Promise<CopilotSession> | null = null;
  return {
    async get() {
      if (cached && cached.expiresAtMs - now() > SESSION_REFRESH_SKEW_MS) {
        return cached;
      }
      inflight ??= exchangeToken(oauthToken, deps)
        .then((session) => {
          cached = session;
          return session;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    invalidate() {
      cached = null;
    },
  };
}

const managers = new Map<string, SessionManager>();

export function sessionFor(oauthToken: string): SessionManager {
  let manager = managers.get(oauthToken);
  if (!manager) {
    manager = createSessionManager(oauthToken);
    managers.set(oauthToken, manager);
  }
  return manager;
}

export type CopilotModel = {
  id: string;
  name: string;
  vendor: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
  preview: boolean;
};

export function parseModels(json: unknown): CopilotModel[] {
  const data = asRecord(json)?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const candidates: { model: CopilotModel; picker: boolean | null }[] = [];

  for (const item of data) {
    const o = asRecord(item);
    const id = o?.id;
    if (typeof id !== "string" || !id || seen.has(id)) continue;

    const caps = asRecord(o?.capabilities);
    if (caps && typeof caps.type === "string" && caps.type !== "chat") continue;
    const supports = asRecord(caps?.supports);
    if (supports?.tool_calls === false) continue;
    const policy = asRecord(o?.policy);
    if (typeof policy?.state === "string" && policy.state !== "enabled") continue;
    const endpoints = o?.supported_endpoints;
    if (Array.isArray(endpoints) && !endpoints.includes("/chat/completions")) continue;

    const limits = asRecord(caps?.limits);
    const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
    seen.add(id);
    candidates.push({
      picker: typeof o?.model_picker_enabled === "boolean" ? o.model_picker_enabled : null,
      model: {
        id,
        name: typeof o?.name === "string" && o.name ? o.name : id,
        vendor: typeof o?.vendor === "string" ? o.vendor : null,
        contextWindow: num(limits?.max_context_window_tokens),
        maxOutput: num(limits?.max_output_tokens),
        preview: o?.preview === true,
      },
    });
  }

  const picked = candidates.filter((c) => c.picker !== false);
  const chosen = picked.length > 0 ? picked : candidates;
  return chosen
    .map((c) => c.model)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listModels(
  oauthToken: string,
  deps: ApiDeps & { manager?: SessionManager } = {},
): Promise<CopilotModel[]> {
  const fetchImpl = deps.fetchImpl ?? proxyFetch;
  const manager = deps.manager ?? createSessionManager(oauthToken, deps);
  const session = await manager.get();
  const res = await fetchImpl(`${session.apiBase}/models`, {
    method: "GET",
    headers: { ...authHeaders(session), Accept: "application/json" },
  });
  if (res.status === 401) {
    throw new CopilotAuthError(
      "signed_out",
      "Your GitHub sign-in has expired. Sign in again in Settings → Models.",
    );
  }
  if (!res.ok) {
    throw new CopilotAuthError(
      "failed",
      `Copilot returned HTTP ${res.status} while listing models.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new CopilotAuthError("failed", "Copilot returned an unreadable model list.");
  }
  return parseModels(json);
}

const PREFERRED_DEFAULTS = ["gpt-4.1", "gpt-5-mini", "claude-haiku-4.5", "gpt-4o"];

export function pickDefaultModel(models: readonly CopilotModel[]): string | null {
  for (const id of PREFERRED_DEFAULTS) {
    if (models.some((m) => m.id === id)) return id;
  }
  return (models.find((m) => !m.preview) ?? models[0])?.id ?? null;
}
