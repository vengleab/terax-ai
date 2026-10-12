import * as fs from "node:fs/promises";
import * as path from "node:path";
import { checkReadable, checkWritable } from "../../../src/modules/ai/lib/security";

export type Access = "read" | "write";
export type Resolved = { ok: true; path: string } | { ok: false; reason: string };

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    return path.resolve(root);
  }
}

/** Resolves symlinks for the part of the path that exists, and keeps the rest as written. */
async function canonical(target: string): Promise<string> {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Decides which files the agent's tools may touch: inside an open workspace folder, after symlinks are
 * resolved, and passing Terax's own deny-list for secret files and system folders (applied to both the
 * path as written and the real path, so a link into `~/.ssh` is caught). The path returned is the real
 * one, so a link cannot be swapped between this check and its use.
 */
export class WorkspaceGuard {
  constructor(private readonly roots: () => string[]) {}

  get folders(): string[] {
    return this.roots();
  }

  async resolve(input: string, access: Access, base?: string): Promise<Resolved> {
    const roots = this.roots();
    if (roots.length === 0) return { ok: false, reason: "No folder is open in VS Code, so there is nothing to work on." };
    if (!input.trim()) return { ok: false, reason: "Empty path." };
    const check = access === "read" ? checkReadable : checkWritable;
    const written = path.resolve(base ?? roots[0], input);
    const first = check(written);
    if (!first.ok) return first;
    const real = await canonical(written);
    const second = check(real);
    if (!second.ok) return second;
    for (const root of roots) {
      if (within(await canonicalRoot(root), real)) return { ok: true, path: real };
    }
    return { ok: false, reason: `Refused: ${input} is outside the workspace folders.` };
  }
}
