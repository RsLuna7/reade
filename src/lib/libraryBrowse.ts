import type { CollectionItem, DocumentFormat, DocumentInfo } from "./backend";
import { isMarkedRead, type LibraryReadMarks } from "./readMarks";
import { highWaterCoverage } from "./readingTimeEstimate";
import type { ReadingPosition } from "./readingPositions";
import { documentTreeName, isDocumentUnderDirectory, treePathCollator } from "./tree";

/** Cover tile logical width in the library grid (px). Independent of reader font size. */
export const LIBRARY_COVER_SIZE_MIN = 130;
export const LIBRARY_COVER_SIZE_MAX = 230;
export const LIBRARY_COVER_SIZE_DEFAULT = 170;

export type HomeSurface = "today" | "library";
export type LibrarySortKey = "recent" | "title" | "progress";
export type LibraryReadStatus = "new" | "reading" | "read";

export type LibraryBrowseScope =
  | { kind: "all" }
  | { kind: "folder"; path: string }
  | { kind: "shelf"; id: string };

export const ALL_LIBRARY_SCOPE: LibraryBrowseScope = { kind: "all" };

export function clampLibraryCoverSize(
  value: unknown,
  fallback = LIBRARY_COVER_SIZE_DEFAULT,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(
    Math.min(LIBRARY_COVER_SIZE_MAX, Math.max(LIBRARY_COVER_SIZE_MIN, value)),
  );
}

export function normalizeHomeSurface(
  value: unknown,
  fallback: HomeSurface = "today",
): HomeSurface {
  return value === "today" || value === "library" ? value : fallback;
}

export function normalizeLibrarySortKey(
  value: unknown,
  fallback: LibrarySortKey = "recent",
): LibrarySortKey {
  return value === "recent" || value === "title" || value === "progress" ? value : fallback;
}

export function normalizeLibraryReadStatus(
  value: unknown,
): LibraryReadStatus | "" {
  return value === "new" || value === "reading" || value === "read" ? value : "";
}

export function normalizeLibraryFormatFilter(value: unknown): DocumentFormat | "" {
  return value === "markdown" || value === "mdx" || value === "pdf" || value === "epub"
    ? value
    : "";
}

export function normalizeLibraryBrowseScope(value: unknown): LibraryBrowseScope {
  if (!value || typeof value !== "object") return ALL_LIBRARY_SCOPE;
  const candidate = value as { kind?: unknown; path?: unknown; id?: unknown };
  if (candidate.kind === "folder" && typeof candidate.path === "string" && candidate.path) {
    return { kind: "folder", path: candidate.path };
  }
  if (candidate.kind === "shelf" && typeof candidate.id === "string" && candidate.id) {
    return { kind: "shelf", id: candidate.id };
  }
  return ALL_LIBRARY_SCOPE;
}

export function inferDocumentFormat(relativePath: string): DocumentFormat {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".epub")) return "epub";
  if (lower.endsWith(".mdx")) return "mdx";
  return "markdown";
}

export function placeholderLibraryDocument(relativePath: string): DocumentInfo {
  return {
    relativePath,
    title: "",
    size: 0,
    modified: 0,
    format: inferDocumentFormat(relativePath),
    indexStatus: "failed",
    indexError: "missing",
  };
}

export interface LibraryBrowseItem {
  document: DocumentInfo;
  present: boolean;
}

/**
 * Reading-status for library filters. Marked-read is independent of position:
 * reaching the last page never implies 已读, and marking 已读 never rewrites
 * the stored locator.
 */
export function libraryReadStatus(
  markedRead: boolean,
  position: ReadingPosition | null | undefined,
  segmentCount?: number | null,
): LibraryReadStatus {
  if (markedRead) return "read";
  if (!position) return "new";
  const coverage = highWaterCoverage(position, segmentCount);
  if (coverage !== null) return coverage >= 0.01 ? "reading" : "new";
  // PDF (or other page locators) without a reliable denominator: the user has
  // a real position, but we still must not invent a percentage.
  return "reading";
}

export function libraryStatusText(
  status: LibraryReadStatus,
  progressLabel: string | null,
): string {
  if (status === "read") return "已读";
  if (status === "new") return "未开始";
  if (!progressLabel) return "阅读中";
  if (progressLabel.endsWith("%") || progressLabel.startsWith("第")) {
    return progressLabel.startsWith("第") ? `读到${progressLabel}` : `读到 ${progressLabel}`;
  }
  return `读到 ${progressLabel}`;
}

export function matchesLibraryTitleQuery(title: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return title.toLowerCase().includes(needle);
}

/**
 * Scope the catalog. Folder and shelf replace each other; they never stack.
 * Title / format / status filters are applied by {@link filterLibraryBrowseItems}.
 */
export function collectScopedLibraryItems(
  orderedDocuments: readonly DocumentInfo[],
  scope: LibraryBrowseScope,
  shelfItems: readonly CollectionItem[] | null,
): LibraryBrowseItem[] {
  if (scope.kind === "shelf") {
    if (!shelfItems) return [];
    const present = new Map(
      orderedDocuments.map((document) => [document.relativePath, document]),
    );
    return shelfItems.map((item) => {
      const document = present.get(item.relativePath);
      return {
        document: document ?? placeholderLibraryDocument(item.relativePath),
        present: item.present && Boolean(document),
      };
    });
  }
  const scoped =
    scope.kind === "folder"
      ? orderedDocuments.filter((document) =>
          isDocumentUnderDirectory(document.relativePath, scope.path),
        )
      : orderedDocuments;
  return scoped.map((document) => ({ document, present: true }));
}

export interface LibraryBrowseFilterInput {
  titleQuery: string;
  format: DocumentFormat | "";
  status: LibraryReadStatus | "";
  readMarks: LibraryReadMarks;
  positions: Record<string, ReadingPosition>;
  segmentCount: (relativePath: string) => number | null | undefined;
}

export function filterLibraryBrowseItems(
  items: readonly LibraryBrowseItem[],
  input: LibraryBrowseFilterInput,
): LibraryBrowseItem[] {
  return items.filter((item) => {
    if (!item.present && input.status) return false;
    const title = documentTreeName(item.document);
    if (!matchesLibraryTitleQuery(title, input.titleQuery)) return false;
    if (input.format && item.document.format !== input.format) return false;
    if (input.status) {
      const status = libraryReadStatus(
        isMarkedRead(input.readMarks, item.document.relativePath),
        input.positions[item.document.relativePath],
        input.segmentCount(item.document.relativePath),
      );
      if (status !== input.status) return false;
    }
    return true;
  });
}

export interface LibraryBrowseSortInput {
  sort: LibrarySortKey;
  positions: Record<string, ReadingPosition>;
  segmentCount: (relativePath: string) => number | null | undefined;
}

function progressSortValue(
  item: LibraryBrowseItem,
  input: LibraryBrowseSortInput,
): number {
  if (!item.present) return -1;
  const coverage = highWaterCoverage(
    input.positions[item.document.relativePath],
    input.segmentCount(item.document.relativePath),
  );
  return coverage === null ? -1 : coverage;
}

export function sortLibraryBrowseItems(
  items: readonly LibraryBrowseItem[],
  input: LibraryBrowseSortInput,
): LibraryBrowseItem[] {
  const next = [...items];
  if (input.sort === "title") {
    next.sort((left, right) =>
      treePathCollator.compare(documentTreeName(left.document), documentTreeName(right.document)),
    );
    return next;
  }
  if (input.sort === "progress") {
    next.sort((left, right) => {
      const delta = progressSortValue(right, input) - progressSortValue(left, input);
      if (delta !== 0) return delta;
      return treePathCollator.compare(
        documentTreeName(left.document),
        documentTreeName(right.document),
      );
    });
    return next;
  }
  next.sort((left, right) => {
    const leftAt = input.positions[left.document.relativePath]?.updatedAt ?? 0;
    const rightAt = input.positions[right.document.relativePath]?.updatedAt ?? 0;
    if (rightAt !== leftAt) return rightAt - leftAt;
    return treePathCollator.compare(
      documentTreeName(left.document),
      documentTreeName(right.document),
    );
  });
  return next;
}

export function libraryRangeTitle(
  scope: LibraryBrowseScope,
  folderLabel: string | null,
  shelfName: string | null,
): string {
  if (scope.kind === "folder") return folderLabel ? `文件夹 / ${folderLabel}` : "文件夹";
  if (scope.kind === "shelf") return shelfName ?? "我的书架";
  return "全部图书";
}

export function libraryCountLabel(visible: number, total: number): string {
  if (visible === total) return `共 ${total} 篇文档`;
  return `显示 ${visible} / ${total} 篇文档`;
}
