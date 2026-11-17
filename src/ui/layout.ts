// Home screen geometry, in rem. 1rem = 1/67.5 of the window height (16 px at 1080p, 32 px at 4K), so the whole
// layout scales with the screen. The same numbers drive the scroll-follow maths and the CSS (styles.css).
import type { PageGeometry, RowGeometry } from "./scroll";

export const REM_PER_SCREEN_HEIGHT = 67.5;

export const TILE_W = 21;
export const TILE_H = (TILE_W * 9) / 16;
export const GAP = 1.6;
export const ROW_PAD_START = 7;
export const ROW_PAD_END = 7;
export const PEEK = 4;

export const TOPBAR_H = 8;
export const HERO_H = 25;
export const ROW_H = 19;
export const PAGE_PAD_END = 4;

export const ROW_GEOMETRY: RowGeometry = { tileW: TILE_W, gap: GAP, padStart: ROW_PAD_START, padEnd: ROW_PAD_END };

export const pageGeometry = (rowCount: number): PageGeometry => ({ heroH: HERO_H, rowH: ROW_H, rowCount, padEnd: PAGE_PAD_END });

/** Visible height under the top bar, in rem. */
export const VIEWPORT_H = REM_PER_SCREEN_HEIGHT - TOPBAR_H;

/** Window width in rem (wider than 120 on ultrawide screens). */
export const viewportWidthRem = (innerWidth: number, innerHeight: number): number =>
  innerHeight > 0 ? (innerWidth / innerHeight) * REM_PER_SCREEN_HEIGHT : 120;
