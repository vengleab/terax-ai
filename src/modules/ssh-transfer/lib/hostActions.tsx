import { createContext, useContext } from "react";

export type SshHostActions = {
  openLocalFile: (path: string) => void;
  openRemoteFile: (profileId: string, remotePath: string) => void;
  openTerminal: (profileId: string) => void;
};

const noop: SshHostActions = {
  openLocalFile: () => undefined,
  openRemoteFile: () => undefined,
  openTerminal: () => undefined,
};

export const HostActionsContext = createContext<SshHostActions>(noop);

export function useHostActions(): SshHostActions {
  return useContext(HostActionsContext);
}
