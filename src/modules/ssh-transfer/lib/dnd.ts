import type { PaneId } from "../types";

export const PANE_ATTR = "data-sshx-pane";
export const PATH_ATTR = "data-sshx-path";
export const DIR_ATTR = "data-sshx-dir";
export const DRAG_THRESHOLD = 5;

export type DropTarget = {
  pane: PaneId;
  /** A folder row under the pointer, or null for the pane's current folder. */
  dir: string | null;
};

type Hit = {
  closest(selector: string): Hit | null;
  getAttribute(name: string): string | null;
  contains(other: unknown): boolean;
};

export function dragStarted(dx: number, dy: number, threshold = DRAG_THRESHOLD): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

export function targetEquals(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.pane === b.pane && a.dir === b.dir;
}

/** Finds the pane, and the folder row inside it, under an element. Pure over the DOM attributes. */
export function resolveDropTarget(el: Hit | null): DropTarget | null {
  if (!el) return null;
  const paneEl = el.closest(`[${PANE_ATTR}]`);
  if (!paneEl) return null;
  const pane = paneEl.getAttribute(PANE_ATTR);
  if (pane !== "left" && pane !== "right") return null;
  const dirEl = el.closest(`[${DIR_ATTR}]`);
  if (dirEl && paneEl.contains(dirEl)) {
    const path = dirEl.getAttribute(PATH_ATTR);
    if (path) return { pane, dir: path };
  }
  return { pane, dir: null };
}

/** Tauri may report drop positions in physical pixels. Scale down only when out of the viewport. */
export function toViewportPoint(
  x: number,
  y: number,
  viewport: { width: number; height: number; dpr: number },
): { x: number; y: number } {
  if (x > viewport.width || y > viewport.height) {
    const dpr = viewport.dpr || 1;
    return { x: x / dpr, y: y / dpr };
  }
  return { x, y };
}
