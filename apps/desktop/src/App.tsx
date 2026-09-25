import { useCallback, useEffect, useRef } from "react";
import StarfireScene from "./components/StarfireScene";

type StarfireDesktop = {
  startDrag(screenX: number, screenY: number): void;

  moveDrag(screenX: number, screenY: number): void;

  endDrag(): void;
};

declare global {
  interface Window {
    starfireDesktop?: StarfireDesktop;
  }
}

export default function App() {
  const dragging = useRef(false);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    dragging.current = true;

    event.currentTarget.setPointerCapture(event.pointerId);

    window.starfireDesktop?.startDrag(event.screenX, event.screenY);
  }, []);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
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
    };
  }, [stopDragging]);

  return (
    <main
      className="starfire-root"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
    >
      <StarfireScene />
    </main>
  );
}
