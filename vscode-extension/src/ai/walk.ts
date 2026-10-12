import * as fs from "node:fs/promises";
import * as path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".cache", ".turbo", "coverage"]);
export const MAX_FILES_SCANNED = 20_000;

/** Every file under `root`, depth first, without following links and without the usual build and cache folders. */
export async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    if (signal?.aborted) return;
    const dir = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const dirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) dirs.push(full);
      } else if (entry.isFile()) {
        if (++seen > MAX_FILES_SCANNED) return;
        yield full;
      }
    }
    // Pushed in reverse, so folders are visited in name order.
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
  }
}

/** A glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) as a regular expression over a `/`-separated path. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close > i) {
        out += `(?:${glob
          .slice(i + 1, close)
          .split(",")
          .map((alt) => globToRegExp(alt).source.slice(1, -1))
          .join("|")})`;
        i = close;
      } else out += "\\{";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i) {
        out += glob.slice(i, close + 1);
        i = close;
      } else out += "\\[";
    } else out += /[.+^$()|\\}\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${out}$`);
}

/** A pattern without a `/` matches file names anywhere; one with a `/` matches the path from the search folder. */
export function matchesGlob(glob: string, relativePath: string): boolean {
  const regex = globToRegExp(glob);
  const normal = relativePath.split(path.sep).join("/");
  return glob.includes("/") ? regex.test(normal) : regex.test(path.posix.basename(normal));
}
