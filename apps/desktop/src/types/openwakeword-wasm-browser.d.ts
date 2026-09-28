declare module "@edyrkaj/openwakeword-wasm-browser" {
  type ExternalDataFile =
    | string
    | {
        path: string;
        data: string;
      };

  type WakeWordEngineOptions = {
    baseAssetUrl: string;

    keywords: string[];

    modelFiles?: Record<
      string,
      string
    >;

    externalDataFiles?: Record<
      string,
      ExternalDataFile
    >;

    detectionThreshold?: number;

    cooldownMs?: number;

    frameSize?: number;

    sampleRate?: number;

    vadHangoverFrames?: number;

    executionProviders?: string[];

    embeddingWindowSize?: number;

    ortWasmPath?: string;

    debug?: boolean;
  };

  type StartOptions = {
    deviceId?: string;
    gain?: number;
  };

  type DetectEvent = {
    keyword: string;
    score: number;
    at: number;
  };

  type Unsubscribe = () => void;

  class WakeWordEngine {
    constructor(
      options: WakeWordEngineOptions,
    );

    load(): Promise<void>;

    start(
      options?: StartOptions,
    ): Promise<void>;

    stop(): Promise<void>;

    on(
      event: "detect",
      handler: (
        event: DetectEvent,
      ) => void,
    ): Unsubscribe;

    on(
      event:
        | "speech-start"
        | "speech-end",
      handler: (
        event: unknown,
      ) => void,
    ): Unsubscribe;

    on(
      event: "error",
      handler: (
        event: unknown,
      ) => void,
    ): Unsubscribe;

    setActiveKeywords(
      names: string[],
    ): void;

    setGain(
      value: number,
    ): void;
  }

  export default WakeWordEngine;
}