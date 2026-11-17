// Bringing the launcher to the front WITH keyboard focus.
//
// Windows deliberately blocks SetForegroundWindow from a process that is not already the
// foreground one ("foreground lock"), so a plain call often just flashes the taskbar. This tries a
// ladder of well-known workarounds, verifying after each one whether we actually got the focus:
//   1. SetForegroundWindow
//   2. AttachThreadInput to the current foreground thread, then SetForegroundWindow
//   3. SwitchToThisWindow
//   4. a synthetic Alt key tap (an injected input event lifts the lock), then SetForegroundWindow
// If every rung fails the caller gets { ok: false } and falls back to a topmost pulse.

export const SW_SHOW = 5;
export const SW_RESTORE = 9;

export interface ForegroundApi {
  getForegroundWindow(): number;
  /** Thread that owns the window (0 if the window is gone). */
  getWindowThreadId(hwnd: number): number;
  getCurrentThreadId(): number;
  attachThreadInput(idAttach: number, idAttachTo: number, attach: boolean): boolean;
  setForegroundWindow(hwnd: number): boolean;
  bringWindowToTop(hwnd: number): boolean;
  showWindow(hwnd: number, cmd: number): boolean;
  switchToThisWindow(hwnd: number): void;
  isIconic(hwnd: number): boolean;
}

export interface ForegroundDeps {
  api: ForegroundApi;
  /** Taps the Alt key (injected input). May be a no-op if input injection is unavailable. */
  altTap(): void;
  sleep?(ms: number): Promise<void>;
  log?(msg: string): void;
}

export type ForegroundMethod = "already" | "direct" | "attach" | "switch" | "alt-tap";

export interface ForegroundResult {
  ok: boolean;
  /** Which rung worked, or "failed". */
  method: ForegroundMethod | "failed";
  /** Every rung that was attempted, in order. */
  tried: string[];
}

export interface Foreground {
  force(hwnd: number): Promise<ForegroundResult>;
}

export function createForeground(deps: ForegroundDeps): Foreground {
  const { api, altTap } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => {});

  const isForeground = (hwnd: number) => api.getForegroundWindow() === hwnd;

  /** Foreground changes can land a few ms after the call returns. */
  async function settle(hwnd: number): Promise<boolean> {
    if (isForeground(hwnd)) return true;
    for (let i = 0; i < 3; i++) {
      await sleep(20);
      if (isForeground(hwnd)) return true;
    }
    return false;
  }

  async function attempt(name: string, tried: string[], fn: () => void | Promise<void>, hwnd: number): Promise<boolean> {
    tried.push(name);
    try {
      await fn();
    } catch (err) {
      log(`foreground step "${name}" threw: ${String(err)}`);
      return false;
    }
    return settle(hwnd);
  }

  return {
    async force(hwnd) {
      const tried: string[] = [];
      try {
        if (api.isIconic(hwnd)) api.showWindow(hwnd, SW_RESTORE);
      } catch (err) {
        log(`restore failed: ${String(err)}`);
      }

      if (isForeground(hwnd)) return { ok: true, method: "already", tried };

      if (await attempt("direct", tried, () => { api.setForegroundWindow(hwnd); }, hwnd)) {
        return { ok: true, method: "direct", tried };
      }

      const attached = await attempt("attach", tried, () => {
        const fg = api.getForegroundWindow();
        const fgThread = fg ? api.getWindowThreadId(fg) : 0;
        const me = api.getCurrentThreadId();
        let didAttach = false;
        try {
          if (fgThread && fgThread !== me) didAttach = api.attachThreadInput(me, fgThread, true);
          api.bringWindowToTop(hwnd);
          api.showWindow(hwnd, SW_SHOW);
          api.setForegroundWindow(hwnd);
        } finally {
          // Always detach, even if a call above threw: a dangling attachment couples two input queues.
          if (didAttach) api.attachThreadInput(me, fgThread, false);
        }
      }, hwnd);
      if (attached) return { ok: true, method: "attach", tried };

      if (await attempt("switch", tried, () => { api.switchToThisWindow(hwnd); }, hwnd)) {
        return { ok: true, method: "switch", tried };
      }

      const altTapped = await attempt("alt-tap", tried, async () => {
        altTap();
        await sleep(40); // the tap is queued; let it reach the system before asking again
        api.setForegroundWindow(hwnd);
      }, hwnd);
      if (altTapped) return { ok: true, method: "alt-tap", tried };

      return { ok: false, method: "failed", tried };
    },
  };
}
