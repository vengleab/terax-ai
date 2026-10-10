import { toast } from "sonner";
import { create } from "zustand";
import { sshApi } from "../lib/api";
import { connectProfile } from "../lib/connect";
import { errorMessage, isCancelled } from "../lib/errors";
import { clearProfileSecrets } from "../lib/secrets";
import type { ConfigImport, ConnectionInfo, SshProfile } from "../types";

type SaveInput = Parameters<typeof sshApi.profileSave>[0];

type ProfilesState = {
  profiles: SshProfile[];
  loaded: boolean;
  loadError: string | null;
  connections: Record<string, ConnectionInfo>;
  connecting: Record<string, boolean>;
  load: () => Promise<void>;
  save: (profile: SaveInput) => Promise<SshProfile>;
  remove: (id: string) => Promise<void>;
  importFromSshConfig: () => Promise<ConfigImport>;
  connect: (id: string) => Promise<ConnectionInfo>;
  disconnect: (id: string) => Promise<void>;
  markDisconnected: (id: string) => void;
  refreshConnections: () => Promise<void>;
};

const inFlight = new Map<string, Promise<ConnectionInfo>>();

export const useProfilesStore = create<ProfilesState>((set, get) => ({
  profiles: [],
  loaded: false,
  loadError: null,
  connections: {},
  connecting: {},

  load: async () => {
    try {
      const [profiles, connections] = await Promise.all([
        sshApi.profilesList(),
        sshApi.connections(),
      ]);
      set({
        profiles,
        loaded: true,
        loadError: null,
        connections: Object.fromEntries(connections.map((c) => [c.profileId, c])),
      });
    } catch (error) {
      set({ loaded: true, loadError: errorMessage(error) });
    }
  },

  save: async (input) => {
    const saved = await sshApi.profileSave(input);
    set((s) => {
      const exists = s.profiles.some((p) => p.id === saved.id);
      return {
        profiles: exists
          ? s.profiles.map((p) => (p.id === saved.id ? saved : p))
          : [...s.profiles, saved],
      };
    });
    return saved;
  },

  remove: async (id) => {
    await sshApi.profileRemove(id);
    await clearProfileSecrets(id);
    set((s) => {
      const { [id]: _gone, ...connections } = s.connections;
      return {
        profiles: s.profiles
          .filter((p) => p.id !== id)
          .map((p) => (p.jumpHost === id ? { ...p, jumpHost: null } : p)),
        connections,
      };
    });
  },

  importFromSshConfig: async () => {
    const result = await sshApi.importSshConfig();
    await get().load();
    return result;
  },

  connect: (id) => {
    const existing = inFlight.get(id);
    if (existing) return existing;
    const target = get().profiles.find((p) => p.id === id);
    if (!target) return Promise.reject(new Error("Unknown server"));
    const jump = target.jumpHost
      ? (get().profiles.find((p) => p.id === target.jumpHost) ?? null)
      : null;
    set((s) => ({ connecting: { ...s.connecting, [id]: true } }));
    const work = connectProfile(target, jump)
      .then(async (info) => {
        set((s) => ({ connections: { ...s.connections, [id]: info } }));
        void sshApi
          .forwardsAutostart(id)
          .then((failures) => {
            for (const failure of failures) {
              toast.error(`Tunnel "${failure.name}" did not start`, {
                description: failure.error.message,
              });
            }
          })
          .catch(() => undefined);
        return info;
      })
      .finally(() => {
        inFlight.delete(id);
        set((s) => {
          const { [id]: _done, ...connecting } = s.connecting;
          return { connecting };
        });
      });
    inFlight.set(id, work);
    return work;
  },

  disconnect: async (id) => {
    try {
      await sshApi.disconnect(id);
    } catch (error) {
      if (!isCancelled(error)) toast.error(errorMessage(error));
    }
    get().markDisconnected(id);
  },

  markDisconnected: (id) =>
    set((s) => {
      const { [id]: _gone, ...connections } = s.connections;
      return { connections };
    }),

  refreshConnections: async () => {
    try {
      const connections = await sshApi.connections();
      set({ connections: Object.fromEntries(connections.map((c) => [c.profileId, c])) });
    } catch {
      // the next explicit action reports the problem
    }
  },
}));

export function profileById(id: string): SshProfile | undefined {
  return useProfilesStore.getState().profiles.find((p) => p.id === id);
}
