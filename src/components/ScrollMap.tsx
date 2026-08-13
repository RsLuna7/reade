/**
 * Scroll-map tick layer (docs/plan-rich-scrollbar.md §3.2): an absolutely
 * positioned strip at the reading pane's right edge rendering the marks
 * computed by `buildScrollMapMarks` plus the single live TTS tick. Purely
 * presentational — measurement and click semantics live in App (RS-D7).
 *
 * The strip itself is pointer-transparent; only the tick buttons receive
 * events, so the native scrollbar and text selection stay untouched.
 */

import type { ScrollMapMark } from "../lib/scrollMap";

export interface ScrollMapProps {
  marks: ScrollMapMark[];
  /** Current read-aloud sentence position; null hides the tick. */
  ttsRatio: number | null;
  onSelect: (mark: ScrollMapMark) => void;
  onSelectTts?: (ratio: number) => void;
}

export function ScrollMap({ marks, ttsRatio, onSelect, onSelectTts }: ScrollMapProps) {
  if (marks.length === 0 && ttsRatio === null) return null;
  return (
    <nav className="scroll-map" aria-label="文档地图">
      {marks.map((mark, index) => (
        <button
          key={`${mark.kind}:${mark.targetId ?? index}:${mark.ratio.toFixed(4)}`}
          type="button"
          className={`scroll-map-tick scroll-map-tick--${mark.kind}${
            mark.color ? ` scroll-map-tick--${mark.color}` : ""
          }`}
          style={{ top: `${(mark.ratio * 100).toFixed(3)}%` }}
          title={mark.label}
          aria-label={mark.label}
          onClick={() => onSelect(mark)}
        />
      ))}
      {ttsRatio !== null && (
        <button
          type="button"
          className="scroll-map-tick scroll-map-tick--tts"
          style={{ top: `${(ttsRatio * 100).toFixed(3)}%` }}
          title="朗读位置"
          aria-label="朗读位置"
          onClick={() => onSelectTts?.(ttsRatio)}
        />
      )}
    </nav>
  );
}

export default ScrollMap;
