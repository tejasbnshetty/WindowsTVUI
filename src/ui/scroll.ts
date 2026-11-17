// "Scroll follows focus": the minimum movement that brings the focused item (plus a little peek of its
// neighbours) fully into view. Units are whatever the caller uses (the UI uses rem, which scales 1080p -> 4K).

export interface FollowInput {
  /** Current scroll position (>= 0; content moves by -scroll). */
  scroll: number;
  /** Where the focused item starts, measured from the start of the content. */
  itemStart: number;
  itemSize: number;
  /** Size of the visible window. */
  viewport: number;
  /** Total content size. */
  content: number;
  /** Extra space to keep visible before / after the item, so the next tile peeks in. */
  peekBefore?: number;
  peekAfter?: number;
}

export function followScroll(i: FollowInput): number {
  const max = Math.max(0, i.content - i.viewport);
  const lo = i.itemStart - (i.peekBefore ?? 0);
  const hi = i.itemStart + i.itemSize + (i.peekAfter ?? 0);
  let s = i.scroll;
  if (hi - s > i.viewport) s = hi - i.viewport; // item (+peek) sticks out at the end
  if (lo - s < 0) s = lo;                        // item (+peek) sticks out at the start (wins if both)
  return Math.min(max, Math.max(0, s));
}

export interface RowGeometry {
  tileW: number;
  gap: number;
  padStart: number;
  padEnd: number;
}

export const contentWidth = (count: number, g: RowGeometry): number =>
  count <= 0 ? g.padStart + g.padEnd : g.padStart + count * g.tileW + (count - 1) * g.gap + g.padEnd;

/** New horizontal scroll of a row when the tile at `index` is focused. */
export function rowScroll(prev: number, index: number, count: number, viewportW: number, g: RowGeometry, peek: number): number {
  const itemStart = g.padStart + index * (g.tileW + g.gap);
  return followScroll({
    scroll: prev,
    itemStart,
    itemSize: g.tileW,
    viewport: viewportW,
    content: contentWidth(count, g),
    // The first / last tile sit flush with the row's edges (aligned with the row title); others keep a peek of their neighbour.
    peekBefore: index === 0 ? itemStart : peek,
    peekAfter: index >= count - 1 ? g.padEnd : peek,
  });
}

export interface PageGeometry {
  heroH: number;
  rowH: number;
  rowCount: number;
  /** Space after the last row. */
  padEnd: number;
}

/** New vertical scroll of the whole home content (hero + rows) for the focused zone. */
export function pageScroll(prev: number, focusRow: number | "hero", viewportH: number, g: PageGeometry): number {
  const content = g.heroH + g.rowCount * g.rowH + g.padEnd;
  if (focusRow === "hero") return followScroll({ scroll: prev, itemStart: 0, itemSize: g.heroH, viewport: viewportH, content });
  return followScroll({
    scroll: prev,
    itemStart: g.heroH + focusRow * g.rowH,
    itemSize: g.rowH,
    viewport: viewportH,
    content,
  });
}
