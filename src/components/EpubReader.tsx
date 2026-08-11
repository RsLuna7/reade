import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ImageOff, ShieldAlert } from "lucide-react";
import { openExternalLink, readEpubAsset, type EpubBlock, type EpubDocument, type EpubInline, type EpubTableSlot, type SearchLocator } from "../lib/backend";
import type { TocItem } from "../lib/markdown";
import { cancelMotion, runMotion, type ReaderMotionLevel } from "../lib/motion";
import { scrollElementWithinContainer } from "../lib/scroll";

interface EpubReaderProps {
  relativePath: string;
  document: EpubDocument;
  locator: SearchLocator | null;
  motionLevel: ReaderMotionLevel;
  onTocChange: (items: TocItem[]) => void;
  onActiveChange: (id: string | null) => void;
}

const EpubMotionContext = createContext<ReaderMotionLevel>("off");

function domId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${prefix}-${(hash >>> 0).toString(36)}`;
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

function BlockView({ block, relativePath, document }: { block: EpubBlock; relativePath: string; document: EpubDocument }): ReactNode {
  const inline = (items: EpubInline[]) => <InlineContent items={items} relativePath={relativePath} document={document} />;
  switch (block.kind) {
    case "heading": {
      const Heading = `h${Math.min(6, Math.max(1, block.level))}` as "h1";
      return <Heading id={block.anchor ? domId("epub-anchor", block.anchor) : undefined}>{inline(block.content)}</Heading>;
    }
    case "paragraph": return <p>{inline(block.content)}</p>;
    case "rule": return <hr />;
    case "codeBlock": return <pre><code data-language={block.language ?? undefined}>{block.text}</code></pre>;
    case "blockQuote": return <blockquote>{block.blocks.map((item, index) => <BlockView block={item} relativePath={relativePath} document={document} key={index} />)}</blockquote>;
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return <List start={block.ordered ? block.start : undefined}>{block.items.map((item, index) => <li key={index}>{item.checked !== null && <input type="checkbox" checked={item.checked} readOnly tabIndex={-1} />}{item.blocks.map((child, childIndex) => <BlockView block={child} relativePath={relativePath} document={document} key={childIndex} />)}</li>)}</List>;
    }
    case "table": return <div className="epub-table-scroll"><table><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((slot, cellIndex) => <TableCell key={cellIndex} slot={slot} relativePath={relativePath} document={document} header={rowIndex < block.headerRows} />)}</tr>)}</tbody></table></div>;
  }
}

export function EpubReader({ relativePath, document, locator, motionLevel, onTocChange, onActiveChange }: EpubReaderProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const toc = useMemo<TocItem[]>(() => document.chapters.map((chapter) => ({ id: domId("epub-chapter", chapter.id), title: chapter.title, level: 1 })), [document.chapters]);

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

  return <EpubMotionContext.Provider value={motionLevel}><div className="epub-reader" ref={rootRef}>
    {document.chapters.map((chapter) => <section className="epub-chapter" id={domId("epub-chapter", chapter.id)} data-chapter-id={chapter.id} key={chapter.id}>
      <div className="epub-chapter-heading">
        <span className="reade-motion-locator-highlight" aria-hidden="true" />
        <p className="epub-chapter-label">Chapter</p>
        <h2 className="epub-chapter-title">{chapter.title}</h2>
      </div>
      {chapter.blocks.map((block, index) => <BlockView block={block} relativePath={relativePath} document={document} key={index} />)}
    </section>)}
    {document.notes.length > 0 && <section className="epub-notes"><h2>注释</h2>{document.notes.map((note) => <aside id={domId("epub-note", note.id)} key={note.id}><strong>{note.id}</strong>{note.blocks.map((block, index) => <BlockView block={block} relativePath={relativePath} document={document} key={index} />)}</aside>)}</section>}
  </div></EpubMotionContext.Provider>;
}
