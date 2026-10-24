import { useCallback, useEffect, useRef } from "react";
import { useDndStore } from "../store/dndStore";
import type { PaneId } from "../types";
import { dragStarted, resolveDropTarget } from "./dnd";

export type PaneDrop = {
  from: PaneId;
  paths: string[];
  to: PaneId;
  dir: string | null;
  move: boolean;
};

type Options = {
  getSelection: (pane: PaneId) => string[];
  onDrop: (drop: PaneDrop) => void;
};

type Session = {
  pane: PaneId;
  paths: string[];
  startX: number;
  startY: number;
  started: boolean;
  ghost: HTMLElement | null;
};

const GHOST_CLASS =
  "fixed z-[9999] pointer-events-none rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground shadow-lg";

/**
 * Pointer-event drag and drop between the two panes. Native HTML5 drag is not used because the
 * webview intercepts it while OS file drops are enabled.
 */
export function useDualPaneDnd({ getSelection, onDrop }: Options) {
  const options = useRef({ getSelection, onDrop });
  options.current = { getSelection, onDrop };
  const session = useRef<Session | null>(null);
  const suppressClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const finish = useCallback(() => {
    const current = session.current;
    current?.ghost?.remove();
    session.current = null;
    cleanup.current?.();
    cleanup.current = null;
    useDndStore.getState().end();
  }, []);

  const onRowPointerDown = useCallback(
    (event: React.PointerEvent, pane: PaneId, path: string) => {
      if (event.button !== 0) return;
      const selected = options.current.getSelection(pane);
      const paths = selected.includes(path) ? selected : [path];
      session.current = {
        pane,
        paths,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
        ghost: null,
      };

      const move = (e: PointerEvent) => {
        const current = session.current;
        if (!current) return;
        if (!current.started) {
          if (!dragStarted(e.clientX - current.startX, e.clientY - current.startY)) return;
          current.started = true;
          const ghost = document.createElement("div");
          ghost.className = GHOST_CLASS;
          ghost.textContent = current.paths.length === 1 ? "1 item" : `${current.paths.length} items`;
          document.body.appendChild(ghost);
          current.ghost = ghost;
          useDndStore.getState().begin(current.paths.length);
        }
        if (current.ghost) {
          current.ghost.style.left = `${e.clientX + 14}px`;
          current.ghost.style.top = `${e.clientY + 14}px`;
        }
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        useDndStore.getState().setHover(resolveDropTarget(hit));
      };

      const up = (e: PointerEvent) => {
        const current = session.current;
        const started = current?.started ?? false;
        const target = started
          ? resolveDropTarget(document.elementFromPoint(e.clientX, e.clientY))
          : null;
        if (started) {
          suppressClick.current = true;
          window.setTimeout(() => {
            suppressClick.current = false;
          }, 0);
        }
        const drop = current && target
          ? { from: current.pane, paths: current.paths, to: target.pane, dir: target.dir, move: e.shiftKey }
          : null;
        finish();
        if (drop) options.current.onDrop(drop);
      };

      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") finish();
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", finish);
      window.addEventListener("keydown", key, true);
      cleanup.current = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", finish);
        window.removeEventListener("keydown", key, true);
      };
    },
    [finish],
  );

  /** True right after a drag ended, so the click that follows it is ignored. */
  const consumeSuppressedClick = useCallback(() => {
    if (!suppressClick.current) return false;
    suppressClick.current = false;
    return true;
  }, []);

  return { onRowPointerDown, consumeSuppressedClick };
}
