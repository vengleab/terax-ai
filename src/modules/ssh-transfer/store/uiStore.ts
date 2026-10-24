import { create } from "zustand";
import type { EndpointRef } from "../types";

export type DialogRequest =
  | { kind: "profile"; profileId?: string }
  | { kind: "keys"; deployTo?: string }
  | { kind: "knownHosts" }
  | { kind: "tunnels"; profileId?: string }
  | {
      kind: "chmod";
      endpoint: EndpointRef;
      path: string;
      name: string;
      mode: number | null;
      onDone?: () => void;
    };

type UiState = {
  dialog: DialogRequest | null;
  open: (dialog: DialogRequest) => void;
  close: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));
