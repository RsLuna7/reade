import type { ReaderMotionLevel } from "./motion";

/**
 * Minimal View Transitions surface. The tsconfig lib stays at ES2020 + DOM
 * without the View Transitions API, so the document type is widened locally
 * (M3/D5 constraint) instead of raising the compile target.
 */
type ViewTransitionCapableDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

/**
 * D5: a theme switch cross-fades only at motionLevel "full" and only when the
 * runtime implements document.startViewTransition; every other path applies
 * the mutation synchronously — identical to the pre-M3 instant switch.
 * The pre-paint boot write (theme-boot.ts) must never route through here.
 */
export function applyThemeMutation(
  mutate: () => void,
  motionLevel: ReaderMotionLevel,
): void {
  const doc = document as ViewTransitionCapableDocument;
  if (motionLevel !== "full" || typeof doc.startViewTransition !== "function") {
    mutate();
    return;
  }
  doc.startViewTransition(mutate);
}
