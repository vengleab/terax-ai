import { useUiStore } from "../store/uiStore";
import { ChmodDialog } from "./ChmodDialog";
import { KeysDialog } from "./KeysDialog";
import { KnownHostsDialog } from "./KnownHostsDialog";
import { ProfileDialog } from "./ProfileDialog";
import { TunnelsDialog } from "./TunnelsDialog";

export function DialogsHost() {
  const dialog = useUiStore((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "profile":
      return (
        <ProfileDialog
          key={`profile:${dialog.profileId ?? ""}`}
          request={dialog}
        />
      );
    case "keys":
      return <KeysDialog key="keys" request={dialog} />;
    case "knownHosts":
      return <KnownHostsDialog key="knownHosts" />;
    case "tunnels":
      return (
        <TunnelsDialog
          key={`tunnels:${dialog.profileId ?? ""}`}
          request={dialog}
        />
      );
    case "chmod":
      return (
        <ChmodDialog
          key={`chmod:${JSON.stringify(dialog.endpoint)}:${dialog.path}`}
          request={dialog}
        />
      );
  }
}
