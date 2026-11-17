import { tileGradient } from "./color";
import { Logo, cssVars } from "./Logo";
import type { RowItem } from "./rows";

export interface TileProps {
  item: RowItem;
  focused: boolean;
  onClick?: () => void;
}

const GEAR = "M19.14 12.94a7.43 7.43 0 0 0 .05-.94 7.43 7.43 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.24-1.12.55-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.43 7.43 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z";

/** One 16:9 tile. Focus (scale, glow, brightness lift) is pure CSS transform/opacity, defined in styles.css. */
export function Tile({ item, focused, onClick }: TileProps) {
  if (item.kind === "settings") {
    return (
      <div class={`tile tile-settings${focused ? " focused" : ""}`} role="button" aria-label="Settings" onClick={onClick}>
        <div class="tile-face">
          <svg class="logo-svg gear" viewBox="0 0 24 24" aria-hidden="true"><path d={GEAR} fill="currentColor" /></svg>
          <span class="settings-word">Settings</span>
        </div>
        <i class="tile-shine" /><i class="tile-glow" /><i class="tile-ring" />
        <div class="tile-name">Settings</div>
      </div>
    );
  }
  const { app } = item;
  const g = tileGradient(app.color);
  const missing = app.installed === false;
  return (
    <div
      class={`tile${focused ? " focused" : ""}${missing ? " missing" : ""}`}
      style={cssVars({ "--c1": g.from, "--c2": g.to, "--glow": app.color })}
      role="button"
      aria-label={missing ? `${app.name}, not installed` : app.name}
      onClick={onClick}
    >
      <div class="tile-face"><Logo app={app} /></div>
      <i class="tile-shine" /><i class="tile-glow" /><i class="tile-ring" />
      {missing && <div class="tile-badge">Not installed</div>}
      <div class="tile-name">{app.name}</div>
    </div>
  );
}
