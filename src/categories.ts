// Which row an app belongs to. Lives at the top level (not in ui/) because the main process uses it too, and
// dist/ui/** is NOT shipped in the installed app (the UI is the bundled ui-dist/ instead).

/** Rows are shown in this order; any other category follows alphabetically after them. */
export const CATEGORY_ORDER = ["Streaming", "Music", "Local & Media", "Apps"];

/** Groups apps into rows following CATEGORY_ORDER; app order inside a row is the file order. */
export function groupByCategory<T extends { category: string }>(apps: T[]): Array<{ title: string; apps: T[] }> {
  const groups = new Map<string, T[]>();
  for (const a of apps) {
    const g = groups.get(a.category);
    if (g) g.push(a); else groups.set(a.category, [a]);
  }
  const known = CATEGORY_ORDER.filter((c) => groups.has(c));
  const extra = [...groups.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort((a, b) => a.localeCompare(b));
  return [...known, ...extra].map((title) => ({ title, apps: groups.get(title)! }));
}
