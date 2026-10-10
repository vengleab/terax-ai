import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { toast } from "sonner";
import { EDIT_SYNC_EVENT, sshApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { getEditInfo } from "../lib/editRegistry";
import type { EditSyncEvent } from "../types";

/** Reports the result of uploading a remote file after the editor saved it. */
export function EditSyncListener() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<EditSyncEvent>(EDIT_SYNC_EVENT, (event) => {
      const { id, outcome, error } = event.payload;
      const info = getEditInfo(id);
      const name = info?.remotePath ?? "file";
      if (error) {
        toast.error(`Could not save ${name} to the server`, { description: error.message });
        return;
      }
      if (!outcome || outcome.kind === "unchanged") return;
      if (outcome.kind === "uploaded") {
        toast.success("Saved to server", { description: name });
        return;
      }
      toast.warning(`${name} changed on the server`, {
        description: "Overwrite it with your version, or discard your edits and reload.",
        duration: 20000,
        action: {
          label: "Overwrite",
          onClick: () =>
            void sshApi
              .editSync(id, true)
              .then(() => toast.success("Saved to server", { description: name }))
              .catch((e) => toast.error(errorMessage(e))),
        },
        cancel: {
          label: "Reload",
          onClick: () =>
            void sshApi
              .editReload(id)
              .then(() => toast("Reloaded from the server", { description: "Close and reopen the tab to see it." }))
              .catch((e) => toast.error(errorMessage(e))),
        },
      });
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("[terax] ssh edit listener failed:", e));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return null;
}
