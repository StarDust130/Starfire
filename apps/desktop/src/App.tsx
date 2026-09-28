import { useCallback, useEffect, useRef, useState } from "react";

import StarfireScene from "./components/StarfireScene";

import { chooseMicrophone, getMicrophones } from "./voice/microphone";

import { createOnnxWakeWord, type WakeEngine } from "./voice/onnxWakeWord";

export type InteractionSource = "wake-word" | "click" | "hotkey";

export default function App() {
  const engineRef = useRef<WakeEngine | null>(null);

  const startingRef = useRef(false);

  const [error, setError] = useState<string | null>(null);

  const activateListening = useCallback((source: InteractionSource): void => {
    console.log(`[Starfire] 💗 listening activated by ${source}`);

    window.dispatchEvent(
      new CustomEvent("starfire:listen", {
        detail: {
          source,
        },
      }),
    );
  }, []);

  const startWakeEngine = useCallback(async (): Promise<void> => {
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

      console.log(`[Starfire] 🎙️ microphone: ${microphone.label}`);

      const engine = await createOnnxWakeWord();

      engineRef.current = engine;

      console.log("[Starfire] 🧠 loading wake-word engine...");

      await engine.load();

      console.log("[Starfire] 🎧 starting wake-word listener...");

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
      console.error("[Starfire] ❌ wake-word startup failed:", cause);

      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      startingRef.current = false;
    }
  }, [activateListening]);

  useEffect(() => {
    void startWakeEngine();

    /*
     * Super+Z from the main process (works while unfocused).
     */
    const removeGlobalListen =
      window.starfireDesktop?.onGlobalListen(() => {
        activateListening("hotkey");
      }) ?? null;

    /*
     * Super+Z while the window has focus.
     * Ctrl+Z is deliberately ignored.
     */
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

    return () => {
      removeGlobalListen?.();

      window.removeEventListener("keydown", handleKeyDown);

      const engine = engineRef.current;

      engineRef.current = null;

      void engine?.stop();
    };
  }, [activateListening, startWakeEngine]);

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
        onActivate={activateListening}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      />
    </main>
  );
}
