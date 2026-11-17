// Plain script (no imports/exports) so it loads directly in the page.
interface TileView { id: string; label: string; color?: string }
interface PairingView { open: boolean; pin: string | null; expiresAt: number | null }
interface RemoteInfo {
  error?: string | null;
  url?: string | null;
  mdnsUrl?: string | null;
  qr?: string | null;
  pairing?: PairingView;
  devices?: number;
  network?: { online: boolean; label: string | null; ip: string | null };
}
interface TvApi {
  getTiles(): Promise<TileView[]>;
  launch(id: string): Promise<{ ok: boolean; error?: string }>;
  getRemoteInfo(): Promise<RemoteInfo>;
  openPairing(): void;
  onNav(cb: (action: string) => void): void;
  onInfo(cb: (info: unknown) => void): void;
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
    if ((e.key === "p" || e.key === "P") && !e.ctrlKey && !e.altKey && !e.metaKey) {
      window.tv.openPairing(); // shows a fresh PIN for pairing another phone
      e.preventDefault();
      return;
    }
    const action = KEYS[e.key];
    if (action && handleAction(action)) e.preventDefault();
  });

  window.tv.onNav((action) => { handleAction(action); });

  // ---- Mouse cursor: visible while it moves, hidden after 3 s of inactivity ----
  const CURSOR_IDLE_MS = 3000;
  let cursorTimer: number | undefined;
  function wakeCursor() {
    document.documentElement.classList.remove("idle-cursor");
    window.clearTimeout(cursorTimer);
    cursorTimer = window.setTimeout(() => document.documentElement.classList.add("idle-cursor"), CURSOR_IDLE_MS);
  }
  // Chromium emits synthetic mousemoves at the SAME position after layout/style changes (e.g. when
  // the cursor style flips); those must not count as activity or the cursor would flicker back.
  let lastX = Number.NaN, lastY = Number.NaN;
  window.addEventListener("mousemove", (e) => {
    if (e.screenX === lastX && e.screenY === lastY) return;
    lastX = e.screenX;
    lastY = e.screenY;
    wakeCursor();
  });
  window.addEventListener("mousedown", wakeCursor);
  wakeCursor();

  // ---- Remote status: error banner + pairing panel + network status ----
  const banner = document.getElementById("error-banner")!;
  const pairingEl = document.getElementById("pairing")!;
  const urlEl = document.getElementById("pair-url")!;
  const mdnsEl = document.getElementById("pair-mdns")!;
  const pinRow = document.getElementById("pair-pin-row")!;
  const pinEl = document.getElementById("pair-pin")!;
  const hintEl = document.getElementById("pair-hint")!;
  const titleEl = document.getElementById("pair-title")!;
  const qrEl = document.getElementById("pair-qr") as HTMLImageElement;
  const netEl = document.getElementById("net-status")!;
  const netText = document.getElementById("net-text")!;

  let info: RemoteInfo = {};

  function renderRemote(): void {
    // Network status line: always visible, so a dropped Wi-Fi is obvious from the couch.
    const net = info.network;
    const online = !!net?.online;
    netEl.classList.toggle("offline", !online);
    netText.textContent = online ? `${net!.label ?? "Network"} connected` : "No network connection";

    if (info.error) {
      banner.textContent = info.error;
      banner.hidden = false;
      pairingEl.hidden = true;
      return;
    }
    banner.hidden = true;
    pairingEl.hidden = false;
    const p = info.pairing;
    const open = !!p?.open && !!p.pin && online;
    urlEl.textContent = info.url ?? (online ? "Starting…" : "Waiting for a network…");
    // The stable name, shown next to the IP address (the IP + QR code keep working if mDNS does not).
    mdnsEl.textContent = info.mdnsUrl ? `or ${info.mdnsUrl}` : "";
    mdnsEl.hidden = !info.mdnsUrl;
    if (open) {
      titleEl.textContent = "Pair a phone";
      pinEl.textContent = p!.pin!;
      pinRow.hidden = false;
      if (info.qr) { qrEl.src = info.qr; qrEl.hidden = false; } else { qrEl.hidden = true; }
      hintEl.textContent = (info.devices ?? 0) > 0 ? "One phone can pair with this PIN." : "";
    } else {
      // Pairing is closed (or there is no network): no PIN or QR on screen.
      titleEl.textContent = "Phone remote";
      pinRow.hidden = true;
      qrEl.hidden = true;
      const n = info.devices ?? 0;
      hintEl.textContent = online ? `${n} phone${n === 1 ? "" : "s"} paired · press P to pair another` : "Phones can reconnect once the network is back";
    }
  }

  window.tv.onInfo((next) => {
    info = next as RemoteInfo;
    renderRemote();
  });

  info = await window.tv.getRemoteInfo();
  renderRemote();

  if (els.length) focus(0);
})();
