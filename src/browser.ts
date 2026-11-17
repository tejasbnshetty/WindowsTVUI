// Which browser URL apps open in (config.json "browser").
//   "default" (or missing)       -> the system default browser
//   "chrome" | "edge" | "firefox" | "brave" -> that browser, if it is installed
//   an absolute path to an .exe  -> that program
// A browser that cannot be found is never an error: the caller falls back to the default browser.
import { expandEnv } from "./env";

export interface BrowserDeps {
  exists(path: string): boolean;
  env: NodeJS.ProcessEnv;
}

export type BrowserChoice =
  | { kind: "default" }
  | { kind: "exe"; path: string }
  | { kind: "missing"; wanted: string };

const KNOWN: Record<string, string[]> = {
  chrome: [
    "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
    "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
    "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
  ],
  edge: [
    "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
    "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  firefox: [
    "%ProgramFiles%\\Mozilla Firefox\\firefox.exe",
    "%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe",
  ],
  brave: [
    "%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  ],
};

export function resolveBrowser(setting: string | undefined, deps: BrowserDeps): BrowserChoice {
  const s = (setting ?? "default").trim();
  if (!s || s.toLowerCase() === "default") return { kind: "default" };

  const known = KNOWN[s.toLowerCase()];
  if (known) {
    for (const candidate of known) {
      const p = expandEnv(candidate, deps.env);
      if (deps.exists(p)) return { kind: "exe", path: p };
    }
    return { kind: "missing", wanted: s };
  }

  const p = expandEnv(s, deps.env);
  return /\.exe$/i.test(p) && deps.exists(p) ? { kind: "exe", path: p } : { kind: "missing", wanted: s };
}
