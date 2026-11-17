// Brand logos from the simple-icons package. They are bundled locally: `npm run icons` (part of the build)
// writes one compact JSON of icon paths, and nothing is ever downloaded at runtime.
import * as fs from "fs";

export interface IconData {
  /** Brand name. */
  t: string;
  /** Brand colour, hex without "#". */
  h: string;
  /** SVG path for a 24x24 viewBox. */
  p: string;
}

export type IconTable = Record<string, IconData>;

export interface IconLookup {
  /** SVG path for a simple-icons slug, or null if the brand has no logo (the tile then uses a wordmark). */
  path(slug: string | undefined): string | null;
  /** Number of icons loaded (0 if the data file is missing). */
  size(): number;
}

/** simple-icons slugs are lower-case letters and digits only. */
export const normalizeSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function createIconLookup(load: () => IconTable | null): IconLookup {
  let table: IconTable | null | undefined;
  const get = (): IconTable => {
    if (table === undefined) {
      try { table = load(); } catch { table = null; }
    }
    return table ?? {};
  };
  return {
    path(slug) {
      if (!slug) return null;
      const icon = get()[normalizeSlug(slug)];
      return icon && typeof icon.p === "string" ? icon.p : null;
    },
    size: () => Object.keys(get()).length,
  };
}

export function loadIconFile(file: string): IconTable | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as IconTable;
  } catch {
    return null;
  }
}
