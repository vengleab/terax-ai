import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { parseServiceAccount, type ServiceAccount, VertexAuthError } from "./serviceAccount";

type ReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type KeyFileDeps = {
  invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads a service account key file straight from disk. The key never leaves that file. */
export async function readServiceAccountFile(path: string, deps: KeyFileDeps = {}): Promise<ServiceAccount> {
  const invoke = deps.invoke ?? tauriInvoke;
  let result: ReadResult;
  try {
    result = await invoke<ReadResult>("fs_read_file", {
      path,
      workspace: { kind: "local" },
      force: false,
    });
  } catch (error) {
    throw new VertexAuthError("invalid_key", `Could not read ${path}: ${reason(error)}`);
  }
  if (result.kind !== "text") {
    throw new VertexAuthError(
      "invalid_key",
      `${path} is not a service account key file. Choose the .json file downloaded from Google Cloud.`,
    );
  }
  return parseServiceAccount(result.content);
}
