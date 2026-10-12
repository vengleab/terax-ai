import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef } from "react";
import { IS_MAC } from "@/lib/platform";
import { createLaunchFolders } from "./lib/controller";

/** Sent by `tauri-plugin-terax-launch` when the OS has handed the app a folder. */
export const FOLDERS_EVENT = "terax:open-folders";

type Options = {
  /** True once the saved tabs are restored. Only macOS hands folders over, so elsewhere this does nothing. */
  ready: boolean;
  openFolder: (path: string) => void;
};

export function useLaunchFolders({ ready, openFolder }: Options): void {
  const open = useRef(openFolder);
  open.current = openFolder;

  const controller = useMemo(
    () =>
      createLaunchFolders({
        takePending: () => invoke<string[]>("plugin:terax-launch|take_pending_folders"),
        authorize: (path) => invoke<string>("workspace_authorize", { path }),
        openFolder: (path) => open.current(path),
      }),
    [],
  );

  useEffect(() => {
    if (!IS_MAC) return;
    let off: (() => void) | undefined;
    let stopped = false;
    void listen(FOLDERS_EVENT, () => void controller.wake()).then((unlisten) => {
      if (stopped) unlisten();
      else off = unlisten;
    });
    return () => {
      stopped = true;
      off?.();
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    if (IS_MAC) void controller.setReady(ready);
  }, [controller, ready]);
}
