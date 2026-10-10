import type { EditInfo } from "../types";

type Entry = EditInfo & { profileId: string };

const sessions = new Map<string, Entry>();

export function rememberEdit(profileId: string, info: EditInfo): void {
  sessions.set(info.id, { ...info, profileId });
}

export function forgetEdit(id: string): void {
  sessions.delete(id);
}

export function getEditInfo(id: string): EditInfo | undefined {
  return sessions.get(id);
}

export function findEditByRemote(profileId: string, remotePath: string): EditInfo | undefined {
  for (const entry of sessions.values()) {
    if (entry.profileId === profileId && entry.remotePath === remotePath) return entry;
  }
  return undefined;
}
