type OverflowMarqueeProps = {
  children: string;
  className?: string;
};

export function OverflowMarquee({ children, className }: OverflowMarqueeProps) {
  return (
    <span className={["overflow-marquee", className].filter(Boolean).join(" ")}>
      <span className="overflow-marquee__text">{children}</span>
    </span>
  );
}

/** 滚动段的像素速度；长短标题共用，避免短的爬、长的闪过。 */
export const MARQUEE_SPEED_PX_PER_SEC = 30;

/**
 * 单程滚动占动画周期的比例，须与 `.overflow-marquee-scroll`
 * 的 10%→50% / 60%→100% 关键帧一致。
 */
const MARQUEE_TRAVEL_RATIO = 0.4;

function motionDisabled(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.motion === "off") {
    return true;
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function marqueeDurationSeconds(overflowPx: number): number {
  return overflowPx / MARQUEE_SPEED_PX_PER_SEC / MARQUEE_TRAVEL_RATIO;
}

export function armOverflowMarquee(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>(".overflow-marquee");
  const text = wrap?.querySelector<HTMLElement>(".overflow-marquee__text");
  if (!wrap || !text) {
    return;
  }
  if (motionDisabled()) {
    wrap.classList.remove("is-overflowing");
    return;
  }
  const overflow = text.scrollWidth - wrap.clientWidth;
  if (overflow <= 1) {
    wrap.classList.remove("is-overflowing");
    wrap.style.removeProperty("--marquee-shift");
    wrap.style.removeProperty("--marquee-duration");
    return;
  }
  wrap.style.setProperty("--marquee-shift", `${-overflow}px`);
  wrap.style.setProperty("--marquee-duration", `${marqueeDurationSeconds(overflow).toFixed(2)}s`);
  wrap.classList.add("is-overflowing");
}

export function disarmOverflowMarquee(root: HTMLElement): void {
  const wrap = root.querySelector<HTMLElement>(".overflow-marquee");
  wrap?.classList.remove("is-overflowing");
}
