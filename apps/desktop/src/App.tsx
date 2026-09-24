import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import {
  characterReducer,
  initialCharacterState,
  type CharacterEvent,
  type CharacterState,
} from "./character";
import "./App.css";

const appWindow = getCurrentWindow();

const PET_WIDTH = 260;
const PET_HEIGHT = 280;
const FLOOR_OFFSET = 16;

function App() {
  const [state, dispatch] = useReducer(characterReducer, initialCharacterState);

  const [facing, setFacing] = useReducer(
    (_current: "left" | "right", next: "left" | "right") => next,
    "right",
  );

  const stateRef = useRef<CharacterState>(state);
  const walkingRef = useRef(false);
  const draggingRef = useRef(false);
  const targetXRef = useRef<number | null>(null);
  const idleUntilRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const send = useCallback((event: CharacterEvent) => {
    dispatch(event);
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    void appWindow
      .onCloseRequested((event) => {
        event.preventDefault();
        void appWindow.hide();
      })
      .then((unlisten) => {
        cleanup = unlisten;
      });

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function placeInitialPosition() {
      const monitor = await currentMonitor();

      if (!monitor || cancelled) {
        return;
      }

      const area = monitor.workArea;

      const x = area.position.x + area.size.width - PET_WIDTH - 30;

      const y = area.position.y + area.size.height - PET_HEIGHT - FLOOR_OFFSET;

      await appWindow.setPosition(new PhysicalPosition(x, y));
    }

    void placeInitialPosition();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    let cancelled = false;
    let lastTime = performance.now();

    async function startWander() {
      const monitor = await currentMonitor();

      if (!monitor || draggingRef.current) {
        return;
      }

      const area = monitor.workArea;
      const current = await appWindow.innerPosition();

      const minX = area.position.x + 20;

      const maxX = area.position.x + area.size.width - PET_WIDTH - 20;

      let nextX = minX + Math.random() * Math.max(maxX - minX, 1);

      if (Math.abs(nextX - current.x) < 140) {
        nextX = nextX > current.x ? minX : maxX;
      }

      targetXRef.current = nextX;
      walkingRef.current = true;

      setFacing(nextX >= current.x ? "right" : "left");

      send({ type: "WALK" });
    }

    async function tick(time: number) {
      const delta = Math.min(time - lastTime, 50);

      lastTime = time;

      if (
        !draggingRef.current &&
        stateRef.current === "idle" &&
        !walkingRef.current &&
        time >= idleUntilRef.current
      ) {
        await startWander();
      }

      if (
        !draggingRef.current &&
        walkingRef.current &&
        targetXRef.current !== null
      ) {
        const position = await appWindow.innerPosition();

        const distance = targetXRef.current - position.x;

        if (Math.abs(distance) < 4) {
          walkingRef.current = false;
          targetXRef.current = null;

          send({ type: "IDLE" });

          idleUntilRef.current =
            performance.now() + 2200 + Math.random() * 5000;
        } else {
          const speed = 0.22 * delta;

          const movement =
            Math.sign(distance) * Math.min(Math.abs(distance), speed);

          setFacing(movement >= 0 ? "right" : "left");

          await appWindow.setPosition(
            new PhysicalPosition(position.x + movement, position.y),
          );
        }
      }

      if (!cancelled) {
        frame = requestAnimationFrame(tick);
      }
    }

    frame = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [send]);

  async function handleDrag() {
    draggingRef.current = true;
    walkingRef.current = false;
    targetXRef.current = null;

    send({ type: "HAPPY" });

    try {
      await appWindow.startDragging();
    } finally {
      draggingRef.current = false;

      send({ type: "IDLE" });

      idleUntilRef.current = performance.now() + 5000;
    }
  }

  function temporaryState(event: CharacterEvent) {
    send(event);

    window.setTimeout(() => {
      send({ type: "IDLE" });

      idleUntilRef.current = performance.now() + 2500;
    }, 1800);
  }

  return (
    <main
      className="pet-root"
      onPointerDown={() => {
        void handleDrag();
      }}
      onDoubleClick={() => {
        temporaryState({
          type: "HAPPY",
        });
      }}
      onContextMenu={(event) => {
        event.preventDefault();

        temporaryState({
          type: "THINK",
        });
      }}
    >
      <div className={`pet-stage state-${state}`}>
        <div className="ambient-glow" />

        <div className="state-particles">
          {state === "happy" && (
            <>
              <span className="particle-one">✦</span>
              <span className="particle-two">✧</span>
              <span className="particle-three">✦</span>
            </>
          )}

          {state === "thinking" && (
            <>
              <span className="thought-one">•</span>
              <span className="thought-two">••</span>
              <span className="thought-three">?</span>
            </>
          )}

          {state === "listening" && (
            <div className="sound-bars">
              <i />
              <i />
              <i />
              <i />
            </div>
          )}
        </div>

        <img
          className={`starfire-sprite facing-${facing}`}
          src="/starfire.svg"
          alt="Starfire"
          draggable={false}
        />

        <div className="shadow" />

        {state === "speaking" && (
          <div className="voice-bubble">
            <span className="voice-bar-one" />
            <span className="voice-bar-two" />
            <span className="voice-bar-three" />
          </div>
        )}

        {state === "listening" && <div className="listen-ring" />}
      </div>
    </main>
  );
}

export default App;
