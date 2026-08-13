import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { DocumentExtent, DocumentInfo } from "../lib/backend";
import { cancelMotion, runMotion, type ReaderMotionLevel } from "../lib/motion";
import type { ReadingPosition } from "../lib/readingPositions";
import {
  buildCoverageTree,
  coverageLevel,
  limitTiles,
  squarify,
  type CoverageNode,
} from "../lib/treemap";

/**
 * 库覆盖率知识地图（docs/plan-coverage-treemap.md §3.2）：手写 squarified
 * treemap 的 SVG 渲染层。面积=字符数、色深=阅读覆盖率（到达率语义）；
 * 文件夹块下钻、文档块直接打开、面包屑返回；空库/未索引态明确。
 */

export interface CoverageTreemapProps {
  documents: DocumentInfo[];
  extents: ReadonlyMap<string, DocumentExtent> | null;
  positions: Record<string, ReadingPosition>;
  motionLevel: ReaderMotionLevel;
  onOpenDocument: (relativePath: string) => void;
}

const MAP_MIN_HEIGHT = 240;
const MAP_MAX_HEIGHT = 460;
/** 标签可读的最小块尺寸（更小的块只保留 tooltip 与可达名称）。 */
const LABEL_MIN_WIDTH = 56;
const LABEL_MIN_HEIGHT = 26;
const TILE_GAP = 2;

function formatChars(chars: number): string {
  if (chars >= 10_000) return `${(chars / 10_000).toFixed(1)} 万字`;
  return `${Math.round(chars)} 字`;
}

function coveragePercent(coverage: number): string {
  return `${Math.round(Math.min(1, Math.max(0, coverage)) * 100)}%`;
}

/** 标签超宽省略：按 CJK 估算字宽截断（SVG text 无原生 ellipsis）。 */
function truncateLabel(label: string, tileWidth: number): string {
  const capacity = Math.max(1, Math.floor((tileWidth - 14) / 11));
  const characters = Array.from(label);
  if (characters.length <= capacity) return label;
  return `${characters.slice(0, Math.max(1, capacity - 1)).join("")}…`;
}

function tileDescription(node: CoverageNode): string {
  const scope =
    node.kind === "document" ? "" : ` · ${node.documentCount} 篇`;
  return `${node.label} · ${formatChars(node.chars)} · 覆盖率 ${coveragePercent(node.coverage)}${scope}`;
}

export function CoverageTreemap({
  documents,
  extents,
  positions,
  motionLevel,
  onOpenDocument,
}: CoverageTreemapProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  // 下钻栈：当前视图的文件夹 key 路径（面包屑即栈内容）。
  const [drillStack, setDrillStack] = useState<CoverageNode[]>([]);
  const [focusInfo, setFocusInfo] = useState<string | null>(null);

  const root = useMemo(
    () => buildCoverageTree(documents, extents, positions),
    [documents, extents, positions],
  );

  // 换库/刷新后旧栈的 key 可能不存在了:按 key 逐层重定位,断链即截断。
  const current = useMemo(() => {
    let node = root;
    const valid: CoverageNode[] = [];
    for (const entry of drillStack) {
      const next = node.children.find(
        (child) => child.kind === "directory" && child.key === entry.key,
      );
      if (!next) break;
      valid.push(next);
      node = next;
    }
    return { node, trail: valid };
  }, [root, drillStack]);

  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const measure = () => {
      const next = Math.max(200, Math.floor(element.clientWidth));
      setWidth((value) => (value === next ? value : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const height = Math.min(MAP_MAX_HEIGHT, Math.max(MAP_MIN_HEIGHT, Math.round(width * 0.52)));
  const tiles = useMemo(
    () =>
      squarify(limitTiles(current.node.children), {
        x: 0,
        y: 0,
        width,
        height,
      }),
    [current.node, width, height],
  );

  // 下钻/返回时的轻过渡:full 240ms 淡入,off 不动(CT 定稿 §3.2)。
  useEffect(() => {
    const element = mapRef.current;
    if (!element) return;
    runMotion(
      element,
      "treemap-drill",
      [{ opacity: 0.4 }, { opacity: 1 }],
      { duration: motionLevel === "full" ? 240 : 160, easing: "ease-out" },
      motionLevel,
    );
    return () => cancelMotion(element, "treemap-drill");
  }, [current.node.key, motionLevel]);

  const drillInto = (node: CoverageNode) => {
    setDrillStack([...current.trail, node]);
  };

  const drillTo = (depth: number) => {
    setDrillStack(current.trail.slice(0, depth));
  };

  const activateTile = (node: CoverageNode) => {
    if (node.kind === "directory") drillInto(node);
    else if (node.kind === "document") onOpenDocument(node.path);
  };

  const handleTileKeyDown = (event: KeyboardEvent<SVGGElement>, node: CoverageNode) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateTile(node);
    }
  };

  if (documents.length === 0) {
    return (
      <p className="coverage-map__empty" role="status">
        文档库为空：打开一个包含文档的书库后，这里会画出全库的覆盖率地图。
      </p>
    );
  }
  if (current.node.chars <= 0) {
    return (
      <p className="coverage-map__empty" role="status">
        索引尚未产出文本数据，稍后再来看这张地图。
      </p>
    );
  }

  return (
    <div className="coverage-map" ref={hostRef}>
      <div className="coverage-map__toolbar">
        <nav className="coverage-map__breadcrumb" aria-label="知识地图层级">
          <button
            type="button"
            onClick={() => drillTo(0)}
            aria-current={current.trail.length === 0 ? "page" : undefined}
          >
            全部
          </button>
          {current.trail.map((entry, index) => (
            <span key={entry.key}>
              <span aria-hidden="true"> / </span>
              <button
                type="button"
                onClick={() => drillTo(index + 1)}
                aria-current={index === current.trail.length - 1 ? "page" : undefined}
              >
                {entry.label}
              </button>
            </span>
          ))}
        </nav>
        {current.trail.length > 0 && (
          <button
            type="button"
            className="coverage-map__back"
            onClick={() => drillTo(current.trail.length - 1)}
          >
            返回上一级
          </button>
        )}
      </div>
      <svg
        className="coverage-map__svg"
        ref={mapRef}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={`覆盖率地图：${current.node.label}，共 ${current.node.documentCount} 篇`}
      >
        {tiles.map(({ item, rect }) => {
          const tileWidth = Math.max(0, rect.width - TILE_GAP);
          const tileHeight = Math.max(0, rect.height - TILE_GAP);
          if (tileWidth < 1 || tileHeight < 1) return null;
          const level = coverageLevel(item.coverage);
          const showLabel = tileWidth >= LABEL_MIN_WIDTH && tileHeight >= LABEL_MIN_HEIGHT;
          const showMeta = showLabel && tileHeight >= 44;
          const interactive = item.kind !== "other";
          const description = tileDescription(item);
          return (
            <g
              key={item.key}
              className={`coverage-map__tile coverage-map__tile--${item.kind}${
                interactive ? " coverage-map__tile--interactive" : ""
              }`}
              role={interactive ? "button" : "img"}
              tabIndex={interactive ? 0 : undefined}
              aria-label={
                item.kind === "directory" ? `${description}（下钻）` : description
              }
              data-level={level}
              onClick={interactive ? () => activateTile(item) : undefined}
              onKeyDown={interactive ? (event) => handleTileKeyDown(event, item) : undefined}
              onMouseEnter={() => setFocusInfo(description)}
              onMouseLeave={() => setFocusInfo(null)}
              onFocus={() => setFocusInfo(description)}
              onBlur={() => setFocusInfo(null)}
            >
              <title>{description}</title>
              <rect
                x={rect.x + TILE_GAP / 2}
                y={rect.y + TILE_GAP / 2}
                width={tileWidth}
                height={tileHeight}
                rx={3}
                fill={`var(--stats-scale-${level})`}
              />
              {showLabel && (
                <text
                  className="coverage-map__label"
                  data-inverse={level >= 3}
                  x={rect.x + TILE_GAP / 2 + 7}
                  y={rect.y + TILE_GAP / 2 + 16}
                >
                  {truncateLabel(
                    item.kind === "directory" ? `${item.label}/` : item.label,
                    tileWidth,
                  )}
                </text>
              )}
              {showMeta && (
                <text
                  className="coverage-map__meta"
                  data-inverse={level >= 3}
                  x={rect.x + TILE_GAP / 2 + 7}
                  y={rect.y + TILE_GAP / 2 + 32}
                >
                  {coveragePercent(item.coverage)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="coverage-map__status" role="status">
        {focusInfo ??
          `${current.node.documentCount} 篇 · ${formatChars(current.node.chars)} · 加权覆盖率 ${coveragePercent(current.node.coverage)}`}
      </p>
    </div>
  );
}
