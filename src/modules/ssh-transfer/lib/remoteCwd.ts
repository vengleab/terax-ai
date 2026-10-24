export const TERMINAL_TITLE_EVENT = "terax:terminal-title";

export const REMOTE_CWD_PREFIX = "terax-cwd:";

const MAX_PATH_LENGTH = 4096;

export type TerminalTitleDetail = { leafId: number; title: string };

/**
 * A remote bash prompt reports its folder as a terminal title with a private prefix. Anything
 * else (a normal title, a relative path, control characters) is ignored.
 */
export function parseRemoteCwdTitle(title: string): string | null {
  if (!title.startsWith(REMOTE_CWD_PREFIX)) return null;
  const path = title.slice(REMOTE_CWD_PREFIX.length);
  if (!path.startsWith("/") || path.length > MAX_PATH_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

export function readTitleEvent(event: Event): TerminalTitleDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== "object" || detail === null) return null;
  const { leafId, title } = detail as Partial<TerminalTitleDetail>;
  if (typeof leafId !== "number" || typeof title !== "string") return null;
  return { leafId, title };
}
