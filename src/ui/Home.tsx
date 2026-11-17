import { useEffect, useRef, useState } from "preact/hooks";
import { inkOn, tileGradient } from "./color";
import { GAP, PEEK, ROW_GEOMETRY, ROW_H, TILE_W, VIEWPORT_H, pageGeometry, viewportWidthRem } from "./layout";
import { Logo, cssVars } from "./Logo";
import type { Focus } from "./nav";
import type { Row } from "./rows";
import { pageScroll, rowScroll } from "./scroll";
import { Tile } from "./Tile";
import type { PublicApp } from "./types";

export function Hero({ app, focused, onActivate }: { app: PublicApp | undefined; focused: boolean; onActivate: () => void }) {
  if (!app) {
    return (
      <section class={`hero hero-welcome${focused ? " focused" : ""}`} onClick={onActivate}>
        <div class="hero-copy">
          <div class="hero-kicker">Welcome</div>
          <h1 class="hero-title">Welcome to Couch UI</h1>
          <p class="hero-sub">Pick something to watch, listen to or play. Use your phone as the remote.</p>
          <div class="hero-button">Browse apps</div>
        </div>
        <i class="hero-ring" />
      </section>
    );
  }
  const g = tileGradient(app.color);
  return (
    <section class={`hero${focused ? " focused" : ""}${inkOn(app.color) === "#0b0d12" ? " ink-dark" : ""}`} style={cssVars({ "--c1": g.from, "--c2": g.to })} onClick={onActivate}>
      <div class="hero-mark" aria-hidden="true"><Logo app={app} /></div>
      <div class="hero-copy">
        <div class="hero-kicker">Continue with</div>
        <h1 class="hero-title">{app.name}</h1>
        <p class="hero-sub">Last opened</p>
        <div class="hero-button">Open</div>
      </div>
      <i class="hero-ring" />
    </section>
  );
}

export interface HomeProps {
  rows: Row[];
  focus: Focus;
  lastApp: PublicApp | undefined;
  onActivateHero: () => void;
  onClickTile: (row: number, col: number) => void;
}

/** Tracks the window size in rem units so scrolling maths matches the CSS at any resolution. */
function useViewportRem(): number {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 120 : viewportWidthRem(window.innerWidth, window.innerHeight)));
  useEffect(() => {
    const on = () => setW(viewportWidthRem(window.innerWidth, window.innerHeight));
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/**
 * Hero + rows. Horizontal scrolling of each row and vertical scrolling of the page follow the focus; both
 * are CSS transforms (GPU-composited), never layout changes.
 */
export function Home({ rows, focus, lastApp, onActivateHero, onClickTile }: HomeProps) {
  const vw = useViewportRem();
  const rowScrolls = useRef<number[]>([]);
  const pageY = useRef(0);

  // Update scroll positions for the focused zone (kept across renders so movement is minimal and stable).
  if (focus.zone === "row") {
    const count = rows[focus.row]?.items.length ?? 0;
    rowScrolls.current[focus.row] = rowScroll(rowScrolls.current[focus.row] ?? 0, focus.col, count, vw, ROW_GEOMETRY, PEEK);
    pageY.current = pageScroll(pageY.current, focus.row, VIEWPORT_H, pageGeometry(rows.length));
  } else {
    pageY.current = pageScroll(pageY.current, "hero", VIEWPORT_H, pageGeometry(rows.length));
  }

  return (
    <main class="home">
      <div class="page" style={cssVars({ transform: `translate3d(0, ${-pageY.current}rem, 0)` })}>
        <Hero app={lastApp} focused={focus.zone === "hero"} onActivate={onActivateHero} />
        {rows.map((row, r) => {
          const active = focus.zone === "row" && focus.row === r;
          return (
            <section class={`row${active ? " active" : ""}`} key={row.id} style={cssVars({ height: `${ROW_H}rem` })}>
              <h2 class="row-title">{row.title}</h2>
              <div class="row-viewport">
                <div class="track" style={cssVars({ transform: `translate3d(${-(rowScrolls.current[r] ?? 0)}rem, 0, 0)`, gap: `${GAP}rem`, paddingLeft: `${ROW_GEOMETRY.padStart}rem` })}>
                  {row.items.map((item, c) => (
                    <div class="slot" key={item.kind === "app" ? item.app.id : "settings"} style={cssVars({ width: `${TILE_W}rem` })}>
                      <Tile item={item} focused={active && focus.col === c} onClick={() => onClickTile(r, c)} />
                    </div>
                  ))}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
