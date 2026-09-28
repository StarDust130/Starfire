import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  chooseMicrophone,
  getMicrophones,
  type MicrophoneDevice,
} from "./voice/microphone";

import {
  createOnnxWakeWord,
  type WakeEngine,
} from "./voice/onnxWakeWord";

type Status =
  | "idle"
  | "loading"
  | "listening"
  | "detected"
  | "error";

export default function App() {
  const engineRef =
    useRef<WakeEngine | null>(
      null,
    );

  const [status, setStatus] =
    useState<Status>("idle");

  const [mic, setMic] =
    useState<MicrophoneDevice | null>(
      null,
    );

  const [score, setScore] =
    useState(0);

  const [hits, setHits] =
    useState(0);

  const [error, setError] =
    useState<string | null>(
      null,
    );

  useEffect(() => {
    return () => {
      void engineRef.current?.stop();
    };
  }, []);

  const start =
    async (): Promise<void> => {
      try {
        setError(null);
        setStatus("loading");

        const devices =
          await getMicrophones();

        const selected =
          chooseMicrophone(
            devices,
          );

        if (!selected) {
          throw new Error(
            "No microphone found.",
          );
        }

        setMic(selected);

        const engine =
          await createOnnxWakeWord();

        engineRef.current =
          engine;

        await engine.load();

        await engine.start(
          selected.id,
          (
            word,
            probability,
          ) => {
            if (
              word !==
              "starfire"
            ) {
              return;
            }

            setScore(
              Math.round(
                probability * 100,
              ),
            );

            setHits(
              (value) =>
                value + 1,
            );

            setStatus(
              "detected",
            );

            window.setTimeout(
              () => {
                setStatus(
                  "listening",
                );
              },
              700,
            );

            window.dispatchEvent(
              new CustomEvent(
                "starfire:wake",
                {
                  detail: {
                    word,
                    probability,
                  },
                },
              ),
            );
          },
        );

        setStatus(
          "listening",
        );
      } catch (cause) {
        console.error(
          cause,
        );

        setError(
          cause instanceof Error
            ? cause.message
            : String(cause),
        );

        setStatus("error");
      }
    };

  const stop =
    async (): Promise<void> => {
      await engineRef.current?.stop();

      engineRef.current =
        null;

      setStatus("idle");
    };

  const listening =
    status === "listening";

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "grid",
        placeItems: "center",
        background: "transparent",
        color: "white",
        fontFamily:
          "Inter, system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: 280,
          padding: 14,
          boxSizing: "border-box",
          borderRadius: 22,
          background:
            "rgba(24,20,31,.97)",
          border:
            "1px solid rgba(255,255,255,.1)",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              display: "grid",
              placeItems: "center",
              background:
                "linear-gradient(135deg,#f04db9,#9e5cff)",
            }}
          >
            🎀
          </div>

          <div>
            <div
              style={{
                fontWeight: 700,
                fontSize: 15,
              }}
            >
              Starfire
            </div>

            <div
              style={{
                fontSize: 9,
                color:
                  "rgba(255,255,255,.45)",
              }}
            >
              Wake-word test
            </div>
          </div>
        </div>

        <div
          style={{
            height: 120,
            display: "grid",
            placeItems: "center",
            textAlign: "center",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 30,
              }}
            >
              {status ===
              "detected"
                ? "✨"
                : status ===
                    "error"
                  ? "⚠️"
                  : status ===
                      "loading"
                    ? "⏳"
                    : listening
                      ? "🎧"
                      : "💤"}
            </div>

            <div
              style={{
                marginTop: 8,
                fontWeight: 700,
              }}
            >
              {status ===
              "detected"
                ? "Wake detected!"
                : status ===
                    "error"
                  ? "Error"
                  : status ===
                      "loading"
                    ? "Loading..."
                    : listening
                      ? "Listening"
                      : "Wake-word test"}
            </div>

            <div
              style={{
                marginTop: 4,
                fontSize: 9,
                color:
                  "rgba(255,255,255,.4)",
              }}
            >
              {status ===
              "listening"
                ? "Say Starfire"
                : status ===
                    "detected"
                  ? "Starfire heard you"
                  : "Local wake-word detection"}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "1fr 1fr 1fr",
            gap: 5,
            marginBottom: 8,
          }}
        >
          <div
            style={{
              padding: 8,
              borderRadius: 9,
              textAlign: "center",
              background:
                "rgba(255,255,255,.04)",
            }}
          >
            <div
              style={{
                fontSize: 7,
                color:
                  "rgba(255,255,255,.3)",
              }}
            >
              SCORE
            </div>

            <div
              style={{
                marginTop: 3,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {score}%
            </div>
          </div>

          <div
            style={{
              padding: 8,
              borderRadius: 9,
              textAlign: "center",
              background:
                "rgba(255,255,255,.04)",
            }}
          >
            <div
              style={{
                fontSize: 7,
                color:
                  "rgba(255,255,255,.3)",
              }}
            >
              HITS
            </div>

            <div
              style={{
                marginTop: 3,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {hits}
            </div>
          </div>

          <div
            style={{
              padding: 8,
              borderRadius: 9,
              textAlign: "center",
              background:
                "rgba(255,255,255,.04)",
            }}
          >
            <div
              style={{
                fontSize: 7,
                color:
                  "rgba(255,255,255,.3)",
              }}
            >
              MIC
            </div>

            <div
              style={{
                marginTop: 3,
                fontSize: 8,
                fontWeight: 700,
                overflow: "hidden",
                whiteSpace:
                  "nowrap",
                textOverflow:
                  "ellipsis",
              }}
            >
              {mic?.label ??
                "None"}
            </div>
          </div>
        </div>

        {error && (
          <div
            style={{
              marginBottom: 8,
              padding: 8,
              borderRadius: 8,
              background:
                "rgba(255,50,80,.12)",
              color: "#ff9bb7",
              fontSize: 8,
              wordBreak:
                "break-word",
            }}
          >
            {error}
          </div>
        )}

        <button
          onClick={() => {
            if (listening) {
              void stop();
            } else {
              void start();
            }
          }}
          style={{
            width: "100%",
            height: 32,
            border: 0,
            borderRadius: 11,
            background:
              "linear-gradient(90deg,#ef4fba,#a052ff)",
            color: "white",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {listening
            ? "🛑 Stop"
            : "🎤 Start"}
        </button>
      </div>
    </div>
  );
}