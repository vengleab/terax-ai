import { ConflictDialog } from "./ConflictDialog";
import { DialogsHost } from "./DialogsHost";
import { EditSyncListener } from "./EditSyncListener";
import { PromptHost } from "./PromptHost";

/** Everything that can appear on top of the app regardless of where SSH File Transfer was used. */
export function SshOverlays() {
  return (
    <>
      <PromptHost />
      <DialogsHost />
      <ConflictDialog />
      <EditSyncListener />
    </>
  );
}
