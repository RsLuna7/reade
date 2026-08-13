// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INK_ORIGIN_MAX_AGE_MS,
  INK_REVEAL_CLASS,
  INK_REVEAL_DURATION_MS,
  applyThemeMutation,
  consumeThemeTransitionOrigin,
  revealRadius,
  setNextThemeTransitionOrigin,
} from "./themeTransition";

// jsdom does not implement the View Transitions API; the tests install and
// remove a mock through this untyped optional view of the document (the DOM
// lib types the method as required, so a plain Document cast would reject
// both the mock assignment and the delete).
type MutableDocument = { startViewTransition?: unknown };
const mutableDocument = document as unknown as MutableDocument;

afterEach(() => {
  delete mutableDocument.startViewTransition;
  document.documentElement.classList.remove(INK_REVEAL_CLASS);
  consumeThemeTransitionOrigin();
  vi.restoreAllMocks();
});

function mockStartViewTransition() {
  // Real API runs the update callback inside the transition; the mock keeps
  // that contract so the mutation must land through it, not around it.
  return vi.fn((update: () => void) => {
    update();
    return {};
  });
}

/** ready/finished 齐备的 transition mock(墨水扩散的完整路径)。 */
function mockInkCapableTransition() {
  let resolveReady!: () => void;
  let resolveFinished!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const start = vi.fn((update: () => void) => {
    update();
    return { ready, finished };
  });
  return { start, resolveReady, resolveFinished };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("applyThemeMutation (M3/D5)", () => {
  it("wraps the mutation in exactly one view transition at full motion", () => {
    const startViewTransition = mockStartViewTransition();
    mutableDocument.startViewTransition = startViewTransition;
    const mutate = vi.fn();

    applyThemeMutation(mutate, "full");

    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("applies instantly without calling the API at off and subtle", () => {
    const startViewTransition = mockStartViewTransition();
    mutableDocument.startViewTransition = startViewTransition;

    for (const level of ["off", "subtle"] as const) {
      const mutate = vi.fn();
      applyThemeMutation(mutate, level);
      expect(mutate).toHaveBeenCalledTimes(1);
    }

    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("falls back to a direct write when the API is missing", () => {
    expect(typeof mutableDocument.startViewTransition).toBe("undefined");
    const mutate = vi.fn();

    expect(() => applyThemeMutation(mutate, "full")).not.toThrow();
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("revealRadius (plan-theme-ink-transition)", () => {
  it("reaches the farthest viewport corner from every origin", () => {
    // 左上角出发 → 最远角是右下角。
    expect(revealRadius(0, 0, 300, 400)).toBe(500);
    // 右下角出发 → 最远角是左上角。
    expect(revealRadius(300, 400, 300, 400)).toBe(500);
    // 中心出发 → 半对角线。
    expect(revealRadius(150, 200, 300, 400)).toBe(250);
    // 视口外的坐标同样成立(理论边界)。
    expect(revealRadius(-100, 0, 300, 400)).toBe(Math.hypot(400, 400));
  });
});

describe("theme transition origin handoff", () => {
  it("hands the origin over exactly once", () => {
    setNextThemeTransitionOrigin({ x: 24, y: 860 }, 1000);
    expect(consumeThemeTransitionOrigin(1100)).toEqual({ x: 24, y: 860 });
    expect(consumeThemeTransitionOrigin(1100)).toBeNull();
  });

  it("drops stale coordinates beyond the freshness window", () => {
    setNextThemeTransitionOrigin({ x: 24, y: 860 }, 1000);
    expect(consumeThemeTransitionOrigin(1000 + INK_ORIGIN_MAX_AGE_MS + 1)).toBeNull();
  });

  it("rejects non-finite coordinates", () => {
    setNextThemeTransitionOrigin({ x: Number.NaN, y: 10 }, 1000);
    expect(consumeThemeTransitionOrigin(1000)).toBeNull();
  });
});

describe("ink reveal path (full + origin)", () => {
  it("animates ::view-transition-new(root) after ready and scopes the class", async () => {
    const transition = mockInkCapableTransition();
    mutableDocument.startViewTransition = transition.start;
    const animate = vi.fn().mockReturnValue({});
    document.documentElement.animate =
      animate as unknown as typeof document.documentElement.animate;
    const mutate = vi.fn();

    applyThemeMutation(mutate, "full", { x: 30, y: 700 });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(INK_REVEAL_CLASS)).toBe(true);
    expect(animate).not.toHaveBeenCalled();

    transition.resolveReady();
    await flushMicrotasks();
    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes, options] = animate.mock.calls[0] as [
      { clipPath: string[] },
      { pseudoElement: string; duration: number },
    ];
    expect(keyframes.clipPath[0]).toBe("circle(0px at 30px 700px)");
    expect(keyframes.clipPath[1]).toMatch(/^circle\(\d+px at 30px 700px\)$/);
    expect(options.pseudoElement).toBe("::view-transition-new(root)");
    expect(options.duration).toBe(INK_REVEAL_DURATION_MS);

    // finished 后作用域 class 摘除,后续默认交叉淡入不受影响。
    transition.resolveFinished();
    await flushMicrotasks();
    expect(document.documentElement.classList.contains(INK_REVEAL_CLASS)).toBe(false);
  });

  it("keeps the default cross-fade when no origin is supplied", () => {
    const transition = mockInkCapableTransition();
    mutableDocument.startViewTransition = transition.start;
    const animate = vi.fn();
    document.documentElement.animate =
      animate as unknown as typeof document.documentElement.animate;

    applyThemeMutation(vi.fn(), "full", null);
    expect(transition.start).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(INK_REVEAL_CLASS)).toBe(false);
    expect(animate).not.toHaveBeenCalled();
  });

  it("stays instant at subtle even with an origin", () => {
    const startViewTransition = mockStartViewTransition();
    mutableDocument.startViewTransition = startViewTransition;
    const mutate = vi.fn();

    applyThemeMutation(mutate, "subtle", { x: 10, y: 10 });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("survives a transition object without ready/finished (test-grade mocks)", () => {
    const startViewTransition = mockStartViewTransition();
    mutableDocument.startViewTransition = startViewTransition;
    const mutate = vi.fn();

    expect(() => applyThemeMutation(mutate, "full", { x: 5, y: 5 })).not.toThrow();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(INK_REVEAL_CLASS)).toBe(false);
  });

  it("releases the scope class when the pseudo-element animate throws", async () => {
    const transition = mockInkCapableTransition();
    mutableDocument.startViewTransition = transition.start;
    document.documentElement.animate = vi.fn(() => {
      throw new Error("pseudoElement not supported");
    }) as unknown as typeof document.documentElement.animate;

    applyThemeMutation(vi.fn(), "full", { x: 5, y: 5 });
    transition.resolveReady();
    await flushMicrotasks();
    // 能力探针失败 → 立即摘 class 回落默认过渡。
    expect(document.documentElement.classList.contains(INK_REVEAL_CLASS)).toBe(false);
  });
});
