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
  // Pushed whenever the pairing state, the LAN address or the network status changes.
  onInfo: (cb: (info: unknown) => void) => {
    ipcRenderer.on("remote:info", (_e, info: unknown) => cb(info));
  },
  quit: () => ipcRenderer.send("app:quit"),
});
