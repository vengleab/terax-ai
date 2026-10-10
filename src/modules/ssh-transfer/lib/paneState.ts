import type { EndpointRef } from "../types";
import { DEFAULT_VIEW, type ViewOptions } from "./sort";

export type PaneState = {
  endpoint: EndpointRef;
  path: string;
  selection: string[];
  anchor: string | null;
  cursor: string | null;
  view: ViewOptions;
  back: string[];
  forward: string[];
  refreshKey: number;
};

const MAX_HISTORY = 50;

export function initialPane(endpoint: EndpointRef, path: string, view: ViewOptions = DEFAULT_VIEW): PaneState {
  return {
    endpoint,
    path,
    selection: [],
    anchor: null,
    cursor: null,
    view,
    back: [],
    forward: [],
    refreshKey: 0,
  };
}

export function sameEndpoint(a: EndpointRef, b: EndpointRef): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "local" || (b.kind === "remote" && a.profileId === b.profileId);
}

function cleared(pane: PaneState): PaneState {
  return {
    ...pane,
    selection: [],
    anchor: null,
    cursor: null,
    view: { ...pane.view, filter: "" },
  };
}

export function navigate(pane: PaneState, path: string): PaneState {
  if (path === pane.path) return { ...pane, refreshKey: pane.refreshKey + 1 };
  const back = pane.path ? [...pane.back, pane.path].slice(-MAX_HISTORY) : pane.back;
  return { ...cleared(pane), path, back, forward: [] };
}

export function goBack(pane: PaneState): PaneState {
  const target = pane.back[pane.back.length - 1];
  if (target === undefined) return pane;
  return {
    ...cleared(pane),
    path: target,
    back: pane.back.slice(0, -1),
    forward: pane.path ? [pane.path, ...pane.forward].slice(0, MAX_HISTORY) : pane.forward,
  };
}

export function goForward(pane: PaneState): PaneState {
  const [target, ...rest] = pane.forward;
  if (target === undefined) return pane;
  return {
    ...cleared(pane),
    path: target,
    forward: rest,
    back: pane.path ? [...pane.back, pane.path].slice(-MAX_HISTORY) : pane.back,
  };
}

export function switchEndpoint(pane: PaneState, endpoint: EndpointRef, path: string): PaneState {
  return { ...initialPane(endpoint, path, pane.view) };
}

export function refresh(pane: PaneState): PaneState {
  return { ...pane, refreshKey: pane.refreshKey + 1 };
}
