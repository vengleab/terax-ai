import type { FileEntry } from "../types";
import { joinPath, isDirLike } from "./pathOps";
import { type ViewOptions, viewEntries } from "./sort";

export type DirState =
  | { status: "loading" }
  | { status: "loaded"; entries: FileEntry[] }
  | { status: "error"; message: string };

export type TreeState = Record<string, DirState>;

export type TreeRow =
  | { kind: "entry"; entry: FileEntry; path: string; depth: number; isDir: boolean; expanded: boolean }
  | { kind: "status"; id: string; depth: number; text: string; tone: "muted" | "error" };

export function isUnder(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

/** Flattens the expanded part of the tree into the rows to draw. */
export function flattenTree(
  root: string,
  nodes: TreeState,
  expanded: ReadonlySet<string>,
  view: ViewOptions,
): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (dir: string, depth: number) => {
    const node = nodes[dir];
    if (!node || node.status === "loading") {
      rows.push({ kind: "status", id: `${dir}\0loading`, depth, text: "Loading…", tone: "muted" });
      return;
    }
    if (node.status === "error") {
      rows.push({ kind: "status", id: `${dir}\0error`, depth, text: node.message, tone: "error" });
      return;
    }
    const entries = viewEntries([...node.entries], view);
    if (entries.length === 0) {
      rows.push({ kind: "status", id: `${dir}\0empty`, depth, text: "Empty folder", tone: "muted" });
      return;
    }
    for (const entry of entries) {
      const path = joinPath(dir, entry.name);
      const isDir = isDirLike(entry);
      const open = isDir && expanded.has(path);
      rows.push({ kind: "entry", entry, path, depth, isDir, expanded: open });
      if (open) walk(path, depth + 1);
    }
  };

  walk(root, 0);
  return rows;
}

/** Forgets everything at or below `prefix`, for folders that were renamed or deleted. */
export function dropSubtree(
  nodes: TreeState,
  expanded: ReadonlySet<string>,
  prefix: string,
): { nodes: TreeState; expanded: Set<string> } {
  const nextNodes: TreeState = {};
  for (const [path, state] of Object.entries(nodes)) {
    if (!isUnder(path, prefix)) nextNodes[path] = state;
  }
  const nextExpanded = new Set<string>();
  for (const path of expanded) {
    if (!isUnder(path, prefix)) nextExpanded.add(path);
  }
  return { nodes: nextNodes, expanded: nextExpanded };
}

/** Expanded folders that still exist in the tree, parents first, so refreshes can run in order. */
export function foldersToRefresh(
  root: string,
  nodes: TreeState,
  expanded: ReadonlySet<string>,
): string[] {
  const dirs = [root, ...[...expanded].filter((p) => isUnder(p, root) && p !== root && nodes[p])];
  return dirs.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
