import type { FileEntry } from "../types";
import { isDirLike } from "./pathOps";

export type SortKey = "name" | "size" | "mtime";
export type SortDir = "asc" | "desc";
export type SortSpec = { key: SortKey; dir: SortDir };

export type ViewOptions = {
  sort: SortSpec;
  showHidden: boolean;
  filter: string;
};

export const DEFAULT_VIEW: ViewOptions = {
  sort: { key: "name", dir: "asc" },
  showHidden: false,
  filter: "",
};

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Folders always come first; the chosen key orders within each group. */
export function viewEntries(
  entries: FileEntry[],
  { sort, showHidden, filter }: ViewOptions,
): FileEntry[] {
  const needle = filter.trim().toLowerCase();
  const visible = entries.filter((entry) => {
    if (!showHidden && entry.name.startsWith(".")) return false;
    return !needle || entry.name.toLowerCase().includes(needle);
  });
  const direction = sort.dir === "asc" ? 1 : -1;
  return visible.sort((a, b) => {
    const aDir = isDirLike(a);
    const bDir = isDirLike(b);
    if (aDir !== bDir) return aDir ? -1 : 1;
    let order = 0;
    if (sort.key === "size") order = a.size - b.size;
    else if (sort.key === "mtime") order = (a.mtime ?? 0) - (b.mtime ?? 0);
    if (order === 0) order = compareNames(a.name, b.name);
    return order * direction;
  });
}

export function toggleSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key !== key) return { key, dir: key === "name" ? "asc" : "desc" };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}
