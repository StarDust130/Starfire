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

  const startingRef = useRef(false);

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

  const startWakeEngine = useCallback(
    async (allowRetry = true): Promise<void> => {
      if (engineRef.current || startingRef.current) {
        return;
      }

      startingRef.current = true;

      try {
        console.log("[Starfire] 🎤 requesting microphone...");

        const microphones = await getMicrophones();

        const microphone = chooseMicrophone(microphones);

        if (!microphone) {
          throw new Error("No microphone found.");
        }

        micIdRef.current = microphone.id;

        console.log(`[Starfire] 🎙️ microphone: ${microphone.label}`);

        const engine = await createOnnxWakeWord();

        engineRef.current = engine;

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

        console.log("[Starfire] ✅ wake-word listener ready.");
      } catch (cause) {
        /*
         * The wake engine's AudioContext can transiently fail to load
         * its worklet right after a conversation AudioContext closed
         * ("Unable to load a worklet's module"). One automatic retry
         * fixes that race.
         */
        if (allowRetry && !engineRef.current) {
          console.warn(
            "[Starfire] ⚠️ wake-word start failed — retrying once...",
            cause instanceof Error ? cause.message : cause,
          );

          startingRef.current = false;

          await new Promise((resolve) => {
            setTimeout(resolve, WAKE_RETRY_DELAY_MS);
          });

          return startWakeEngine(false);
        }

        console.error("[Starfire] ❌ wake-word startup failed:", cause);

        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        startingRef.current = false;
      }
    },
    [activateListening],
  );

  const stopWakeEngine = useCallback(async (): Promise<void> => {
    const engine = engineRef.current;

    engineRef.current = null;

    startingRef.current = false;

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

      void engine?.stop();
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
