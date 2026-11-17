// Brand-colour helpers for tile gradients and readable logo/text colour.

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [51, 65, 85];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("");
}

/** amount > 0 mixes towards white, < 0 towards black (-1..1). */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const t = amount < 0 ? 0 : 255;
  const k = Math.abs(Math.max(-1, Math.min(1, amount)));
  return rgbToHex([r + (t - r) * k, g + (t - g) * k, b + (t - b) * k]);
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function luminance(hex: string): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const [r, g, b] = hexToRgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Logo / text colour with enough contrast on top of the brand colour. White works on most brand colours
 * (red, blue, purple, grey); only genuinely light ones (Plex yellow, Spotify green) need dark ink.
 */
export function inkOn(hex: string): "#ffffff" | "#0b0d12" {
  return luminance(hex) > 0.28 ? "#0b0d12" : "#ffffff";
}

/** The two stops of a tile's diagonal gradient. */
export function tileGradient(hex: string): { from: string; to: string } {
  return { from: shade(hex, 0.12), to: shade(hex, -0.38) };
}

/** Font size (rem) for a generated wordmark so long names still fit a 16:9 tile. */
export function wordmarkSize(name: string): number {
  const longestWord = Math.max(...name.split(/\s+/).map((w) => w.length), 1);
  const total = name.length;
  if (total <= 3) return 5.2;
  if (total <= 6) return 3.8;
  if (longestWord <= 7 && total <= 14) return 2.8;
  return 2.2;
}
