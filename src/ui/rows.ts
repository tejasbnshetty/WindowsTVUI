// Turning the app list into the home screen's rows. No Node or DOM dependencies (used by main and the UI).
import { CATEGORY_ORDER, groupByCategory } from "../categories";
import type { PublicApp } from "./types";

export { CATEGORY_ORDER, groupByCategory };

export type RowItem = { kind: "app"; app: PublicApp } | { kind: "settings" };

export interface Row {
  id: string;
  title: string;
  items: RowItem[];
}

/** The rows of the home screen. The Settings tile is always the LAST tile of the LAST row. */
export function buildRows(apps: readonly PublicApp[]): Row[] {
  const rows: Row[] = groupByCategory([...apps]).map((g) => ({
    id: g.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title: g.title,
    items: g.apps.map((app): RowItem => ({ kind: "app", app })),
  }));
  if (rows.length === 0) rows.push({ id: "apps", title: "Apps", items: [] });
  rows[rows.length - 1].items.push({ kind: "settings" });
  return rows;
}

export const rowCounts = (rows: readonly Row[]): number[] => rows.map((r) => r.items.length);
