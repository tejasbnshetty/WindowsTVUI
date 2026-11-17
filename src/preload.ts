import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tv", {
  getTiles: () => ipcRenderer.invoke("tiles:get"),
  launch: (id: string) => ipcRenderer.invoke("tiles:launch", id),
  quit: () => ipcRenderer.send("app:quit"),
});
