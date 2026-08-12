import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ImageOff, ShieldAlert } from "lucide-react";
import { openExternalLink, readEpubAsset, type Annotation, type EpubBlock, type EpubDocument, type EpubInline, type EpubTableSlot, type SearchLocator } from "../lib/backend";
import {
  clearAnnotationMarks,
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
  onBrokenAnnotationsChange?: (ids: string[]) => void;
  onTocChange: (items: TocItem[]) => void;
  onActiveChange: (id: string | null) => void;
}

const EpubMotionContext = createContext<ReaderMotionLevel>("off");

function domId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${prefix}-${(hash >>> 0).toString(36)}`;
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

/** Builds a Markdown-like indented TOC from chapter nav levels and in-chapter headings. */
export function buildEpubToc(document: EpubDocument): TocItem[] {
  const items: TocItem[] = [];
  for (const chapter of document.chapters) {
    const chapterLevel = clampTocLevel(chapter.level ?? 1);
    items.push({
      id: domId("epub-chapter", chapter.id),
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

function EpubImage({ relativePath, document, assetId, alt }: { relativePath: string; document: EpubDocument; assetId: number; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const asset = document.assets.find((item) => item.id === assetId);

  useEffect(() => {
    if (!asset?.allowed) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void readEpubAsset(relativePath, assetId).then((bytes) => {
      if (cancelled) return;
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: asset.mediaType }));
      setUrl(objectUrl);
    }).catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset?.allowed, asset?.mediaType, assetId, relativePath]);

  if (!asset?.allowed || !url) {
    return <span className="epub-asset-placeholder"><ImageOff size={18} aria-hidden="true" />{asset?.allowed ? "图片暂不可用" : "不支持的图片类型"}</span>;
  }
  return <img className="epub-image" src={url} alt={alt || asset.alt} loading="lazy" />;
}

function InlineContent({ items, relativePath, document }: { items: EpubInline[]; relativePath: string; document: EpubDocument }): ReactNode {
  const motionLevel = useContext(EpubMotionContext);
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
    if (item.kind === "anchor") return <span id={domId("epub-anchor", item.id)} key={index} />;
    if (item.kind === "noteRef") return <a className="epub-note-ref" href={`#${domId("epub-note", item.id)}`} key={index}>[{item.id}]</a>;
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
    const target = domId("epub-anchor", item.target.value.replace(/^#/, ""));
    return <a href={`#${target}`} key={index} onClick={(event) => {
      event.preventDefault();
      const targetElement = globalThis.document.getElementById(target);
      scrollElementWithinContainer(
        targetElement?.closest<HTMLElement>(".reading-scroll") ?? null,
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
        <Heading id={block.anchor ? domId("epub-anchor", block.anchor) : undefined}>{inline(block.content)}</Heading>,
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
  onBrokenAnnotationsChange,
  onTocChange,
  onActiveChange,
}: EpubReaderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
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
    const updateActiveChapter = () => {
      frame = null;
      const viewport = scrollRoot?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight, height: window.innerHeight };
      const referenceLine = viewport.top + viewport.height * 0.18;
      let active: { id: string; distance: number } | null = null;
      for (const section of sections) {
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
    const observer = new IntersectionObserver(scheduleUpdate, { root: scrollRoot, threshold: [0, 0.01, 0.5, 1] });
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
    // Group marks by anchor element so each subtree is walked once per paint;
    // each group builds its index lazily, after earlier groups already wrapped.
    const groups = new Map<HTMLElement, TextQuoteMarkInput[]>();
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
      const target = block ?? chapter;
      const marks = groups.get(target) ?? [];
      if (!marks.length) groups.set(target, marks);
      marks.push({
        id: annotation.id,
        color: annotation.color,
        markKind: annotation.kind,
        quote: annotation.locator.quote,
        prefix: annotation.locator.prefix,
        suffix: annotation.locator.suffix,
        // The captured offset disambiguates quotes repeated inside the block.
        hintStart: annotation.locator.startOffset,
      });
    }
    for (const [target, marks] of groups) {
      broken.push(...paintTextQuoteMarks(target, marks));
    }
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
    onBrokenAnnotationsChange?.(Array.from(new Set(broken)));
  }, [annotations, document, onBrokenAnnotationsChange]);

  return <EpubMotionContext.Provider value={motionLevel}><div className="epub-reader" ref={rootRef}>
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
    {document.notes.length > 0 && <section className="epub-notes"><h2>注释</h2>{document.notes.map((note) => <aside id={domId("epub-note", note.id)} key={note.id}><strong>{note.id}</strong>{note.blocks.map((block, index) => <BlockView block={block} relativePath={relativePath} document={document} key={index} />)}</aside>)}</section>}
  </div></EpubMotionContext.Provider>;
}
