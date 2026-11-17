// Plain script (no imports/exports) so it loads directly in the page.
interface TileView { id: string; label: string; color?: string }
interface RemoteInfo { url?: string | null; pin?: string; qr?: string | null; error?: string }
interface TvApi {
  getTiles(): Promise<TileView[]>;
  launch(id: string): Promise<{ ok: boolean; error?: string }>;
  getRemoteInfo(): Promise<RemoteInfo>;
  onNav(cb: (action: string) => void): void;
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
    if (!tiles.length) return;
    const res = await window.tv.launch(tiles[current].id);
    if (!res.ok) showToast(res.error ?? "Launch failed");
  }

  // Spatial navigation: nearest tile in the pressed direction.
  function move(dx: number, dy: number) {
    if (!els.length) return;
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

  // Shared by the keyboard and the phone remote.
  function handleAction(action: string): boolean {
    switch (action) {
      case "left": move(-1, 0); return true;
      case "right": move(1, 0); return true;
      case "up": move(0, -1); return true;
      case "down": move(0, 1); return true;
      case "ok": launch(); return true;
      case "back":
      case "home": if (els.length) focus(0); return true;
      default: return false;
    }
  }

  const KEYS: Record<string, string> = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Enter: "ok",
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { window.tv.quit(); e.preventDefault(); return; }
    const action = KEYS[e.key];
    if (action && handleAction(action)) e.preventDefault();
  });

  window.tv.onNav((action) => { handleAction(action); });

  // The cursor is hidden for TV use, but shown while it's being moved (phone trackpad / mouse).
  let cursorTimer: number | undefined;
  window.addEventListener("mousemove", () => {
    document.documentElement.classList.add("show-cursor");
    window.clearTimeout(cursorTimer);
    cursorTimer = window.setTimeout(() => document.documentElement.classList.remove("show-cursor"), 2500);
  });

  // Pairing panel (bottom-right): URL, QR code, PIN.
  const info = await window.tv.getRemoteInfo();
  const urlEl = document.getElementById("pair-url")!;
  const pinEl = document.getElementById("pair-pin")!;
  const qrEl = document.getElementById("pair-qr") as HTMLImageElement;
  if (info.error) {
    urlEl.textContent = info.error;
    pinEl.parentElement!.hidden = true;
    qrEl.hidden = true;
  } else {
    urlEl.textContent = info.url ?? "No network connection";
    pinEl.textContent = info.pin ?? "";
    if (info.qr) qrEl.src = info.qr; else qrEl.hidden = true;
  }

  if (els.length) focus(0);
})();
