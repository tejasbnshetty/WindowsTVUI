import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tv", {
  getTiles: () => ipcRenderer.invoke("tiles:get"),
  launch: (id: string) => ipcRenderer.invoke("tiles:launch", id),
  getRemoteInfo: () => ipcRenderer.invoke("remote:info"),
  onNav: (cb: (action: string) => void) => {
    ipcRenderer.on("remote:nav", (_e, action: unknown) => {
      if (typeof action === "string") cb(action);
    });
  },
  quit: () => ipcRenderer.send("app:quit"),
});
