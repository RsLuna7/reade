import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type {
  Annotation,
  AnnotationColor,
  AnnotationKind,
} from "../lib/backend";
import {
  ANNOTATION_COLORS,
  APPROXIMATE_ANCHOR_LABEL,
  annotationKindLabel,
  annotationListTitle,
  colorAccessibleLabel,
  colorDisplayName,
  isAnnotationMarkKind,
  type AnnotationMarkKind,
} from "../lib/annotations";
import { previewGroupAnnotations } from "../lib/annotationHub";
import { isRelocatableAnnotation } from "../lib/annotationRelocate";
import type { RebindDryRunReport } from "../lib/rebindDryRun";
import { useReaderStore } from "../store/useReaderStore";

export type AnnotationTool = "view" | AnnotationMarkKind;

/**
 * 颜色语义命名(plan-annotation-color-names CN-D5):组件直接读 store,
 * 改名即时反映到所有色块;label 恒带颜色词("金句（黄色）"),无障碍不丢底色。
 */
function useAnnotationColorNames(): Record<AnnotationColor, string> {
  return useReaderStore((state) => state.annotationColorNames);
}

interface SelectionToolbarProps {
  open: boolean;
  x: number;
  y: number;
  color: AnnotationColor;
  /** 点击色块:直接以该色落高亮,同时更新偏好色。 */
  onPickColor: (color: AnnotationColor) => void;
  onHighlight: () => void;
  onUnderline: () => void;
  onAddNote: () => void;
  onBookmark: () => void;
  /** 金句卡片入口(QC-D5):选区文本生成引文卡片。未传时不渲染按钮。 */
  onMakeCard?: () => void;
  /** 相关段落入口(RP-D4)。未传时不渲染按钮。 */
  onFindRelated?: () => void;
  /** 选区 ≥ RELATED_MIN_SELECTION_CHARS 时可用,不足禁用并提示。 */
  canFindRelated?: boolean;
  /**
   * 段落分享深链入口(plan-web-text-deeplink):复制 `?doc=…#text=…` 链接。
   * 仅 Web 运行时由 App 传入;桌面无可分享 URL 语义,不渲染按钮。
   */
  onCopyDeepLink?: () => void;
  onClose: () => void;
  canHighlight: boolean;
}

export function SelectionToolbar({
  open,
  x,
  y,
  color,
  onPickColor,
  onHighlight,
  onUnderline,
  onAddNote,
  onBookmark,
  onMakeCard,
  onFindRelated,
  canFindRelated = false,
  onCopyDeepLink,
  onClose,
  canHighlight,
}: SelectionToolbarProps) {
  const colorNames = useAnnotationColorNames();
  if (!open) return null;
  return (
    <div
      className="annotation-toolbar reade-motion-panel"
      role="toolbar"
      aria-label="标注工具条"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="annotation-toolbar-colors">
        {ANNOTATION_COLORS.map((item) => (
          <button
            key={item}
            type="button"
            className={`annotation-color-swatch annotation-color-swatch--${item}${color === item ? " active" : ""}`}
            aria-label={`以${colorAccessibleLabel(item, colorNames)}高亮`}
            title={colorAccessibleLabel(item, colorNames)}
            aria-pressed={color === item}
            disabled={!canHighlight}
            onClick={() => onPickColor(item)}
          />
        ))}
      </div>
      <button type="button" disabled={!canHighlight} onClick={onHighlight}>
        高亮
      </button>
      <button type="button" disabled={!canHighlight} onClick={onUnderline}>
        下划线
      </button>
      <button type="button" disabled={!canHighlight} onClick={onAddNote}>
        笔记
      </button>
      <button type="button" onClick={onBookmark}>
        书签
      </button>
      {onFindRelated ? (
        <button
          type="button"
          disabled={!canFindRelated}
          title={canFindRelated ? "在全库中寻找相关段落" : "至少选中 8 个字符"}
          onClick={onFindRelated}
        >
          相关
        </button>
      ) : null}
      {onMakeCard ? (
        <button type="button" disabled={!canHighlight} onClick={onMakeCard}>
          卡片
        </button>
      ) : null}
      {onCopyDeepLink ? (
        <button
          type="button"
          disabled={!canHighlight}
          title="复制指向这段文字的分享链接"
          onClick={onCopyDeepLink}
        >
          链接
        </button>
      ) : null}
      <button type="button" className="annotation-toolbar-close" aria-label="关闭标注工具条" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

/** 有摘录文本的高亮/下划线才能生成金句卡片(书签无摘录,QC-D3)。 */
export function annotationSupportsCard(annotation: Annotation): boolean {
  return isAnnotationMarkKind(annotation.kind) && Boolean(annotation.selectedText?.trim());
}

interface AnnotationEditBubbleProps {
  annotation: Annotation;
  x: number;
  y: number;
  onChangeColor: (annotation: Annotation, color: AnnotationColor) => void;
  onEditNote: (annotation: Annotation) => void;
  onDelete: (annotation: Annotation) => void;
  /** 金句卡片入口(QC-D3 M2):从已有摘录生成卡片。未传时不渲染。 */
  onGenerateCard?: (annotation: Annotation) => void;
  onClose: () => void;
}

/** 点击正文中的标注 mark 后弹出的小型编辑气泡(改色/笔记/删除)。 */
export function AnnotationEditBubble({
  annotation,
  x,
  y,
  onChangeColor,
  onEditNote,
  onDelete,
  onGenerateCard,
  onClose,
}: AnnotationEditBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const colorNames = useAnnotationColorNames();

  useEffect(() => {
    const onPointerDown = (event: Event) => {
      const element = ref.current;
      if (!element) return;
      if (event.target instanceof Node && element.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="annotation-edit-bubble reade-motion-panel"
      role="dialog"
      aria-label="编辑标注"
      style={{ left: x, top: y }}
    >
      {isAnnotationMarkKind(annotation.kind) ? (
        <div className="annotation-toolbar-colors" role="group" aria-label="更改颜色">
          {ANNOTATION_COLORS.map((item) => (
            <button
              key={item}
              type="button"
              className={`annotation-color-swatch annotation-color-swatch--${item}${
                annotation.color === item ? " active" : ""
              }`}
              aria-label={`改为${colorAccessibleLabel(item, colorNames)}`}
              title={colorAccessibleLabel(item, colorNames)}
              aria-pressed={annotation.color === item}
              onClick={() => onChangeColor(annotation, item)}
            />
          ))}
        </div>
      ) : null}
      <div className="annotation-edit-actions">
        <button type="button" onClick={() => onEditNote(annotation)}>
          笔记
        </button>
        {onGenerateCard && annotationSupportsCard(annotation) ? (
          <button type="button" onClick={() => onGenerateCard(annotation)}>
            卡片
          </button>
        ) : null}
        <button type="button" onClick={() => onDelete(annotation)}>
          删除
        </button>
        <button
          type="button"
          className="annotation-toolbar-close"
          aria-label="关闭标注编辑"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  );
}

interface AnnotationToolsPanelProps {
  open: boolean;
  tool: AnnotationTool;
  color: AnnotationColor;
  canUndo: boolean;
  canClear: boolean;
  onToolChange: (tool: AnnotationTool) => void;
  onColorChange: (color: AnnotationColor) => void;
  onUndo: () => void;
  onClear: () => void;
}

export function AnnotationToolsPanel({
  open,
  tool,
  color,
  canUndo,
  canClear,
  onToolChange,
  onColorChange,
  onUndo,
  onClear,
}: AnnotationToolsPanelProps) {
  const colorNames = useAnnotationColorNames();
  const showColors = tool === "highlight" || tool === "underline";
  return (
    <div
      className="annotation-tools-popover reade-motion-panel"
      role="dialog"
      aria-label="标注工具"
      aria-hidden={!open}
      data-open={open}
      inert={!open}
    >
      <div className="annotation-tools-heading">标注工具</div>
      <p className="annotation-tools-hint">
        选择高亮或下划线后，在正文中划选即可落笔；浏览模式下划选会出现浮动工具条。
      </p>
      <div className="annotation-mode-tools" role="toolbar" aria-label="标注模式">
        {(
          [
            ["view", "浏览"],
            ["highlight", "高亮"],
            ["underline", "下划线"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tool === value ? "active" : ""}
            aria-pressed={tool === value}
            onClick={() => onToolChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {showColors ? (
        <div className="annotation-toolbar-colors" aria-label="标注颜色">
          {ANNOTATION_COLORS.map((item) => (
            <button
              key={item}
              type="button"
              className={`annotation-color-swatch annotation-color-swatch--${item}${color === item ? " active" : ""}`}
              aria-label={`选择${colorAccessibleLabel(item, colorNames)}`}
              title={colorAccessibleLabel(item, colorNames)}
              aria-pressed={color === item}
              onClick={() => onColorChange(item)}
            />
          ))}
        </div>
      ) : null}
      <div className="annotation-mode-actions">
        <button type="button" disabled={!canUndo} onClick={onUndo}>
          撤销
        </button>
        <button type="button" disabled={!canClear} onClick={onClear}>
          清空本文档
        </button>
      </div>
    </div>
  );
}

/** @deprecated Use AnnotationToolsPanel */
export const AnnotationModeBar = AnnotationToolsPanel;

export type AnnotationListSort = "time" | "position";

interface AnnotationListProps {
  annotations: Annotation[];
  brokenIds: Set<string>;
  /** Ids anchored through a non-exact step (normalized/fuzzy weak hint). */
  approximateIds?: Set<string>;
  loading?: boolean;
  sort?: AnnotationListSort;
  onSortChange?: (sort: AnnotationListSort) => void;
  onExport?: () => void;
  onSelect: (annotation: Annotation) => void;
  onDelete: (annotation: Annotation) => void;
  onEditNote: (annotation: Annotation) => void;
  onChangeColor?: (annotation: Annotation, color: AnnotationColor) => void;
  /** "在文档中定位此文本" for unanchored quote-bearing annotations (§5.6 B). */
  onRelocate?: (annotation: Annotation) => void;
  /** 金句卡片入口(QC-D3 M2):仅对有摘录的高亮/下划线显示。 */
  onGenerateCard?: (annotation: Annotation) => void;
  /** 全书回顾编纂入口(plan-book-digest):列表非空时显示。 */
  onCompileDigest?: () => void;
  onClearAll?: () => void;
}

export function AnnotationList({
  annotations,
  brokenIds,
  approximateIds,
  loading = false,
  sort = "time",
  onSortChange,
  onExport,
  onSelect,
  onDelete,
  onEditNote,
  onChangeColor,
  onRelocate,
  onGenerateCard,
  onCompileDigest,
  onClearAll,
}: AnnotationListProps) {
  const colorNames = useAnnotationColorNames();
  if (loading) {
    return <p className="toc-empty">获取标注中…</p>;
  }
  if (!annotations.length) {
    return <p className="toc-empty">这篇文档还没有标注。选中文字后可添加高亮、下划线或书签。</p>;
  }
  const anchored = annotations.filter((annotation) => !brokenIds.has(annotation.id));
  const orphans = annotations.filter((annotation) => brokenIds.has(annotation.id));

  // Orphans keep the full card (note/color/delete) — a downgraded card, not
  // an error state; only the in-document jump is gone.
  const renderItem = (annotation: Annotation, broken: boolean) => {
    const canRecolor = isAnnotationMarkKind(annotation.kind) && Boolean(onChangeColor);
    const approximate = !broken && Boolean(approximateIds?.has(annotation.id));
    return (
      <li key={annotation.id} className={`annotation-list-item${broken ? " is-broken" : ""}`}>
        <button type="button" className="annotation-list-main" onClick={() => onSelect(annotation)}>
          <span
            className={`annotation-list-kind annotation-list-kind--${annotation.kind}${
              annotation.color ? ` annotation-list-kind--${annotation.color}` : ""
            }`}
          >
            {annotationKindLabel(annotation.kind)}
            {approximate ? (
              <span
                className="annotation-method-dot"
                role="img"
                title={APPROXIMATE_ANCHOR_LABEL}
                aria-label={APPROXIMATE_ANCHOR_LABEL}
              />
            ) : null}
          </span>
          <span className="annotation-list-title">{annotationListTitle(annotation)}</span>
          {annotation.note ? <span className="annotation-list-note">{annotation.note}</span> : null}
        </button>
        {canRecolor ? (
          <div
            className="annotation-toolbar-colors annotation-list-colors"
            role="group"
            aria-label="更改颜色"
            onMouseDown={(event) => event.preventDefault()}
          >
            {ANNOTATION_COLORS.map((item) => (
              <button
                key={item}
                type="button"
                className={`annotation-color-swatch annotation-color-swatch--${item}${
                  annotation.color === item ? " active" : ""
                }`}
                aria-label={`改为${colorAccessibleLabel(item, colorNames)}`}
                title={colorAccessibleLabel(item, colorNames)}
                aria-pressed={annotation.color === item}
                onClick={() => onChangeColor?.(annotation, item)}
              />
            ))}
          </div>
        ) : null}
        <div className="annotation-list-actions">
          {broken && onRelocate && isRelocatableAnnotation(annotation) ? (
            <button
              type="button"
              aria-label="在文档中定位此文本"
              title="在文档中定位此文本"
              onClick={() => onRelocate(annotation)}
            >
              重新定位
            </button>
          ) : null}
          {onGenerateCard && annotationSupportsCard(annotation) ? (
            <button
              type="button"
              title="用这段摘录生成金句卡片"
              onClick={() => onGenerateCard(annotation)}
            >
              卡片
            </button>
          ) : null}
          <button type="button" onClick={() => onEditNote(annotation)}>
            笔记
          </button>
          <button type="button" onClick={() => onDelete(annotation)}>
            删除
          </button>
        </div>
      </li>
    );
  };

  return (
    <div className="annotation-list-wrap">
      {(onSortChange || onExport || onClearAll) ? (
        <div className="annotation-list-toolbar">
          {onSortChange ? (
            <div className="annotation-sort-toggle" role="group" aria-label="标注排序方式">
              {(
                [
                  ["time", "按时间"],
                  ["position", "按位置"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={sort === value ? "active" : ""}
                  aria-pressed={sort === value}
                  onClick={() => onSortChange(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="annotation-list-toolbar-actions">
            {onCompileDigest ? (
              <button
                type="button"
                title="把本文档全部摘录按章节编纂成读书报告"
                onClick={onCompileDigest}
              >
                读书报告
              </button>
            ) : null}
            {onExport ? (
              <button type="button" onClick={onExport}>
                导出本文档
              </button>
            ) : null}
            {onClearAll ? (
              <button type="button" onClick={onClearAll}>
                清除本文档标注
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {anchored.length ? (
        <ol className="annotation-list">
          {anchored.map((annotation) => renderItem(annotation, false))}
        </ol>
      ) : null}
      {orphans.length ? (
        // Hypothesis Orphans pattern: the group only exists while it has
        // members, quotes are struck through, everything stays operable.
        <section className="annotation-orphan-group" aria-label="未锚定标注">
          <h3 className="annotation-orphan-heading">
            未锚定
            <span className="side-panel-count">{orphans.length}</span>
          </h3>
          <p className="annotation-orphan-hint">
            文档内容可能已被修改，以下标注暂时无法定位到正文；笔记与内容仍完整保留。
          </p>
          <ol className="annotation-list">
            {orphans.map((annotation) => renderItem(annotation, true))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

export interface AnnotationLibraryGroup {
  path: string;
  title: string;
  /** 路径已不在当前扫描中(失联组):置尾灰显、只读展示、仍可导出。 */
  missing?: boolean;
  annotations: Annotation[];
}

export type AnnotationLibraryStatus = "idle" | "loading" | "error" | "ready";

/** 全库检索与筛选状态(App 拥有;检索输入经 240ms 防抖后触发查询)。 */
export interface AnnotationLibraryFilters {
  query: string;
  kinds: AnnotationKind[];
  colors: AnnotationColor[];
}

const ANNOTATION_KIND_CHIPS: ReadonlyArray<[AnnotationKind, string]> = [
  ["highlight", "高亮"],
  ["underline", "下划线"],
  ["bookmark", "书签"],
];

function toggleFilterValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

/**
 * 检索框 + 类型 chip × 颜色点(方案四 §3.1 前端接线)。侧栏 tab 与全屏
 * 中枢共用;chip/色点为纯前端过滤,与检索结果求交由调用方完成。
 */
export function AnnotationFilterControls({
  filters,
  onChange,
}: {
  filters: AnnotationLibraryFilters;
  onChange: (filters: AnnotationLibraryFilters) => void;
}) {
  const colorNames = useAnnotationColorNames();
  return (
    <div className="annotation-filter-controls">
      <div className="annotation-library-search">
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          value={filters.query}
          placeholder="搜索全库标注"
          aria-label="搜索全库标注"
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
        />
      </div>
      <div className="annotation-filter-row" role="group" aria-label="筛选标注类型与颜色">
        {ANNOTATION_KIND_CHIPS.map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className={`annotation-filter-chip${filters.kinds.includes(kind) ? " active" : ""}`}
            aria-pressed={filters.kinds.includes(kind)}
            onClick={() => onChange({ ...filters, kinds: toggleFilterValue(filters.kinds, kind) })}
          >
            {label}
          </button>
        ))}
        {/* 色点升级为「圆点 + 语义名」chip:名字是 chip 的脸,筛选值仍是色键。 */}
        {ANNOTATION_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`annotation-filter-chip annotation-filter-chip--color${
              filters.colors.includes(color) ? " active" : ""
            }`}
            aria-label={`筛选${colorAccessibleLabel(color, colorNames)}标注`}
            title={colorAccessibleLabel(color, colorNames)}
            aria-pressed={filters.colors.includes(color)}
            onClick={() =>
              onChange({ ...filters, colors: toggleFilterValue(filters.colors, color) })
            }
          >
            <span
              className={`annotation-color-dot annotation-color-dot--${color}`}
              aria-hidden="true"
            />
            {colorDisplayName(color, colorNames)}
          </button>
        ))}
      </div>
    </div>
  );
}

function AnnotationEntryContent({ annotation }: { annotation: Annotation }) {
  return (
    <>
      <span
        className={`annotation-list-kind annotation-list-kind--${annotation.kind}${
          annotation.color ? ` annotation-list-kind--${annotation.color}` : ""
        }`}
      >
        {annotationKindLabel(annotation.kind)}
      </span>
      <span className="annotation-list-title">{annotationListTitle(annotation)}</span>
      {annotation.note ? <span className="annotation-list-note">{annotation.note}</span> : null}
    </>
  );
}

/**
 * 按文档分组的条目列表(方案四 §3.2):组头可折叠(本地 state,不持久化),
 * 每组默认前 20 条 + 「展开全部」;失联组灰显、条目只读但可整组导出。
 * 侧栏 tab 与全屏中枢共享此组件,仅容器与密度不同。
 */
export function AnnotationLibraryGroupList({
  groups,
  currentPath = null,
  onSelect,
  onExportGroup,
  onCompileCurrentGroup,
}: {
  groups: AnnotationLibraryGroup[];
  currentPath?: string | null;
  onSelect: (annotation: Annotation) => void;
  onExportGroup?: (group: AnnotationLibraryGroup) => void;
  /**
   * 编纂读书报告(plan-book-digest 定稿):编纂依赖当前文档已加载的
   * TOC,因此仅当前文档分组渲染该动作;不传则不渲染。
   */
  onCompileCurrentGroup?: (group: AnnotationLibraryGroup) => void;
}) {
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(new Set());
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());

  const toggleCollapsed = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <>
      {groups.map((group) => {
        const collapsed = collapsedPaths.has(group.path);
        const preview = expandedPaths.has(group.path)
          ? { visible: group.annotations, hiddenCount: 0 }
          : previewGroupAnnotations(group.annotations);
        return (
          <section
            key={group.path}
            className={`annotation-library-group${group.missing ? " is-missing" : ""}`}
            aria-label={group.title}
            data-group-path={group.path}
          >
            <h3 className="annotation-library-doc">
              <button
                type="button"
                className="annotation-library-collapse"
                aria-expanded={!collapsed}
                onClick={() => toggleCollapsed(group.path)}
              >
                {collapsed ? (
                  <ChevronRight size={13} aria-hidden="true" />
                ) : (
                  <ChevronDown size={13} aria-hidden="true" />
                )}
                <span className="annotation-library-doc-title" title={group.path}>
                  {group.title}
                </span>
              </button>
              {group.path === currentPath ? (
                <span className="annotation-library-current">当前</span>
              ) : null}
              <span className="side-panel-count">{group.annotations.length}</span>
              {onCompileCurrentGroup && group.path === currentPath ? (
                <button
                  type="button"
                  className="annotation-library-export"
                  aria-label={`编纂 ${group.title} 的读书报告`}
                  title="把该文档全部摘录按章节编纂成读书报告"
                  onClick={() => onCompileCurrentGroup(group)}
                >
                  编纂读书报告
                </button>
              ) : null}
              {onExportGroup ? (
                <button
                  type="button"
                  className="annotation-library-export"
                  aria-label={`导出 ${group.title} 的标注`}
                  title="导出该文档的标注（Markdown → 剪贴板）"
                  onClick={() => onExportGroup(group)}
                >
                  导出该文档
                </button>
              ) : null}
            </h3>
            {!collapsed && group.missing ? (
              <p className="annotation-library-missing-hint">
                文档已移动或删除，标注仍保留；若文件仍在库内新位置，刷新后会提示迁移。
              </p>
            ) : null}
            {!collapsed ? (
              <>
                <ol className="annotation-list">
                  {preview.visible.map((annotation) => (
                    <li key={annotation.id} className="annotation-list-item">
                      {group.missing ? (
                        <div className="annotation-list-main annotation-list-main--static">
                          <AnnotationEntryContent annotation={annotation} />
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="annotation-list-main"
                          onClick={() => onSelect(annotation)}
                        >
                          <AnnotationEntryContent annotation={annotation} />
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
                {preview.hiddenCount > 0 ? (
                  <button
                    type="button"
                    className="annotation-library-expand"
                    onClick={() =>
                      setExpandedPaths((current) => new Set(current).add(group.path))
                    }
                  >
                    展开全部 {group.annotations.length} 条
                  </button>
                ) : null}
              </>
            ) : null}
          </section>
        );
      })}
    </>
  );
}

/**
 * One annotated document whose path vanished from the current scan: either
 * an ambiguous fingerprint move (several candidates) or a document whose
 * path and fingerprint both failed to match (§5.6 C).
 */
export interface LostDocumentEntry {
  path: string;
  annotationCount: number;
  /** Candidate paths sharing the last known content fingerprint. */
  candidates: string[];
}

export interface LibraryDocumentOption {
  relativePath: string;
  title: string;
}

interface LostDocumentRowProps {
  entry: LostDocumentEntry;
  documents: LibraryDocumentOption[];
  onDryRun: (oldPath: string, newPath: string) => Promise<RebindDryRunReport>;
  onRebind: (oldPath: string, newPath: string) => Promise<void>;
}

type LostDocumentRowState =
  | { phase: "idle" }
  | { phase: "verifying" }
  | { phase: "verified"; target: string; report: RebindDryRunReport }
  | { phase: "rebinding"; target: string; report: RebindDryRunReport }
  | { phase: "error"; message: string };

function LostDocumentRow({ entry, documents, onDryRun, onRebind }: LostDocumentRowProps) {
  const [target, setTarget] = useState("");
  const [state, setState] = useState<LostDocumentRowState>({ phase: "idle" });

  const pickTarget = (value: string) => {
    setTarget(value);
    // A different target invalidates any previous dry-run report.
    setState({ phase: "idle" });
  };

  const runDryRun = async () => {
    if (!target) return;
    setState({ phase: "verifying" });
    try {
      const report = await onDryRun(entry.path, target);
      setState({ phase: "verified", target, report });
    } catch (cause) {
      setState({
        phase: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const runRebind = async () => {
    if (state.phase !== "verified") return;
    setState({ phase: "rebinding", target: state.target, report: state.report });
    try {
      await onRebind(entry.path, state.target);
      // On success the entry disappears from the list; no local state left.
    } catch (cause) {
      setState({
        phase: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const candidateSet = new Set(entry.candidates);
  const otherDocuments = documents.filter((item) => !candidateSet.has(item.relativePath));
  const verified = state.phase === "verified" || state.phase === "rebinding";
  const busy = state.phase === "verifying" || state.phase === "rebinding";

  return (
    <li className="lost-document-item">
      <div className="lost-document-head">
        <span className="lost-document-path" title={entry.path}>
          {entry.path}
        </span>
        <span className="side-panel-count">{entry.annotationCount}</span>
      </div>
      <label className="lost-document-target">
        迁移到
        <select
          className="setting-select"
          aria-label={`为 ${entry.path} 选择迁移目标文档`}
          value={target}
          disabled={busy}
          onChange={(event) => pickTarget(event.target.value)}
        >
          <option value="">选择目标文档…</option>
          {entry.candidates.length ? (
            <optgroup label="内容指纹相同的候选">
              {entry.candidates.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="手动选择库内文档">
            {otherDocuments.map((item) => (
              <option key={item.relativePath} value={item.relativePath}>
                {item.relativePath}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <div className="lost-document-actions">
        <button type="button" disabled={!target || busy} onClick={() => void runDryRun()}>
          {state.phase === "verifying" ? "验证中…" : "验证锚定"}
        </button>
        <button
          type="button"
          disabled={!verified || busy}
          title={verified ? undefined : "先验证锚定率，再迁移标注"}
          onClick={() => void runRebind()}
        >
          {state.phase === "rebinding" ? "迁移中…" : "迁移标注"}
        </button>
      </div>
      {verified ? (
        <p className="lost-document-report" role="status">
          {`${state.report.total} 条标注中 ${state.report.anchorable} 条可重新锚定`}
          {state.report.skipped > 0
            ? `，另有 ${state.report.skipped} 条书签不参与文本验证`
            : ""}
          。确认后迁移全部记录。
        </p>
      ) : null}
      {state.phase === "error" ? (
        <p className="lost-document-report is-error" role="alert">
          {state.message}
        </p>
      ) : null}
    </li>
  );
}

interface LostDocumentsSectionProps {
  entries: LostDocumentEntry[];
  documents: LibraryDocumentOption[];
  onDryRun: (oldPath: string, newPath: string) => Promise<RebindDryRunReport>;
  onRebind: (oldPath: string, newPath: string) => Promise<void>;
}

/**
 * 集中重绑入口（MarginNote「找回失联笔记」骨架 + KOReader 向导的 dry-run）：
 * 每个失联文档先选目标、验证 TextQuote 锚定率，用户确认后才迁移；
 * 绝不自动迁移歧义候选，也不提供删除以外的破坏性建议。
 */
export function LostDocumentsSection({
  entries,
  documents,
  onDryRun,
  onRebind,
}: LostDocumentsSectionProps) {
  if (!entries.length) return null;
  return (
    <section className="lost-documents" aria-label="失联文档">
      <h3 className="annotation-orphan-heading">
        失联文档
        <span className="side-panel-count">{entries.length}</span>
      </h3>
      <p className="annotation-orphan-hint">
        以下文档带有标注，但在当前文档库中找不到原路径。选择目标文档并验证锚定率后，可迁移其标注；验证基于目标文档正文，实际效果以打开后为准。
      </p>
      <ul className="lost-document-list">
        {entries.map((entry) => (
          <LostDocumentRow
            key={entry.path}
            entry={entry}
            documents={documents}
            onDryRun={onDryRun}
            onRebind={onRebind}
          />
        ))}
      </ul>
    </section>
  );
}

interface AnnotationLibraryPanelProps {
  status: AnnotationLibraryStatus;
  groups: AnnotationLibraryGroup[];
  error?: string | null;
  currentPath?: string | null;
  /** Lost-document rebind entries; the section hides itself when empty. */
  lostDocuments?: LostDocumentEntry[];
  documents?: LibraryDocumentOption[];
  /** 检索与筛选状态(不传则隐藏检索/筛选行,保持旧用法兼容)。 */
  filters?: AnnotationLibraryFilters;
  onFiltersChange?: (filters: AnnotationLibraryFilters) => void;
  /** 检索或筛选已生效:计数行改为命中统计,导出按钮改为「导出当前结果」。 */
  filterActive?: boolean;
  onDryRunRebind?: (oldPath: string, newPath: string) => Promise<RebindDryRunReport>;
  onRebindLostDocument?: (oldPath: string, newPath: string) => Promise<void>;
  onRefresh: () => void;
  onExport: () => void;
  /** 组头「导出该文档」;不传则不渲染该动作。 */
  onExportGroup?: (group: AnnotationLibraryGroup) => void;
  /** 导出标注为 JSON 数据文件(§5.7 信封,含墓碑)。 */
  onExportJson?: () => void;
  /** 导出标注为 Readwise 兼容 CSV(仅现存高亮/下划线)。 */
  onExportCsv?: () => void;
  /** 从 JSON 数据文件导入标注(选择文件 → dry-run 摘要 → 确认)。 */
  onImport?: () => void;
  onSelect: (annotation: Annotation) => void;
  /** 全屏中枢入口(方案四 A2);不传则不显示链接。 */
  onOpenHub?: () => void;
}

/** 「导出标注…」的格式二选(JSON / CSV)与「导入标注…」入口,选择后收起。 */
function AnnotationTransferActions({
  onExportJson,
  onExportCsv,
  onImport,
}: Pick<AnnotationLibraryPanelProps, "onExportJson" | "onExportCsv" | "onImport">) {
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  if (!onExportJson && !onExportCsv && !onImport) return null;
  const pick = (handler?: () => void) => {
    setExportMenuOpen(false);
    handler?.();
  };
  return (
    <>
      {onExportJson || onExportCsv ? (
        <button
          type="button"
          aria-expanded={exportMenuOpen}
          onClick={() => setExportMenuOpen((open) => !open)}
        >
          导出标注…
        </button>
      ) : null}
      {onImport ? (
        <button type="button" onClick={() => pick(onImport)}>
          导入标注…
        </button>
      ) : null}
      {exportMenuOpen ? (
        <div className="annotation-transfer-menu" role="group" aria-label="选择导出格式">
          {onExportJson ? (
            <button type="button" onClick={() => pick(onExportJson)}>
              JSON 数据文件
            </button>
          ) : null}
          {onExportCsv ? (
            <button type="button" onClick={() => pick(onExportCsv)}>
              Readwise CSV
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** 全库标注总览:检索/筛选 + 按文档分组折叠,点击条目跳转到对应文档内标注。 */
export function AnnotationLibraryPanel({
  status,
  groups,
  error = null,
  currentPath = null,
  lostDocuments = [],
  documents = [],
  filters,
  onFiltersChange,
  filterActive = false,
  onDryRunRebind,
  onRebindLostDocument,
  onRefresh,
  onExport,
  onExportGroup,
  onExportJson,
  onExportCsv,
  onImport,
  onSelect,
  onOpenHub,
}: AnnotationLibraryPanelProps) {
  if (status === "idle" || status === "loading") {
    return <p className="toc-empty">正在汇总全库标注…</p>;
  }
  if (status === "error") {
    return (
      <div className="annotation-library">
        <p className="toc-empty">{error ?? "无法读取全库标注。"}</p>
        <div className="annotation-list-toolbar">
          <div className="annotation-list-toolbar-actions">
            <button type="button" onClick={onRefresh}>
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
  const filterControls =
    filters && onFiltersChange ? (
      <AnnotationFilterControls filters={filters} onChange={onFiltersChange} />
    ) : null;
  if (!groups.length) {
    return (
      <div className="annotation-library">
        {filterControls}
        <p className="toc-empty">
          {filterActive ? "没有命中的标注。" : "整个文档库还没有标注。"}
        </p>
        <div className="annotation-list-toolbar">
          <div className="annotation-list-toolbar-actions">
            <button type="button" onClick={onRefresh}>
              刷新
            </button>
            {/* 空库也能导入:导入入口不依赖已有标注。 */}
            {!filterActive && onImport ? (
              <button type="button" onClick={onImport}>
                导入标注…
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
  const total = groups.reduce((sum, group) => sum + group.annotations.length, 0);
  return (
    <div className="annotation-library">
      {onOpenHub ? (
        <button type="button" className="annotation-hub-link" onClick={onOpenHub}>
          在中枢中打开
        </button>
      ) : null}
      {filterControls}
      <div className="annotation-list-toolbar">
        <span className="annotation-library-total">
          {filterActive
            ? `命中 ${total} 条，来自 ${groups.length} 个文档`
            : `共 ${total} 条`}
        </span>
        <div className="annotation-list-toolbar-actions">
          <button type="button" onClick={onRefresh}>
            刷新
          </button>
          <button type="button" onClick={onExport}>
            {filterActive ? "导出当前结果" : "导出全库"}
          </button>
          {/* 文件级导出/导入始终作用于全库,与上方的筛选状态无关。 */}
          {!filterActive ? (
            <AnnotationTransferActions
              onExportJson={onExportJson}
              onExportCsv={onExportCsv}
              onImport={onImport}
            />
          ) : null}
        </div>
      </div>
      {!filterActive && onDryRunRebind && onRebindLostDocument ? (
        <LostDocumentsSection
          entries={lostDocuments}
          documents={documents}
          onDryRun={onDryRunRebind}
          onRebind={onRebindLostDocument}
        />
      ) : null}
      <AnnotationLibraryGroupList
        groups={groups}
        currentPath={currentPath}
        onSelect={onSelect}
        onExportGroup={onExportGroup}
      />
    </div>
  );
}

/** Dry-run 摘要数据(由 `planAnnotationImport` 的计数派生)。 */
export interface AnnotationImportSummary {
  /** 导入文件名;桌面端为完整路径的文件名部分。 */
  fileName: string | null;
  added: number;
  skipped: number;
  updated: number;
  deletions: number;
  /** 内容指纹命中现有文档、建议走重绑链的文档数。 */
  rebindDocuments: number;
  /** 实际会写入的记录数(0 = 无事可做,只显示关闭)。 */
  totalWrites: number;
}

interface AnnotationImportConfirmProps {
  summary: AnnotationImportSummary;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 导入前的 dry-run 摘要确认(Q6:先摘要,用户确认后才落库)。
 * 计数为零的类别照样列出,让"什么都不会发生"也一目了然。
 */
export function AnnotationImportConfirm({
  summary,
  busy = false,
  onConfirm,
  onCancel,
}: AnnotationImportConfirmProps) {
  const counters: Array<[string, number]> = [
    ["新增", summary.added],
    ["跳过（已存在）", summary.skipped],
    ["更新（较新版本）", summary.updated],
    ["删除传播", summary.deletions],
  ];
  return (
    <div
      className="annotation-import-dialog reade-motion-panel"
      role="dialog"
      aria-label="确认导入标注"
    >
      <div className="annotation-import-heading">导入标注</div>
      {summary.fileName ? (
        <p className="annotation-import-file" title={summary.fileName}>
          {summary.fileName}
        </p>
      ) : null}
      <ul className="annotation-import-summary">
        {counters.map(([label, count]) => (
          <li key={label} data-zero={count === 0}>
            <span>{label}</span>
            <span className="annotation-import-count">{count}</span>
          </li>
        ))}
      </ul>
      {summary.rebindDocuments > 0 ? (
        <p className="annotation-import-hint">
          {summary.rebindDocuments}{" "}
          个文档的原路径不在当前库中，但内容指纹与库内文档一致；导入后可在「失联文档」区完成迁移，路径不会被自动改写。
        </p>
      ) : null}
      {summary.totalWrites === 0 ? (
        <p className="annotation-import-hint">文件中的标注均已存在，无需导入。</p>
      ) : null}
      <div className="annotation-import-actions">
        <button type="button" disabled={busy} onClick={onCancel}>
          {summary.totalWrites === 0 ? "关闭" : "取消"}
        </button>
        {summary.totalWrites > 0 ? (
          <button
            type="button"
            className="annotation-import-confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "导入中…" : `导入 ${summary.totalWrites} 条更改`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
