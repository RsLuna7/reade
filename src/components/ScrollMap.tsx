/**
 * Scroll-map tick layer (docs/plan-rich-scrollbar.md §3.2): an absolutely
 * positioned strip at the reading pane's right edge rendering the marks
 * computed by `buildScrollMapMarks`. Purely presentational — measurement
 * and click semantics live in App (RS-D7).
 *
 * The strip itself is pointer-transparent; only the tick buttons receive
 * events, so the native scrollbar and text selection stay untouched.
 */

import type { ScrollMapMark } from "../lib/scrollMap";

export interface ScrollMapProps {
  marks: ScrollMapMark[];
  onSelect: (mark: ScrollMapMark) => void;
}

export function ScrollMap({ marks, onSelect }: ScrollMapProps) {
  if (marks.length === 0) return null;
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
    </nav>
  );
}

export default ScrollMap;
