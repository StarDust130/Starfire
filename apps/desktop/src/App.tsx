import { useCallback, useEffect, useRef, useState } from "react";

import StarfireScene from "./components/StarfireScene";
import { chooseMicrophone, getMicrophones } from "./voice/microphone";
import { createOnnxWakeWord, type WakeEngine } from "./voice/onnxWakeWord";

import {
  VoiceController,
  type VoiceSnapshot,
} from "./voice/realtime/controller";
import { createMicPipeline } from "./voice/realtime/microphone";
import { createPlaybackPipeline } from "./voice/realtime/playback";

export type InteractionSource = "wake-word" | "click" | "hotkey";

const WAKE_RETRY_DELAY_MS = 800;

export default function App() {
  const engineRef = useRef<WakeEngine | null>(null);

  /*
   * In-flight wake engine startup: stopWakeEngine must be able to wait
   * for it — otherwise a still-starting engine could grab the
   * microphone right after the voice session opened it.
   */
  const engineStartRef = useRef<Promise<void> | null>(null);

  const controllerRef = useRef<VoiceController | null>(null);

  const micIdRef = useRef<string | undefined>(undefined);

  const [error, setError] = useState<string | null>(null);

  const [voice, setVoice] = useState<VoiceSnapshot>({
    state: "idle",
    message: null,
  });

  const [activeTool, setActiveTool] = useState<string | null>(null);

  const [goodbyeSleep, setGoodbyeSleep] = useState(false);

  const activateListening = useCallback((source: InteractionSource): void => {
    console.log(`[Starfire] 💗 listening activated by ${source}`);

    window.dispatchEvent(
      new CustomEvent("starfire:listen", {
        detail: { source },
      }),
    );

    void controllerRef.current?.start(source);
  }, []);

  const startWakeEngine = useCallback(async (): Promise<void> => {
    if (engineRef.current) {
      return;
    }

    if (engineStartRef.current) {
      return engineStartRef.current;
    }

    const attempt = async (retried: boolean): Promise<void> => {
      let engine: WakeEngine | null = null;

      try {
        console.log("[Starfire] 🎤 requesting microphone...");

        const microphones = await getMicrophones();

        const microphone = chooseMicrophone(microphones);

        if (!microphone) {
          throw new Error("No microphone found.");
        }

        micIdRef.current = microphone.id;

        console.log(`[Starfire] 🎙️ microphone: ${microphone.label}`);

        engine = await createOnnxWakeWord();

        await engine.load();

        await engine.start(microphone.id, (word, probability) => {
          if (word.toLowerCase() !== "starfire") {
            return;
          }

          console.log(
            `[Starfire] ✅ wake detected: "${word}" score=${probability.toFixed(3)}`,
          );

          activateListening("wake-word");
        });

        /*
         * Publish the engine only after it is fully started — a failed
         * load/start must not leave a half-built engine behind (which
         * used to skip the retry below and block stopWakeEngine).
         */
        engineRef.current = engine;

        console.log("[Starfire] ✅ wake-word listener ready.");
      } catch (cause) {
        await engine?.stop().catch(() => {});

        /*
         * The wake engine's AudioContext can transiently fail to load
         * its worklet right after a conversation AudioContext closed
         * ("Unable to load a worklet's module"). One automatic retry
         * fixes that race.
         */
        if (!retried) {
          console.warn(
            "[Starfire] ⚠️ wake-word start failed — retrying once...",
            cause instanceof Error ? cause.message : cause,
          );

          await new Promise((resolve) => {
            setTimeout(resolve, WAKE_RETRY_DELAY_MS);
          });

          return attempt(true);
        }

        console.error("[Starfire] ❌ wake-word startup failed:", cause);

        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };

    const run = attempt(false).finally(() => {
      engineStartRef.current = null;
    });

    engineStartRef.current = run;

    return run;
  }, [activateListening]);

  const stopWakeEngine = useCallback(async (): Promise<void> => {
    /*
     * If a startup is still in flight, wait for it to settle first so
     * it cannot re-grab the microphone after we stop everything.
     */
    const starting = engineStartRef.current;

    if (starting) {
      await starting.catch(() => {});
    }

    const engine = engineRef.current;

    engineRef.current = null;

    if (engine) {
      console.log("[Starfire] 🛑 wake-word listener paused for conversation.");

      await engine.stop();
    }
  }, []);

  useEffect(() => {
    void startWakeEngine();

    const removeGlobalListen =
      window.starfireDesktop?.onGlobalListen(() => {
        activateListening("hotkey");
      }) ?? null;

    const handleKeyDown = (event: KeyboardEvent): void => {
      const isSuperZ =
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z";

      if (!isSuperZ) {
        return;
      }

      event.preventDefault();

      activateListening("hotkey");
    };

    window.addEventListener("keydown", handleKeyDown);

    const controller = new VoiceController({
      bridge: window.starfireVoice ?? null,

      createMic: createMicPipeline,

      createPlayback: createPlaybackPipeline,

      onStopWakeEngine: stopWakeEngine,

      onStartWakeEngine: () => {
        void startWakeEngine();
      },

      getDeviceId: () => micIdRef.current,

      onLog: (message) => {
        if (window.starfireVoice) {
          window.starfireVoice.log(message);
        } else {
          console.log(`[Starfire Voice] ${message}`);
        }
      },

      onToolEvent: (event) => {
        if (event.kind === "tool-call") {
          setActiveTool(event.name ?? "tool");

          if (event.name === "end_session") {
            setGoodbyeSleep(true);

            window.setTimeout(() => {
              setGoodbyeSleep(false);
            }, 6000);
          }
        } else if (event.kind === "tool-end") {
          setActiveTool(null);
        }
      },
    });

    controllerRef.current = controller;

    const unsubscribe = controller.subscribe((snapshot) => {
      setVoice(snapshot);
    });

    const handlePageHide = (): void => {
      controller.stop("pagehide");
    };

    window.addEventListener("pagehide", handlePageHide);

    return () => {
      removeGlobalListen?.();

      window.removeEventListener("keydown", handleKeyDown);

      window.removeEventListener("pagehide", handlePageHide);

      unsubscribe();

      controller.dispose();

      controllerRef.current = null;

      setActiveTool(null);

      const engine = engineRef.current;

      engineRef.current = null;

      void engine?.stop().catch(() => {});
    };
  }, [activateListening, startWakeEngine, stopWakeEngine]);

  useEffect(() => {
    if (!voice.message) {
      return;
    }

    const timer = window.setTimeout(() => {
      controllerRef.current?.clearMessage();
    }, 6000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [voice.message]);

  const handleDragStart = useCallback((): void => {
    window.starfireDesktop?.startDrag();
  }, []);

  const handleDragEnd = useCallback((): void => {
    window.starfireDesktop?.endDrag();
  }, []);

  return (
    <main className="starfire-root">
      <StarfireScene
        error={error}
        voiceState={voice.state}
        voiceError={voice.message}
        voiceMouth={controllerRef.current?.mouth ?? { raw: 0 }}
        activeTool={activeTool}
        goodbyeSleep={goodbyeSleep}
        onActivate={activateListening}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      />
    </main>
  );
}
