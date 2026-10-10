import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef } from "react";
import { useDndStore } from "../store/dndStore";
import { type DropTarget, resolveDropTarget, toViewportPoint } from "./dnd";

type Options = {
  active: boolean;
  onDrop: (target: DropTarget, paths: string[]) => void;
};

function targetAt(x: number, y: number): DropTarget | null {
  const point = toViewportPoint(x, y, {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  });
  return resolveDropTarget(document.elementFromPoint(point.x, point.y));
}

/** Accepts files dropped from the operating system onto a pane. Inactive tabs ignore drops. */
export function useOsFileDrop({ active, onDrop }: Options) {
  const options = useRef({ active, onDrop });
  options.current = { active, onDrop };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!options.current.active) return;
        const payload = event.payload;
        const dnd = useDndStore.getState();
        if (payload.type === "enter" || payload.type === "over") {
          dnd.setHover(targetAt(payload.position.x, payload.position.y));
          return;
        }
        if (payload.type === "leave") {
          dnd.setHover(null);
          return;
        }
        const target = targetAt(payload.position.x, payload.position.y);
        dnd.setHover(null);
        if (target && payload.paths.length > 0) options.current.onDrop(target, payload.paths);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => console.error("[terax] ssh drop listener failed:", error));

    return () => {
      disposed = true;
      useDndStore.getState().setHover(null);
      unlisten?.();
    };
  }, []);
}
