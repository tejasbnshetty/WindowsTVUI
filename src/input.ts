// Windows input injection via user32!SendInput, called through koffi (no native build step).
//
// Layering:  Input API (this file)  ->  RawInput descriptors  ->  InputBackend.
// The default backend (createWin32Backend) talks to user32.dll; tests substitute a mock
// backend and assert on the exact descriptors that would be sent.

import type { KeyName, MediaAction, MouseButton } from "./protocol";

// ---- Win32 constants ----
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

export const VK = {
  BACK: 0x08, TAB: 0x09, RETURN: 0x0d, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12 /* Alt */,
  ESCAPE: 0x1b, PRIOR: 0x21 /* PageUp */, NEXT: 0x22 /* PageDown */, END: 0x23, HOME: 0x24,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
  W: 0x57, T: 0x54, F5: 0x74,
  VOLUME_MUTE: 0xad, VOLUME_DOWN: 0xae, VOLUME_UP: 0xaf,
  MEDIA_NEXT_TRACK: 0xb0, MEDIA_PREV_TRACK: 0xb1, MEDIA_PLAY_PAUSE: 0xb3,
} as const;

// ---- Raw descriptors (what one INPUT struct will contain) ----
export type RawInput =
  | { kind: "mouse"; dx: number; dy: number; mouseData: number; flags: number }
  | { kind: "key"; vk: number; scan: number; flags: number };

export interface InputBackend {
  /** Sends the inputs as ONE atomic SendInput call. Returns how many were accepted. */
  sendInput(inputs: RawInput[]): number;
}

export type Modifier = "ctrl" | "alt" | "shift";
const MODIFIER_VK: Record<Modifier, number> = { ctrl: VK.CONTROL, alt: VK.MENU, shift: VK.SHIFT };

// Keys that need KEYEVENTF_EXTENDEDKEY so they act as the grey navigation keys, not numpad keys.
const EXTENDED_VKS: ReadonlySet<number> = new Set([VK.PRIOR, VK.NEXT, VK.END, VK.HOME, VK.LEFT, VK.UP, VK.RIGHT, VK.DOWN]);

/** Whitelisted key names -> (vk, modifiers). The only keys the remote can press. */
export const KEY_TABLE: Record<KeyName, { vk: number; modifiers: Modifier[] }> = {
  Enter: { vk: VK.RETURN, modifiers: [] },
  Backspace: { vk: VK.BACK, modifiers: [] },
  Escape: { vk: VK.ESCAPE, modifiers: [] },
  Tab: { vk: VK.TAB, modifiers: [] },
  ArrowUp: { vk: VK.UP, modifiers: [] },
  ArrowDown: { vk: VK.DOWN, modifiers: [] },
  ArrowLeft: { vk: VK.LEFT, modifiers: [] },
  ArrowRight: { vk: VK.RIGHT, modifiers: [] },
  Home: { vk: VK.HOME, modifiers: [] },
  End: { vk: VK.END, modifiers: [] },
  PageUp: { vk: VK.PRIOR, modifiers: [] },
  PageDown: { vk: VK.NEXT, modifiers: [] },
  "Alt+Left": { vk: VK.LEFT, modifiers: ["alt"] },
  "Alt+Right": { vk: VK.RIGHT, modifiers: ["alt"] },
  F5: { vk: VK.F5, modifiers: [] },
  "Ctrl+W": { vk: VK.W, modifiers: ["ctrl"] },
  "Ctrl+T": { vk: VK.T, modifiers: ["ctrl"] },
};

const MEDIA_VK: Record<MediaAction, number> = {
  vol_up: VK.VOLUME_UP,
  vol_down: VK.VOLUME_DOWN,
  mute: VK.VOLUME_MUTE,
  play_pause: VK.MEDIA_PLAY_PAUSE,
  next: VK.MEDIA_NEXT_TRACK,
  prev: VK.MEDIA_PREV_TRACK,
};

const BUTTON_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP },
  right: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP },
  middle: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP },
};

// ---- Descriptor builders (pure) ----
const mouse = (flags: number, dx = 0, dy = 0, mouseData = 0): RawInput => ({ kind: "mouse", dx, dy, mouseData, flags });
const key = (vk: number, flags = 0, scan = 0): RawInput => ({ kind: "key", vk, scan, flags });
const keyFlags = (vk: number, up: boolean): number =>
  (EXTENDED_VKS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0);
/** SendInput stores wheel deltas in a DWORD: negative values are their two's-complement form. */
const dword = (n: number): number => n >>> 0;

export interface Input {
  moveRelative(dx: number, dy: number): void;
  click(button: MouseButton): void;
  mouseDown(button: MouseButton): void;
  mouseUp(button: MouseButton): void;
  /** dy > 0 scrolls down, dx > 0 scrolls right. 120 units = one wheel notch. */
  scroll(dy: number, dx?: number): void;
  keyTap(vk: number, modifiers?: Modifier[]): void;
  /** Types text with KEYEVENTF_UNICODE (layout independent). Callers must pass printable text. */
  typeText(text: string): void;
  mediaKey(name: MediaAction): void;
  /** Named, whitelisted key (see KEY_TABLE). */
  namedKey(name: KeyName): void;
}

export function createInput(backend: InputBackend): Input {
  const send = (inputs: RawInput[]): void => {
    if (inputs.length === 0) return;
    const accepted = backend.sendInput(inputs);
    if (accepted !== inputs.length) {
      // Typically UIPI: the foreground window is elevated and we are not.
      console.warn(`SendInput accepted ${accepted}/${inputs.length} events`);
    }
  };

  const api: Input = {
    moveRelative(dx, dy) {
      if (!dx && !dy) return;
      send([mouse(MOUSEEVENTF_MOVE, Math.trunc(dx), Math.trunc(dy))]);
    },
    click(button) {
      const f = BUTTON_FLAGS[button];
      send([mouse(f.down), mouse(f.up)]);
    },
    mouseDown(button) {
      send([mouse(BUTTON_FLAGS[button].down)]);
    },
    mouseUp(button) {
      send([mouse(BUTTON_FLAGS[button].up)]);
    },
    scroll(dy, dx = 0) {
      const inputs: RawInput[] = [];
      // Windows: positive wheel delta = scroll UP (away from user), so invert our "down is positive".
      if (dy) inputs.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, dword(-Math.trunc(dy))));
      // Positive horizontal delta = scroll right.
      if (dx) inputs.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, dword(Math.trunc(dx))));
      send(inputs);
    },
    keyTap(vk, modifiers = []) {
      const inputs: RawInput[] = [];
      for (const m of modifiers) inputs.push(key(MODIFIER_VK[m], 0));
      inputs.push(key(vk, keyFlags(vk, false)));
      inputs.push(key(vk, keyFlags(vk, true)));
      for (const m of [...modifiers].reverse()) inputs.push(key(MODIFIER_VK[m], KEYEVENTF_KEYUP));
      send(inputs);
    },
    typeText(text) {
      const inputs: RawInput[] = [];
      // One event pair per UTF-16 code unit; surrogate pairs (emoji) are sent as two units.
      for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i);
        inputs.push(key(0, KEYEVENTF_UNICODE, unit));
        inputs.push(key(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, unit));
      }
      send(inputs);
    },
    mediaKey(name) {
      const vk = MEDIA_VK[name];
      if (vk === undefined) return;
      send([key(vk, 0), key(vk, KEYEVENTF_KEYUP)]);
    },
    namedKey(name) {
      const entry = KEY_TABLE[name];
      if (!entry) return;
      api.keyTap(entry.vk, entry.modifiers);
    },
  };
  return api;
}

// ---- Real backend: user32.dll via koffi ----
export function createWin32Backend(): InputBackend {
  if (process.platform !== "win32") throw new Error("Input injection is only supported on Windows");
  // Loaded lazily so tests (and non-Windows tooling) never need the native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require("koffi") as typeof import("koffi");
  const user32 = koffi.load("user32.dll");

  const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
    dx: "long", dy: "long", mouseData: "uint32", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t",
  });
  const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
    wVk: "uint16", wScan: "uint16", dwFlags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t",
  });
  const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", { uMsg: "uint32", wParamL: "uint16", wParamH: "uint16" });
  const INPUT_UNION = koffi.union("INPUT_UNION", { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct("INPUT", { type: "uint32", u: INPUT_UNION });
  const cbSize = koffi.sizeof(INPUT);
  // 40 on 64-bit Windows. A wrong size makes SendInput fail, so check it up front.
  if (cbSize !== 40 && cbSize !== 28) throw new Error(`Unexpected INPUT struct size ${cbSize}`);

  const SendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)");

  return {
    sendInput(inputs) {
      const native = inputs.map((i) =>
        i.kind === "mouse"
          ? { type: INPUT_MOUSE, u: { mi: { dx: i.dx, dy: i.dy, mouseData: i.mouseData, dwFlags: i.flags, time: 0, dwExtraInfo: 0 } } }
          : { type: INPUT_KEYBOARD, u: { ki: { wVk: i.vk, wScan: i.scan, dwFlags: i.flags, time: 0, dwExtraInfo: 0 } } }
      );
      return SendInput(native.length, native, cbSize);
    },
  };
}
