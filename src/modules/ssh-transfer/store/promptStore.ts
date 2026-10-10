import { create } from "zustand";
import type { HostKeyErrorData } from "../types";

export type SecretKind = "password" | "passphrase";

export type HostKeyPrompt = {
  kind: "hostKey";
  id: number;
  changed: boolean;
  data: HostKeyErrorData;
  resolve: (accept: boolean) => void;
};

export type SecretAnswer = { value: string; remember: boolean };

export type SecretPrompt = {
  kind: "secret";
  id: number;
  profileName: string;
  secret: SecretKind;
  invalid: boolean;
  resolve: (answer: SecretAnswer | null) => void;
};

export type Prompt = HostKeyPrompt | SecretPrompt;

type PromptState = {
  queue: Prompt[];
  push: (prompt: Prompt) => void;
  answerFirst: () => void;
};

let promptSeq = 0;

export const usePromptStore = create<PromptState>((set) => ({
  queue: [],
  push: (prompt) => set((s) => ({ queue: [...s.queue, prompt] })),
  answerFirst: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

export function askHostKey(data: HostKeyErrorData, changed: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    promptSeq += 1;
    usePromptStore.getState().push({ kind: "hostKey", id: promptSeq, changed, data, resolve });
  });
}

export function askSecret(
  profileName: string,
  secret: SecretKind,
  invalid: boolean,
): Promise<SecretAnswer | null> {
  return new Promise((resolve) => {
    promptSeq += 1;
    usePromptStore.getState().push({
      kind: "secret",
      id: promptSeq,
      profileName,
      secret,
      invalid,
      resolve,
    });
  });
}
