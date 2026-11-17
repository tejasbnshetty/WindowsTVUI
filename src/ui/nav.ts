// Focus navigation on the home screen: a hero banner on top, then rows of tiles.
//   up    from the first row -> the hero            down from the hero -> the first row
//   left/right move inside a row and stop at the ends (no wrap-around)
//   up/down between rows keep the column you were in when the target row is long enough ("preferred column")

export type Dir = "up" | "down" | "left" | "right";

export type Focus = { zone: "hero" } | { zone: "row"; row: number; col: number };

export interface Moved {
  focus: Focus;
  /** Preferred column to remember for vertical moves. */
  memory: number;
}

export const HERO: Focus = { zone: "hero" };

/** Index of the nearest row (searching in `step` direction from `from`) that has at least one tile, or -1. */
function nonEmptyRow(counts: readonly number[], from: number, step: 1 | -1): number {
  for (let r = from; r >= 0 && r < counts.length; r += step) if (counts[r] > 0) return r;
  return -1;
}

export function firstFocus(counts: readonly number[]): Focus {
  const r = nonEmptyRow(counts, 0, 1);
  return r >= 0 ? { zone: "row", row: r, col: 0 } : HERO;
}

/** Keeps a focus valid after the number of rows/tiles changed (e.g. apps.json was reloaded). */
export function clampFocus(counts: readonly number[], focus: Focus): Focus {
  if (focus.zone === "hero") return focus;
  if (focus.row >= counts.length || counts[focus.row] === 0) {
    const r = nonEmptyRow(counts, Math.min(focus.row, counts.length - 1), -1);
    const fallback = r >= 0 ? r : nonEmptyRow(counts, 0, 1);
    return fallback >= 0 ? { zone: "row", row: fallback, col: Math.min(focus.col, counts[fallback] - 1) } : HERO;
  }
  return { zone: "row", row: focus.row, col: Math.min(focus.col, counts[focus.row] - 1) };
}

export function moveFocus(counts: readonly number[], focus: Focus, dir: Dir, memory = 0): Moved {
  if (focus.zone === "hero") {
    if (dir === "down") {
      const r = nonEmptyRow(counts, 0, 1);
      if (r >= 0) return { focus: { zone: "row", row: r, col: Math.min(memory, counts[r] - 1) }, memory };
    }
    return { focus, memory };
  }

  const { row, col } = focus;
  switch (dir) {
    case "left": {
      const c = Math.max(0, col - 1);
      return { focus: { zone: "row", row, col: c }, memory: c };
    }
    case "right": {
      const c = Math.min(counts[row] - 1, col + 1);
      return { focus: { zone: "row", row, col: c }, memory: c };
    }
    case "up": {
      const r = nonEmptyRow(counts, row - 1, -1);
      if (r < 0) return { focus: HERO, memory };
      return { focus: { zone: "row", row: r, col: Math.min(memory, counts[r] - 1) }, memory };
    }
    case "down": {
      const r = nonEmptyRow(counts, row + 1, 1);
      if (r < 0) return { focus, memory }; // already on the last row
      return { focus: { zone: "row", row: r, col: Math.min(memory, counts[r] - 1) }, memory };
    }
  }
}

export const sameFocus = (a: Focus, b: Focus): boolean =>
  a.zone === b.zone && (a.zone === "hero" || (b.zone === "row" && a.row === b.row && a.col === b.col));
