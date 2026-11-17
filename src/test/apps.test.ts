import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AppDef, LaunchDeps, expandEnv, installedState, launchApp, loadApps, parseApps } from "../apps";
import { resolveBrowser } from "../browser";
import { createIconLookup, loadIconFile, normalizeSlug } from "../icons";
import { customImageUrl, ensureDir, findCustomImage, listWallpapers, resolveCustom, resolveInside, resolveWallpaper } from "../wallpapers";
import { createSettingsStore } from "../settings";
import { DEFAULT_UI } from "../uiSettings";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tvui-apps-"));
const touch = (p: string, content = "x") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

// ===========================================================================
// apps.json
// ===========================================================================

const good = (over: Record<string, unknown> = {}) => ({ id: "x", name: "X", category: "Streaming", launch: "url", target: "https://x.com", color: "#112233", ...over });

test("apps.json: a valid entry is accepted with all its fields", () => {
  const r = parseApps({ apps: [good({ icon: "netflix", image: "x.png" })] });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.apps[0], { id: "x", name: "X", category: "Streaming", launch: "url", target: "https://x.com", color: "#112233", icon: "netflix", image: "x.png" });
});

test("apps.json: defaults (category 'Apps', colour slate) and trimming", () => {
  const a = parseApps({ apps: [{ id: "a", name: "  A  ", launch: "exe", target: " C:\\a.exe " }] }).apps[0];
  assert.equal(a.name, "A");
  assert.equal(a.category, "Apps");
  assert.equal(a.color, "#334155");
  assert.equal(a.target, "C:\\a.exe");
});

test("apps.json: bad entries are skipped with a reason, good ones survive (one typo never blanks the launcher)", () => {
  const r = parseApps({ apps: [
    good({ id: "ok1" }),
    good({ id: "Bad Id" }), good({ id: "" }), good({ id: "ok1" }),
    good({ id: "n1", name: "" }), good({ id: "n2", name: "x".repeat(41) }),
    good({ id: "l1", launch: "powershell" }), good({ id: "t1", target: "" }),
    good({ id: "u1", target: "javascript:alert(1)" }), good({ id: "u2", target: "file:///C:/Windows/System32/cmd.exe" }), good({ id: "u3", target: "ftp://x" }),
    5, null, "str",
    good({ id: "ok2", icon: "../../etc", image: "..\\..\\evil.png", color: "red", category: "" }),
  ] });
  assert.deepEqual(r.apps.map((a) => a.id), ["ok1", "ok2"]);
  assert.equal(r.problems.length, 13);
  const ok2 = r.apps[1];
  assert.ok(!("icon" in ok2) && !("image" in ok2), "unsafe icon key / image path dropped");
  assert.equal(ok2.color, "#334155");
  assert.equal(ok2.category, "Apps");
});

test("apps.json: wrong top-level shape and unreadable files are reported, not thrown", () => {
  assert.equal(parseApps(null).apps.length, 0);
  assert.equal(parseApps([]).apps.length, 0);
  assert.equal(parseApps({ apps: "no" }).apps.length, 0);
  assert.equal(parseApps({}).problems.length, 1);
  const dir = tmp();
  const missing = loadApps(path.join(dir, "nope.json"));
  assert.equal(missing.apps.length, 0);
  assert.match(missing.problems[0], /Could not read/);
  touch(path.join(dir, "bad.json"), "{ not json");
  assert.equal(loadApps(path.join(dir, "bad.json")).apps.length, 0);
  touch(path.join(dir, "bom.json"), "\uFEFF" + JSON.stringify({ apps: [good()] }));
  assert.equal(loadApps(path.join(dir, "bom.json")).apps.length, 1, "UTF-8 BOM from Notepad tolerated");
});

test("the shipped apps.json: all starter apps present, valid, unique, in the right rows, with the right launch types", () => {
  const file = path.join(__dirname, "..", "..", "apps.json");
  const r = loadApps(file);
  assert.deepEqual(r.problems, []);
  const names = r.apps.map((a) => a.name);
  for (const n of ["Netflix", "YouTube", "Disney+", "Prime Video", "Apple TV", "Max", "Paramount+", "Stan", "Binge", "Kayo", "ABC iview", "SBS On Demand", "9Now", "7plus", "10",
    "Spotify", "Apple Music", "YouTube Music", "VLC", "Stremio", "Plex", "Jellyfin", "Kodi", "Browser"]) {
    assert.ok(names.includes(n), `${n} is a starter app`);
  }
  assert.equal(r.apps.length, 24);
  assert.equal(new Set(r.apps.map((a) => a.id)).size, 24);
  const cat = (c: string) => r.apps.filter((a) => a.category === c).map((a) => a.name);
  assert.equal(cat("Streaming").length, 15);
  assert.deepEqual(cat("Music"), ["Spotify", "Apple Music", "YouTube Music"]);
  assert.deepEqual(cat("Local & Media"), ["VLC", "Stremio", "Plex", "Jellyfin", "Kodi"]);
  assert.deepEqual(cat("Apps"), ["Browser"]);
  for (const a of r.apps) assert.ok(a.launch === "exe" ? /^%|^[A-Z]:\\/i.test(a.target) : /^https:\/\//.test(a.target), `${a.id} target`);
  assert.ok(r.apps.filter((a) => a.launch === "exe").map((a) => a.name).join() === "VLC,Stremio,Plex,Jellyfin,Kodi");
});

test("the shipped apps.json: every icon key is a real simple-icons logo; apps WITHOUT one are exactly the brands simple-icons lacks", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const si = require("simple-icons") as Record<string, { slug?: string }>;
  const slugs = new Set(Object.values(si).map((v) => v?.slug).filter(Boolean));
  const r = loadApps(path.join(__dirname, "..", "..", "apps.json"));
  for (const a of r.apps.filter((x) => x.icon)) assert.ok(slugs.has(a.icon!), `${a.name}: simple-icons has "${a.icon}"`);
  const wordmarks = r.apps.filter((a) => !a.icon).map((a) => a.name).sort();
  assert.deepEqual(wordmarks, ["10", "7plus", "9Now", "ABC iview", "Binge", "Browser", "Disney+", "Kayo", "Prime Video", "SBS On Demand", "Stan"]);
});

test("expandEnv: %VAR% is case-insensitive, unknown variables stay visible, no recursion", () => {
  const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\T\\AppData\\Local" };
  assert.equal(expandEnv("%ProgramFiles%\\VLC\\vlc.exe", env), "C:\\Program Files\\VLC\\vlc.exe");
  assert.equal(expandEnv("%programfiles%\\x", env), "C:\\Program Files\\x");
  assert.equal(expandEnv("%LocalAppData%\\Programs", env), "C:\\Users\\T\\AppData\\Local\\Programs");
  assert.equal(expandEnv("%NOPE%\\x", env), "%NOPE%\\x");
  assert.equal(expandEnv("100% sure", env), "100% sure");
  assert.equal(expandEnv("%A%%ProgramFiles%", { A: "%ProgramFiles%", ProgramFiles: "P" }), "%ProgramFiles%P", "single pass only");
});

// ===========================================================================
// Launching
// ===========================================================================

function deps(over: Partial<LaunchDeps> & { files?: string[]; log?: string[] } = {}): LaunchDeps & { log: string[] } {
  const log = over.log ?? [];
  const files = new Set((over.files ?? []).map((f) => f.toLowerCase()));
  return {
    exists: (p) => files.has(p.toLowerCase()),
    env: { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\L" },
    openExternal: async (u) => { log.push(`open ${u}`); },
    spawnDetached: async (f, a) => { log.push(`spawn ${f} ${a.join(" ")}`.trim()); },
    listStoreApps: async () => null,
    browser: "default",
    ...over,
    log,
  };
}
const def = (over: Partial<AppDef>): AppDef => ({ id: "a", name: "A", category: "Apps", launch: "url", target: "https://a.com", color: "#000000", ...over });

test("launch url: opens in the DEFAULT browser by default", async () => {
  const d = deps();
  assert.deepEqual(await launchApp(def({}), d), { ok: true });
  assert.deepEqual(d.log, ["open https://a.com"]);
});

test("launch url: uses the browser from config when installed; falls back to the default browser (not an error) when it is missing", async () => {
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  let d = deps({ browser: "chrome", files: [chrome] });
  assert.deepEqual(await launchApp(def({}), d), { ok: true });
  assert.deepEqual(d.log, [`spawn ${chrome} https://a.com`]);
  d = deps({ browser: "chrome" });
  assert.deepEqual(await launchApp(def({}), d), { ok: true });
  assert.deepEqual(d.log, ["open https://a.com"], "chrome missing -> default browser");
  d = deps({ browser: "C:\\Tools\\mybrowser.exe", files: ["C:\\Tools\\mybrowser.exe"] });
  await launchApp(def({}), d);
  assert.deepEqual(d.log, ["spawn C:\\Tools\\mybrowser.exe https://a.com"]);
});

test("launch exe: expands %ENV%, spawns it, and a missing program is 'not installed' (never an exception)", async () => {
  const vlc = "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe";
  let d = deps({ files: [vlc] });
  assert.deepEqual(await launchApp(def({ launch: "exe", target: "%ProgramFiles%\\VideoLAN\\VLC\\vlc.exe", name: "VLC" }), d), { ok: true });
  assert.deepEqual(d.log, [`spawn ${vlc}`]);
  d = deps();
  const r = await launchApp(def({ launch: "exe", target: "%ProgramFiles%\\VideoLAN\\VLC\\vlc.exe", name: "VLC" }), d);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "not-installed");
    assert.match(r.message, /VLC isn't installed/);
    assert.ok(r.message.includes(vlc), "says where it looked");
  }
  assert.deepEqual(d.log, [], "nothing was started");
});

test("launch exe: a program that exists but fails to start is reported as a failure", async () => {
  const d = deps({ files: ["C:\\a.exe"], spawnDetached: async () => { throw new Error("EACCES"); } });
  const r = await launchApp(def({ launch: "exe", target: "C:\\a.exe" }), d);
  assert.deepEqual(r, { ok: false, code: "failed", message: "Could not open A: EACCES" });
});

test("launch store-app: installed -> explorer shell:AppsFolder; not in the list -> 'not installed'; list unavailable -> still tries", async () => {
  const aumid = "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App";
  let d = deps({ listStoreApps: async () => new Set([aumid]) });
  assert.deepEqual(await launchApp(def({ launch: "store-app", target: aumid }), d), { ok: true });
  assert.deepEqual(d.log, [`spawn explorer.exe shell:AppsFolder\\${aumid}`]);
  d = deps({ listStoreApps: async () => new Set(["Other!App"]) });
  const r = await launchApp(def({ launch: "store-app", target: aumid, name: "Apple Music" }), d);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "not-installed");
  assert.deepEqual(d.log, [], "Windows' own 'app not found' dialog is never triggered");
  d = deps({ listStoreApps: async () => null });
  assert.deepEqual(await launchApp(def({ launch: "store-app", target: aumid }), d), { ok: true });
});

test("launch store-app: protocol targets (e.g. ms-windows-store:) open directly", async () => {
  const d = deps();
  assert.deepEqual(await launchApp(def({ launch: "store-app", target: "ms-windows-store://home" }), d), { ok: true });
  assert.deepEqual(d.log, ["open ms-windows-store://home"]);
  const d2 = deps();
  await launchApp(def({ launch: "store-app", target: "C:\\x\\y.exe" }), d2);
  assert.ok(d2.log[0].startsWith("spawn explorer.exe"), "a Windows path is not mistaken for a protocol");
});

test("launch: an exception from openExternal is contained", async () => {
  const d = deps({ openExternal: async () => { throw new Error("no handler"); } });
  assert.deepEqual(await launchApp(def({}), d), { ok: false, code: "failed", message: "Could not open A: no handler" });
});

test("installedState: only exe apps can be known-missing (drives the tile's 'Not installed' badge)", () => {
  const env = { ProgramFiles: "C:\\P" };
  const exists = (p: string) => p === "C:\\P\\ok.exe";
  assert.equal(installedState(def({ launch: "exe", target: "%ProgramFiles%\\ok.exe" }), { exists, env }), true);
  assert.equal(installedState(def({ launch: "exe", target: "%ProgramFiles%\\gone.exe" }), { exists, env }), false);
  assert.equal(installedState(def({ launch: "url" }), { exists, env }), null);
  assert.equal(installedState(def({ launch: "store-app", target: "X!App" }), { exists, env }), null);
});

// ===========================================================================
// Browser resolution
// ===========================================================================

test("browser: default / blank / missing setting -> system default", () => {
  const d = { exists: () => false, env: {} };
  for (const s of [undefined, "", "default", "DEFAULT", "  default "]) assert.deepEqual(resolveBrowser(s, d), { kind: "default" });
});

test("browser: names resolve to the first existing install location; absent -> 'missing'", () => {
  const env = { ProgramFiles: "C:\\P", "ProgramFiles(x86)": "C:\\P86", LOCALAPPDATA: "C:\\L" };
  assert.deepEqual(resolveBrowser("edge", { exists: (p) => p === "C:\\P86\\Microsoft\\Edge\\Application\\msedge.exe", env }), { kind: "exe", path: "C:\\P86\\Microsoft\\Edge\\Application\\msedge.exe" });
  assert.deepEqual(resolveBrowser("Chrome", { exists: (p) => p === "C:\\L\\Google\\Chrome\\Application\\chrome.exe", env }), { kind: "exe", path: "C:\\L\\Google\\Chrome\\Application\\chrome.exe" });
  assert.deepEqual(resolveBrowser("firefox", { exists: () => false, env }), { kind: "missing", wanted: "firefox" });
  assert.equal(resolveBrowser("brave", { exists: (p) => p.endsWith("brave.exe"), env }).kind, "exe");
});

test("browser: an explicit path must be an existing .exe", () => {
  const env = { ProgramFiles: "C:\\P" };
  assert.deepEqual(resolveBrowser("%ProgramFiles%\\Br\\br.exe", { exists: () => true, env }), { kind: "exe", path: "C:\\P\\Br\\br.exe" });
  assert.equal(resolveBrowser("C:\\Br\\br.exe", { exists: () => false, env }).kind, "missing");
  assert.equal(resolveBrowser("C:\\Br\\readme.txt", { exists: () => true, env }).kind, "missing", "not an exe");
  assert.equal(resolveBrowser("notabrowser", { exists: () => true, env }).kind, "missing");
});

// ===========================================================================
// Wallpapers + custom images
// ===========================================================================

test("wallpapers: lists jpg/jpeg/png/webp (any case), sorted naturally; ignores other files, folders and hidden files", () => {
  const dir = tmp();
  for (const n of ["b.jpg", "a.PNG", "c.webp", "d.jpeg", "img10.png", "img2.png", "notes.txt", "clip.mp4", "pic.gif", ".hidden.png", "pic.png.exe"]) touch(path.join(dir, n));
  fs.mkdirSync(path.join(dir, "sub.png")); // a FOLDER with an image-like name
  touch(path.join(dir, "sub", "inner.png"));
  const list = listWallpapers(dir);
  assert.deepEqual(list.map((w) => w.name), ["a.PNG", "b.jpg", "c.webp", "d.jpeg", "img2.png", "img10.png"]);
  assert.equal(list[0].url, "couch://wallpaper/a.PNG");
});

test("wallpapers: names with spaces and unicode are URL-encoded", () => {
  const dir = tmp();
  touch(path.join(dir, "My Photo (1) é.jpg"));
  const [w] = listWallpapers(dir);
  assert.equal(w.url, "couch://wallpaper/My%20Photo%20(1)%20%C3%A9.jpg");
  assert.equal(resolveWallpaper(dir, "My%20Photo%20(1)%20%C3%A9.jpg"), path.join(dir, "My Photo (1) é.jpg"));
});

test("wallpapers: a missing or unreadable folder is empty, and ensureDir creates it (even nested)", () => {
  const dir = tmp();
  assert.deepEqual(listWallpapers(path.join(dir, "nope")), []);
  assert.equal(ensureDir(path.join(dir, "a", "b", "wallpapers")), true);
  assert.ok(fs.statSync(path.join(dir, "a", "b", "wallpapers")).isDirectory());
  touch(path.join(dir, "file"), "x");
  assert.equal(ensureDir(path.join(dir, "file", "sub")), false, "returns false instead of throwing");
});

test("couch:// path safety: only plain image names inside the folder resolve", () => {
  const root = tmp();
  touch(path.join(root, "ok.png"));
  assert.equal(resolveWallpaper(root, "ok.png"), path.join(root, "ok.png"));
  const attacks = [
    "../x.png", "..%2Fx.png", "%2e%2e%2fx.png", "..\\x.png", "..%5Cx.png", "a/../x.png", "sub/x.png", "sub%2Fx.png",
    "C:\\Windows\\win.ini", "C%3A%5CWindows%5Cwin.ini", "/etc/passwd", "ok.png/", "", ".", "..", "...", "x.png\u0000.txt", "x.png%00", "settings.json", "ok.exe", "ok.svg",
    "con.png:stream", "a|b.png", "a?b.png", "a*b.png", "%E0%A4%A", "x".repeat(300) + ".png",
  ];
  for (const a of attacks) assert.equal(resolveWallpaper(root, a), null, JSON.stringify(a));
  assert.equal(resolveInside(root, "ok.PNG", [".png"]), path.join(root, "ok.PNG"), "extension check is case-insensitive");
});

test("custom app images: png/svg/jpg/webp allowed; svg is NOT allowed as a wallpaper", () => {
  const root = tmp();
  assert.ok(resolveCustom(root, "stan.svg"));
  assert.equal(resolveWallpaper(root, "stan.svg"), null);
  assert.equal(resolveCustom(root, "../stan.svg"), null);
});

test("custom app images: <id>.png etc. is auto-detected in assets/custom; apps.json 'image' overrides; traversal in 'image' is ignored", () => {
  const dir = tmp();
  touch(path.join(dir, "stan.svg"));
  touch(path.join(dir, "special-logo.webp"));
  assert.equal(findCustomImage(dir, "stan"), "stan.svg");
  assert.equal(findCustomImage(dir, "kayo"), "kayo.PNG".toLowerCase() === "kayo.png" ? findCustomImage(dir, "kayo") : null);
  assert.equal(findCustomImage(dir, "binge"), null);
  assert.equal(findCustomImage(dir, "binge", "special-logo.webp"), "special-logo.webp");
  assert.equal(findCustomImage(dir, "binge", "../../secret.png"), null);
  assert.equal(findCustomImage(path.join(dir, "missing"), "stan"), null);
  assert.equal(customImageUrl("My Logo.png"), "couch://asset/My%20Logo.png");
});

// ===========================================================================
// Icons
// ===========================================================================

test("icons: lookups are case/punctuation tolerant; unknown brands return null (-> wordmark tile)", () => {
  const lookup = createIconLookup(() => ({ netflix: { t: "Netflix", h: "E50914", p: "M0 0h24v24H0z" }, applemusic: { t: "Apple Music", h: "FA243C", p: "M1 1" } }));
  assert.equal(lookup.path("netflix"), "M0 0h24v24H0z");
  assert.equal(lookup.path("Netflix"), "M0 0h24v24H0z");
  assert.equal(lookup.path("Apple-Music"), "M1 1");
  assert.equal(lookup.path("stan"), null);
  assert.equal(lookup.path(undefined), null);
  assert.equal(lookup.path(""), null);
  assert.equal(lookup.size(), 2);
  assert.equal(normalizeSlug("YouTube Music!"), "youtubemusic");
});

test("icons: a missing or corrupt data file degrades to 'no logos' (wordmarks), never an error; the data loads lazily, once", () => {
  assert.equal(createIconLookup(() => null).path("netflix"), null);
  assert.equal(createIconLookup(() => { throw new Error("disk"); }).path("netflix"), null);
  let loads = 0;
  const l = createIconLookup(() => { loads++; return { a: { t: "A", h: "000000", p: "M0" } }; });
  assert.equal(loads, 0);
  l.path("a"); l.path("a"); l.size();
  assert.equal(loads, 1);
  const dir = tmp();
  assert.equal(loadIconFile(path.join(dir, "none.json")), null);
  touch(path.join(dir, "bad.json"), "{{");
  assert.equal(loadIconFile(path.join(dir, "bad.json")), null);
  touch(path.join(dir, "ok.json"), JSON.stringify({ a: { t: "A", h: "000000", p: "M0" } }));
  assert.equal(loadIconFile(path.join(dir, "ok.json"))?.a.p, "M0");
});

// ===========================================================================
// settings.json: ui preferences persist
// ===========================================================================

test("settings store: UI preferences persist, are validated on load, and display settings are untouched", () => {
  const file = path.join(tmp(), "settings.json");
  const a = createSettingsStore(file);
  assert.deepEqual(a.get().ui, DEFAULT_UI);
  a.setDisplay({ id: 3, label: "TV", width: 1920, height: 1080 });
  const saved = a.setUi({ screensaverMinutes: 10, reduceEffects: true, wallpaper: { mode: "rotate", minutes: 5 }, lastLaunchedId: "netflix" });
  assert.equal(saved.screensaverMinutes, 10);
  const b = createSettingsStore(file);
  assert.equal(b.get().ui.reduceEffects, true);
  assert.deepEqual(b.get().ui.wallpaper, { mode: "rotate", id: "builtin:aurora", minutes: 5 });
  assert.equal(b.get().ui.lastLaunchedId, "netflix");
  assert.equal(b.get().display?.id, 3);
  fs.writeFileSync(file, JSON.stringify({ display: null, ui: { screensaverMinutes: 999, wallpaper: { id: "../../x" }, reduceEffects: "maybe" } }));
  const c = createSettingsStore(file);
  assert.equal(c.get().ui.screensaverMinutes, 30, "snapped to an allowed value");
  assert.equal(c.get().ui.wallpaper.id, "builtin:aurora", "unsafe id rejected");
  assert.equal(c.get().ui.reduceEffects, false);
  fs.writeFileSync(file, "garbage");
  assert.deepEqual(createSettingsStore(file).get().ui, DEFAULT_UI);
});

test("settings store: setUi ignores hostile patches from the renderer", () => {
  const file = path.join(tmp(), "settings.json");
  const s = createSettingsStore(file);
  const ui = s.setUi({ screensaverMinutes: "x", wallpaper: { id: "file:../../evil.png", minutes: -1 }, lastLaunchedId: "../..", extra: 1, __proto__: { x: 1 } });
  assert.deepEqual(ui, { ...DEFAULT_UI, wallpaper: { ...DEFAULT_UI.wallpaper, minutes: 1 } });
});

// ===========================================================================
// Packaging guard
// ===========================================================================

test("PACKAGING: no main-process module requires anything from dist/ui/ (which is not shipped in the installed app)", () => {
  const dist = path.join(__dirname, "..");
  const offenders: string[] = [];
  for (const f of fs.readdirSync(dist).filter((n) => n.endsWith(".js"))) {
    const text = fs.readFileSync(path.join(dist, f), "utf8");
    for (const m of text.matchAll(/require\("(\.\/ui\/[^"]+)"\)/g)) offenders.push(`${f} -> ${m[1]}`);
  }
  assert.deepEqual(offenders, [], "ui/ is bundled separately by Vite; shared code belongs at the top level of src/");
});

test("PACKAGING: everything the main process needs at runtime is covered by the packaged file list", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
  const files: string[] = pkg.build.files;
  for (const need of ["dist/**/*", "ui-dist/**/*", "apps.json", "config.json", "build/simple-icons.json", "build/icon.png", "src/remote/index.html", "src/remote/remote.css"]) {
    assert.ok(files.includes(need), `build.files includes ${need}`);
  }
  assert.ok(files.includes("!dist/test/**") && files.includes("!dist/ui/**"), "tests and unused UI sources are left out");
});
