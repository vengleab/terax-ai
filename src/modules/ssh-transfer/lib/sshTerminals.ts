import { create } from "zustand";

export type SshTerminal = {
  tabId: number;
  leafId: number;
  profileId: string;
  remoteCwd: string | null;
  startedAt: number;
};

type Terminals = Record<number, SshTerminal>;

type SshTerminalsState = {
  terminals: Terminals;
  register: (terminal: Omit<SshTerminal, "remoteCwd" | "startedAt"> & { startedAt?: number }) => void;
  setRemoteCwd: (leafId: number, cwd: string) => void;
  forget: (tabId: number) => void;
  prune: (liveTabIds: ReadonlySet<number>) => void;
};

/** Drops terminals whose tab is gone. Returns the same object when nothing changed. */
export function pruneTerminals(terminals: Terminals, liveTabIds: ReadonlySet<number>): Terminals {
  let changed = false;
  const next: Terminals = {};
  for (const [key, terminal] of Object.entries(terminals)) {
    if (liveTabIds.has(terminal.tabId)) next[Number(key)] = terminal;
    else changed = true;
  }
  return changed ? next : terminals;
}

export const useSshTerminals = create<SshTerminalsState>((set) => ({
  terminals: {},
  register: (terminal) =>
    set((s) => ({
      terminals: {
        ...s.terminals,
        [terminal.tabId]: {
          remoteCwd: null,
          startedAt: terminal.startedAt ?? Date.now(),
          ...terminal,
        },
      },
    })),
  setRemoteCwd: (leafId, cwd) =>
    set((s) => {
      const match = Object.values(s.terminals).find((t) => t.leafId === leafId);
      if (!match || match.remoteCwd === cwd) return s;
      return { terminals: { ...s.terminals, [match.tabId]: { ...match, remoteCwd: cwd } } };
    }),
  forget: (tabId) =>
    set((s) => {
      if (!(tabId in s.terminals)) return s;
      const { [tabId]: _gone, ...rest } = s.terminals;
      return { terminals: rest };
    }),
  prune: (liveTabIds) =>
    set((s) => {
      const next = pruneTerminals(s.terminals, liveTabIds);
      return next === s.terminals ? s : { terminals: next };
    }),
}));
