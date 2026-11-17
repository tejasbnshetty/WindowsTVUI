// Real user32/kernel32 bindings (koffi) for the ForegroundApi and AppControlApi interfaces.
// Window handles are passed as uintptr_t numbers, which avoids koffi pointer objects entirely.
import type { AppControlApi } from "./appControl";
import type { ForegroundApi } from "./foreground";

export type Win32 = ForegroundApi & AppControlApi;

export function createWin32(): Win32 {
  if (process.platform !== "win32") throw new Error("Win32 APIs are only available on Windows");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require("koffi") as typeof import("koffi");
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");

  const GetForegroundWindow = user32.func("uintptr_t __stdcall GetForegroundWindow()");
  const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)");
  const GetClassNameW = user32.func("int __stdcall GetClassNameW(uintptr_t hWnd, void *lpClassName, int nMaxCount)");
  const AttachThreadInput = user32.func("int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)");
  const SetForegroundWindow = user32.func("int __stdcall SetForegroundWindow(uintptr_t hWnd)");
  const BringWindowToTop = user32.func("int __stdcall BringWindowToTop(uintptr_t hWnd)");
  const ShowWindow = user32.func("int __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)");
  const SwitchToThisWindow = user32.func("void __stdcall SwitchToThisWindow(uintptr_t hWnd, int fUnknown)");
  const IsIconic = user32.func("int __stdcall IsIconic(uintptr_t hWnd)");
  const GetCurrentThreadId = kernel32.func("uint32 __stdcall GetCurrentThreadId()");

  return {
    getForegroundWindow: () => Number(GetForegroundWindow()),
    getWindowThreadId: (hwnd) => GetWindowThreadProcessId(hwnd, [0]),
    getCurrentThreadId: () => GetCurrentThreadId(),
    attachThreadInput: (a, b, attach) => AttachThreadInput(a, b, attach ? 1 : 0) !== 0,
    setForegroundWindow: (hwnd) => SetForegroundWindow(hwnd) !== 0,
    bringWindowToTop: (hwnd) => BringWindowToTop(hwnd) !== 0,
    showWindow: (hwnd, cmd) => ShowWindow(hwnd, cmd) !== 0,
    switchToThisWindow: (hwnd) => SwitchToThisWindow(hwnd, 1),
    isIconic: (hwnd) => IsIconic(hwnd) !== 0,
    getWindowPid(hwnd) {
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      return pid[0];
    },
    getClassName(hwnd) {
      const buf = Buffer.alloc(512);
      const n = GetClassNameW(hwnd, buf, 256);
      return n > 0 ? buf.toString("utf16le", 0, n * 2) : "";
    },
  };
}

/** Reads an Electron getNativeWindowHandle() buffer as a number. */
export function handleToNumber(buf: Buffer): number {
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}
