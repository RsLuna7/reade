import type { ReaderMotionLevel } from "./motion";

/**
 * Minimal View Transitions surface. The tsconfig lib stays at ES2020 + DOM
 * without the View Transitions API, so the document type is widened locally
 * (M3/D5 constraint) instead of raising the compile target.
 */
interface ViewTransitionLike {
  ready?: Promise<void>;
  finished?: Promise<void>;
}

type ViewTransitionCapableDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionLike | undefined;
};

/** 墨水扩散时长(TT-D4):对角线扫过的感知下限。 */
export const INK_REVEAL_DURATION_MS = 450;
/** 扩散期间圈定 `::view-transition-*` 覆盖样式的 html class。 */
export const INK_REVEAL_CLASS = "theme-ink-reveal";
/** origin 保鲜期:点击后超过该时长仍未消费即视为陈旧,回落交叉淡入。 */
export const INK_ORIGIN_MAX_AGE_MS = 1500;

export interface ThemeTransitionOrigin {
  x: number;
  y: number;
}

/** 扩散半径 = origin 到视口四角的最远距离(盖满全屏的最小圆)。 */
export function revealRadius(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  return Math.hypot(Math.max(x, viewportWidth - x), Math.max(y, viewportHeight - y));
}

/**
 * 一次性扩散源(定稿 §6.1):点击处理器写入、主题 effect 消费。
 * 模块级坐标而非 React state——它是"下一次主题变更"的事件参数,
 * 不是可回放的共享状态。
 */
let pendingOrigin: (ThemeTransitionOrigin & { at: number }) | null = null;

export function setNextThemeTransitionOrigin(
  origin: ThemeTransitionOrigin,
  now: number = Date.now(),
): void {
  pendingOrigin =
    Number.isFinite(origin.x) && Number.isFinite(origin.y)
      ? { x: origin.x, y: origin.y, at: now }
      : null;
}

/** 取出并清空;超过保鲜期的陈旧坐标丢弃(如点了当前系列色卡没有换主题)。 */
export function consumeThemeTransitionOrigin(
  now: number = Date.now(),
): ThemeTransitionOrigin | null {
  const origin = pendingOrigin;
  pendingOrigin = null;
  if (!origin || now - origin.at > INK_ORIGIN_MAX_AGE_MS) return null;
  return { x: origin.x, y: origin.y };
}

/** 引用计数的作用域 class:连点时前一次的清理不摘掉后一次的样式。 */
let inkRevealCount = 0;

function acquireInkRevealScope(): () => void {
  inkRevealCount += 1;
  document.documentElement.classList.add(INK_REVEAL_CLASS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inkRevealCount = Math.max(0, inkRevealCount - 1);
    if (inkRevealCount === 0) {
      document.documentElement.classList.remove(INK_REVEAL_CLASS);
    }
  };
}

/**
 * D5: a theme switch cross-fades only at motionLevel "full" and only when the
 * runtime implements document.startViewTransition; every other path applies
 * the mutation synchronously — identical to the pre-M3 instant switch.
 * The pre-paint boot write (theme-boot.ts) must never route through here.
 *
 * 墨水扩散(plan-theme-ink-transition):full 档且提供 origin 时,新主题
 * 快照以 origin 为圆心做 clip-path 揭示;任何能力缺口(无 ready、
 * animate 对伪元素抛错)都静默回落——最坏结果 = 既有交叉淡入。
 */
export function applyThemeMutation(
  mutate: () => void,
  motionLevel: ReaderMotionLevel,
  origin?: ThemeTransitionOrigin | null,
): void {
  const doc = document as ViewTransitionCapableDocument;
  if (motionLevel !== "full" || typeof doc.startViewTransition !== "function") {
    mutate();
    return;
  }
  if (!origin) {
    doc.startViewTransition(mutate);
    return;
  }

  const transition = doc.startViewTransition(mutate);
  const ready = transition?.ready;
  if (!ready || typeof ready.then !== "function") return;

  const release = acquireInkRevealScope();
  ready
    .then(() => {
      try {
        const radius = revealRadius(origin.x, origin.y, window.innerWidth, window.innerHeight);
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${origin.x}px ${origin.y}px)`,
              `circle(${Math.ceil(radius)}px at ${origin.x}px ${origin.y}px)`,
            ],
          },
          {
            duration: INK_REVEAL_DURATION_MS,
            easing: "ease-in-out",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      } catch {
        // WebView2 版本分布不齐:伪元素定向不可用时立即摘掉作用域
        // class,默认交叉淡入(animation 已被圈定关闭前的状态)接管。
        release();
      }
    })
    .catch(release);
  const finished = transition?.finished;
  if (finished && typeof finished.then === "function") {
    void finished.then(release, release);
  } else {
    // 没有 finished 语义的实现:动画时长后兜底清理。
    window.setTimeout(release, INK_REVEAL_DURATION_MS + 200);
  }
}
