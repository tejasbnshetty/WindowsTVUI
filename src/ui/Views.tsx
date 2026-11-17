// Full-screen views: Settings, pairing (connect your phone / pair a new device) and the screensaver.
import { useEffect, useRef, useState } from "preact/hooks";
import { useClock, useNow } from "./Chrome";
import { cssVars } from "./Logo";
import { formatCountdown, type PairingScreen } from "./screens";
import type { Item, Section } from "./settingsModel";
import { MENU } from "./settingsModel";
import type { SettingsFocus } from "./settingsNav";
import type { WallpaperOption } from "./slides";
import type { LauncherInfo } from "./types";
import { WallpaperLayer } from "./Chrome";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function ItemRow({ item, focused }: { item: Item; focused: boolean }) {
  const cls = `item item-${item.kind}${focused ? " focused" : ""}${item.kind === "action" && item.danger ? " danger" : ""}${item.kind === "action" && item.armed ? " armed" : ""}${item.kind === "action" && item.current ? " current" : ""}`;
  return (
    <div class={cls} role={item.kind === "info" ? undefined : "button"}>
      <span class="item-label">{item.label}</span>
      {item.kind === "choice" && <span class="item-value"><i class="chev">‹</i>{item.value}<i class="chev">›</i></span>}
      {item.kind === "action" && item.hint && <span class="item-hint">{item.hint}</span>}
      {item.kind === "info" && item.value && <span class={`item-hint${item.mono ? " item-path" : ""}`}>{item.value}</span>}
    </div>
  );
}

export function SettingsScreen({ sections, focus }: { sections: Section[]; focus: SettingsFocus }) {
  const paneRef = useRef<HTMLDivElement>(null);
  const section = sections[focus.section] ?? sections[0];
  // Keep the focused row visible when a pane has more items than fit.
  useEffect(() => {
    paneRef.current?.querySelector(".item.focused")?.scrollIntoView({ block: "nearest" });
  }, [focus.zone === "pane" ? focus.item : -1, focus.section]);
  return (
    <div class="settings" role="dialog" aria-label="Settings">
      <div class="settings-inner">
        <nav class="settings-menu">
          <h1 class="settings-title">Settings</h1>
          {MENU.map((m, i) => (
            <div class={`menu-item${focus.section === i ? " selected" : ""}${focus.section === i && focus.zone === "menu" ? " focused" : ""}`} key={m.id}>{m.title}</div>
          ))}
          <div class="settings-hint">Back returns</div>
        </nav>
        <div class="settings-pane" ref={paneRef}>
          <h2 class="pane-title">{section?.title}</h2>
          {section?.items.map((it, i) => <ItemRow item={it} focused={focus.zone === "pane" && focus.item === i} key={it.id} />)}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export function PairScreenView({ screen, info }: { screen: Exclude<PairingScreen, { kind: "home" }>; info: LauncherInfo }) {
  const now = useNow(500);
  const first = screen.kind === "connect";
  const left = screen.kind === "pair-new" ? formatCountdown(screen.expiresAt, now) : "";
  const online = screen.online;
  return (
    <div class="pair" role="dialog" aria-label={first ? "Connect your phone" : "Pair a new device"}>
      <div class="pair-copy">
        <div class="pair-kicker">{first ? "Welcome to Couch UI" : "Pair a new phone"}</div>
        <h1 class="pair-title">{first ? "Connect your phone" : "Scan to pair"}</h1>
        {online ? (
          <ol class="pair-steps">
            <li>Join the <b>same Wi-Fi</b> as this TV</li>
            <li>
              Scan the QR code, or open <b class="pair-url">{info.url}</b>
              {info.mdnsUrl && <div class="pair-alt">or <b>{info.mdnsUrl}</b></div>}
            </li>
            <li>Enter this PIN</li>
          </ol>
        ) : (
          <p class="pair-offline">No network connection. Connect the laptop to Wi-Fi and this screen will update by itself.</p>
        )}
        <div class="pair-pin" aria-label="PIN">{(info.pairing.pin ?? "······").split("").map((d, i) => <span key={i}>{d}</span>)}</div>
        <div class="pair-foot">
          {screen.kind === "pair-new" ? <>Closes in <b>{left}</b> · press <b>Back</b> to cancel</> : <>Esc on the keyboard exits</>}
        </div>
      </div>
      <div class="pair-qr">
        {online && info.qr ? <img src={info.qr} alt="QR code for the phone remote" /> : <div class="pair-qr-empty">QR code</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screensaver: slow Ken Burns slideshow + big clock
// ---------------------------------------------------------------------------

const SLIDE_MS = 14_000;

export function ScreensaverView({ slides }: { slides: WallpaperOption[] }) {
  const clock = useClock();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (slides.length < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % slides.length), SLIDE_MS);
    return () => clearInterval(t);
  }, [slides.length]);
  const cur = slides[index % Math.max(1, slides.length)];
  const prev = slides.length > 1 ? slides[(index - 1 + slides.length) % slides.length] : undefined;
  return (
    <div class="screensaver" aria-hidden="true">
      {/* Stable keys (per slide) keep each slide element - and its Ken Burns animation - alive while it fades out. */}
      {prev && <div class="ss-slide ss-out" key={`s${index - 1}`} data-kb={String(((index - 1) % 4 + 4) % 4)}><WallpaperLayer wp={prev} /></div>}
      {cur && <div class="ss-slide ss-in" key={`s${index}`} data-kb={String(index % 4)}><WallpaperLayer wp={cur} /></div>}
      <div class="ss-shade" />
      <div class="ss-clock">
        <div class="ss-time">{clock.time}</div>
        <div class="ss-date">{clock.date}</div>
      </div>
    </div>
  );
}
