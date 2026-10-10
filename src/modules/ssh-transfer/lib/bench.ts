import { toast } from "sonner";
import { useProfilesStore } from "../store/profilesStore";
import { useWorkbenchStore } from "../store/workbenchStore";
import type { EndpointRef } from "../types";
import { sshApi } from "./api";
import { errorMessage, isCancelled } from "./errors";
import { normalizeLocal } from "./pathOps";

async function localStart(profileId?: string): Promise<string> {
  const profile = profileId
    ? useProfilesStore.getState().profiles.find((p) => p.id === profileId)
    : undefined;
  if (profile?.defaultLocalDir) {
    try {
      return normalizeLocal(await sshApi.fsCanonicalize({ kind: "local" }, profile.defaultLocalDir));
    } catch {
      // fall back to home
    }
  }
  return normalizeLocal(await sshApi.fsHome({ kind: "local" }));
}

/** Connects (asking for anything the server needs) and returns the endpoint with its starting folder. */
export async function remoteStart(profileId: string): Promise<{ endpoint: EndpointRef; path: string } | null> {
  const store = useProfilesStore.getState();
  try {
    const info = store.connections[profileId] ?? (await store.connect(profileId));
    return { endpoint: { kind: "remote", profileId }, path: info.home };
  } catch (error) {
    if (!isCancelled(error)) toast.error(errorMessage(error));
    return null;
  }
}

/** Prepares the two panes of a tab. The left pane is local, the right pane is the given server when it connects. */
export async function initBench(tabId: number, rightProfileId?: string): Promise<void> {
  const home = await localStart(rightProfileId);
  const local: { endpoint: EndpointRef; path: string } = { endpoint: { kind: "local" }, path: home };
  const remote = rightProfileId ? await remoteStart(rightProfileId) : null;
  useWorkbenchStore.getState().ensure(tabId, local, remote ?? local);
}

/** Points one pane of an existing tab at a server, connecting first. */
export async function openServerInPane(tabId: number, pane: "left" | "right", profileId: string): Promise<void> {
  const target = await remoteStart(profileId);
  if (!target) return;
  useWorkbenchStore.getState().update(tabId, pane, (p) => ({
    ...p,
    endpoint: target.endpoint,
    path: target.path,
    selection: [],
    anchor: null,
    cursor: null,
    back: [],
    forward: [],
    refreshKey: p.refreshKey + 1,
  }));
}

export async function openLocalInPane(tabId: number, pane: "left" | "right"): Promise<void> {
  const path = await localStart();
  useWorkbenchStore.getState().update(tabId, pane, (p) => ({
    ...p,
    endpoint: { kind: "local" },
    path,
    selection: [],
    anchor: null,
    cursor: null,
    back: [],
    forward: [],
    refreshKey: p.refreshKey + 1,
  }));
}
