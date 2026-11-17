import { render } from "preact";
import { App } from "./App";
import { createController, isAction } from "./controller";
import type { TvApi } from "./types";

declare global {
  interface Window { tv: TvApi }
}

const controller = createController({ tv: window.tv });

// ---- Keyboard: arrows/Enter/Backspace/Home drive the launcher, P pairs a phone, Esc exits ----
const KEYS: Record<string, string> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Enter: "ok", Backspace: "back", Home: "home",
};

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { controller.exitKey(); e.preventDefault(); return; }
  if ((e.key === "p" || e.key === "P") && !e.ctrlKey && !e.altKey && !e.metaKey) { controller.pairKey(); e.preventDefault(); return; }
  const action = KEYS[e.key];
  if (action && isAction(action)) { controller.input(action); e.preventDefault(); return; }
  controller.activity(); // any other key still wakes the screensaver (and does nothing else)
});

// ---- Mouse (the phone's trackpad moves the real cursor): wakes the screensaver; hides after 3 s idle ----
const CURSOR_IDLE_MS = 3000;
let cursorTimer: number | undefined;
let lastX = Number.NaN, lastY = Number.NaN;
function wakeCursor(): void {
  document.documentElement.classList.remove("idle-cursor");
  window.clearTimeout(cursorTimer);
  cursorTimer = window.setTimeout(() => document.documentElement.classList.add("idle-cursor"), CURSOR_IDLE_MS);
}
window.addEventListener("mousemove", (e) => {
  // Chromium also emits synthetic same-position moves after style changes; those are not activity.
  if (e.screenX === lastX && e.screenY === lastY) return;
  lastX = e.screenX; lastY = e.screenY;
  wakeCursor();
  controller.activity();
});
window.addEventListener("mousedown", () => { wakeCursor(); controller.activity(); });
window.addEventListener("wheel", () => controller.activity(), { passive: true });
wakeCursor();

// ---- Visibility: the screensaver only counts while the launcher is really on screen ----
const syncVisible = () => controller.setVisible(document.visibilityState === "visible");
document.addEventListener("visibilitychange", syncVisible);
syncVisible();

void controller.init();
render(<App controller={controller} />, document.getElementById("app")!);
