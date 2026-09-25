const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("starfireDesktop", {
  isElectron: true,

  startDrag(screenX, screenY) {
    ipcRenderer.send("starfire:drag-start", {
      screenX,
      screenY,
    });
  },

  moveDrag(screenX, screenY) {
    ipcRenderer.send("starfire:drag-move", {
      screenX,
      screenY,
    });
  },

  endDrag() {
    ipcRenderer.send("starfire:drag-end");
  },
});
