import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LanguageModel } from "ai";
import { createVertexFetch, PLACEHOLDER_BASE } from "../../../src/modules/ai/providers/google-vertex/build";
import { GOOGLE_VERTEX_ID, GOOGLE_VERTEX_MODEL_ID } from "../../../src/modules/ai/providers/google-vertex/data";
import { isValidLocation, isValidProject } from "../../../src/modules/ai/providers/google-vertex/endpoint";
import {
  createTokenCache,
  parseServiceAccount,
  type ServiceAccount,
  type TokenCache,
  VertexAuthError,
} from "../../../src/modules/ai/providers/google-vertex/serviceAccount";
import { ChatSetupError } from "./model";
import { type AiSettings, effectiveModel } from "./settings";

/**
 * Google Vertex AI with a service account, using the same sign-in, address rules and request rewriting as the
 * Terax app (`src/modules/ai/providers/google-vertex`). The key file is read from where the person keeps it
 * on every request, never copied, stored or shown; only its path is a setting.
 */

const MAX_KEY_FILE_BYTES = 64 * 1024;

/** Settings may name the file with `~`. */
export function expandHome(file: string, home = os.homedir()): string {
  if (file === "~") return home;
  return file.startsWith("~/") || file.startsWith("~\\") ? path.join(home, file.slice(2)) : file;
}

/** Reads and checks a key file. Errors name the file, never its content. */
export async function readKeyFile(file: string): Promise<ServiceAccount> {
  const resolved = expandHome(file.trim());
  let text: string;
  try {
    const info = await fs.stat(resolved);
    if (!info.isFile()) throw new Error("it is not a file");
    if (info.size > MAX_KEY_FILE_BYTES) throw new VertexAuthError("invalid_key", `${resolved} is too large to be a service account key file.`);
    text = await fs.readFile(resolved, "utf8");
  } catch (error) {
    if (error instanceof VertexAuthError) throw error;
    throw new VertexAuthError("invalid_key", `Could not read ${resolved}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseServiceAccount(text);
}

/** A sign-in problem, in the chat's terms: the person is pointed to the key file when it is the key file's fault. */
export function asSetupError(error: unknown): unknown {
  if (!(error instanceof VertexAuthError)) return error;
  const keyFault = error.kind === "invalid_key" || error.kind === "rejected";
  return new ChatSetupError(error.message, keyFault ? "choose-key-file" : undefined);
}

export type VertexDeps = {
  /** For tests: the network. */
  fetchImpl?: typeof fetch;
  /** For tests: how long a token is kept. */
  tokens?: TokenCache;
};

// One cache for the whole window, so a conversation signs in once an hour and not once a message.
let shared: TokenCache | undefined;
const sharedTokens = () => (shared ??= createTokenCache({ fetchImpl: (input, init) => fetch(input, init) }));

export async function createVertexModel(settings: AiSettings, deps: VertexDeps = {}): Promise<LanguageModel> {
  const vertex = settings.vertex;
  if (!vertex?.keyFile) {
    throw new ChatSetupError('Choose the Google service account key file: run "Terax: Choose Google Service Account Key File".', "choose-key-file");
  }
  if (!isValidLocation(vertex.location)) {
    throw new ChatSetupError(`"${vertex.location}" is not a valid Google Cloud location. Set terax.ai.vertex.location to global or a region such as us-central1.`, "open-settings");
  }
  if (vertex.project && !isValidProject(vertex.project)) {
    throw new ChatSetupError(`"${vertex.project}" is not a valid Google Cloud project id (setting terax.ai.vertex.project).`, "open-settings");
  }

  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const tokens = deps.tokens ?? (deps.fetchImpl ? createTokenCache({ fetchImpl: deps.fetchImpl }) : sharedTokens());
  const loadAccount = () => readKeyFile(vertex.keyFile);

  // Sign in now, so a missing, wrong or rejected key is reported before anything is sent.
  try {
    await tokens.get(await loadAccount());
  } catch (error) {
    throw asSetupError(error);
  }

  const inner = createVertexFetch({
    fetchImpl,
    tokens,
    loadAccount,
    getSettings: async () => ({ location: vertex.location, modelId: effectiveModel(settings), projectOverride: vertex.project }),
  });
  // The key file is read for every request, so a problem that appears later is reported the same way.
  const guarded: typeof fetch = async (input, init) => {
    try {
      return await inner(input, init);
    } catch (error) {
      throw asSetupError(error);
    }
  };

  const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
  return createOpenAICompatible({ name: GOOGLE_VERTEX_ID, baseURL: PLACEHOLDER_BASE, fetch: guarded })(GOOGLE_VERTEX_MODEL_ID);
}
