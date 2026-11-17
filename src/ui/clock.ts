export interface ClockText {
  time: string;
  date: string;
}

/** "9:41 PM" / "Tuesday, 17 November" in the system locale (a TV is read from across the room: keep it short). */
export function formatClock(d: Date, locale?: string): ClockText {
  return {
    time: d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }),
    date: d.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" }),
  };
}

/** Milliseconds until the next minute boundary (so the clock can tick exactly when the minute changes). */
export function msToNextMinute(now: number): number {
  return 60_000 - (now % 60_000) + 50;
}
