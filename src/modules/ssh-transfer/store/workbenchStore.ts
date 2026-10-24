import { create } from "zustand";
import {
  initialPane,
  refresh,
  type PaneState,
} from "../lib/paneState";
import { DEFAULT_VIEW, type ViewOptions } from "../lib/sort";
import type { EndpointRef, PaneId } from "../types";

export type Bench = { left: PaneState; right: PaneState; active: PaneId };

type PaneInit = { endpoint: EndpointRef; path: string };

type WorkbenchState = {
  benches: Record<number, Bench>;
  ensure: (tabId: number, left: PaneInit, right: PaneInit) => void;
  update: (tabId: number, pane: PaneId, fn: (pane: PaneState) => PaneState) => void;
  setActive: (tabId: number, pane: PaneId) => void;
  refreshMatching: (endpoint: EndpointRef | null) => void;
  remove: (tabId: number) => void;
};

const SHOW_HIDDEN_KEY = "terax.sshx.showHidden";

export function readViewDefaults(): ViewOptions {
  try {
    return { ...DEFAULT_VIEW, showHidden: window.localStorage.getItem(SHOW_HIDDEN_KEY) === "1" };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function persistShowHidden(show: boolean): void {
  try {
    window.localStorage.setItem(SHOW_HIDDEN_KEY, show ? "1" : "0");
  } catch {
    // storage may be unavailable
  }
}

export function otherPane(pane: PaneId): PaneId {
  return pane === "left" ? "right" : "left";
}

function matches(pane: PaneState, endpoint: EndpointRef | null): boolean {
  if (!endpoint) return true;
  if (pane.endpoint.kind !== endpoint.kind) return false;
  return endpoint.kind === "local" || (pane.endpoint.kind === "remote" && pane.endpoint.profileId === endpoint.profileId);
}

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  benches: {},

  ensure: (tabId, left, right) =>
    set((s) => {
      if (s.benches[tabId]) return s;
      const view = readViewDefaults();
      return {
        benches: {
          ...s.benches,
          [tabId]: {
            left: initialPane(left.endpoint, left.path, view),
            right: initialPane(right.endpoint, right.path, view),
            active: "left",
          },
        },
      };
    }),

  update: (tabId, pane, fn) =>
    set((s) => {
      const bench = s.benches[tabId];
      if (!bench) return s;
      return { benches: { ...s.benches, [tabId]: { ...bench, [pane]: fn(bench[pane]) } } };
    }),

  setActive: (tabId, pane) =>
    set((s) => {
      const bench = s.benches[tabId];
      if (!bench || bench.active === pane) return s;
      return { benches: { ...s.benches, [tabId]: { ...bench, active: pane } } };
    }),

  refreshMatching: (endpoint) =>
    set((s) => {
      const benches: Record<number, Bench> = {};
      for (const [id, bench] of Object.entries(s.benches)) {
        benches[Number(id)] = {
          ...bench,
          left: matches(bench.left, endpoint) ? refresh(bench.left) : bench.left,
          right: matches(bench.right, endpoint) ? refresh(bench.right) : bench.right,
        };
      }
      return { benches };
    }),

  remove: (tabId) =>
    set((s) => {
      if (!s.benches[tabId]) return s;
      const { [tabId]: _gone, ...benches } = s.benches;
      return { benches };
    }),
}));
