import { useEffect, useRef } from "react";
import {
  BLINK_MS,
  blinkScale,
  createGazeState,
  eyesTransform,
  gazeTargetFromPointer,
  nextBlinkAt,
  stepGaze,
} from "../lib/brandCompanion";
import type { ReaderMotionLevel } from "../lib/motion";

type BrandCompanionProps = {
  motionLevel: ReaderMotionLevel;
};

export function BrandCompanion({ motionLevel }: BrandCompanionProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const eyes = eyesRef.current;
    if (!svg || !eyes) return;

    if (motionLevel === "off") {
      eyes.style.transform = eyesTransform(createGazeState(), 1);
      return;
    }

    const state = createGazeState();
    const pointer = {
      x: typeof window === "undefined" ? 0 : window.innerWidth * 0.62,
      y: typeof window === "undefined" ? 0 : window.innerHeight * 0.42,
    };
    let raf = 0;
    let previous = 0;
    let blinkUntil = 0;
    let nextBlink = nextBlinkAt(performance.now(), motionLevel);

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (typeof document !== "undefined" && document.hidden) {
        previous = now;
        return;
      }

      const dt = previous === 0 ? 0.016 : (now - previous) / 1000;
      previous = now;

      if (now >= nextBlink) {
        blinkUntil = now + BLINK_MS;
        nextBlink = nextBlinkAt(now, motionLevel);
      }

      const box = svg.getBoundingClientRect();
      const target = gazeTargetFromPointer(
        pointer.x,
        pointer.y,
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      stepGaze(state, target.x, target.y, dt, motionLevel);
      eyes.style.transform = eyesTransform(state, blinkScale(now, blinkUntil));
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [motionLevel]);

  return (
    <svg
      ref={svgRef}
      className="brand-companion"
      viewBox="0 0 35 35"
      aria-hidden="true"
    >
      <g ref={eyesRef} className="brand-companion-eyes">
        <ellipse className="brand-companion-eye" cx="12.4" cy="16.2" rx="4.1" ry="5.15" />
        <ellipse className="brand-companion-eye" cx="22.6" cy="16.2" rx="4.1" ry="5.15" />
      </g>
    </svg>
  );
}
