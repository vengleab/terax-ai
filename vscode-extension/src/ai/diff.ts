import type { DiffLine } from "../../shared/chat";

const CONTEXT = 3;
const MAX_LINES = 160;

/**
 * A short before/after preview of a change for the approval popup: the lines that differ with a few
 * lines of context, found by trimming what the two versions share at both ends. It is a preview for a
 * person to read, not a patch.
 */
export function previewChange(before: string, after: string): { lines: DiffLine[]; truncated: boolean } {
  if (before === after) return { lines: [], truncated: false };
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const lines: DiffLine[] = [];
  for (let i = Math.max(0, start - CONTEXT); i < start; i++) lines.push({ kind: "ctx", text: a[i] });
  for (let i = start; i < endA; i++) lines.push({ kind: "del", text: a[i] });
  for (let i = start; i < endB; i++) lines.push({ kind: "add", text: b[i] });
  for (let i = endA; i < Math.min(a.length, endA + CONTEXT); i++) lines.push({ kind: "ctx", text: a[i] });
  const truncated = lines.length > MAX_LINES;
  return { lines: truncated ? lines.slice(0, MAX_LINES) : lines, truncated };
}
