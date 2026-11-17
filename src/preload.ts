import { contextBridge, ipcRenderer } from "electron";
import type { DisplayView, LauncherInfo, TvApi, UiSettings } from "./ui/types";

// The only things the launcher page can ask the main process to do. Every argument is validated again in main.ts.
const tv: TvApi = {
  getApps: () => ipcRenderer.invoke("apps:list"),
  getUi: () => ipcRenderer.invoke("ui:get"),
  setUi: (patch: Partial<UiSettings>) => ipcRenderer.invoke("ui:set", patch),
  getWallpapers: () => ipcRenderer.invoke("wallpapers:list"),
  getRemoteInfo: () => ipcRenderer.invoke("remote:info"),
  onInfo: (cb: (info: LauncherInfo) => void) => {
    // Pushed whenever the pairing state, the LAN address, the network status or the connected phones change.
    ipcRenderer.on("remote:info", (_e, info: LauncherInfo) => cb(info));
  },
  onNav: (cb: (action: string) => void) => {
    ipcRenderer.on("remote:nav", (_e, action: unknown) => {
      if (typeof action === "string") cb(action);
    });
  },
  launch: (id: string) => ipcRenderer.invoke("apps:launch", id),
  getDevices: () => ipcRenderer.invoke("devices:list"),
  forgetDevices: () => ipcRenderer.invoke("devices:forget"),
  openPairing: () => ipcRenderer.send("pairing:open"),
  closePairing: () => ipcRenderer.send("pairing:close"),
  getDisplays: (): Promise<DisplayView[]> => ipcRenderer.invoke("display:list"),
  chooseDisplay: (id: number | null) => ipcRenderer.invoke("display:choose", id),
  getAbout: () => ipcRenderer.invoke("about:get"),
  openFolder: (which: "wallpapers" | "data") => ipcRenderer.send("folder:open", which),
  quit: () => ipcRenderer.send("app:quit"),
};

contextBridge.exposeInMainWorld("tv", tv);
