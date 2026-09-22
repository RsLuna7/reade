/**
 * Real-render fixture for the PDF comment rail (plan-pdf-comment-rail).
 * Mounts the shipped component against fake PDF highlight marks so layout,
 * collision stacking, and theme tokens can be inspected in a browser:
 *   pnpm dev → /tools/fixtures/comment-rail-fixture.html?theme=paper-dark
 */
import React, { useRef } from "react";
import ReactDOM from "react-dom/client";
import type { Annotation } from "../../src/lib/backend";
import { PdfCommentRail } from "../../src/components/comments/PdfCommentRail";

const theme = new URLSearchParams(window.location.search).get("theme") ?? "paper-light";
document.documentElement.dataset.theme = theme;

function highlight(id: string, page: number, topPx: number, leftPx: number, widthPx: number): Annotation {
  return {
    id,
    relativePath: "paper.pdf",
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: `annotation ${id}`,
    title: null,
    locator: {
      kind: "pdf",
      page,
      view: "original",
      quote: `annotation ${id}`,
      prefix: "",
      suffix: "",
      rects: [{ x: leftPx / 620, y: topPx / 900, w: widthPx / 620, h: 0.02 }],
    },
    sortIndex: `P|${String(page).padStart(5, "0")}|${String(topPx).padStart(8, "0")}`,
    createdAt: page,
    updatedAt: page,
    annotationTop: topPx,
  } as Annotation & { annotationTop: number };
}

const annotations: Annotation[] = [
  highlight("a-far", 1, 120, 60, 260),
  highlight("b-near", 1, 300, 60, 200),
  highlight("c-near", 1, 322, 60, 320),
  highlight("d-multiline", 1, 520, 60, 300),
  highlight("e-far", 1, 760, 60, 220),
];

const at = (minutesAgo: number) => Date.parse("2026-09-20T21:00:00+08:00") - minutesAgo * 60_000;

const authors = [
  { id: "local-me", name: "我", isDefault: true, createdAt: at(600), updatedAt: at(600), deletedAt: null },
  { id: "author-2", name: "研究者", isDefault: false, createdAt: at(400), updatedAt: at(400), deletedAt: null },
];

const threads = ["a-far", "b-near", "c-near", "d-multiline", "e-far"].map((annotationId, index) => ({
  id: `thread-${annotationId}`,
  annotationId,
  createdAt: index + 1,
  updatedAt: index + 1,
  deletedAt: null,
}));

const messages = [
  { id: "m1", threadId: "thread-a-far", authorId: "local-me", body: "这条标注说明了章节的主线。", createdAt: at(180), updatedAt: at(180), deletedAt: null },
  {
    id: "m2",
    threadId: "thread-b-near",
    authorId: "local-me",
    body: "这两条标注挨得很近，卡片必须自动向下避让，不能重叠。",
    createdAt: at(150),
    updatedAt: at(150),
    deletedAt: null,
  },
  { id: "m3", threadId: "thread-b-near", authorId: "author-2", body: "同意，第二张卡片被推到下面了。", createdAt: at(96), updatedAt: at(96), deletedAt: null },
  { id: "m4", threadId: "thread-c-near", authorId: "author-2", body: "第二条相邻讨论。", createdAt: at(64), updatedAt: at(64), deletedAt: null },
  {
    id: "m5",
    threadId: "thread-d-multiline",
    authorId: "local-me",
    body: "跨三行的标注只应该出现一张卡片：这里验证 lead rect 语义。",
    createdAt: at(38),
    updatedAt: at(38),
    deletedAt: null,
  },
  { id: "m6", threadId: "thread-e-far", authorId: "local-me", body: "远离冲突区的卡片要回到自己的锚点。", createdAt: at(12), updatedAt: at(12), deletedAt: null },
];

function Fixture() {
  const layoutRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const position = (id: string) => {
    const top = (annotations.find((item) => item.id === id) as Annotation & { annotationTop: number })
      .annotationTop;
    return { top };
  };
  return (
    // Mirrors the reader: the shared scroll root is .reading-scroll, so the
    // rail's scroll reflow path is the same one production uses.
    <div className="reading-scroll" style={{ height: "900px", overflow: "auto" }}>
    <div ref={layoutRef} className="pdf-original-layout" data-comment-rail="true">
      <div className="pdf-page-area" style={{ position: "relative", height: "1000px" }}>
        {/* Stand-in for the PDF page box so the demo reads like the reader. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 24,
            bottom: 0,
            left: 24,
            background: "#fff",
            boxShadow: "0 7px 28px rgba(34,30,24,.16)",
          }}
        />
        <div
          ref={anchorRef}
          style={{ position: "absolute", inset: 0, height: "1000px", pointerEvents: "none" }}
        >
          {Array.from({ length: 46 }, (_, index) => (
            <div
              key={`line-${index}`}
              style={{
                position: "absolute",
                left: "60px",
                right: "60px",
                top: `${60 + index * 18}px`,
                height: "7px",
                background: "rgba(32,39,41,.14)",
                borderRadius: "2px",
              }}
            />
          ))}
          {annotations.map((annotation) => (
            <span
              key={annotation.id}
              className="pdf-user-highlight pdf-user-highlight--highlight pdf-user-highlight--yellow pdf-user-highlight--lead"
              data-annotation-id={annotation.id}
              style={{
                position: "absolute",
                left: "60px",
                width: "300px",
                height: "16px",
                ...position(annotation.id),
              }}
            />
          ))}
        </div>
      </div>
      <PdfCommentRail
        anchorRootRef={anchorRef}
        layoutRootRef={layoutRef}
        threads={threads}
        messages={messages}
        authors={authors}
        annotations={annotations}
        activeAnnotationId="b-near"
        reflowKey="fixture"
        onActivate={(id) => console.log("activate", id)}
        onReply={async (threadId, body) => console.log("reply", threadId, body)}
      />
    </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("comment-rail-fixture")!).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
