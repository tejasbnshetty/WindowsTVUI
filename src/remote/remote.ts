// Phone remote page. Plain script (no imports/exports); wrapped in an IIFE so it
// shares no globals with the other scripts in this tsconfig.
(() => {
  const TOKEN_KEY = "tvui.token";
  const MODE_KEY = "tvui.mode";
  const SENS_KEY = "tvui.sensitivity";
  const NATURAL_KEY = "tvui.naturalScroll";

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const statusEl = $("status");
  const statusText = $("status-text");
  const pairView = $("pair-view");
  const remoteView = $("remote-view");
  const pairForm = $<HTMLFormElement>("pair-form");
  const pinInput = $<HTMLInputElement>("pin");
  const pairBtn = $<HTMLButtonElement>("pair-btn");
  const pairMsg = $("pair-msg");

  // ---- localStorage (may be unavailable, e.g. private mode) ----
  const store = {
    get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
    set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    remove(k: string): void { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const getToken = () => store.get(TOKEN_KEY);

  // ---- status indicator ----
  type Status = "on" | "off" | "connecting";
  function setStatus(s: Status): void {
    statusEl.className = `status ${s}`;
    statusText.textContent = s === "on" ? "Connected" : s === "connecting" ? "Connecting…" : "Disconnected";
  }

  // =====================================================================
  // Sending
  // =====================================================================
  let ws: WebSocket | null = null;

  function rawSend(s: string): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(s);
  }

  // Discrete commands go through a token bucket (25/s sustained, burst 8) so a burst such as
  // deleting 30 characters is paced instead of being dropped by the server's rate limit.
  const BURST = 8;
  const REFILL_MS = 40;
  let tokens = BURST;
  let lastRefill = performance.now();
  const queue: string[] = [];
  let drainTimer: number | undefined;

  function drain(): void {
    const now = performance.now();
    tokens = Math.min(BURST, tokens + (now - lastRefill) / REFILL_MS);
    lastRefill = now;
    while (queue.length && tokens >= 1) {
      rawSend(queue.shift()!);
      tokens -= 1;
    }
    if (queue.length && drainTimer === undefined) {
      drainTimer = window.setTimeout(() => { drainTimer = undefined; drain(); }, REFILL_MS);
    }
  }
  function sendCmd(obj: object): void {
    if (queue.length >= 100) queue.shift();
    queue.push(JSON.stringify(obj));
    drain();
  }
  function clearQueue(): void {
    queue.length = 0;
    window.clearTimeout(drainTimer);
    drainTimer = undefined;
  }
  /** Cursor/scroll streams are already paced by requestAnimationFrame; send immediately. */
  function sendStream(obj: object): void { rawSend(JSON.stringify(obj)); }

  // Held mouse buttons: released explicitly on mode change / backgrounding, and by the server on disconnect.
  const heldButtons = new Set<string>();
  function mouseDown(button: string): void {
    if (heldButtons.has(button)) return;
    heldButtons.add(button);
    sendCmd({ type: "mouse_down", button });
  }
  function mouseUp(button: string): void {
    heldButtons.delete(button);
    sendCmd({ type: "mouse_up", button });
  }
  function releaseAll(): void {
    for (const b of [...heldButtons]) mouseUp(b);
  }

  // =====================================================================
  // Views & connection
  // =====================================================================
  let retryTimer: number | undefined;
  let retryDelay = 1000;
  let attempting = false;

  function showPair(): void {
    stopConnection();
    remoteView.hidden = true;
    pairView.hidden = false;
    setStatus("off");
    pinInput.focus();
  }

  function showRemote(): void {
    pairView.hidden = true;
    remoteView.hidden = false;
  }

  function stopConnection(): void {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    clearQueue();
    heldButtons.clear();
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
  }

  /** true = token valid, false = token rejected, null = server unreachable. */
  async function checkSession(token: string): Promise<boolean | null> {
    try {
      const res = await fetch("/api/session", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (res.status === 200) return true;
      if (res.status === 401) return false;
      return null;
    } catch {
      return null;
    }
  }

  function scheduleReconnect(): void {
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(attempt, retryDelay);
    retryDelay = Math.min(retryDelay * 1.5, 5000);
  }

  async function attempt(): Promise<void> {
    if (attempting) return;
    const token = getToken();
    if (!token) { showPair(); return; }
    attempting = true;
    try {
      showRemote();
      setStatus("connecting");
      const valid = await checkSession(token);
      if (valid === false) { store.remove(TOKEN_KEY); showPair(); return; }
      if (valid === null) { setStatus("off"); scheduleReconnect(); return; }
      connect(token);
    } finally {
      attempting = false;
    }
  }

  function connect(token: string): void {
    stopConnection();
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws = socket;
    socket.onopen = () => { retryDelay = 1000; setStatus("on"); };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      clearQueue();
      heldButtons.clear(); // the server releases anything still held when the socket closes
      setStatus("off");
      scheduleReconnect();
    };
    socket.onerror = () => { /* onclose follows */ };
  }

  // iOS suspends sockets in the background: reconnect right away when the page returns.
  function wake(): void {
    if (getToken() && !(ws && ws.readyState <= WebSocket.OPEN)) {
      window.clearTimeout(retryTimer);
      retryDelay = 1000;
      void attempt();
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseAll(); else wake();
  });
  window.addEventListener("pagehide", releaseAll);
  window.addEventListener("pageshow", wake);
  window.addEventListener("online", wake);

  // iOS: no pinch-zoom anywhere (user-scalable=no is ignored by Safari).
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(ev, (e) => e.preventDefault());
  }

  // When the iOS keyboard opens the visual viewport shrinks; size the layout to it.
  function syncViewport(): void {
    const vv = window.visualViewport;
    document.documentElement.style.setProperty("--vh", vv ? `${vv.height}px` : "100dvh");
    window.scrollTo(0, 0);
  }
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
  syncViewport();

  // =====================================================================
  // Buttons (pointerdown fires faster than click on iOS and keeps input focus)
  // =====================================================================
  function bindPress(selector: string, attr: string, onPress: (value: string) => void): void {
    document.querySelectorAll<HTMLElement>(selector).forEach((btn) => {
      const release = () => btn.classList.remove("pressed");
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // don't steal focus from the keyboard field
        btn.classList.add("pressed");
        onPress(btn.getAttribute(attr)!);
      });
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("pointerleave", release);
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
    });
  }
  bindPress("[data-action]", "data-action", (action) => sendCmd({ type: "nav", action }));
  bindPress("[data-media]", "data-media", (action) => sendCmd({ type: "media", action }));
  bindPress("[data-key]", "data-key", (key) => sendCmd({ type: "key", key }));

  // =====================================================================
  // Mode tabs
  // =====================================================================
  type Mode = "nav" | "pad" | "kb";
  const MODES: Mode[] = ["nav", "pad", "kb"];
  const sections: Record<Mode, HTMLElement> = { nav: $("mode-nav"), pad: $("mode-pad"), kb: $("mode-kb") };
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));
  const kbInput = $<HTMLInputElement>("kb-input");
  let mode: Mode = "nav";

  function setMode(next: Mode, fromTap: boolean): void {
    if (mode === "pad" && next !== "pad") { releaseAll(); resetGesture(); }
    mode = next;
    for (const m of MODES) sections[m].hidden = m !== next;
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.mode === next));
    store.set(MODE_KEY, next);
    if (next === "kb") {
      // focus() must run inside the tap's event handler or iOS won't open the keyboard
      if (fromTap) { resetKb(); kbInput.focus(); }
    } else {
      kbInput.blur();
    }
  }
  tabs.forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode as Mode, true)));

  // =====================================================================
  // Trackpad
  // =====================================================================
  const pad = $("pad");
  const TAP_MS = 250;        // max press time for a tap
  const TAP_SLOP = 10;       // px of movement still counted as a tap
  const DOUBLE_TAP_MS = 320; // tap then touch again within this = click-and-drag
  const SCROLL_UNITS_PER_PX = 3;

  let sensitivity = Number(store.get(SENS_KEY)) || 1.5;
  let naturalScroll = store.get(NATURAL_KEY) !== "0";
  const sensInput = $<HTMLInputElement>("sens");
  const naturalInput = $<HTMLInputElement>("natural");
  sensInput.value = String(sensitivity);
  naturalInput.checked = naturalScroll;
  sensInput.addEventListener("input", () => {
    sensitivity = Math.min(3, Math.max(0.5, Number(sensInput.value) || 1.5));
    store.set(SENS_KEY, String(sensitivity));
  });
  naturalInput.addEventListener("change", () => {
    naturalScroll = naturalInput.checked;
    store.set(NATURAL_KEY, naturalScroll ? "1" : "0");
  });

  interface Touch { x: number; y: number; sx: number; sy: number }
  const pointers = new Map<number, Touch>();
  let gesture = { startT: 0, moved: false, maxPointers: 0, dragging: false, locked: false };
  let lastTap = { t: 0, x: 0, y: 0 };

  // Pending motion, flushed once per animation frame (and rate-capped) to keep message volume sane.
  let pendX = 0, pendY = 0, pendSX = 0, pendSY = 0;
  let rafId = 0;
  let lastFlush = 0;

  function resetGesture(): void {
    pointers.clear();
    pendX = pendY = pendSX = pendSY = 0;
    gesture = { startT: 0, moved: false, maxPointers: 0, dragging: false, locked: false };
    pad.classList.remove("active");
  }

  function flushMotion(): void {
    rafId = 0;
    const now = performance.now();
    if (now - lastFlush < 14) { scheduleFlush(); return; }
    lastFlush = now;
    const ix = Math.trunc(pendX), iy = Math.trunc(pendY);
    if (ix || iy) {
      pendX -= ix; pendY -= iy; // keep the sub-pixel remainder
      sendStream({ type: "mouse_move", dx: ix, dy: iy });
    }
    const sx = Math.trunc(pendSX), sy = Math.trunc(pendSY);
    if (sx || sy) {
      pendSX -= sx; pendSY -= sy;
      sendStream({ type: "scroll", dx: sx, dy: sy });
    }
  }
  function scheduleFlush(): void {
    if (!rafId) rafId = requestAnimationFrame(flushMotion);
  }

  function queueMove(dx: number, dy: number): void {
    // Mild acceleration: faster finger movement gets up to ~2x extra gain.
    const speed = Math.hypot(dx, dy);
    const gain = sensitivity * (1 + Math.min(speed, 24) * 0.04);
    pendX += dx * gain;
    pendY += dy * gain;
    scheduleFlush();
  }

  function queueScroll(dx: number, dy: number): void {
    // Server convention: dy > 0 scrolls down, dx > 0 scrolls right.
    // Natural: content follows the fingers, so dragging up scrolls down.
    const dir = naturalScroll ? -1 : 1;
    pendSX += dir * dx * SCROLL_UNITS_PER_PX;
    pendSY += dir * dy * SCROLL_UNITS_PER_PX;
    scheduleFlush();
  }

  pad.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

  pad.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    const now = performance.now();
    if (pointers.size === 0) {
      gesture = { startT: now, moved: false, maxPointers: 1, dragging: false, locked: false };
      pad.classList.add("active");
      // Tap, then touch again quickly and hold: press the left button and drag.
      if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 60) {
        gesture.dragging = true;
        lastTap.t = 0;
        mouseDown("left");
      }
    } else {
      gesture.maxPointers = Math.max(gesture.maxPointers, pointers.size + 1);
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
  });

  pad.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(p.x - p.sx, p.y - p.sy) > TAP_SLOP) gesture.moved = true;
    if (gesture.locked) return;
    if (pointers.size === 1) {
      queueMove(dx, dy);
    } else if (pointers.size === 2 && !gesture.dragging) {
      // Each pointer reports its own delta; halving gives the two-finger average.
      queueScroll(dx / 2, dy / 2);
    }
  });

  function endPointer(e: PointerEvent, cancelled: boolean): void {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size > 0) {
      gesture.locked = true; // leftover finger after a multi-touch gesture must not move the cursor
      return;
    }
    const now = performance.now();
    flushMotion();
    if (gesture.dragging) {
      mouseUp("left");
    } else if (!cancelled && !gesture.moved && now - gesture.startT < TAP_MS && !gesture.locked) {
      sendCmd({ type: "mouse_click", button: "left" });
      lastTap = { t: now, x: e.clientX, y: e.clientY };
    } else if (!cancelled && !gesture.moved && gesture.maxPointers === 2 && now - gesture.startT < TAP_MS) {
      sendCmd({ type: "mouse_click", button: "right" });
    }
    pendX = pendY = pendSX = pendSY = 0;
    pad.classList.remove("active");
    gesture.dragging = false;
  }
  pad.addEventListener("pointerup", (e) => endPointer(e, false));
  pad.addEventListener("pointercancel", (e) => endPointer(e, true));

  // Left / right click buttons: press = down, release = up, so you can hold one thumb and drag with the other.
  function bindMouseButton(id: string, button: string): void {
    const el = $(id);
    const up = () => { el.classList.remove("pressed"); if (heldButtons.has(button)) mouseUp(button); };
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("pressed");
      mouseDown(button);
    });
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  bindMouseButton("btn-left", "left");
  bindMouseButton("btn-right", "right");

  // =====================================================================
  // Keyboard: live-typing text field
  // =====================================================================
  // The field always starts with an invisible sentinel so that Backspace on an "empty" field still
  // produces an input event. We diff the field against its previous value and translate the change
  // into Backspace keys + typed text, which also covers autocorrect and suggestion replacements.
  const SENTINEL = "​";
  const MAX_FIELD_CHARS = 40;
  let prevChars: string[] = [SENTINEL];

  function resetKb(): void {
    kbInput.value = SENTINEL;
    prevChars = [SENTINEL];
  }

  function sendTypedText(text: string): void {
    const chars = Array.from(text.replace(/[​\u0000-\u001f\u007f-\u009f]/g, ""));
    for (let i = 0; i < chars.length; i += 80) {
      sendCmd({ type: "text", value: chars.slice(i, i + 80).join("") });
    }
  }

  kbInput.addEventListener("input", () => {
    const cur = Array.from(kbInput.value);
    let i = 0;
    while (i < prevChars.length && i < cur.length && prevChars[i] === cur[i]) i++;
    let removed = prevChars.length - i;
    if (i === 0) removed = Math.max(1, removed - 1); // the sentinel itself isn't a real character
    for (let n = 0; n < removed; n++) sendCmd({ type: "key", key: "Backspace" });
    sendTypedText(cur.slice(i).join(""));
    if (cur[0] !== SENTINEL || cur.length > MAX_FIELD_CHARS) resetKb();
    else prevChars = cur;
  });

  kbInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendCmd({ type: "key", key: "Enter" });
    }
  });
  kbInput.addEventListener("focus", () => { resetKb(); window.scrollTo(0, 0); });

  // =====================================================================
  // Pairing
  // =====================================================================
  let lockTimer: number | undefined;

  function startLockout(seconds: number): void {
    window.clearInterval(lockTimer);
    let left = seconds;
    pairBtn.disabled = true;
    const tick = () => {
      if (left <= 0) {
        window.clearInterval(lockTimer);
        pairBtn.disabled = false;
        pairMsg.textContent = "";
        return;
      }
      pairMsg.textContent = `Too many attempts. Try again in ${left}s.`;
      left -= 1;
    };
    tick();
    lockTimer = window.setInterval(tick, 1000);
  }

  pinInput.addEventListener("input", () => {
    pinInput.value = pinInput.value.replace(/\D/g, "").slice(0, 6);
  });

  pairForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = pinInput.value;
    if (!/^\d{6}$/.test(pin)) { pairMsg.textContent = "Enter all 6 digits."; return; }
    pairBtn.disabled = true;
    pairMsg.textContent = "";
    try {
      const res = await fetch("/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 200 && typeof body.token === "string") {
        store.set(TOKEN_KEY, body.token);
        pinInput.value = "";
        pairBtn.disabled = false;
        retryDelay = 1000;
        void attempt();
        return;
      }
      if (res.status === 429) {
        startLockout(Number(body.retryAfter) || 60);
        return;
      }
      pairMsg.textContent = res.status === 401
        ? `Wrong PIN. ${body.remaining ?? ""} ${body.remaining === 1 ? "try" : "tries"} left.`
        : "Something went wrong. Try again.";
      pinInput.value = "";
      pairBtn.disabled = false;
    } catch {
      pairMsg.textContent = "Can't reach the TV. Check Wi-Fi.";
      pairBtn.disabled = false;
    }
  });

  // =====================================================================
  // Start
  // =====================================================================
  const savedMode = store.get(MODE_KEY);
  setMode(MODES.includes(savedMode as Mode) ? (savedMode as Mode) : "nav", false);
  if (getToken()) void attempt(); else showPair();
})();
