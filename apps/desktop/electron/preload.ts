import { contextBridge, ipcRenderer } from "electron";

const starfireDesktop = {
  isElectron: true,

  startDrag(screenX: number, screenY: number): void {
    ipcRenderer.send("starfire:drag-start", {
      screenX,
      screenY,
    });
  },

  moveDrag(screenX: number, screenY: number): void {
    ipcRenderer.send("starfire:drag-move", {
      screenX,
      screenY,
    });
  },

  endDrag(): void {
    ipcRenderer.send("starfire:drag-end");
  },
};

contextBridge.exposeInMainWorld("starfireDesktop", starfireDesktop);
