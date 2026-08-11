export type ReaderMotionLevel = "off" | "subtle" | "full";

const activeMotions = new WeakMap<Element, Map<string, Animation>>();

function forgetMotion(element: Element, slot: string, animation: Animation): void {
  const motions = activeMotions.get(element);
  if (motions?.get(slot) !== animation) return;

  motions.delete(slot);
  if (motions.size === 0) activeMotions.delete(element);
}

/**
 * Runs one named effect on an element. Starting the same slot again cancels the
 * previous effect, while effects in other slots continue independently.
 */
export function runMotion(
  element: Element,
  slot: string,
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  options: number | KeyframeAnimationOptions,
  level: ReaderMotionLevel,
): Animation | null {
  if (level === "off" || typeof element.animate !== "function") {
    cancelMotion(element, slot);
    return null;
  }

  cancelMotion(element, slot);

  const animation = element.animate(keyframes, options);
  const motions = activeMotions.get(element) ?? new Map<string, Animation>();
  motions.set(slot, animation);
  activeMotions.set(element, motions);

  const forget = () => forgetMotion(element, slot, animation);
  animation.addEventListener("finish", forget, { once: true });
  animation.addEventListener("cancel", forget, { once: true });

  return animation;
}

/** Cancels one effect slot, or every tracked effect when the slot is omitted. */
export function cancelMotion(element: Element, slot?: string): void {
  const motions = activeMotions.get(element);
  if (!motions) return;

  if (slot !== undefined) {
    const animation = motions.get(slot);
    if (!animation) return;
    motions.delete(slot);
    animation.cancel();
    if (motions.size === 0) activeMotions.delete(element);
    return;
  }

  activeMotions.delete(element);
  for (const animation of motions.values()) animation.cancel();
}
