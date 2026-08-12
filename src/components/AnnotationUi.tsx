import { useEffect, useRef } from "react";
import type {
  Annotation,
  AnnotationColor,
} from "../lib/backend";
import {
  ANNOTATION_COLORS,
  annotationKindLabel,
  annotationListTitle,
  isAnnotationMarkKind,
  type AnnotationMarkKind,
} from "../lib/annotations";

export type AnnotationTool = "view" | AnnotationMarkKind;

/** 标注颜色的中文名,供 aria-label 与文案统一使用。 */
export const ANNOTATION_COLOR_LABELS: Record<AnnotationColor, string> = {
  yellow: "黄",
  green: "绿",
  blue: "蓝",
  pink: "粉",
};

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
  onClose,
  canHighlight,
}: SelectionToolbarProps) {
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
            aria-label={`以${ANNOTATION_COLOR_LABELS[item]}色高亮`}
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
      <button type="button" className="annotation-toolbar-close" aria-label="关闭标注工具条" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

interface AnnotationEditBubbleProps {
  annotation: Annotation;
  x: number;
  y: number;
  onChangeColor: (annotation: Annotation, color: AnnotationColor) => void;
  onEditNote: (annotation: Annotation) => void;
  onDelete: (annotation: Annotation) => void;
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
  onClose,
}: AnnotationEditBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);

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
              aria-label={`改为${ANNOTATION_COLOR_LABELS[item]}色`}
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
              aria-label={`选择${ANNOTATION_COLOR_LABELS[item]}色`}
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
  loading?: boolean;
  sort?: AnnotationListSort;
  onSortChange?: (sort: AnnotationListSort) => void;
  onExport?: () => void;
  onSelect: (annotation: Annotation) => void;
  onDelete: (annotation: Annotation) => void;
  onEditNote: (annotation: Annotation) => void;
  onChangeColor?: (annotation: Annotation, color: AnnotationColor) => void;
  onClearAll?: () => void;
}

export function AnnotationList({
  annotations,
  brokenIds,
  loading = false,
  sort = "time",
  onSortChange,
  onExport,
  onSelect,
  onDelete,
  onEditNote,
  onChangeColor,
  onClearAll,
}: AnnotationListProps) {
  if (loading) {
    return <p className="toc-empty">获取标注中…</p>;
  }
  if (!annotations.length) {
    return <p className="toc-empty">这篇文档还没有标注。选中文字后可添加高亮、下划线或书签。</p>;
  }
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
      <ol className="annotation-list">
        {annotations.map((annotation) => {
          const broken = brokenIds.has(annotation.id);
          const canRecolor = isAnnotationMarkKind(annotation.kind) && Boolean(onChangeColor);
          return (
            <li key={annotation.id} className={`annotation-list-item${broken ? " is-broken" : ""}`}>
              <button type="button" className="annotation-list-main" onClick={() => onSelect(annotation)}>
                <span
                  className={`annotation-list-kind annotation-list-kind--${annotation.kind}${
                    annotation.color ? ` annotation-list-kind--${annotation.color}` : ""
                  }`}
                >
                  {annotationKindLabel(annotation.kind)}
                </span>
                <span className="annotation-list-title">{annotationListTitle(annotation)}</span>
                {annotation.note ? <span className="annotation-list-note">{annotation.note}</span> : null}
                {broken ? <span className="annotation-list-broken">定位失效</span> : null}
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
                      aria-label={`改为${ANNOTATION_COLOR_LABELS[item]}色`}
                      aria-pressed={annotation.color === item}
                      onClick={() => onChangeColor?.(annotation, item)}
                    />
                  ))}
                </div>
              ) : null}
              <div className="annotation-list-actions">
                <button type="button" onClick={() => onEditNote(annotation)}>
                  笔记
                </button>
                <button type="button" onClick={() => onDelete(annotation)}>
                  删除
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export interface AnnotationLibraryGroup {
  path: string;
  title: string;
  annotations: Annotation[];
}

export type AnnotationLibraryStatus = "idle" | "loading" | "error" | "ready";

interface AnnotationLibraryPanelProps {
  status: AnnotationLibraryStatus;
  groups: AnnotationLibraryGroup[];
  error?: string | null;
  currentPath?: string | null;
  onRefresh: () => void;
  onExport: () => void;
  onSelect: (annotation: Annotation) => void;
}

/** 全库标注总览:按文档分组展示,点击条目跳转到对应文档内标注。 */
export function AnnotationLibraryPanel({
  status,
  groups,
  error = null,
  currentPath = null,
  onRefresh,
  onExport,
  onSelect,
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
  if (!groups.length) {
    return (
      <div className="annotation-library">
        <p className="toc-empty">整个文档库还没有标注。</p>
        <div className="annotation-list-toolbar">
          <div className="annotation-list-toolbar-actions">
            <button type="button" onClick={onRefresh}>
              刷新
            </button>
          </div>
        </div>
      </div>
    );
  }
  const total = groups.reduce((sum, group) => sum + group.annotations.length, 0);
  return (
    <div className="annotation-library">
      <div className="annotation-list-toolbar">
        <span className="annotation-library-total">共 {total} 条</span>
        <div className="annotation-list-toolbar-actions">
          <button type="button" onClick={onRefresh}>
            刷新
          </button>
          <button type="button" onClick={onExport}>
            导出全库
          </button>
        </div>
      </div>
      {groups.map((group) => (
        <section key={group.path} className="annotation-library-group" aria-label={group.title}>
          <h3 className="annotation-library-doc">
            <span className="annotation-library-doc-title" title={group.path}>
              {group.title}
            </span>
            {group.path === currentPath ? (
              <span className="annotation-library-current">当前</span>
            ) : null}
            <span className="side-panel-count">{group.annotations.length}</span>
          </h3>
          <ol className="annotation-list">
            {group.annotations.map((annotation) => (
              <li key={annotation.id} className="annotation-list-item">
                <button
                  type="button"
                  className="annotation-list-main"
                  onClick={() => onSelect(annotation)}
                >
                  <span
                    className={`annotation-list-kind annotation-list-kind--${annotation.kind}${
                      annotation.color ? ` annotation-list-kind--${annotation.color}` : ""
                    }`}
                  >
                    {annotationKindLabel(annotation.kind)}
                  </span>
                  <span className="annotation-list-title">{annotationListTitle(annotation)}</span>
                  {annotation.note ? (
                    <span className="annotation-list-note">{annotation.note}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
