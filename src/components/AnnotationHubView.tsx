import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import type { Annotation } from "../lib/backend";
import type { RebindDryRunReport } from "../lib/rebindDryRun";
import { ANNOTATION_TONES, ANNOTATION_TONE_META } from "../lib/annotationModel";
import {
  AnnotationFilterControls,
  AnnotationLibraryGroupList,
  AnnotationTransferActions,
  LostDocumentsSection,
  type AnnotationLibraryFilters,
  type AnnotationLibraryGroup,
  type AnnotationLibraryStatus,
  type LibraryDocumentOption,
  type LostDocumentEntry,
} from "./AnnotationUi";
import { useReaderStore } from "../store/useReaderStore";

/**
 * 全屏「全库摘录」中枢：检索/筛选、按文档分组、导出导入与失联重绑。
 * 侧栏阅读态不再挂「全库」peer tab；入口为标注 tab 顶栏链接与命令面板。
 */
interface AnnotationHubViewProps {
  status: AnnotationLibraryStatus;
  groups: AnnotationLibraryGroup[];
  error?: string | null;
  currentPath?: string | null;
  lostDocuments?: LostDocumentEntry[];
  documents?: LibraryDocumentOption[];
  filters: AnnotationLibraryFilters;
  onFiltersChange: (filters: AnnotationLibraryFilters) => void;
  filterActive: boolean;
  onDryRunRebind?: (oldPath: string, newPath: string) => Promise<RebindDryRunReport>;
  onRebindLostDocument?: (oldPath: string, newPath: string) => Promise<void>;
  onRefresh: () => void;
  onExport: () => void;
  onExportGroup: (group: AnnotationLibraryGroup) => void;
  onExportJson?: () => void;
  onExportCsv?: () => void;
  onImport?: () => void;
  /** 编纂读书报告(plan-book-digest):仅当前文档分组渲染。 */
  onCompileCurrentGroup?: (group: AnnotationLibraryGroup) => void;
  onSelect: (annotation: Annotation) => void;
  onExit: () => void;
}

export function AnnotationHubView({
  status,
  groups,
  error = null,
  currentPath = null,
  lostDocuments = [],
  documents = [],
  filters,
  onFiltersChange,
  filterActive,
  onDryRunRebind,
  onRebindLostDocument,
  onRefresh,
  onExport,
  onExportGroup,
  onExportJson,
  onExportCsv,
  onImport,
  onCompileCurrentGroup,
  onSelect,
  onExit,
}: AnnotationHubViewProps) {
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const colorNames = useReaderStore((state) => state.annotationColorNames);
  const toneLabels = {
    sand: colorNames.yellow || ANNOTATION_TONE_META.sand.label,
    sage: colorNames.green || ANNOTATION_TONE_META.sage.label,
    slate: colorNames.blue || ANNOTATION_TONE_META.slate.label,
  };
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

  const transferActions =
    !filterActive ? (
      <AnnotationTransferActions
        onExportJson={onExportJson}
        onExportCsv={onExportCsv}
        onImport={onImport}
      />
    ) : null;

  const lostSection =
    status === "ready" &&
    !filterActive &&
    onDryRunRebind &&
    onRebindLostDocument ? (
      <LostDocumentsSection
        entries={lostDocuments}
        documents={documents}
        onDryRun={onDryRunRebind}
        onRebind={onRebindLostDocument}
      />
    ) : null;

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
      <div className="annotation-hub-empty">
        <p className="toc-empty">
          {filterActive ? "没有命中的标注。" : "整个文档库还没有标注。"}
        </p>
        {!filterActive && onImport ? (
          <div className="annotation-list-toolbar-actions">
            <button type="button" onClick={onImport}>
              导入标注…
            </button>
          </div>
        ) : null}
        {lostSection}
      </div>
    );
  } else {
    results = (
      <>
        {lostSection}
        <AnnotationLibraryGroupList
          groups={groups}
          currentPath={currentPath}
          onSelect={onSelect}
          onExportGroup={onExportGroup}
          onCompileCurrentGroup={onCompileCurrentGroup}
        />
      </>
    );
  }

  return (
    <div className="annotation-hub-view" aria-label="全库摘录">
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
          <h1>全库摘录</h1>
          <span>{summaryLine}</span>
        </div>
        <div className="annotation-hub-tools">
          <button type="button" onClick={onRefresh}>
            刷新
          </button>
          {status === "ready" ? (
            <button type="button" onClick={onExport}>
              {filterActive ? "导出当前结果" : "导出全库"}
            </button>
          ) : null}
          {status === "ready" ? transferActions : null}
        </div>
      </header>
      <div className="annotation-hub-layout">
        <aside className="annotation-hub-filters" aria-label="筛选标注">
          <AnnotationFilterControls filters={filters} onChange={onFiltersChange} />
          {/* 三色外观图例；自定义名来自阅读设置。 */}
          <section className="annotation-hub-legend" aria-label="颜色外观">
            <h3>颜色外观</h3>
            <ul>
              {ANNOTATION_TONES.map((tone) => (
                <li key={tone}>
                  <span
                    className={`annotation-tone-swatch annotation-tone-swatch--${tone}`}
                    aria-hidden="true"
                  />
                  <span>{toneLabels[tone]}</span>
                </li>
              ))}
            </ul>
          </section>
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
