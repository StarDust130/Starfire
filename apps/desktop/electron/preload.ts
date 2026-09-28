import { contextBridge, ipcRenderer } from "electron";

const starfireDesktop = {
  isElectron: true,

  startDrag(): void {
    ipcRenderer.send("starfire:drag-start");
  },

  endDrag(): void {
    ipcRenderer.send("starfire:drag-end");
  },

  /*
   * Main sends "starfire:global-listen" via webContents.send.
   * Returns an unsubscribe function.
   */
  onGlobalListen(callback: () => void): () => void {
    const listener = (): void => {
      callback();
    };

    ipcRenderer.on("starfire:global-listen", listener);

    return () => {
      ipcRenderer.removeListener("starfire:global-listen", listener);
    };
  },
};

contextBridge.exposeInMainWorld("starfireDesktop", starfireDesktop);
