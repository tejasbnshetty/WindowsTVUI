// Plain script (no imports/exports) so it loads directly in the page.
interface TileView { id: string; label: string; color?: string }
interface TvApi {
  getTiles(): Promise<TileView[]>;
  launch(id: string): Promise<{ ok: boolean; error?: string }>;
  quit(): void;
}
interface Window { tv: TvApi }

(async () => {
  const grid = document.getElementById("grid")!;
  const toast = document.getElementById("toast")!;
  const tiles = await window.tv.getTiles();

  let current = 0;
  const els: HTMLElement[] = tiles.map((t) => {
    const el = document.createElement("div");
    el.className = "tile";
    el.style.setProperty("--accent", t.color ?? "#6366f1");
    const icon = document.createElement("div");
    icon.className = "icon";
    icon.textContent = t.label.charAt(0);
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = t.label;
    el.append(icon, label);
    el.addEventListener("click", () => { focus(els.indexOf(el)); launch(); });
    grid.appendChild(el);
    return el;
  });

  function focus(i: number) {
    els[current]?.classList.remove("focused");
    current = i;
    els[current].classList.add("focused");
  }

  function showToast(msg: string) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 3000);
  }

  async function launch() {
    const res = await window.tv.launch(tiles[current].id);
    if (!res.ok) showToast(res.error ?? "Launch failed");
  }

  // Spatial navigation: nearest tile in the pressed direction.
  function move(dx: number, dy: number) {
    const c = els[current].getBoundingClientRect();
    const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    let best = -1, bestScore = Infinity;
    els.forEach((el, i) => {
      if (i === current) return;
      const r = el.getBoundingClientRect();
      const ox = r.left + r.width / 2 - cx, oy = r.top + r.height / 2 - cy;
      const along = ox * dx + oy * dy;
      if (along <= 1) return;
      const across = Math.abs(dx ? oy : ox);
      const score = along + across * 3;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) focus(best);
  }

  window.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowLeft": move(-1, 0); break;
      case "ArrowRight": move(1, 0); break;
      case "ArrowUp": move(0, -1); break;
      case "ArrowDown": move(0, 1); break;
      case "Enter": launch(); break;
      case "Escape": window.tv.quit(); break;
      default: return;
    }
    e.preventDefault();
  });

  if (els.length) focus(0);
})();
