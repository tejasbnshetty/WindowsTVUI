// Wire protocol between the phone remote and the laptop.
// Everything arriving over the WebSocket is untrusted: parseCommand() builds a fresh,
// fully-validated Command from it (or returns null), and nothing else may reach SendInput.

export type NavAction = "up" | "down" | "left" | "right" | "ok" | "back" | "home";
export type MouseButton = "left" | "right" | "middle";
export type MediaAction = "vol_up" | "vol_down" | "mute" | "play_pause" | "next" | "prev";

export const KEY_NAMES = [
  "Enter", "Backspace", "Escape", "Tab",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  "Alt+Left", "Alt+Right", "F5", "Ctrl+W", "Ctrl+T",
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

export type Command =
  | { type: "nav"; action: NavAction }
  | { type: "mouse_move"; dx: number; dy: number }
  | { type: "mouse_click"; button: MouseButton }
  | { type: "mouse_down"; button: MouseButton }
  | { type: "mouse_up"; button: MouseButton }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "key"; key: KeyName }
  | { type: "text"; value: string }
  | { type: "media"; action: MediaAction };

export type InputCommand = Exclude<Command, { type: "nav" }>;

// Limits
export const MAX_MOVE = 200;     // pixels per mouse_move message, per axis
export const MAX_SCROLL = 600;   // wheel units per scroll message, per axis (120 = one notch)
export const MAX_TEXT_LENGTH = 200;

const NAV_ACTIONS: ReadonlySet<string> = new Set<NavAction>(["up", "down", "left", "right", "ok", "back", "home"]);
const MOUSE_BUTTONS: ReadonlySet<string> = new Set<MouseButton>(["left", "right", "middle"]);
const MEDIA_ACTIONS: ReadonlySet<string> = new Set<MediaAction>(["vol_up", "vol_down", "mute", "play_pause", "next", "prev"]);
const KEY_SET: ReadonlySet<string> = new Set<string>(KEY_NAMES);

// C0/C1 control characters (incl. newline, tab, DEL). Enter/Tab/Backspace go through `key`.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function clampInt(n: unknown, limit: number): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(-limit, Math.min(limit, Math.round(n)));
}

/** Messages that may legitimately arrive at high frequency (a finger dragging). */
export function isStreamCommand(cmd: Command): boolean {
  return cmd.type === "mouse_move" || cmd.type === "scroll";
}

export function parseCommand(raw: unknown): Command | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const type = m.type;
  if (typeof type !== "string") return null;

  switch (type) {
    case "nav": {
      const a = m.action;
      return typeof a === "string" && NAV_ACTIONS.has(a) ? { type, action: a as NavAction } : null;
    }
    case "mouse_move":
    case "scroll": {
      const limit = type === "mouse_move" ? MAX_MOVE : MAX_SCROLL;
      const dx = clampInt(m.dx, limit);
      const dy = clampInt(m.dy, limit);
      if (dx === null || dy === null) return null;
      if (dx === 0 && dy === 0) return null; // nothing to do
      return { type, dx, dy };
    }
    case "mouse_click":
    case "mouse_down":
    case "mouse_up": {
      const b = m.button;
      return typeof b === "string" && MOUSE_BUTTONS.has(b) ? { type, button: b as MouseButton } : null;
    }
    case "key": {
      const k = m.key;
      return typeof k === "string" && KEY_SET.has(k) ? { type, key: k as KeyName } : null;
    }
    case "text": {
      const v = m.value;
      if (typeof v !== "string" || v.length === 0 || v.length > MAX_TEXT_LENGTH) return null;
      if (CONTROL_CHARS.test(v)) return null;
      return { type, value: v };
    }
    case "media": {
      const a = m.action;
      return typeof a === "string" && MEDIA_ACTIONS.has(a) ? { type, action: a as MediaAction } : null;
    }
    default:
      return null; // unknown type
  }
}
