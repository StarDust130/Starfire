import { contextBridge, ipcRenderer } from "electron";

const starfireDesktop = {
  isElectron: true,

  startDrag(): void {
    ipcRenderer.send("starfire:drag-start");
  },

  endDrag(): void {
    ipcRenderer.send("starfire:drag-end");
  },

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

const starfireVoice = {
  start(): Promise<unknown> {
    return ipcRenderer.invoke("starfire-voice:start");
  },

  sendAudio(base64Pcm16: string): void {
    ipcRenderer.send("starfire-voice:audio", base64Pcm16);
  },

  interrupt(): void {
    ipcRenderer.send("starfire-voice:interrupt");
  },

  stop(): void {
    void ipcRenderer.invoke("starfire-voice:stop");
  },

  log(message: string): void {
    ipcRenderer.send("starfire-voice:log", message);
  },

  onEvent(callback: (event: unknown) => void): () => void {
    const listener = (_event: unknown, payload: unknown): void => {
      callback(payload);
    };

    ipcRenderer.on("starfire-voice:event", listener);

    return () => {
      ipcRenderer.removeListener("starfire-voice:event", listener);
    };
  },

  onAudio(callback: (pcm: ArrayBuffer) => void): () => void {
    const listener = (_event: unknown, data: Uint8Array): void => {
      const copy = new Uint8Array(data.byteLength);

      copy.set(data);

      callback(copy.buffer);
    };

    ipcRenderer.on("starfire-voice:audio", listener);

    return () => {
      ipcRenderer.removeListener("starfire-voice:audio", listener);
    };
  },
};

contextBridge.exposeInMainWorld("starfireDesktop", starfireDesktop);

contextBridge.exposeInMainWorld("starfireVoice", starfireVoice);
