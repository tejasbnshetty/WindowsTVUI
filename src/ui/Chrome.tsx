// The parts around the home content: top bar, wallpaper, toast, error banner.
import { useEffect, useRef, useState } from "preact/hooks";
import { formatClock, msToNextMinute } from "./clock";
import { cssVars } from "./Logo";
import type { PairingChips } from "./screens";
import type { WallpaperOption } from "./slides";
import type { Toast as ToastState, UiState } from "./controller";

/** Re-renders every `ms` and returns Date.now(). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** The current time, ticking exactly on the minute. */
export function useClock(): { time: string; date: string } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => { setNow(Date.now()); t = setTimeout(tick, msToNextMinute(Date.now())); };
    t = setTimeout(tick, msToNextMinute(Date.now()));
    return () => clearTimeout(t);
  }, []);
  return formatClock(new Date(now));
}

export function TopBar({ info, chips }: { info: UiState["info"]; chips: PairingChips }) {
  const clock = useClock();
  const online = !!info?.network.online;
  return (
    <header class="topbar">
      <div class="clock">
        <div class="clock-time">{clock.time}</div>
        <div class="clock-date">{clock.date}</div>
      </div>
      <div class="chips">
        {chips.waitingForPhone && <div class="chip chip-waiting"><i class="dot pulse" />Waiting for your phone…</div>}
        {chips.phoneConnected && <div class="chip chip-ok"><i class="dot ok" />Phone connected</div>}
        <div class={`chip${online ? "" : " chip-bad"}`} aria-label="Network status">
          <i class={`dot${online ? " ok" : " bad"}`} />
          {online ? `${info?.network.label ?? "Network"} connected` : "No network"}
        </div>
      </div>
    </header>
  );
}

/** One wallpaper layer: a built-in generated gradient or a picture from the user's folder. */
export function WallpaperLayer({ wp }: { wp: WallpaperOption }) {
  if (wp.url) return <div class="wp wp-photo" style={cssVars({ backgroundImage: `url("${wp.url}")` })} />;
  return <div class={`wp wp-${wp.id.replace("builtin:", "")}`} />;
}

/** Cross-fades between wallpapers: the new layer fades in on top, then the old one is dropped. */
export function Wallpaper({ wp }: { wp: WallpaperOption | undefined }) {
  const [layers, setLayers] = useState<WallpaperOption[]>(wp ? [wp] : []);
  const last = useRef(wp?.id);
  useEffect(() => {
    if (!wp || wp.id === last.current) return;
    last.current = wp.id;
    setLayers((l) => [...l.slice(-1), wp]);
    const t = setTimeout(() => setLayers((l) => l.slice(-1)), 1200);
    return () => clearTimeout(t);
  }, [wp?.id]);
  return (
    <div class="wallpaper" aria-hidden="true">
      {layers.map((l, i) => <div class={`wp-layer${i === layers.length - 1 && layers.length > 1 ? " fade-in" : ""}`} key={l.id}><WallpaperLayer wp={l} /></div>)}
      <div class="wallpaper-shade" />
    </div>
  );
}

export function ToastView({ toast }: { toast: ToastState | null }) {
  return (
    <div class="toast-wrap" aria-live="polite">
      {toast && <div class={`toast${toast.kind === "error" ? " toast-error" : ""}`} key={toast.id}>{toast.text}</div>}
    </div>
  );
}

export function ErrorBanner({ text }: { text: string | null }) {
  if (!text) return null;
  return <div class="banner" role="alert">{text}</div>;
}
