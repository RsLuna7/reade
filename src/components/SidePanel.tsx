// D12：从 App.tsx 提取的右侧目录/标注面板（行为不变，仅移动）。
import type { ReactNode } from "react";
import {
  AnnotationList,
  type AnnotationListSort,
} from "./AnnotationUi";
import { TocNavigation } from "./TocNavigation";
import type { Annotation, AnnotationColor } from "../lib/backend";
import type { TocItem } from "../lib/markdown";
import type { TocHeatResult } from "../lib/tocHeat";

export type SidePanelTab = "toc" | "annotations";

export function SidePanel({
  tab,
  onTabChange,
  tocItems,
  activeId,
  onSelectHeading,
  tocHeat,
  onSelectDocumentTop,
  tocEstimateLine,
  annotations,
  brokenIds,
  approximateIds,
  geometricFallbackIds,
  annotationsLoading,
  annotationSort,
  onAnnotationSortChange,
  onExportAnnotations,
  onSelectAnnotation,
  onDeleteAnnotation,
  onEditAnnotationNote,
  onChangeAnnotationColor,
  onRelocateAnnotation,
  onGenerateAnnotationCard,
  onCompileAnnotationsDigest,
  onClearAnnotations,
  annotationsPanel,
  onOpenLibraryHub,
}: {
  tab: SidePanelTab;
  onTabChange: (tab: SidePanelTab) => void;
  tocItems: TocItem[];
  activeId: string | null;
  onSelectHeading: (id: string) => void;
  tocHeat?: TocHeatResult | null;
  onSelectDocumentTop?: () => void;
  tocEstimateLine?: string | null;
  annotations: Annotation[];
  brokenIds: Set<string>;
  approximateIds: Set<string>;
  geometricFallbackIds: Set<string>;
  annotationsLoading: boolean;
  annotationSort: AnnotationListSort;
  onAnnotationSortChange: (sort: AnnotationListSort) => void;
  onExportAnnotations: () => void;
  onSelectAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  onEditAnnotationNote: (annotation: Annotation) => void;
  onChangeAnnotationColor: (annotation: Annotation, color: AnnotationColor) => void;
  onRelocateAnnotation: (annotation: Annotation) => void;
  onGenerateAnnotationCard?: (annotation: Annotation) => void;
  /** 全书回顾编纂(plan-book-digest):标注 tab 工具条入口。 */
  onCompileAnnotationsDigest?: () => void;
  onClearAnnotations: () => void;
  /** Chapter/page-band outline for Markdown/PDF/EPUB; honesty fallback stays AnnotationList. */
  annotationsPanel?: ReactNode;
  /** 二级入口：全屏全库摘录（命令面板亦可）。 */
  onOpenLibraryHub?: () => void;
}) {
  return (
    <div className="toc-inner">
      <div className="side-panel-tabs" role="tablist" aria-label="目录与标注">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "toc"}
          className={tab === "toc" ? "active" : ""}
          onClick={() => onTabChange("toc")}
        >
          目录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "annotations"}
          className={tab === "annotations" ? "active" : ""}
          onClick={() => onTabChange("annotations")}
        >
          标注
          {annotations.length > 0 ? <span className="side-panel-count">{annotations.length}</span> : null}
        </button>
      </div>
      {tab === "toc" ? (
        <TocNavigation
          items={tocItems}
          activeId={activeId}
          onSelect={onSelectHeading}
          heat={tocHeat}
          onSelectTop={onSelectDocumentTop}
          estimateLine={tocEstimateLine}
        />
      ) : (
        <>
          {onOpenLibraryHub ? (
            <button type="button" className="annotation-hub-link side-panel-hub-link" onClick={onOpenLibraryHub}>
              打开全库摘录
            </button>
          ) : null}
          {annotationsPanel ?? (
            <AnnotationList
              annotations={annotations}
              brokenIds={brokenIds}
              approximateIds={approximateIds}
              geometricFallbackIds={geometricFallbackIds}
              loading={annotationsLoading}
              sort={annotationSort}
              onSortChange={onAnnotationSortChange}
              onExport={onExportAnnotations}
              onSelect={onSelectAnnotation}
              onDelete={onDeleteAnnotation}
              onEditNote={onEditAnnotationNote}
              onChangeColor={onChangeAnnotationColor}
              onRelocate={onRelocateAnnotation}
              onGenerateCard={onGenerateAnnotationCard}
              onCompileDigest={onCompileAnnotationsDigest}
              onClearAll={onClearAnnotations}
            />
          )}
        </>
      )}
    </div>
  );
}
