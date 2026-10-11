import { proxyFetch } from "../../lib/proxyFetch";

export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

const TOKEN_LIFETIME_S = 3600;
const BACKDATE_S = 30;
const REFRESH_SKEW_MS = 60_000;

export type ServiceAccount = {
  clientEmail: string;
  privateKey: string;
  projectId: string;
  tokenUri: string;
  /** Identifies this particular key, so a replaced key file is not served an old token. */
  keyId: string;
};

export type VertexAuthFailure = "invalid_key" | "rejected" | "network" | "failed";

export class VertexAuthError extends Error {
  constructor(
    readonly kind: VertexAuthFailure,
    message: string,
  ) {
    super(message);
    this.name = "VertexAuthError";
  }
}

export function safeTokenUri(candidate: unknown): string {
  if (typeof candidate !== "string") return DEFAULT_TOKEN_URI;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const trusted = host === "googleapis.com" || host.endsWith(".googleapis.com");
    return url.protocol === "https:" && trusted ? url.toString() : DEFAULT_TOKEN_URI;
  } catch {
    return DEFAULT_TOKEN_URI;
  }
}

/** A short checksum that tells two keys apart. It is not a security measure and reveals nothing useful about the key. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Reads and checks a downloaded service account key file. Never echoes the private key in errors. */
export function parseServiceAccount(text: string): ServiceAccount {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new VertexAuthError("invalid_key", "That is not a JSON file.");
  }
  const o = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  if (o.type !== "service_account") {
    throw new VertexAuthError(
      "invalid_key",
      'This is not a service account key. It should contain "type": "service_account". Create one under IAM & Admin, Service Accounts, Keys, Add key, JSON.',
    );
  }
  const clientEmail = o.client_email;
  const privateKey = o.private_key;
  const projectId = o.project_id;
  if (typeof clientEmail !== "string" || !clientEmail.includes("@")) {
    throw new VertexAuthError("invalid_key", "The key file has no client_email.");
  }
  if (typeof privateKey !== "string" || !privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new VertexAuthError(
      "invalid_key",
      "The key file has no usable private_key (expected a PKCS#8 key that begins with BEGIN PRIVATE KEY).",
    );
  }
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new VertexAuthError("invalid_key", "The key file has no project_id.");
  }
  const keyId = `${typeof o.private_key_id === "string" ? o.private_key_id : ""}:${fingerprint(privateKey)}`;
  return {
    clientEmail,
    privateKey,
    projectId: projectId.trim(),
    tokenUri: safeTokenUri(o.token_uri),
    keyId,
  };
}

/** The small, non-secret subset worth keeping in plain settings. */
export function accountSummary(sa: ServiceAccount): { clientEmail: string; projectId: string } {
  return { clientEmail: sa.clientEmail, projectId: sa.projectId };
}

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function textBase64Url(text: string): string {
  return base64Url(new TextEncoder().encode(text));
}

export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new VertexAuthError("invalid_key", "The private_key in the key file could not be read.");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function signJwt(
  sa: ServiceAccount,
  nowSec: number,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  const iat = nowSec - BACKDATE_S;
  const header = textBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = textBase64Url(
    JSON.stringify({
      iss: sa.clientEmail,
      scope: CLOUD_PLATFORM_SCOPE,
      aud: sa.tokenUri,
      iat,
      exp: iat + TOKEN_LIFETIME_S,
    }),
  );
  const unsigned = `${header}.${claims}`;
  let key: CryptoKey;
  try {
    key = await subtle.importKey(
      "pkcs8",
      pemToDer(sa.privateKey) as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    if (error instanceof VertexAuthError) throw error;
    throw new VertexAuthError("invalid_key", "The private_key in the key file is not a valid RSA key.");
  }
  const signature = await subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(signature)}`;
}

export type AccessToken = { accessToken: string; expiresAtMs: number };

export type TokenDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  subtle?: SubtleCrypto;
};

export async function fetchAccessToken(sa: ServiceAccount, deps: TokenDeps = {}): Promise<AccessToken> {
  const fetchImpl = deps.fetchImpl ?? proxyFetch;
  const now = deps.now ?? Date.now;
  const assertion = await signJwt(sa, Math.floor(now() / 1000), deps.subtle);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  let res: Response;
  try {
    res = await fetchImpl(sa.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    });
  } catch (error) {
    throw new VertexAuthError(
      "network",
      `Could not reach Google to sign in: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // handled below
  }
  if (!res.ok) {
    const reason =
      typeof json.error_description === "string"
        ? json.error_description
        : typeof json.error === "string"
          ? json.error
          : `HTTP ${res.status}`;
    throw new VertexAuthError("rejected", `Google rejected the service account: ${reason}`);
  }
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new VertexAuthError("failed", "Google did not return an access token.");
  }
  const lifetime = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : TOKEN_LIFETIME_S;
  return { accessToken, expiresAtMs: now() + lifetime * 1000 };
}

export type TokenManager = {
  get(): Promise<string>;
  invalidate(): void;
};

export type TokenCache = {
  get(sa: ServiceAccount): Promise<string>;
  invalidate(sa: ServiceAccount): void;
};

function identity(sa: ServiceAccount): string {
  return `${sa.clientEmail}|${sa.keyId}|${sa.tokenUri}`;
}

/** Keeps one access token per service account key, renewing it shortly before it expires. */
export function createTokenCache(deps: TokenDeps = {}): TokenCache {
  const now = deps.now ?? Date.now;
  const cached = new Map<string, AccessToken>();
  const inflight = new Map<string, Promise<AccessToken>>();
  return {
    async get(sa) {
      const id = identity(sa);
      const hit = cached.get(id);
      if (hit && hit.expiresAtMs - now() > REFRESH_SKEW_MS) return hit.accessToken;
      let pending = inflight.get(id);
      if (!pending) {
        pending = fetchAccessToken(sa, deps)
          .then((token) => {
            cached.set(id, token);
            return token;
          })
          .finally(() => {
            inflight.delete(id);
          });
        inflight.set(id, pending);
      }
      return (await pending).accessToken;
    },
    invalidate(sa) {
      cached.delete(identity(sa));
    },
  };
}

export function createTokenManager(sa: ServiceAccount, deps: TokenDeps = {}): TokenManager {
  const cache = createTokenCache(deps);
  return {
    get: () => cache.get(sa),
    invalidate: () => cache.invalidate(sa),
  };
}
