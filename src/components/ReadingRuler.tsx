import { useEffect, useRef, useState } from "react";
import { rulerBandHeight } from "../lib/focusMode";

/**
 * 阅读标尺（plan-focus-mode §3.3）：跟随指针的横向色带。
 * `pointer-events: none` 的纯视觉层，挂在 .reading-frame 内、以
 * 阅读容器（readerRef）矩形为坐标系；指针离开阅读区即隐藏。
 * 触屏（hover: none）由调用方不渲染本组件。
 */
export function ReadingRuler({
  readerRef,
  fontSize,
  lineHeight,
}: {
  readerRef: React.RefObject<HTMLElement | null>;
  fontSize: number;
  lineHeight: number;
}) {
  const [y, setY] = useState<number | null>(null);
  const frame = useRef<number | null>(null);
  const height = rulerBandHeight(fontSize, lineHeight);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader) return;

    const onPointerMove = (event: PointerEvent) => {
      if (frame.current !== null) return;
      const clientY = event.clientY;
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null;
        const rect = reader.getBoundingClientRect();
        const offset = clientY - rect.top - height / 2;
        setY(Math.min(Math.max(0, rect.height - height), Math.max(0, offset)));
      });
    };
    const onPointerLeave = () => {
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      setY(null);
    };

    reader.addEventListener("pointermove", onPointerMove, { passive: true });
    reader.addEventListener("pointerleave", onPointerLeave);
    return () => {
      reader.removeEventListener("pointermove", onPointerMove);
      reader.removeEventListener("pointerleave", onPointerLeave);
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      setY(null);
    };
  }, [height, readerRef]);

  if (y === null) return null;
  return (
    <div
      className="reading-ruler"
      aria-hidden="true"
      data-testid="reading-ruler"
      style={{ height: `${height}px`, transform: `translateY(${y}px)` }}
    />
  );
}
