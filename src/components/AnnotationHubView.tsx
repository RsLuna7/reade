import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import type { Annotation } from "../lib/backend";
import {
  AnnotationFilterControls,
  AnnotationLibraryGroupList,
  type AnnotationLibraryFilters,
  type AnnotationLibraryGroup,
  type AnnotationLibraryStatus,
} from "./AnnotationUi";
import { useReaderStore } from "../store/useReaderStore";

/**
 * 全屏标注中枢(方案四 A2):左列筛选(检索/类型/颜色/文档快捷定位),
 * 右列分组卡片流。分组与条目渲染和侧栏「全库」tab 共享同一套组件
 * (AnnotationUi 的 AnnotationLibraryGroupList),仅容器与密度不同;
 * 数据与筛选状态由 App 持有,与侧栏 tab 完全同源。
 */
interface AnnotationHubViewProps {
  status: AnnotationLibraryStatus;
  groups: AnnotationLibraryGroup[];
  error?: string | null;
  currentPath?: string | null;
  filters: AnnotationLibraryFilters;
  onFiltersChange: (filters: AnnotationLibraryFilters) => void;
  filterActive: boolean;
  onRefresh: () => void;
  onExport: () => void;
  onExportGroup: (group: AnnotationLibraryGroup) => void;
  onSelect: (annotation: Annotation) => void;
  onExit: () => void;
}

export function AnnotationHubView({
  status,
  groups,
  error = null,
  currentPath = null,
  filters,
  onFiltersChange,
  filterActive,
  onRefresh,
  onExport,
  onExportGroup,
  onSelect,
  onExit,
}: AnnotationHubViewProps) {
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const resultsRef = useRef<HTMLDivElement>(null);

  // 与 StatsView 一致:Esc 返回阅读面(已被其他层处理过的按键不重复响应)。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      onExit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit]);

  const scrollToGroup = (path: string) => {
    const target = resultsRef.current?.querySelector<HTMLElement>(
      `[data-group-path="${CSS.escape(path)}"]`,
    );
    target?.scrollIntoView({
      block: "start",
      behavior: motionLevel === "off" ? "auto" : "smooth",
    });
  };

  const total = groups.reduce((sum, group) => sum + group.annotations.length, 0);
  const summaryLine =
    status === "ready"
      ? filterActive
        ? `命中 ${total} 条，来自 ${groups.length} 个文档`
        : `共 ${total} 条 · ${groups.length} 个文档`
      : "正在汇总全库标注…";

  let results;
  if (status === "error") {
    results = (
      <div className="review-complete" role="alert">
        <p className="review-complete-title">无法读取全库标注</p>
        <p className="review-complete-hint">{error ?? "请重试。"}</p>
        <div className="review-complete-actions">
          <button type="button" onClick={onRefresh}>
            重试
          </button>
        </div>
      </div>
    );
  } else if (status === "idle" || status === "loading") {
    results = (
      <div className="review-state">
        <span className="spinner" aria-hidden="true" />
        正在汇总全库标注…
      </div>
    );
  } else if (!groups.length) {
    results = (
      <p className="toc-empty">
        {filterActive ? "没有命中的标注。" : "整个文档库还没有标注。"}
      </p>
    );
  } else {
    results = (
      <AnnotationLibraryGroupList
        groups={groups}
        currentPath={currentPath}
        onSelect={onSelect}
        onExportGroup={onExportGroup}
      />
    );
  }

  return (
    <div className="annotation-hub-view" aria-label="全库标注中枢">
      <header className="review-header annotation-hub-header">
        <button
          className="icon-button"
          type="button"
          aria-label="返回阅读"
          title="返回阅读（Esc）"
          onClick={onExit}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div className="review-heading">
          <h1>全库标注</h1>
          <span>{summaryLine}</span>
        </div>
        <div className="annotation-hub-tools">
          <button type="button" onClick={onRefresh}>
            刷新
          </button>
          <button type="button" onClick={onExport}>
            {filterActive ? "导出当前结果" : "导出全库"}
          </button>
        </div>
      </header>
      <div className="annotation-hub-layout">
        <aside className="annotation-hub-filters" aria-label="筛选标注">
          <AnnotationFilterControls filters={filters} onChange={onFiltersChange} />
          {groups.length > 0 ? (
            <nav className="annotation-hub-nav" aria-label="文档快捷定位">
              <h3>文档</h3>
              <ul>
                {groups.map((group) => (
                  <li key={group.path}>
                    <button type="button" title={group.path} onClick={() => scrollToGroup(group.path)}>
                      <span className="annotation-hub-nav-title">{group.title}</span>
                      <span className="side-panel-count">{group.annotations.length}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </aside>
        <div className="annotation-hub-results" ref={resultsRef}>
          {results}
        </div>
      </div>
    </div>
  );
}

export default AnnotationHubView;
