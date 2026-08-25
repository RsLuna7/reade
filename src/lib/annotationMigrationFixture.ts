/**
 * Frozen v5 → v6 semantic fixture.
 *
 * This module is imported by tests only. It deliberately contains no real
 * user paths or content and must never be imported by the production entry.
 * Rust mirrors the `MIG-*` cases in `user_store.rs` tests.
 */
import type { Annotation } from "./backend";
import type { ReviewState } from "./reviewScheduler";

export interface AnnotationMigrationReviewFixture {
  annotationId: string;
  state: ReviewState;
}

export interface AnnotationMigrationLibraryFixture {
  caseId: string;
  root: string;
  fingerprints: ReadonlyMap<string, string>;
  annotations: Annotation[];
  reviews: AnnotationMigrationReviewFixture[];
}

const markdownHighlight: Annotation = {
  id: "mig-md-highlight",
  relativePath: "notes/guide.md",
  kind: "highlight",
  color: "yellow",
  note: "这一段是整篇的核心。",
  selectedText: "阅读时只做安静的留痕",
  title: "用户保留的标题",
  locator: {
    kind: "markdown",
    quote: "阅读时只做安静的留痕",
    prefix: "一句话：",
    suffix: "；读完后再复盘。",
    headingId: "reading-flow",
    start: 128,
    end: 139,
  },
  sortIndex: "M|00000|00000128",
  createdAt: 1_000,
  updatedAt: 1_400,
  deletedAt: null,
};

const markdownPinkUnderline: Annotation = {
  id: "mig-md-pink",
  relativePath: "notes/guide.md",
  kind: "underline",
  color: "pink",
  note: null,
  selectedText: "旧粉色必须可以回滚",
  title: "旧粉色必须可以回滚",
  locator: {
    kind: "markdown",
    quote: "旧粉色必须可以回滚",
    prefix: "兼容要求：",
    suffix: "。",
    headingId: "migration",
  },
  sortIndex: "M|00000|00000000",
  createdAt: 1_100,
  updatedAt: 1_100,
  deletedAt: null,
};

const pdfOriginal: Annotation = {
  id: "mig-pdf-original",
  relativePath: "papers/layout.pdf",
  kind: "highlight",
  color: "green",
  note: null,
  selectedText: "The stored rectangle is only a fallback.",
  title: "The stored rectangle is only a fallback.",
  locator: {
    kind: "pdf",
    page: 12,
    view: "original",
    quote: "The stored rectangle is only a fallback.",
    prefix: "Anchor rule: ",
    suffix: " Never fake precision.",
    rects: [{ x: 0.1, y: 0.2, w: 0.42, h: 0.025 }],
    pageWidth: 595,
    pageHeight: 842,
  },
  sortIndex: "P|00012|00002000",
  createdAt: 1_200,
  updatedAt: 1_200,
  deletedAt: null,
};

const pdfReadingTombstone: Annotation = {
  id: "mig-pdf-reading-deleted",
  relativePath: "papers/layout.pdf",
  kind: "underline",
  color: "blue",
  note: "已删除记录仍要参与迁移对账。",
  selectedText: "Reading mode quote",
  title: "Reading mode quote",
  locator: {
    kind: "pdf",
    page: 15,
    view: "reading",
    quote: "Reading mode quote",
    prefix: "",
    suffix: "",
    rects: [],
  },
  sortIndex: "P|00015|00000000",
  createdAt: 1_300,
  updatedAt: 2_000,
  deletedAt: 2_000,
};

const epubUnderline: Annotation = {
  id: "mig-epub",
  relativePath: "books/reader.epub",
  kind: "underline",
  color: "blue",
  note: "章节变化后也要保住感悟。",
  selectedText: "章节级偏移是补充提示",
  title: "章节级偏移是补充提示",
  locator: {
    kind: "epub",
    chapterId: "OEBPS/chapter-2.xhtml",
    blockIndex: 7,
    startOffset: 3,
    endOffset: 12,
    quote: "章节级偏移是补充提示",
    prefix: "",
    suffix: "。",
    start: 640,
    end: 649,
  },
  sortIndex: "E|00002|00000640",
  createdAt: 1_500,
  updatedAt: 1_600,
  deletedAt: null,
};

const markdownBookmark: Annotation = {
  id: "mig-bookmark-md",
  relativePath: "notes/guide.md",
  kind: "bookmark",
  color: null,
  note: "书签也可能有旧笔记。",
  selectedText: null,
  title: "回到迁移章节",
  locator: {
    kind: "bookmark",
    target: { format: "markdown", headingId: "migration", scrollRatio: 0.72 },
  },
  sortIndex: "M|00000|72000000",
  createdAt: 1_700,
  updatedAt: 1_800,
  deletedAt: null,
};

const pdfBookmark: Annotation = {
  id: "mig-bookmark-pdf",
  relativePath: "papers/layout.pdf",
  kind: "bookmark",
  color: null,
  note: null,
  selectedText: null,
  title: "第 20 页",
  locator: {
    kind: "bookmark",
    target: { format: "pdf", page: 20, offsetRatio: 0.35 },
  },
  sortIndex: "P|00020|35000000",
  createdAt: 1_900,
  updatedAt: 1_900,
  deletedAt: null,
};

const secondRootAnnotation: Annotation = {
  ...markdownHighlight,
  id: "mig-second-root",
  relativePath: "private/other.md",
  note: null,
  title: "另一个文档库",
  createdAt: 2_100,
  updatedAt: 2_100,
};

export const ANNOTATION_MIGRATION_FIXTURE: AnnotationMigrationLibraryFixture[] = [
  {
    caseId: "MIG-A",
    root: "D:/fixture/library-a",
    fingerprints: new Map([
      ["notes/guide.md", "ntxt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ["papers/layout.pdf", "pmd5:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      ["books/reader.epub", "pmd5:cccccccccccccccccccccccccccccccc"],
    ]),
    annotations: [
      markdownHighlight,
      markdownPinkUnderline,
      pdfOriginal,
      pdfReadingTombstone,
      epubUnderline,
      markdownBookmark,
      pdfBookmark,
    ],
    reviews: [
      {
        annotationId: "mig-md-highlight",
        state: {
          box: 2,
          dueAt: 90_000,
          lastReviewedAt: 80_000,
          totalReviews: 3,
          suspended: false,
        },
      },
      {
        annotationId: "mig-epub",
        state: {
          box: 1,
          dueAt: 100_000,
          lastReviewedAt: 70_000,
          totalReviews: 1,
          suspended: true,
        },
      },
    ],
  },
  {
    caseId: "MIG-B",
    root: "D:/fixture/library-b",
    fingerprints: new Map([
      ["private/other.md", "ntxt:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"],
    ]),
    annotations: [secondRootAnnotation],
    reviews: [],
  },
];
