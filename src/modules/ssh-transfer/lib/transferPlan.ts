import type { ConflictPolicy, EndpointRef, TransferMode, TransferRequest } from "../types";
import { baseName, excludeNested, parentPath } from "./pathOps";
import { sameEndpoint, type PaneState } from "./paneState";

export type TransferBuild =
  | { ok: true; request: TransferRequest; title: string; from: string; to: string }
  | { ok: false; reason: string };

export function transferTitle(mode: TransferMode, paths: string[]): string {
  const subject = paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`;
  return `${mode === "move" ? "Move" : "Copy"} ${subject}`;
}

/**
 * Builds a transfer from the selection of one pane to a folder of another (or the same) pane.
 * Refuses transfers that would do nothing or loop, before anything reaches the backend.
 */
export function buildTransfer(args: {
  src: Pick<PaneState, "endpoint" | "path">;
  dst: Pick<PaneState, "endpoint" | "path">;
  paths: string[];
  mode: TransferMode;
  dstDir?: string;
  conflict?: ConflictPolicy;
  label: (endpoint: EndpointRef) => string;
}): TransferBuild {
  const sources = excludeNested(args.paths);
  if (sources.length === 0) return { ok: false, reason: "Select something first" };
  const dstDir = args.dstDir ?? args.dst.path;
  if (!dstDir) return { ok: false, reason: "The destination folder is not ready yet" };

  const same = sameEndpoint(args.src.endpoint, args.dst.endpoint);
  if (same) {
    if (sources.every((p) => parentPath(p) === dstDir)) {
      return { ok: false, reason: "Those items are already in this folder" };
    }
    const into = sources.find((p) => dstDir === p || dstDir.startsWith(`${p.replace(/\/+$/, "")}/`));
    if (into) {
      return { ok: false, reason: `Cannot put ${baseName(into)} inside itself` };
    }
  }

  return {
    ok: true,
    request: {
      src: args.src.endpoint,
      dst: args.dst.endpoint,
      sources,
      dstDir,
      mode: args.mode,
      conflict: args.conflict ?? "ask",
      resume: true,
    },
    title: transferTitle(args.mode, sources),
    from: args.label(args.src.endpoint),
    to: args.label(args.dst.endpoint),
  };
}
