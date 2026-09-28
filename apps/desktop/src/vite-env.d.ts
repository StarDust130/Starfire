/// <reference types="vite/client" />

interface StarfireDesktopApi {
  isElectron: boolean;

  startDrag(): void;

  endDrag(): void;

  onGlobalListen(callback: () => void): () => void;
}

declare global {
  interface Window {
    starfireDesktop?: StarfireDesktopApi;
  }
}

export {};
