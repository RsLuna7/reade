import { createContext, Fragment, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ImageOff, ShieldAlert } from "lucide-react";
import { openExternalLink, readEpubAsset, type Annotation, type EpubBlock, type EpubDocument, type EpubInline, type EpubTableSlot, type SearchLocator } from "../lib/backend";
import {
  clearAnnotationMarks,
  decorateApproximateAnnotationMarks,
  isAnnotationMarkKind,
  paintTextQuoteMarks,
  type TextQuoteMarkInput,
} from "../lib/annotations";
import type { TocItem } from "../lib/markdown";
import { cancelMotion, runMotion, type ReaderMotionLevel } from "../lib/motion";
import { scrollElementWithinContainer } from "../lib/scroll";

interface EpubReaderProps {
  relativePath: string;
  document: EpubDocument;
  locator: SearchLocator | null;
  motionLevel: ReaderMotionLevel;
  annotations?: Annotation[];
  /** Enables the fuzzy last-resort anchoring step (global preference). */
  fuzzyAnchoring?: boolean;
  onBrokenAnnotationsChange?: (ids: string[]) => void;
  onApproximateAnnotationsChange?: (ids: string[]) => void;
  onTocChange: (items: TocItem[]) => void;
  onActiveChange: (id: string | null) => void;
}

const EpubMotionContext = createContext<ReaderMotionLevel>("off");
/**
 * D07: per-reader-instance scope for rendered DOM ids. The same book can be
 * open in the main and secondary pane (or two books can share ids); without
 * a scope, `#anchor` jumps and footnote links always landed on the first
 * instance in the document. The scope suffix is appended to every rendered
 * in-book id (anchor spans, headings, notes) — never to `epubChapterTocId`,
 * whose value is part of the annotation-attribution and TOC contracts.
 */
const EpubScopeContext = createContext<string>("");

function domId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

/** D07: instance-scoped DOM id for in-book anchors and notes. */
function scopedDomId(prefix: string, value: string, scope: string): string {
  const suffix = scope.replace(/[^a-zA-Z0-9_-]/g, "");
  return `${domId(prefix, value)}${suffix}`;
}

function clampTocLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(6, Math.max(1, Math.round(level)));
}

function epubInlineText(items: EpubInline[]): string {
  return items.map((item) => {
    switch (item.kind) {
      case "text":
        return item.text;
      case "link":
        return epubInlineText(item.content);
      case "image":
        return item.alt;
      case "lineBreak":
        return " ";
      default:
        return "";
    }
  }).join("").replace(/\s+/g, " ").trim();
}

/**
 * Chapter-level TOC id for a chapter id — the public counterpart of the
 * private domId hash, so annotation attribution (`buildTocHeat`) can map
 * `locator.chapterId` to the chapter entry emitted by `buildEpubToc`.
 */
export function epubChapterTocId(chapterId: string): string {
  return domId("epub-chapter", chapterId);
}

/** Builds a Markdown-like indented TOC from chapter nav levels and in-chapter headings. */
export function buildEpubToc(document: EpubDocument): TocItem[] {
  const items: TocItem[] = [];
  for (const chapter of document.chapters) {
    const chapterLevel = clampTocLevel(chapter.level ?? 1);
    items.push({
      id: epubChapterTocId(chapter.id),
      title: chapter.title,
      level: chapterLevel,
    });

    let skippedChapterTitleHeading = false;
    for (const block of chapter.blocks) {
      if (block.kind !== "heading") continue;
      const title = epubInlineText(block.content);
      if (!title) continue;
      if (!skippedChapterTitleHeading && title === chapter.title) {
        skippedChapterTitleHeading = true;
        continue;
      }
      skippedChapterTitleHeading = true;
      if (!block.anchor) continue;
      items.push({
        id: domId("epub-anchor", block.anchor),
        title,
        level: clampTocLevel(block.level),
      });
    }
  }
  return items;
}

/**
 * D11: EPUB 图片资产的共享加载器。同一 (relativePath, assetId) 的并发
 * 请求合并为一次 IPC 读取（并发上限 EPUB_IMAGE_CONCURRENCY，队列排空）；
 * Blob URL 按消费者引用计数，最后一个消费者卸载后才撤销。加载失败的
 * in-flight Promise 从缓存移除，允许后续重试。
 */
interface SharedEpubAsset {
  consumers: number;
  url: string;
}

const EPUB_IMAGE_CONCURRENCY = 4;
const sharedEpubAssets = new Map<string, SharedEpubAsset>();
const inFlightEpubAssets = new Map<string, Promise<void>>();
const epubImageQueue: Array<() => void> = [];
let epubImageActive = 0;

function epubAssetKey(relativePath: string, assetId: number): string {
  return `${relativePath}\u0000${assetId}`;
}

function pumpEpubImageQueue(): void {
  while (epubImageActive < EPUB_IMAGE_CONCURRENCY && epubImageQueue.length > 0) {
    const next = epubImageQueue.shift();
    next?.();
  }
}

function withEpubImageSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      epubImageActive += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          epubImageActive -= 1;
          pumpEpubImageQueue();
        });
    };
    epubImageQueue.push(run);
    pumpEpubImageQueue();
  });
}

async function acquireEpubAssetUrl(
  relativePath: string,
  assetId: number,
  mediaType: string,
): Promise<() => void> {
  const key = epubAssetKey(relativePath, assetId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = sharedEpubAssets.get(key);
    if (existing) {
      existing.consumers += 1;
      return () => releaseEpubAsset(key);
    }
    let loading = inFlightEpubAssets.get(key);
    if (!loading) {
      loading = withEpubImageSlot(async () => {
        const bytes = await readEpubAsset(relativePath, assetId);
        sharedEpubAssets.set(key, {
          consumers: 0,
          url: URL.createObjectURL(new Blob([bytes], { type: mediaType })),
        });
      }).catch((cause: unknown) => {
        // 失败的 Promise 不常驻缓存：下一个消费者可以重新发起读取。
        inFlightEpubAssets.delete(key);
        throw cause;
      });
      inFlightEpubAssets.set(key, loading);
    }
    await loading;
    const shared = sharedEpubAssets.get(key);
    if (shared) {
      shared.consumers += 1;
      return () => releaseEpubAsset(key);
    }
    // 等待期间全部消费者恰好释放：重新获取。
  }
  throw new Error("EPUB asset could not be acquired");
}

function releaseEpubAsset(key: string): void {
  const shared = sharedEpubAssets.get(key);
  if (!shared) return;
  shared.consumers -= 1;
  if (shared.consumers <= 0) {
    sharedEpubAssets.delete(key);
    URL.revokeObjectURL(shared.url);
  }
}

function EpubImage({ relativePath, document, assetId, alt }: { relativePath: string; document: EpubDocument; assetId: number; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const placeholderRef = useRef<HTMLSpanElement | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const asset = document.assets.find((item) => item.id === assetId);

  // D11: <img loading="lazy"> 只延迟浏览器取用，不延迟 IPC 读取——真正的
  // 按需加载在这里：元素进入视口附近（1.2 预热边距）才发起资产请求。
  useEffect(() => {
    if (!asset?.allowed) return;
    const node = placeholderRef.current;
    if (!node || typeof IntersectionObserver !== "function") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
        }
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [asset?.allowed]);

  useEffect(() => {
    if (!asset?.allowed || !nearViewport) return;
    let cancelled = false;
    let release: (() => void) | null = null;
    void acquireEpubAssetUrl(relativePath, assetId, asset.mediaType)
      .then((acquired) => {
        if (cancelled) {
          acquired();
          return;
        }
        release = acquired;
        setUrl(sharedEpubAssets.get(epubAssetKey(relativePath, assetId))?.url ?? null);
      })
      .catch(() => {
        // 失败：回到占位符并重新进入可触发状态（观察器尚未断开），
        // 重新滚动到视口附近即可重试。
        if (!cancelled) {
          setUrl(null);
          setNearViewport(false);
        }
      });
    return () => {
      cancelled = true;
      release?.();
      setUrl(null);
    };
  }, [asset?.allowed, asset?.mediaType, assetId, nearViewport, relativePath]);

  if (!asset?.allowed || !url) {
    return (
      <span className="epub-asset-placeholder" ref={placeholderRef}>
        <ImageOff size={18} aria-hidden="true" />
        {asset?.allowed ? "图片暂不可用" : "不支持的图片类型"}
      </span>
    );
  }
  return <img className="epub-image" src={url} alt={alt || asset.alt} loading="lazy" />;
}

function InlineContent({ items, relativePath, document }: { items: EpubInline[]; relativePath: string; document: EpubDocument }): ReactNode {
  const motionLevel = useContext(EpubMotionContext);
  const scope = useContext(EpubScopeContext);
  const render = (item: EpubInline, index: number): ReactNode => {
    if (item.kind === "text") {
      let node: ReactNode = item.text;
      if (item.code) node = <code>{node}</code>;
      if (item.strike) node = <s>{node}</s>;
      if (item.italic) node = <em>{node}</em>;
      if (item.bold) node = <strong>{node}</strong>;
      return <Fragment key={index}>{node}</Fragment>;
    }
    if (item.kind === "lineBreak") return <br key={index} />;
    if (item.kind === "anchor") return <span id={scopedDomId("epub-anchor", item.id, scope)} key={index} />;
    if (item.kind === "noteRef") return <a className="epub-note-ref" href={`#${scopedDomId("epub-note", item.id, scope)}`} key={index}>[{item.id}]</a>;
    if (item.kind === "image") {
      return item.source.kind === "asset"
        ? <EpubImage key={index} relativePath={relativePath} document={document} assetId={item.source.value} alt={item.alt} />
        : <span className="epub-asset-placeholder" key={index}><ShieldAlert size={16} aria-hidden="true" />远程或不安全资源已拦截</span>;
    }
    const children = <InlineContent items={item.content} relativePath={relativePath} document={document} />;
    if (item.target.kind === "external") {
      return <a href={item.target.value} key={index} rel="noreferrer" onClick={(event) => {
        event.preventDefault();
        if (window.confirm(`将在系统应用中打开外部链接：\n\n${item.target.value}\n\n是否继续？`)) void openExternalLink(item.target.value);
      }}>{children}</a>;
    }
    if (item.target.kind === "relative") {
      return <span className="epub-link-blocked" title="未开放书内附件或非章节资源" key={index}>{children}</span>;
    }
    const target = scopedDomId("epub-anchor", item.target.value.replace(/^#/, ""), scope);
    return <a href={`#${target}`} key={index} onClick={(event) => {
      event.preventDefault();
      // D07: resolve inside THIS reader instance — the same book can be
      // open in both panes, and each link must scroll its own instance.
      const instanceRoot = event.currentTarget.closest<HTMLElement>(".epub-reader");
      const targetElement = instanceRoot?.querySelector<HTMLElement>(`#${CSS.escape(target)}`) ?? null;
      scrollElementWithinContainer(
        instanceRoot?.closest<HTMLElement>(".reading-scroll") ?? null,
        targetElement,
        motionLevel === "off" ? "auto" : "smooth",
      );
    }}>{children}</a>;
  };
  return <>{items.map(render)}</>;
}

function TableCell({ slot, relativePath, document, header }: { slot: EpubTableSlot; relativePath: string; document: EpubDocument; header: boolean }) {
  if (slot.kind === "covered") return null;
  const Cell = header ? "th" : "td";
  return <Cell colSpan={slot.colSpan} rowSpan={slot.rowSpan}>{slot.blocks.map((block, index) => <BlockView block={block} relativePath={relativePath} document={document} key={index} />)}</Cell>;
}

function BlockView({
  block,
  relativePath,
  document,
  blockIndex,
}: {
  block: EpubBlock;
  relativePath: string;
  document: EpubDocument;
  blockIndex?: number;
}): ReactNode {
  const inline = (items: EpubInline[]) => <InlineContent items={items} relativePath={relativePath} document={document} />;
  const scope = useContext(EpubScopeContext);
  const wrap = (node: ReactNode) =>
    typeof blockIndex === "number" ? (
      <div className="epub-block" data-block-index={blockIndex}>
        {node}
      </div>
    ) : (
      node
    );
  switch (block.kind) {
    case "heading": {
      const Heading = `h${Math.min(6, Math.max(1, block.level))}` as "h1";
      return wrap(
        <Heading id={block.anchor ? scopedDomId("epub-anchor", block.anchor, scope) : undefined}>{inline(block.content)}</Heading>,
      );
    }
    case "paragraph":
      return wrap(<p>{inline(block.content)}</p>);
    case "rule":
      return wrap(<hr />);
    case "codeBlock":
      return wrap(
        <pre>
          <code data-language={block.language ?? undefined}>{block.text}</code>
        </pre>,
      );
    case "blockQuote":
      return wrap(
        <blockquote>
          {block.blocks.map((item, index) => (
            <BlockView block={item} relativePath={relativePath} document={document} key={index} />
          ))}
        </blockquote>,
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return wrap(
        <List start={block.ordered ? block.start : undefined}>
          {block.items.map((item, index) => (
            <li key={index}>
              {item.checked !== null && <input type="checkbox" checked={item.checked} readOnly tabIndex={-1} />}
              {item.blocks.map((child, childIndex) => (
                <BlockView block={child} relativePath={relativePath} document={document} key={childIndex} />
              ))}
            </li>
          ))}
        </List>,
      );
    }
    case "table":
      return wrap(
        <div className="epub-table-scroll">
          <table>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((slot, cellIndex) => (
                    <TableCell
                      key={cellIndex}
                      slot={slot}
                      relativePath={relativePath}
                      document={document}
                      header={rowIndex < block.headerRows}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
  }
}

export function EpubReader({
  relativePath,
  document,
  locator,
  motionLevel,
  annotations = [],
  fuzzyAnchoring = false,
  onBrokenAnnotationsChange,
  onApproximateAnnotationsChange,
  onTocChange,
  onActiveChange,
}: EpubReaderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // D07: unique scope for this reader instance's in-book DOM ids.
  const scope = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const toc = useMemo<TocItem[]>(() => buildEpubToc(document), [document]);

  useEffect(() => { onTocChange(toc); onActiveChange(toc[0]?.id ?? null); }, [onActiveChange, onTocChange, toc]);
  useEffect(() => {
    if (locator?.kind !== "epubChapter") return;
    let highlighted: HTMLElement | null = null;
    const frame = requestAnimationFrame(() => {
      const chapter = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-chapter-id]") ?? [])
        .find((element) => element.dataset.chapterId === locator.chapterId);
      scrollElementWithinContainer(
        rootRef.current?.closest<HTMLElement>(".reading-scroll") ?? null,
        chapter ?? null,
        "auto",
      );
      highlighted = chapter?.querySelector<HTMLElement>(".reade-motion-locator-highlight") ?? null;
      if (!highlighted) return;
      runMotion(
        highlighted,
        "locator-highlight",
        [
          { opacity: 0 },
          { opacity: motionLevel === "full" ? 0.3 : 0.2, offset: 0.18 },
          { opacity: 0 },
        ],
        { duration: motionLevel === "full" ? 880 : 720, easing: "ease-out" },
        motionLevel,
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      if (highlighted) cancelMotion(highlighted, "locator-highlight");
    };
  }, [locator, motionLevel, relativePath]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const sections = Array.from(root.querySelectorAll<HTMLElement>(".epub-chapter"));
    const scrollRoot = root.closest<HTMLElement>(".reading-scroll");
    let frame: number | null = null;
    // D11: IntersectionObserver 已经筛出"可见"章节；滚动帧只测量这些
    // （外加全部章节兜底一次），不再对整书逐章 getBoundingClientRect。
    const intersecting = new Set<HTMLElement>();
    const updateActiveChapter = () => {
      frame = null;
      const viewport = scrollRoot?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight, height: window.innerHeight };
      const referenceLine = viewport.top + viewport.height * 0.18;
      let active: { id: string; distance: number } | null = null;
      const candidates = intersecting.size > 0 ? intersecting : sections;
      for (const section of candidates) {
        const rect = section.getBoundingClientRect();
        if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
        const distance = rect.top <= referenceLine && rect.bottom >= referenceLine
          ? 0
          : Math.min(Math.abs(rect.top - referenceLine), Math.abs(rect.bottom - referenceLine));
        if (!active || distance < active.distance) active = { id: section.id, distance };
      }
      if (active?.id) onActiveChange(active.id);
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = requestAnimationFrame(updateActiveChapter);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) intersecting.add(entry.target as HTMLElement);
          else intersecting.delete(entry.target as HTMLElement);
        }
        scheduleUpdate();
      },
      { root: scrollRoot, threshold: [0, 0.01, 0.5, 1] },
    );
    sections.forEach((section) => observer.observe(section));
    const scrollTarget: EventTarget = scrollRoot ?? window;
    scrollTarget.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    scheduleUpdate();
    return () => {
      observer.disconnect();
      scrollTarget.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [document.chapters, onActiveChange]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    clearAnnotationMarks(root);
    const broken: string[] = [];
    const approximate: string[] = [];
    const groups = new Map<HTMLElement, TextQuoteMarkInput[]>();
    const retryByChapter = new Map<HTMLElement, TextQuoteMarkInput[]>();
    const chapterOnlyIds = new Set<string>();
    for (const annotation of annotations) {
      if (!isAnnotationMarkKind(annotation.kind) || annotation.locator.kind !== "epub" || !annotation.color) continue;
      const chapter = root.querySelector<HTMLElement>(
        `.epub-chapter[data-chapter-id="${CSS.escape(annotation.locator.chapterId)}"]`,
      );
      if (!chapter) {
        broken.push(annotation.id);
        continue;
      }
      const block = chapter.querySelector<HTMLElement>(
        `.epub-block[data-block-index="${annotation.locator.blockIndex}"]`,
      );
      const mark: TextQuoteMarkInput = {
        id: annotation.id,
        color: annotation.color,
        markKind: annotation.kind,
        quote: annotation.locator.quote,
        prefix: annotation.locator.prefix,
        suffix: annotation.locator.suffix,
        hintStart: annotation.locator.startOffset,
      };
      if (block) {
        const marks = groups.get(block) ?? [];
        if (!marks.length) groups.set(block, marks);
        marks.push(mark);
        const retries = retryByChapter.get(chapter) ?? [];
        if (!retries.length) retryByChapter.set(chapter, retries);
        retries.push(mark);
      } else {
        chapterOnlyIds.add(annotation.id);
        const marks = groups.get(chapter) ?? [];
        if (!marks.length) groups.set(chapter, marks);
        marks.push(mark);
      }
    }
    const recovered = new Set<string>();
    const chapterLevel = new Set<string>();
    for (const [target, marks] of groups) {
      const painted = paintTextQuoteMarks(target, marks, undefined, {
        normalizeWhitespace: true,
        fuzzy: fuzzyAnchoring,
      });
      broken.push(...painted.broken);
      approximate.push(...painted.approximate.keys());
      for (const mark of marks) {
        if (!painted.broken.includes(mark.id) && chapterOnlyIds.has(mark.id)) {
          chapterLevel.add(mark.id);
          approximate.push(mark.id);
        }
      }
    }
    for (const [chapter, marks] of retryByChapter) {
      const missed = marks.filter((mark) => broken.includes(mark.id));
      if (!missed.length) continue;
      const painted = paintTextQuoteMarks(chapter, missed, undefined, {
        normalizeWhitespace: true,
        fuzzy: fuzzyAnchoring,
      });
      for (const mark of missed) {
        if (painted.broken.includes(mark.id)) continue;
        recovered.add(mark.id);
        chapterLevel.add(mark.id);
        approximate.push(mark.id);
      }
    }
    decorateApproximateAnnotationMarks(root, chapterLevel);
    for (const annotation of annotations) {
      if (annotation.kind !== "bookmark" || annotation.locator.kind !== "bookmark") continue;
      if (annotation.locator.target.format !== "epub") continue;
      const target = annotation.locator.target;
      const chapter = root.querySelector<HTMLElement>(
        `.epub-chapter[data-chapter-id="${CSS.escape(target.chapterId)}"]`,
      );
      if (!chapter) {
        broken.push(annotation.id);
        continue;
      }
      if (target.headingId && !root.querySelector(`#${CSS.escape(target.headingId)}`)) {
        broken.push(annotation.id);
      }
    }
    onBrokenAnnotationsChange?.(Array.from(new Set(broken.filter((id) => !recovered.has(id)))));
    onApproximateAnnotationsChange?.(Array.from(new Set(approximate)));
  }, [annotations, document, fuzzyAnchoring, onApproximateAnnotationsChange, onBrokenAnnotationsChange]);

  return <EpubMotionContext.Provider value={motionLevel}><EpubScopeContext.Provider value={scope}><div className="epub-reader" ref={rootRef}>
    {document.chapters.map((chapter) => <section className="epub-chapter" id={domId("epub-chapter", chapter.id)} data-chapter-id={chapter.id} key={chapter.id}>
      <div className="epub-chapter-heading">
        <span className="reade-motion-locator-highlight" aria-hidden="true" />
        <p className="epub-chapter-label">Chapter</p>
        <h2 className="epub-chapter-title">{chapter.title}</h2>
      </div>
      {chapter.blocks.map((block, index) => (
        <BlockView
          block={block}
          relativePath={relativePath}
          document={document}
          blockIndex={index}
          key={index}
        />
      ))}
    </section>)}
    {document.notes.length > 0 && <section className="epub-notes"><h2>注释</h2>{document.notes.map((note) => <aside id={scopedDomId("epub-note", note.id, scope)} key={note.id}><strong>{note.id}</strong>{note.blocks.map((block, index) => <BlockView block={block} relativePath={relativePath} document={document} key={index} />)}</aside>)}</section>}
  </div></EpubScopeContext.Provider></EpubMotionContext.Provider>;
}
