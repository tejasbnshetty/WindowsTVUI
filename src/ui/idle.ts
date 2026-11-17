// Idle timer for the screensaver. It only counts while the launcher is actually visible, so a launched
// app in front (launcher minimized or covered) never triggers it.

export interface IdleDeps {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IdleTimerOptions {
  /** Minutes of inactivity before onIdle fires; 0 (or less) = disabled. Read every time the timer is (re)armed. */
  getMinutes(): number;
  onIdle(): void;
  deps?: IdleDeps;
}

export interface IdleTimer {
  /** Any user input: restarts the countdown. */
  activity(): void;
  /** The launcher became visible / hidden. Hidden stops the countdown; visible starts it fresh. */
  setVisible(visible: boolean): void;
  /** The configured delay changed (or was turned off): re-arm with the new value. */
  refresh(): void;
  /** Stop everything. */
  stop(): void;
  isArmed(): boolean;
}

export function createIdleTimer(o: IdleTimerOptions): IdleTimer {
  const deps: IdleDeps = o.deps ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  let handle: unknown = null;
  let visible = true;
  let stopped = false;

  function clear(): void {
    if (handle !== null) { deps.clearTimeout(handle); handle = null; }
  }

  function arm(): void {
    clear();
    if (stopped || !visible) return;
    const minutes = o.getMinutes();
    if (!(minutes > 0)) return;
    handle = deps.setTimeout(() => { handle = null; o.onIdle(); }, minutes * 60_000);
  }

  return {
    activity: arm,
    refresh: arm,
    setVisible(v) { visible = v; if (v) arm(); else clear(); },
    stop() { stopped = true; clear(); },
    isArmed: () => handle !== null,
  };
}
