// Keeps the display awake while the launcher runs (a TV that blanks mid-movie is useless).

export interface PowerApi {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export interface PowerGuard {
  start(): void;
  stop(): void;
  active(): boolean;
}

export function createPowerGuard(api: PowerApi): PowerGuard {
  let id: number | null = null;
  return {
    start() {
      if (id !== null && api.isStarted(id)) return; // already holding the blocker
      id = api.start("prevent-display-sleep");
    },
    stop() {
      if (id === null) return;
      if (api.isStarted(id)) api.stop(id);
      id = null;
    },
    active: () => id !== null && api.isStarted(id),
  };
}
