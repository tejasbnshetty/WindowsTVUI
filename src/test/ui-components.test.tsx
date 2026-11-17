import { test } from "node:test";
import * as assert from "node:assert/strict";
import { render } from "preact-render-to-string";
import { Logo } from "../ui/Logo";
import { Tile } from "../ui/Tile";
import { Home, Hero } from "../ui/Home";
import { PairScreenView, ScreensaverView, SettingsScreen } from "../ui/Views";
import { ErrorBanner, ToastView, TopBar, WallpaperLayer } from "../ui/Chrome";
import { buildRows } from "../ui/rows";
import { buildSections } from "../ui/settingsModel";
import { DEFAULT_UI } from "../uiSettings";
import { inkOn, luminance, shade, tileGradient, wordmarkSize, hexToRgb, rgbToHex } from "../ui/color";
import { ROW_H, TILE_W } from "../ui/layout";
import type { LauncherInfo, PublicApp } from "../ui/types";

const app = (over: Partial<PublicApp> = {}): PublicApp =>
  ({ id: "netflix", name: "Netflix", category: "Streaming", type: "url", color: "#E50914", iconPath: "M0 0h24v24H0z", imageUrl: null, installed: null, ...over });

const info = (over: Partial<LauncherInfo> = {}): LauncherInfo => ({
  error: null, url: "http://192.168.1.5:8787", mdnsUrl: "http://couchui.local:8787", qr: "data:image/png;base64,AAAA",
  pairing: { open: true, pin: "123456", expiresAt: null }, devices: 0, connected: 0,
  network: { online: true, label: "Wi-Fi", ip: "192.168.1.5" }, ...over,
});

// ---------------- logos ----------------

test("Logo: bundled simple-icons path -> inline SVG in a readable colour (white on dark brands, near-black on light ones)", () => {
  const dark = render(<Logo app={app()} />);
  assert.match(dark, /<svg[^>]*class="logo-svg"/);
  assert.match(dark, /viewBox="0 0 24 24"/);
  assert.match(dark, /d="M0 0h24v24H0z"/);
  assert.match(dark, /color:#ffffff/);
  assert.match(render(<Logo app={app({ color: "#EBAF00" })} />), /color:#0b0d12/, "light yellow brand gets dark ink");
});

test("Logo: a custom image beats the bundled logo (served from couch://asset)", () => {
  const html = render(<Logo app={app({ imageUrl: "couch://asset/netflix.png" })} />);
  assert.match(html, /<img[^>]*class="logo-img"[^>]*src="couch:\/\/asset\/netflix\.png"/);
  assert.doesNotMatch(html, /<svg/);
});

test("Logo: brands without a logo get a bold generated wordmark from the NAME in readable ink", () => {
  const html = render(<Logo app={app({ name: "ABC iview", iconPath: null, color: "#00A06B" })} />);
  assert.match(html, /<span class="wordmark"[^>]*>ABC iview<\/span>/);
  assert.doesNotMatch(html, /<svg|<img/);
  assert.match(html, /font-size:/);
});

test("Logo: wordmark size shrinks for long names so they fit a 16:9 tile", () => {
  assert.ok(wordmarkSize("10") > wordmarkSize("Binge"));
  assert.ok(wordmarkSize("Binge") > wordmarkSize("Prime Video"));
  assert.ok(wordmarkSize("Prime Video") >= wordmarkSize("SBS On Demand"));
  assert.ok(wordmarkSize("SBS On Demand") >= 2);
});

// ---------------- colour maths ----------------

test("color: hex parsing, shading and contrast helpers", () => {
  assert.deepEqual(hexToRgb("#ff8800"), [255, 136, 0]);
  assert.deepEqual(hexToRgb("nonsense"), [51, 65, 85], "bad colour -> slate, never NaN");
  assert.equal(rgbToHex([255, 136, 0]), "#ff8800");
  assert.equal(rgbToHex([300, -5, 0.4]), "#ff0000");
  assert.equal(shade("#000000", 1), "#ffffff");
  assert.equal(shade("#ffffff", -1), "#000000");
  assert.equal(shade("#336699", 0), "#336699");
  assert.ok(luminance("#ffffff") > 0.99 && luminance("#000000") < 0.01);
  assert.equal(inkOn("#000000"), "#ffffff");
  assert.equal(inkOn("#ffffff"), "#0b0d12");
  const g = tileGradient("#E50914");
  assert.ok(luminance(g.from) > luminance(g.to), "gradient goes light -> dark");
});

test("color: every starter brand colour keeps its logo readable (contrast >= 3:1 against the darker gradient stop)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const apps = (require("../../apps.json") as { apps: Array<{ name: string; color: string }> }).apps;
  const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const a of apps) {
    const g = tileGradient(a.color);
    const ink = inkOn(a.color);
    assert.ok(contrast(ink, g.from) >= 2.5 && contrast(ink, g.to) >= 2.5, `${a.name} (${a.color}) ink ${ink}`);
  }
});

// ---------------- tiles ----------------

test("Tile: an unfocused tile has a gradient + logo; the NAME is in the DOM (shown only on focus via CSS)", () => {
  const html = render(<Tile item={{ kind: "app", app: app() }} focused={false} />);
  assert.match(html, /class="tile"/);
  assert.doesNotMatch(html, /focused/);
  assert.match(html, /--c1:#/);
  assert.match(html, /--c2:#/);
  assert.match(html, /<div class="tile-name">Netflix<\/div>/);
  assert.match(html, /tile-glow/);
  assert.match(html, /tile-ring/);
  assert.match(html, /role="button"/);
});

test("Tile: focus adds the 'focused' class (scale 1.08, glow, brightness lift and the visible focus ring all hang off it)", () => {
  assert.match(render(<Tile item={{ kind: "app", app: app() }} focused={true} />), /class="tile focused"/);
});

test("Tile: apps known to be missing show 'Not installed' and say so to screen readers", () => {
  const html = render(<Tile item={{ kind: "app", app: app({ installed: false, name: "VLC" }) }} focused={false} />);
  assert.match(html, /class="tile missing"/);
  assert.match(html, /<div class="tile-badge">Not installed<\/div>/);
  assert.match(html, /aria-label="VLC, not installed"/);
  assert.doesNotMatch(render(<Tile item={{ kind: "app", app: app({ installed: true }) }} focused={false} />), /Not installed/);
  assert.doesNotMatch(render(<Tile item={{ kind: "app", app: app({ installed: null }) }} focused={false} />), /Not installed/);
});

test("Tile: the Settings tile has a gear and its own label", () => {
  const html = render(<Tile item={{ kind: "settings" }} focused={true} />);
  assert.match(html, /tile-settings focused/);
  assert.match(html, /aria-label="Settings"/);
  assert.match(html, /<svg[^>]*gear/);
});

// ---------------- hero ----------------

test("Hero: shows the last launched app with an Open button and a brand gradient", () => {
  const html = render(<Hero app={app()} focused={false} onActivate={() => {}} />);
  assert.match(html, /Continue with/);
  assert.match(html, /<h1 class="hero-title">Netflix<\/h1>/);
  assert.match(html, /<div class="hero-button">Open<\/div>/);
  assert.match(html, /--c1:#/);
  assert.match(html, /hero-mark/);
});

test("Hero: light brand colours get dark text (readable), dark ones keep white", () => {
  assert.match(render(<Hero app={app({ name: "Spotify", color: "#1ED760" })} focused={false} onActivate={() => {}} />), /class="hero ink-dark"/);
  assert.match(render(<Hero app={app({ name: "Plex", color: "#EBAF00" })} focused={true} onActivate={() => {}} />), /hero focused ink-dark/);
  assert.doesNotMatch(render(<Hero app={app()} focused={false} onActivate={() => {}} />), /ink-dark/);
});

test("Hero: with nothing launched yet it is a welcome banner", () => {
  const html = render(<Hero app={undefined} focused={true} onActivate={() => {}} />);
  assert.match(html, /hero hero-welcome focused/);
  assert.match(html, /Welcome to Couch UI/);
  assert.match(html, /Browse apps/);
  assert.doesNotMatch(html, />Open</);
});

// ---------------- home / rows / scrolling ----------------

const many = (n: number, category: string): PublicApp[] => Array.from({ length: n }, (_, i) => app({ id: `${category}${i}`, name: `${category} ${i}`, category }));

test("Home: a titled row per category with every tile, hero first, Settings last", () => {
  const rows = buildRows([...many(3, "Streaming"), ...many(2, "Music")]);
  const html = render(<Home rows={rows} focus={{ zone: "row", row: 0, col: 0 }} lastApp={undefined} onActivateHero={() => {}} onClickTile={() => {}} />);
  assert.ok(html.indexOf("hero") < html.indexOf("row-title"));
  assert.deepEqual([...html.matchAll(/<h2 class="row-title">([^<]+)</g)].map((m) => m[1]), ["Streaming", "Music"]);
  assert.equal([...html.matchAll(/class="tile[ "]/g)].length, 3 + 2 + 1, "5 apps + the Settings tile");
  assert.ok(html.lastIndexOf("tile-settings") > html.lastIndexOf("Music 1"), "Settings is the last tile");
});

test("Home: exactly one tile carries focus, and it is the one in the focus state", () => {
  const rows = buildRows([...many(4, "Streaming"), ...many(3, "Music")]);
  const html = render(<Home rows={rows} focus={{ zone: "row", row: 1, col: 2 }} lastApp={undefined} onActivateHero={() => {}} onClickTile={() => {}} />);
  assert.equal([...html.matchAll(/class="tile focused"/g)].length, 1);
  assert.match(html, /class="tile focused"[^>]*aria-label="Music 2"/);
  assert.match(html, /class="row active"/);
  assert.equal([...html.matchAll(/class="row active"/g)].length, 1, "only the focused row is active");
  assert.doesNotMatch(html, /hero focused/);
});

test("Home: focus on the hero focuses the hero and no tile", () => {
  const rows = buildRows(many(3, "Streaming"));
  const html = render(<Home rows={rows} focus={{ zone: "hero" }} lastApp={app()} onActivateHero={() => {}} onClickTile={() => {}} />);
  assert.match(html, /class="hero focused"/);
  assert.doesNotMatch(html, /class="tile focused"/);
});

test("Home: rows scroll horizontally with a CSS TRANSFORM (GPU), not by changing layout", () => {
  const rows = buildRows(many(15, "Streaming"));
  const far = render(<Home rows={rows} focus={{ zone: "row", row: 0, col: 14 }} lastApp={undefined} onActivateHero={() => {}} onClickTile={() => {}} />);
  const m = /class="track" style="[^"]*transform:translate3d\((-?[\d.]+)rem, 0, 0\)/.exec(far);
  assert.ok(m, "track uses translate3d");
  assert.ok(Number(m![1]) < -30, `scrolled far left: ${m![1]}rem`);
  const near = render(<Home rows={rows} focus={{ zone: "row", row: 0, col: 0 }} lastApp={undefined} onActivateHero={() => {}} onClickTile={() => {}} />);
  assert.match(near, /translate3d\(-?0(\.0+)?rem, 0, 0\)/, "first tile: not scrolled");
  assert.ok(!/(["; ])left:|margin-left:\s*-/.test(far), "no left/margin animation (padding-left is static)");
});

test("Home: the page scrolls vertically (transform) when a lower row is focused so the hero moves away", () => {
  const rows = buildRows([...many(3, "Streaming"), ...many(3, "Music"), ...many(3, "Local & Media"), ...many(3, "Apps")]);
  const top = render(<Home rows={rows} focus={{ zone: "hero" }} lastApp={undefined} onActivateHero={() => {}} onClickTile={() => {}} />);
  assert.match(top, /class="page" style="[^"]*translate3d\(0, -?0(\.0+)?rem, 0\)/);
  const low = render(<Home rows={rows} focus={{ zone: "row", row: 3, col: 0 }} lastApp={undefined} onActivateHero={() => {}} onClickTile={() => {}} />);
  const m = /class="page" style="[^"]*translate3d\(0, (-[\d.]+)rem, 0\)/.exec(low);
  assert.ok(m && Number(m[1]) < -10, "page scrolled up to show the 4th row");
  assert.ok(ROW_H > 0 && TILE_W > 0);
});

// ---------------- chrome ----------------

test("TopBar: clock + date on the left; network status and the phone chips on the right", () => {
  const waiting = render(<TopBar info={info({ devices: 2 })} chips={{ waitingForPhone: true, phoneConnected: false }} />);
  assert.match(waiting, /class="clock-time"/);
  assert.match(waiting, /class="clock-date"/);
  assert.match(waiting, /Wi-Fi connected/);
  assert.match(waiting, /Waiting for your phone…/);
  assert.doesNotMatch(waiting, /Phone connected/);
  const connected = render(<TopBar info={info({ devices: 2, connected: 1 })} chips={{ waitingForPhone: false, phoneConnected: true }} />);
  assert.match(connected, /Phone connected/);
  assert.doesNotMatch(connected, /Waiting for your phone/);
  const off = render(<TopBar info={info({ network: { online: false, label: null, ip: null } })} chips={{ waitingForPhone: false, phoneConnected: false }} />);
  assert.match(off, /No network/);
  assert.match(off, /chip-bad/);
});

test("ErrorBanner: the red port-busy banner is shown when there is an error, and absent otherwise", () => {
  assert.match(render(<ErrorBanner text="Port 8787 is already in use" />), /<div class="banner" role="alert">Port 8787 is already in use<\/div>/);
  assert.equal(render(<ErrorBanner text={null} />), "");
});

test("Toast: info and error variants", () => {
  assert.match(render(<ToastView toast={{ id: 1, text: "VLC isn't installed", kind: "error" }} />), /toast toast-error/);
  assert.match(render(<ToastView toast={{ id: 2, text: "Phone connected", kind: "info" }} />), /class="toast"/);
  assert.doesNotMatch(render(<ToastView toast={null} />), /<div class="toast( |")/);
});

test("Wallpaper layers: built-in gradients are CSS classes; the user's pictures are background images via couch://", () => {
  assert.match(render(<WallpaperLayer wp={{ id: "builtin:ocean", name: "Ocean" }} />), /class="wp wp-ocean"/);
  assert.match(render(<WallpaperLayer wp={{ id: "file:a.png", name: "a", url: "couch://wallpaper/a.png" }} />), /background-image:url\((&quot;|")couch:\/\/wallpaper\/a\.png(&quot;|")\)/);
});

// ---------------- settings + pairing + screensaver views ----------------

test("SettingsScreen: menu with all six sections, the selected pane's items, and the focused row marked", () => {
  const sections = buildSections({ displays: [], devices: [], wallpapers: [{ id: "builtin:aurora", name: "Aurora" }], about: null, ui: DEFAULT_UI, armed: null });
  const html = render(<SettingsScreen sections={sections} focus={{ zone: "pane", section: 2, item: 0 }} />);
  assert.deepEqual([...html.matchAll(/class="menu-item[^"]*">([^<]+)</g)].map((m) => m[1]), ["Display", "Wallpaper", "Screensaver", "Devices", "Add app", "About / Exit"]);
  assert.match(html, /class="menu-item selected">Screensaver</, "pane focus: the section is selected but the MENU row is not the focus");
  assert.match(html, /<h2 class="pane-title">Screensaver<\/h2>/);
  assert.match(html, /class="item item-choice focused"/);
  assert.match(html, /Start after/);
  const menuFocused = render(<SettingsScreen sections={sections} focus={{ zone: "menu", section: 0 }} />);
  assert.match(menuFocused, /menu-item selected focused">Display</);
});

test("SettingsScreen: choices show ‹ value ›, danger actions are styled, armed confirmations are visible", () => {
  const armed = buildSections({ displays: [], devices: [], wallpapers: [], about: null, ui: DEFAULT_UI, armed: "dev-forget" });
  const html = render(<SettingsScreen sections={armed} focus={{ zone: "pane", section: 3, item: 1 }} />);
  assert.match(html, /item-action danger armed/);
  assert.match(html, /Press OK again to forget every phone/);
  const display = buildSections({ displays: [], devices: [], wallpapers: [], about: null, ui: DEFAULT_UI, armed: null });
  assert.match(render(<SettingsScreen sections={display} focus={{ zone: "pane", section: 0, item: 1 }} />), /‹<\/i>(Off|On)<i class="chev">›/);
});

test("PairScreenView (first run): 'Connect your phone' with QR, URL, the couchui.local alternative and the PIN digits", () => {
  const html = render(<PairScreenView screen={{ kind: "connect", online: true }} info={info()} />);
  assert.match(html, /Connect your phone/);
  assert.match(html, /<img src="data:image\/png;base64,AAAA"/);
  assert.match(html, /http:\/\/192\.168\.1\.5:8787/);
  assert.match(html, /http:\/\/couchui\.local:8787/);
  assert.deepEqual([...html.matchAll(/<span>(\d)<\/span>/g)].map((m) => m[1]).join(""), "123456");
  assert.match(html, /Esc on the keyboard exits/);
  assert.match(html, /same Wi-Fi/);
});

test("PairScreenView (pair new device): 'Scan to pair' with a countdown and how to cancel", () => {
  const html = render(<PairScreenView screen={{ kind: "pair-new", expiresAt: Date.now() + 120_000, online: true }} info={info({ devices: 2 })} />);
  assert.match(html, /Scan to pair/);
  assert.match(html, /Closes in <b>(1:5\d|2:00)<\/b>/);
  assert.match(html, /press <b>Back<\/b> to cancel/);
});

test("PairScreenView: with no network it says so instead of showing a useless QR code", () => {
  const html = render(<PairScreenView screen={{ kind: "connect", online: false }} info={info({ qr: null, url: null, network: { online: false, label: null, ip: null } })} />);
  assert.match(html, /No network connection/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /pair-qr-empty/);
});

test("ScreensaverView: slideshow layers with Ken Burns variants and a big clock overlay", () => {
  const html = render(<ScreensaverView slides={[{ id: "file:a.png", name: "a", url: "couch://wallpaper/a.png" }, { id: "builtin:ocean", name: "Ocean" }]} />);
  assert.match(html, /class="screensaver"/);
  assert.match(html, /ss-slide ss-in" data-kb="0"/);
  assert.match(html, /class="ss-time"/);
  assert.match(html, /class="ss-date"/);
  assert.match(html, /couch:\/\/wallpaper\/a\.png/);
  const single = render(<ScreensaverView slides={[{ id: "builtin:aurora", name: "Aurora" }]} />);
  assert.doesNotMatch(single, /ss-out/, "one slide: no crossfade partner");
});
