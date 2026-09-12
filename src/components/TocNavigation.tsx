// D12：从 App.tsx 提取的目录导航（行为/hook 顺序不变，仅移动）。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { TocItem } from "../lib/markdown";
import type { TocHeatResult } from "../lib/tocHeat";
import {
  findTocScrollParent,
  measureTocIndicator,
  scrollTocLinkIntoView,
  tocScrollBehaviorFromMotion,
  type TocIndicatorBox,
} from "../lib/tocActiveIndicator";

export function TocNavigation({
  items,
  activeId,
  onSelect,
  heat,
  onSelectTop,
  estimateLine,
}: {
  items: TocItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** 方案三 T1 批注密度;不传时不渲染热力点/文首提示。 */
  heat?: TocHeatResult | null;
  /** 文首/失效章节说明行的跳转目标(滚动到文档顶部)。 */
  onSelectTop?: () => void;
  /** 阅读时间预估(plan-reading-time-estimate §3.3):目录顶部一行。 */
  estimateLine?: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const [indicator, setIndicator] = useState<TocIndicatorBox | null>(null);

  const setLinkRef = useCallback(
    (id: string) => (node: HTMLAnchorElement | null) => {
      if (node) linkRefs.current.set(id, node);
      else linkRefs.current.delete(id);
    },
    [],
  );

  const measureActive = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !activeId) {
      setIndicator(null);
      return null as HTMLAnchorElement | null;
    }
    const link = linkRefs.current.get(activeId);
    if (!link) {
      setIndicator(null);
      return null;
    }
    setIndicator(measureTocIndicator(wrap, link));
    return link;
  }, [activeId]);

  useLayoutEffect(() => {
    measureActive();
  }, [measureActive, items, heat, estimateLine]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !activeId) return;
    const link = linkRefs.current.get(activeId);
    if (!link) return;
    const scrollParent = findTocScrollParent(wrap);
    if (!scrollParent) return;
    scrollTocLinkIntoView(
      scrollParent,
      link,
      tocScrollBehaviorFromMotion(document.documentElement.dataset.motion),
    );
  }, [activeId]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      measureActive();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [measureActive]);

  return (
    <div className="toc-section">
      {estimateLine ? <p className="toc-estimate">{estimateLine}</p> : null}
      {heat && heat.unassignedCount > 0 ? (
        <button type="button" className="toc-unassigned" onClick={onSelectTop}>
          文首或已变更章节另有 {heat.unassignedCount} 条标注
        </button>
      ) : null}
      {items.length ? (
        <div className="toc-list-wrap" ref={wrapRef}>
          {indicator ? (
            <div
              className="toc-active-indicator"
              style={{ top: indicator.top, height: indicator.height }}
              aria-hidden="true"
            />
          ) : null}
          <ol className="toc-list">
            {items.map((item, index) => {
              const heatEntry = heat?.byId.get(item.id);
              const heatLabel = heatEntry ? `本节 ${heatEntry.count} 条标注` : null;
              return (
                <li key={`${item.id}:${index}`}>
                  <a
                    ref={setLinkRef(item.id)}
                    className={`toc-link${activeId === item.id ? " active" : ""}${
                      heatEntry ? " has-heat" : ""
                    }`}
                    style={{ "--toc-depth": item.level } as CSSProperties}
                    href={`#${item.id}`}
                    aria-current={activeId === item.id ? "location" : undefined}
                    title={heatLabel ? `${item.title}（${heatLabel}）` : item.title}
                    aria-label={heatLabel ? `${item.title}，${heatLabel}` : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      onSelect(item.id);
                    }}
                  >
                    {item.title}
                    {heatEntry ? (
                      <span
                        className="toc-heat"
                        data-level={heatEntry.level}
                        aria-hidden="true"
                      />
                    ) : null}
                  </a>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <p className="toc-empty">这篇文档没有可导航的标题。</p>
      )}
    </div>
  );
}
