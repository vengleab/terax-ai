export type RawEntry = { name: string; kind: "file" | "dir" | "symlink" };

export type BrowserEntry = { name: string; kind: "dir" | "file" };

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function joinPath(base: string, name: string): string {
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

export function parentPath(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (trimmed === "/" || /^[A-Za-z]:\/?$/.test(trimmed)) {
    return /^[A-Za-z]:/.test(trimmed) ? `${trimmed.slice(0, 2)}/` : "/";
  }
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  const parent = trimmed.slice(0, index);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

export function expandHome(input: string, home: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return joinPath(home, trimmed.slice(2));
  return trimmed;
}

const isJson = (name: string) => name.toLowerCase().endsWith(".json");

/**
 * What the file chooser shows: folders, and files that could be a service account key (`.json`).
 * A symlink can point at either, so `.json` links count as files and any other link as a folder.
 */
export function chooserEntries(entries: readonly RawEntry[]): BrowserEntry[] {
  const shown: BrowserEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "dir") shown.push({ name: entry.name, kind: "dir" });
    else if (isJson(entry.name)) shown.push({ name: entry.name, kind: "file" });
    else if (entry.kind === "symlink") shown.push({ name: entry.name, kind: "dir" });
  }
  return shown.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Where to open the chooser, most likely first: the folder used last time, then Downloads (where Google saves keys), then home. */
export function startFolders(lastDirectory: string | null, home: string): string[] {
  const homeDir = normalizePath(home);
  const folders = [lastDirectory ? normalizePath(lastDirectory) : null, joinPath(homeDir, "Downloads"), homeDir];
  return folders.filter((f, i): f is string => !!f && folders.indexOf(f) === i);
}
