import { useEffect, useRef } from "react";
import {
  BLINK_DURATION_MS,
  DEFAULT_REST_GAZE,
  IDLE_REST_MS,
  blinkScaleAt,
  createGazeState,
  eyesTransform,
  followUpBlinkAt,
  gazeTargetFromPointer,
  isBlinking,
  isGazeSettled,
  needsAnimationFrame,
  nextBlinkAt,
  restFocusPoint,
  stepGaze,
} from "../lib/brandCompanion";
import type { ReaderMotionLevel } from "../lib/motion";

type BrandCompanionProps = {
  motionLevel: ReaderMotionLevel;
};

const REST_SURFACE = ".article-shell, .home-view, .welcome";

export function BrandCompanion({ motionLevel }: BrandCompanionProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const eyesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const eyes = eyesRef.current;
    if (!svg || !eyes) return;

    if (motionLevel === "off") {
      eyes.style.transform = eyesTransform(createGazeState(), 1);
      svg.dataset.gaze = "rest";
      return;
    }

    const state = createGazeState();
    const pointer = { x: 0, y: 0 };
    let following = false;
    let restTarget = { ...DEFAULT_REST_GAZE };
    let raf = 0;
    let previous = 0;
    let blinkStartedAt = 0;
    let nextBlink = nextBlinkAt(performance.now(), motionLevel);
    let idleTimer = 0;
    let blinkTimer = 0;
    let cancelled = false;

    const faceOrigin = () => {
      const box = svg.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };

    const computeRestTarget = () => {
      const surface = document.querySelector<HTMLElement>(REST_SURFACE);
      if (!surface) return { ...DEFAULT_REST_GAZE };
      const rect = surface.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return { ...DEFAULT_REST_GAZE };
      const origin = faceOrigin();
      const focus = restFocusPoint(rect);
      return gazeTargetFromPointer(focus.x, focus.y, origin.x, origin.y);
    };

    const currentTarget = () => {
      if (!following) return restTarget;
      const origin = faceOrigin();
      return gazeTargetFromPointer(pointer.x, pointer.y, origin.x, origin.y);
    };

    const stopLoop = () => {
      previous = 0;
      if (raf !== 0) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const scheduleBlinkWake = () => {
      window.clearTimeout(blinkTimer);
      const delay = nextBlink - performance.now();
      if (!Number.isFinite(delay)) return;
      blinkTimer = window.setTimeout(() => {
        ensureLoop();
      }, Math.max(16, delay));
    };

    const apply = (now: number) => {
      if (!isBlinking(now, blinkStartedAt) && now >= nextBlink) {
        blinkStartedAt = now;
        nextBlink = followUpBlinkAt(now, motionLevel) ?? nextBlinkAt(now + BLINK_DURATION_MS, motionLevel);
      }
      const scaleY = blinkScaleAt(now, blinkStartedAt);
      if (blinkStartedAt > 0 && now - blinkStartedAt >= BLINK_DURATION_MS) {
        blinkStartedAt = 0;
      }
      const target = currentTarget();
      const dt = previous === 0 ? 0.016 : (now - previous) / 1000;
      previous = now;
      stepGaze(state, target.x, target.y, dt, motionLevel);
      eyes.style.transform = eyesTransform(state, scaleY);
      return { target, scaleY };
    };

    const setGazeMode = (nextFollowing: boolean) => {
      following = nextFollowing;
      svg.dataset.gaze = nextFollowing ? "pointer" : "rest";
    };

    const tick = (now: number) => {
      if (cancelled) return;
      const hidden = typeof document !== "undefined" && document.hidden;
      if (hidden) {
        raf = 0;
        previous = 0;
        return;
      }
      const { target, scaleY } = apply(now);
      const keep = needsAnimationFrame({
        hidden: false,
        blinking: isBlinking(now, blinkStartedAt),
        settled: isGazeSettled(state, target.x, target.y, scaleY),
      });
      if (!keep) {
        raf = 0;
        previous = 0;
        scheduleBlinkWake();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    const ensureLoop = () => {
      if (cancelled || (typeof document !== "undefined" && document.hidden)) return;
      if (raf !== 0) return;
      previous = 0;
      raf = requestAnimationFrame(tick);
    };

    const onPointerMove = (event: MouseEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      setGazeMode(true);
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        setGazeMode(false);
        restTarget = computeRestTarget();
        ensureLoop();
      }, IDLE_REST_MS);
      ensureLoop();
    };

    const onVisibility = () => {
      if (document.hidden) {
        stopLoop();
        window.clearTimeout(idleTimer);
        window.clearTimeout(blinkTimer);
        return;
      }
      setGazeMode(false);
      restTarget = computeRestTarget();
      ensureLoop();
      scheduleBlinkWake();
    };

    restTarget = computeRestTarget();
    setGazeMode(false);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("mousemove", onPointerMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    ensureLoop();
    scheduleBlinkWake();

    return () => {
      cancelled = true;
      stopLoop();
      window.clearTimeout(idleTimer);
      window.clearTimeout(blinkTimer);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("mousemove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [motionLevel]);

  return (
    <svg
      ref={svgRef}
      className="brand-companion"
      viewBox="0 0 35 35"
      aria-hidden="true"
      data-gaze="rest"
    >
      <g ref={eyesRef} className="brand-companion-eyes">
        <ellipse className="brand-companion-eye" cx="12.4" cy="16.2" rx="4.1" ry="5.15" />
        <ellipse className="brand-companion-eye" cx="22.6" cy="16.2" rx="4.1" ry="5.15" />
      </g>
    </svg>
  );
}
