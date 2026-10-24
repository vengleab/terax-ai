import type { FileEntry } from "../types";

const WINDOWS_DRIVE = /^[A-Za-z]:\//;

export function normalizeLocal(path: string): string {
  return path.replace(/\\/g, "/");
}

export function isRootPath(path: string): boolean {
  return path === "/" || /^[A-Za-z]:\/?$/.test(path);
}

export function joinPath(base: string, name: string): string {
  if (!base) return name;
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

export function parentPath(path: string): string {
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (isRootPath(normalized)) {
    return /^[A-Za-z]:/.test(normalized) ? `${normalized.slice(0, 2)}/` : "/";
  }
  const index = normalized.lastIndexOf("/");
  if (index < 0) return ".";
  if (index === 0) return "/";
  const parent = normalized.slice(0, index);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

export function baseName(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const index = trimmed.lastIndexOf("/");
  return index < 0 ? trimmed : trimmed.slice(index + 1) || "/";
}

export type Crumb = { label: string; path: string };

export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [];
  const drive = path.match(WINDOWS_DRIVE);
  let rest: string;
  let acc: string;
  if (drive) {
    acc = path.slice(0, 3);
    crumbs.push({ label: path.slice(0, 2), path: acc });
    rest = path.slice(3);
  } else if (path.startsWith("/")) {
    acc = "/";
    crumbs.push({ label: "/", path: "/" });
    rest = path.slice(1);
  } else {
    acc = "";
    rest = path;
  }
  for (const segment of rest.split("/").filter(Boolean)) {
    acc = joinPath(acc, segment);
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

export function expandHome(input: string, home: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return joinPath(home, trimmed.slice(2));
  return trimmed;
}

export function isDirLike(entry: Pick<FileEntry, "kind" | "linkTargetIsDir">): boolean {
  return entry.kind === "dir" || (entry.kind === "symlink" && entry.linkTargetIsDir === true);
}

/** A name that can be used for a new file or folder: no separators, not empty, not a relative marker. */
export function validateNewName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name";
  if (trimmed === "." || trimmed === "..") return "That name is reserved";
  if (/[/\\\0]/.test(trimmed)) return "Names cannot contain slashes";
  if (trimmed.length > 255) return "That name is too long";
  return null;
}

/** Drops paths that are inside another selected path, so a folder and its contents are not both transferred. */
export function excludeNested(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const path of sorted) {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    if (!kept.some((k) => prefix.startsWith(k.endsWith("/") ? k : `${k}/`))) {
      kept.push(path);
    }
  }
  return paths.filter((p) => kept.includes(p)).filter((p, i, all) => all.indexOf(p) === i);
}
