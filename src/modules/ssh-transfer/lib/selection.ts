export type SelectModifiers = { shift: boolean; mod: boolean };

export type SelectionState = {
  selection: string[];
  anchor: string | null;
  cursor: string | null;
};

/** Click selection with the usual shift (range) and ctrl/cmd (toggle) behaviour over the visible order. */
export function applyClick(
  state: SelectionState,
  order: string[],
  path: string,
  { shift, mod }: SelectModifiers,
): SelectionState {
  if (shift && state.anchor && order.includes(state.anchor)) {
    const from = order.indexOf(state.anchor);
    const to = order.indexOf(path);
    if (to < 0) return state;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    return { selection: order.slice(lo, hi + 1), anchor: state.anchor, cursor: path };
  }
  if (mod) {
    const has = state.selection.includes(path);
    return {
      selection: has ? state.selection.filter((p) => p !== path) : [...state.selection, path],
      anchor: path,
      cursor: path,
    };
  }
  return { selection: [path], anchor: path, cursor: path };
}

/** Moves the keyboard cursor. With shift the selection extends from the anchor. */
export function moveCursor(
  state: SelectionState,
  order: string[],
  delta: number | "start" | "end",
  extend: boolean,
): SelectionState {
  if (order.length === 0) return state;
  const current = state.cursor ? order.indexOf(state.cursor) : -1;
  let next: number;
  if (delta === "start") next = 0;
  else if (delta === "end") next = order.length - 1;
  else if (current < 0) next = delta >= 0 ? 0 : order.length - 1;
  else next = Math.max(0, Math.min(order.length - 1, current + delta));
  const path = order[next];
  if (extend) return applyClick(state, order, path, { shift: true, mod: false });
  return { selection: [path], anchor: path, cursor: path };
}

export function selectAll(order: string[]): SelectionState {
  return {
    selection: [...order],
    anchor: order[0] ?? null,
    cursor: order[order.length - 1] ?? null,
  };
}

/** Keeps only paths that still exist, so a refresh does not leave ghosts selected. */
export function pruneSelection(state: SelectionState, order: string[]): SelectionState {
  const present = new Set(order);
  const selection = state.selection.filter((p) => present.has(p));
  if (selection.length === state.selection.length) return state;
  return {
    selection,
    anchor: state.anchor && present.has(state.anchor) ? state.anchor : null,
    cursor: state.cursor && present.has(state.cursor) ? state.cursor : null,
  };
}
