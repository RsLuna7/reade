import { useMemo, useState } from "react";
import type { Annotation, DocumentFormat } from "../lib/backend";
import {
  ANNOTATION_TONE_META,
  type AnnotationEntryKind,
  type DocumentAnnotationBundle,
} from "../lib/annotationModel";
import {
  buildAnnotationOutline,
  type AnnotationOutlineEntry,
  type AnnotationOutlineView,
} from "../lib/annotationOutline";
import type { TocItem } from "../lib/markdown";
import { annotationFromBundleEntry } from "../lib/annotationBundle";

function entryId(item: AnnotationOutlineEntry): string {
  return item.entry.id;
}

function entryPreview(item: AnnotationOutlineEntry): string {
  if (item.kind === "excerpt") return item.entry.sourceText.replace(/\s+/g, " ").trim();
  return item.entry.title?.trim() || "书签";
}

export function DocumentAnnotationsView({
  format,
  toc,
  currentHeadingId,
  currentPage = null,
  epubChapterTocIds,
  bundle,
  loading,
  onJump,
  onSaveReflection,
  onSetEnrollment,
}: {
  format: DocumentFormat;
  toc: TocItem[];
  currentHeadingId: string | null;
  currentPage?: number | null;
  epubChapterTocIds?: Map<string, string>;
  bundle: DocumentAnnotationBundle;
  loading: boolean;
  onJump: (annotation: Annotation) => void;
  onSaveReflection: (
    entryId: string,
    entryKind: AnnotationEntryKind,
    body: string,
  ) => Promise<unknown>;
  onSetEnrollment?: (excerptId: string, enabled: boolean) => Promise<unknown>;
}) {
  const [view, setView] = useState<AnnotationOutlineView>("outline");
  const [query, setQuery] = useState("");
  const [openIds, setOpenIds] = useState<ReadonlySet<string> | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reflectionsByEntryId = useMemo(
    () => new Map(bundle.reflections.map((item) => [item.entryId, item])),
    [bundle.reflections],
  );
  const enrollmentsByExcerptId = useMemo(
    () =>
      new Map(
        bundle.reviewEnrollments
          .filter((item) => item.deletedAt == null)
          .map((item) => [item.excerptId, item]),
      ),
    [bundle.reviewEnrollments],
  );

  const outline = useMemo(
    () =>
      buildAnnotationOutline({
        format,
        toc,
        excerpts: bundle.excerpts,
        places: bundle.places,
        reflectionsByEntryId,
        currentTocId: currentHeadingId,
        currentPage,
        epubChapterTocIds,
        view,
      }),
    [
      bundle.excerpts,
      bundle.places,
      currentHeadingId,
      currentPage,
      epubChapterTocIds,
      format,
      reflectionsByEntryId,
      toc,
      view,
    ],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const defaultOpenId =
    outline.sections.find((section) => section.current)?.id ?? outline.sections[0]?.id ?? null;

  const sectionIsOpen = (id: string): boolean => {
    if (normalizedQuery) return true;
    if (openIds) return openIds.has(id);
    return id === defaultOpenId;
  };

  const jumpTo = (item: AnnotationOutlineEntry) => {
    const annotation = annotationFromBundleEntry(bundle, entryId(item));
    if (annotation) onJump(annotation);
  };

  const saveReflection = async (item: AnnotationOutlineEntry) => {
    const id = entryId(item);
    const body = (drafts[id] ?? reflectionsByEntryId.get(id)?.body ?? "").trim();
    if (!body) {
      setError("感悟不能为空");
      return;
    }
    setSavingId(id);
    setError(null);
    try {
      await onSaveReflection(id, item.kind === "excerpt" ? "excerpt" : "place", body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="document-annotations">
      <header className="document-annotations-header">
        <p className="document-annotations-meta">
          {outline.excerptCount} 条重点 · {outline.sections.length} 个分组 · {outline.reflectionCount}{" "}
          条感悟
        </p>
        <div className="document-annotations-views" role="tablist" aria-label="本文标注视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === "outline"}
            className={view === "outline" ? "active" : ""}
            onClick={() => setView("outline")}
          >
            按章节
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "reflections"}
            className={view === "reflections" ? "active" : ""}
            onClick={() => setView("reflections")}
          >
            我的感悟
          </button>
        </div>
        <label className="document-annotations-search">
          <span className="sr-only">搜索本文标注</span>
          <input
            type="search"
            value={query}
            placeholder="搜索本文"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </header>
      {loading ? <p className="document-annotations-status">正在读取标注…</p> : null}
      {error ? (
        <p className="document-annotations-status" role="alert">
          {error}
        </p>
      ) : null}
      {outline.sections.length === 0 ? (
        <p className="document-annotations-empty">
          {view === "reflections" ? "还没有写下感悟的摘录。" : "本文还没有标注。"}
        </p>
      ) : (
        outline.sections.map((section) => {
          const entries = section.entries.filter((item) => {
            if (!normalizedQuery) return true;
            const reflection = reflectionsByEntryId.get(entryId(item));
            const haystack = `${entryPreview(item)}\n${reflection?.body ?? ""}`.toLowerCase();
            return haystack.includes(normalizedQuery);
          });
          if (normalizedQuery && entries.length === 0) return null;
          const open = sectionIsOpen(section.id);
          return (
            <section key={section.id} className="document-annotations-section">
              <button
                type="button"
                className="document-annotations-section-toggle"
                aria-expanded={open}
                onClick={() => {
                  setOpenIds((current) => {
                    const next = new Set(current ?? (defaultOpenId ? [defaultOpenId] : []));
                    if (next.has(section.id)) next.delete(section.id);
                    else next.add(section.id);
                    return next;
                  });
                }}
              >
                <span>{section.title}</span>
                <span className="document-annotations-section-count">{section.excerptCount}</span>
              </button>
              {open
                ? entries.map((item) => {
                    const id = entryId(item);
                    const reflection = reflectionsByEntryId.get(id);
                    const enrollment = enrollmentsByExcerptId.get(id);
                    const enrolled = Boolean(enrollment && !enrollment.suspended);
                    const expanded = expandedId === id;
                    const toneLabel =
                      item.kind === "excerpt"
                        ? ANNOTATION_TONE_META[item.entry.appearance.tone].label
                        : "书签";
                    return (
                      <article
                        key={id}
                        className={`document-annotations-entry${expanded ? " is-expanded" : ""}`}
                      >
                        <button
                          type="button"
                          className="document-annotations-entry-main"
                          onClick={() => jumpTo(item)}
                        >
                          <span className="document-annotations-entry-text">{entryPreview(item)}</span>
                          <span className="document-annotations-entry-meta">
                            {toneLabel}
                            {reflection ? " · 有感悟" : ""}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="document-annotations-entry-toggle"
                          aria-expanded={expanded}
                          onClick={() => setExpandedId(expanded ? null : id)}
                        >
                          {expanded ? "收起" : reflection ? "看感悟" : "写感悟"}
                        </button>
                        {expanded ? (
                          <div className="document-annotations-editor">
                            <label>
                              <span className="sr-only">感悟</span>
                              <textarea
                                rows={4}
                                value={drafts[id] ?? reflection?.body ?? ""}
                                onChange={(event) =>
                                  setDrafts((current) => ({ ...current, [id]: event.target.value }))
                                }
                                placeholder="读完后把想法写在这里"
                              />
                            </label>
                            <div className="document-annotations-editor-actions">
                              <button
                                type="button"
                                onClick={() => void saveReflection(item)}
                                disabled={savingId === id}
                              >
                                保存感悟
                              </button>
                              {item.kind === "excerpt" && onSetEnrollment ? (
                                <button
                                  type="button"
                                  onClick={() => void onSetEnrollment(id, !enrolled)}
                                >
                                  {enrolled ? "移出间隔回顾" : "加入间隔回顾"}
                                </button>
                              ) : null}
                              <button type="button" onClick={() => jumpTo(item)}>
                                回原文
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  })
                : null}
            </section>
          );
        })
      )}
    </div>
  );
}
