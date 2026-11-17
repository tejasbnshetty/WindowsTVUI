// "Close app" safety checks. Alt+F4 is only sent to a foreground window that is a normal
// application: never the launcher itself, and never the desktop/taskbar (Alt+F4 on the desktop
// opens the shutdown dialog).

export interface AppControlApi {
  getForegroundWindow(): number;
  getWindowPid(hwnd: number): number;
  getClassName(hwnd: number): string;
}

/** Window classes that belong to the Windows shell. */
const SHELL_CLASSES: ReadonlySet<string> = new Set([
  "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "TaskListThumbnailWnd",
]);

export type CloseRefusal = "no-window" | "launcher" | "shell";
export type CloseCheck = { ok: true } | { ok: false; reason: CloseRefusal };

export function checkCloseTarget(api: AppControlApi, ownPid: number): CloseCheck {
  const hwnd = api.getForegroundWindow();
  if (!hwnd) return { ok: false, reason: "no-window" };
  // Any window owned by this process (the launcher, DevTools, ...) is "the launcher".
  if (api.getWindowPid(hwnd) === ownPid) return { ok: false, reason: "launcher" };
  if (SHELL_CLASSES.has(api.getClassName(hwnd))) return { ok: false, reason: "shell" };
  return { ok: true };
}

export const CLOSE_REFUSAL_TEXT: Record<CloseRefusal, string> = {
  "no-window": "No app is in front, so nothing was closed.",
  launcher: "The launcher is in front, so nothing was closed.",
  shell: "The desktop or taskbar is in front, so nothing was closed.",
};
