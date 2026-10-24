import { useCallback, useEffect, useRef, useState } from "react";
import { useProfilesStore } from "../store/profilesStore";
import type { EndpointRef, FileEntry } from "../types";
import { sshApi } from "./api";
import { type SshApiError, toApiError } from "./errors";

export type DirectoryState = {
  entries: FileEntry[];
  loading: boolean;
  error: SshApiError | null;
};

const EMPTY: DirectoryState = { entries: [], loading: false, error: null };

/** Lists one directory and reloads when the endpoint, path or refresh key changes. */
export function useDirectory(
  endpoint: EndpointRef,
  path: string,
  refreshKey: number,
  enabled: boolean,
): DirectoryState & { reload: () => void } {
  const [state, setState] = useState<DirectoryState>(EMPTY);
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);
  const markDisconnected = useProfilesStore((s) => s.markDisconnected);
  const profileId = endpoint.kind === "remote" ? endpoint.profileId : null;

  useEffect(() => {
    void nonce;
    void refreshKey;
    if (!enabled || !path) {
      setState(EMPTY);
      return;
    }
    const request = latest.current + 1;
    latest.current = request;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    sshApi
      .fsList(endpoint, path)
      .then((entries) => {
        if (latest.current === request) setState({ entries, loading: false, error: null });
      })
      .catch((caught) => {
        if (latest.current !== request) return;
        const error = toApiError(caught);
        if (error.code === "connect" && profileId) markDisconnected(profileId);
        setState({ entries: [], loading: false, error });
      });
  }, [endpoint, path, refreshKey, enabled, nonce, profileId, markDisconnected]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
