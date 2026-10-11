import { KEYRING_SERVICE } from "../../config";
import { invoke, resolveSecret, storedMarker } from "../../lib/lazyKeys";
import { GOOGLE_VERTEX_ACCOUNT } from "./data";

/**
 * A service account key file is about 2.4 kB. Windows Credential Manager holds at most 1280
 * characters per entry, so the file is split across several entries. The provider's own key slot
 * holds a short pointer (`vertex-sa:v1:<parts>:<fingerprint>`), which also changes whenever the key
 * file does, so a replaced key is never served from a stale cache.
 */
export const CHUNK_SIZE = 1000;
export const POINTER_PREFIX = "vertex-sa:v1:";

export type CredentialDeps = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  resolve: (value: string) => Promise<string | null>;
};

const defaultDeps: CredentialDeps = { invoke, resolve: resolveSecret };

export function chunkAccount(index: number): string {
  return `${GOOGLE_VERTEX_ACCOUNT}.part${index}`;
}

export function splitIntoChunks(text: string, size = CHUNK_SIZE): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export async function fingerprint(text: string, subtle: SubtleCrypto = crypto.subtle): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function makePointer(parts: number, print: string): string {
  return `${POINTER_PREFIX}${parts}:${print}`;
}

export function parsePointer(pointer: string): { parts: number; print: string } | null {
  const match = /^vertex-sa:v1:(\d{1,3}):([0-9a-f]{12})$/.exec(pointer);
  if (!match) return null;
  const parts = Number(match[1]);
  return parts > 0 ? { parts, print: match[2] } : null;
}

/** Saves the key file in pieces and returns the pointer to keep in the provider's key slot. */
export async function storeAccountText(
  text: string,
  previousParts = 0,
  deps: CredentialDeps = defaultDeps,
): Promise<string> {
  const chunks = splitIntoChunks(text);
  for (const [index, chunk] of chunks.entries()) {
    await deps.invoke("secrets_set", {
      service: KEYRING_SERVICE,
      account: chunkAccount(index),
      password: chunk,
    });
  }
  for (let index = chunks.length; index < previousParts; index++) {
    await deps.invoke("secrets_delete", { service: KEYRING_SERVICE, account: chunkAccount(index) });
  }
  return makePointer(chunks.length, await fingerprint(text));
}

export async function loadAccountText(pointer: string, deps: CredentialDeps = defaultDeps): Promise<string> {
  const parsed = parsePointer(pointer);
  if (!parsed) {
    throw new Error("The saved Google service account is in an unknown format. Remove it and add it again.");
  }
  const parts: string[] = [];
  for (let index = 0; index < parsed.parts; index++) {
    const part = await deps.resolve(storedMarker(chunkAccount(index)));
    if (!part) {
      throw new Error("Part of the saved Google service account is missing from your keychain. Remove it and add it again.");
    }
    parts.push(part);
  }
  return parts.join("");
}

export async function removeAccountParts(parts: number, deps: CredentialDeps = defaultDeps): Promise<void> {
  for (let index = 0; index < parts; index++) {
    await deps
      .invoke("secrets_delete", { service: KEYRING_SERVICE, account: chunkAccount(index) })
      .catch(() => undefined);
  }
}
