import { type RefObject, useEffect, useRef } from "react";

import { clamp, type HeadAnchor } from "../three/pose";

type StarfireZzzProps = {
  anchorRef: RefObject<HeadAnchor | null>;
};

export default function StarfireZzz({ anchorRef }: StarfireZzzProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = rootRef.current;

    if (!element) {
      return;
    }

    const anchor = anchorRef.current;

    if (!anchor) {
      return;
    }

    const x = clamp(
      anchor.x + anchor.r * 0.5,
      8,
      Math.max(8, window.innerWidth - 40),
    );

    const y = clamp(
      anchor.y - anchor.r - 18,
      8,
      Math.max(8, window.innerHeight - 60),
    );

    element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }, [anchorRef]);

  return (
    <div className="starfire-zzz" ref={rootRef}>
      <span className="starfire-z z1">z</span>
      <span className="starfire-z z2">z</span>
      <span className="starfire-z z3">Z</span>
    </div>
  );
}
