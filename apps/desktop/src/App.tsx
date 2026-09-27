import {
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import StarfireScene from "./components/StarfireScene";
import { HandsFreeListener } from "./voice/handsFree";
import { speakWithLfm } from "./voice/lfmAudio";

type StarfireDesktop = {
  startDrag(screenX: number, screenY: number): void;

  moveDrag(screenX: number, screenY: number): void;

  endDrag(): void;
};

type VoiceState = "idle" | "listening" | "thinking" | "speaking";

declare global {
  interface Window {
    starfireDesktop?: StarfireDesktop;
  }
}

let queuedVoiceLevel = 0;
let voiceLevelFrame = 0;

function dispatchVoiceState(state: VoiceState): void {
  window.dispatchEvent(
    new CustomEvent("starfire:voice-state", {
      detail: state,
    }),
  );
}

function dispatchVoiceLevel(level: number): void {
  queuedVoiceLevel = Math.min(1, Math.max(0, level));

  if (voiceLevelFrame !== 0) {
    return;
  }

  voiceLevelFrame = window.requestAnimationFrame(() => {
    voiceLevelFrame = 0;

    window.dispatchEvent(
      new CustomEvent("starfire:voice-level", {
        detail: queuedVoiceLevel,
      }),
    );
  });
}

export default function App() {
  const dragging = useRef(false);

  const [voiceState, setVoiceState] = useState<VoiceState>("idle");

  const [micReady, setMicReady] = useState(false);

  const [micError, setMicError] = useState(false);

  const updateVoiceState = useCallback((state: VoiceState) => {
    console.log(`[Starfire] STATE -> ${state.toUpperCase()}`);

    setVoiceState(state);
    dispatchVoiceState(state);
  }, []);

  const handlePointerDown = useCallback((event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    dragging.current = true;

    event.currentTarget.setPointerCapture(event.pointerId);

    window.starfireDesktop?.startDrag(event.screenX, event.screenY);
  }, []);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    if (!dragging.current) {
      return;
    }

    window.starfireDesktop?.moveDrag(event.screenX, event.screenY);
  }, []);

  const stopDragging = useCallback(() => {
    if (!dragging.current) {
      return;
    }

    dragging.current = false;

    window.starfireDesktop?.endDrag();
  }, []);

  useEffect(() => {
    window.addEventListener("pointerup", stopDragging);

    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointerup", stopDragging);

      window.removeEventListener("pointercancel", stopDragging);

      if (voiceLevelFrame !== 0) {
        window.cancelAnimationFrame(voiceLevelFrame);

        voiceLevelFrame = 0;
      }
    };
  }, [stopDragging]);

  useEffect(() => {
    let disposed = false;

    const handsFree = new HandsFreeListener({
      onReady(microphoneLabel) {
        if (disposed) {
          return;
        }

        console.log("[Starfire] 🎤 microphone ready:", microphoneLabel);

        setMicReady(true);
        setMicError(false);

        updateVoiceState("idle");
      },

      onSpeechStart() {
        if (disposed) {
          return;
        }

        console.log("[Starfire] 🎤 HEARD YOU");

        updateVoiceState("listening");
      },

      onLevel(level) {
        if (!disposed) {
          dispatchVoiceLevel(level);
        }
      },

      async onSpeech(wav) {
        if (disposed) {
          return;
        }

        console.log("[Starfire] 🧠 THINKING");

        updateVoiceState("thinking");

        let receivedAudio = false;

        try {
          const text = await speakWithLfm(wav, {
            onText(delta) {
              console.log("[Starfire] 🤖", delta);
            },

            onAudioStart() {
              receivedAudio = true;

              console.log("[Starfire] 🔊 SPEAKING");

              updateVoiceState("speaking");
            },

            onAudioLevel(level) {
              if (!disposed) {
                dispatchVoiceLevel(level);
              }
            },
          });

          console.log("[Starfire] ✅ RESPONSE:", text);

          if (!receivedAudio) {
            console.warn("[Starfire] ⚠️ No audio was returned by LFM.");
          }
        } catch (error) {
          console.error("[Starfire] ❌ Voice error:", error);

          setMicError(true);
        } finally {
          if (!disposed) {
            dispatchVoiceLevel(0);
            updateVoiceState("idle");
          }
        }
      },

      onError(error) {
        if (disposed) {
          return;
        }

        console.error("[Starfire] ❌ Microphone error:", error);

        setMicReady(false);
        setMicError(true);

        dispatchVoiceLevel(0);
        updateVoiceState("idle");
      },
    });

    console.log("[Starfire] 🎧 Starting hands-free mode");

    void handsFree.start().catch((error: unknown) => {
      if (disposed) {
        return;
      }

      console.error("[Starfire] ❌ Hands-free startup failed:", error);

      setMicReady(false);
      setMicError(true);
    });

    return () => {
      disposed = true;

      console.log("[Starfire] 🎧 Stopping hands-free mode");

      dispatchVoiceLevel(0);

      void handsFree.stop();
    };
  }, [updateVoiceState]);

  const statusText = micError
    ? "Microphone error"
    : voiceState === "listening"
      ? "Listening…"
      : voiceState === "thinking"
        ? "Thinking…"
        : voiceState === "speaking"
          ? "Speaking…"
          : micReady
            ? "Listening for you"
            : "Starting microphone…";

  return (
    <main
      className="starfire-root"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
    >
      <StarfireScene />

      <div
        className={`starfire-voice-status state-${voiceState}`}
        aria-live="polite"
      >
        <span className="starfire-voice-dot" />
        <span>{statusText}</span>
      </div>
    </main>
  );
}
