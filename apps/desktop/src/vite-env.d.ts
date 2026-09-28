/// <reference types="vite/client" />

interface StarfireDesktopApi {
  isElectron: boolean;

  startDrag(): void;

  endDrag(): void;

  onGlobalListen(callback: () => void): () => void;
}

type StarfireVoiceStartResult =
  | { ok: true; conn: number }
  | { ok: false; error: string; fatal: boolean };

type StarfireVoiceRendererEvent = {
  conn: number;
} & (
  | { kind: "session"; info: Record<string, unknown> }
  | { kind: "speech-started" }
  | { kind: "speech-stopped" }
  | { kind: "audio-transcript-delta"; delta: string }
  | { kind: "input-transcript"; text: string }
  | { kind: "response-done"; usage: Record<string, number> | null }
  | { kind: "response-cancelled" }
  | { kind: "error"; message: string; fatal: boolean }
  | { kind: "closed" }
);

interface StarfireVoiceApi {
  start(): Promise<StarfireVoiceStartResult>;

  sendAudio(base64Pcm16: string): void;

  interrupt(): void;

  stop(): void;

  log(message: string): void;

  onEvent(callback: (event: StarfireVoiceRendererEvent) => void): () => void;

  onAudio(callback: (pcm: ArrayBuffer) => void): () => void;
}

declare global {
  interface Window {
    starfireDesktop?: StarfireDesktopApi;

    starfireVoice?: StarfireVoiceApi;
  }
}

export {};
