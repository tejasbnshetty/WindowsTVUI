import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tv", {
  getTiles: () => ipcRenderer.invoke("tiles:get"),
  launch: (id: string) => ipcRenderer.invoke("tiles:launch", id),
  getRemoteInfo: () => ipcRenderer.invoke("remote:info"),
  openPairing: () => ipcRenderer.send("pairing:open"),
  onNav: (cb: (action: string) => void) => {
    ipcRenderer.on("remote:nav", (_e, action: unknown) => {
      if (typeof action === "string") cb(action);
    });
  },
  onPairing: (cb: (pairing: unknown, devices: unknown) => void) => {
    ipcRenderer.on("remote:pairing", (_e, pairing: unknown, devices: unknown) => cb(pairing, devices));
  },
  quit: () => ipcRenderer.send("app:quit"),
});
