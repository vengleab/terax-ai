import type { ExternalSecret } from "../../lib/lazyKeys";
import { type VertexState, vertexState } from "./settings";

/**
 * The Vertex "key" is not a secret held by the app: it is the path of the service account file the
 * user chose. The path goes in plain settings and the file is read from disk when a request needs it,
 * so nothing is written to or read from the OS keychain.
 */
export function createKeyFileBackend(state: Pick<VertexState, "getAccount" | "setAccount">): ExternalSecret {
  return {
    async get() {
      return (await state.getAccount())?.keyFilePath ?? null;
    },
    async set(path) {
      const current = await state.getAccount();
      if (current?.keyFilePath === path) return;
      await state.setAccount({ keyFilePath: path, clientEmail: "", projectId: "" });
    },
    async delete() {
      await state.setAccount(null);
    },
  };
}

export const vertexKeyFileBackend = createKeyFileBackend(vertexState);
