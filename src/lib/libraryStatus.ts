import type { DocumentInfo, IndexProgress } from "./backend";

export interface LibraryStatusDetailInput {
  isWeb: boolean;
  searchQuery: string;
  searchResultCount: number;
  indexProgress: IndexProgress | null;
  documents: DocumentInfo[];
}

/** Compact footer line under the document count in the library sidebar. */
export function buildLibraryStatusDetail(input: LibraryStatusDetailInput): string {
  const query = input.searchQuery.trim();
  if (query) {
    return `${input.searchResultCount} 条搜索结果`;
  }

  const progress = input.indexProgress;
  if (progress && progress.completed < progress.total) {
    return `索引 ${progress.completed}/${progress.total} · 部分 ${progress.partial} · 失败 ${progress.failed}`;
  }

  if (input.documents.length === 0) {
    return input.isWeb ? "GitHub Pages · 公开阅读" : "选择文件夹开始阅读";
  }

  let markdown = 0;
  let pdf = 0;
  let epub = 0;
  let partial = 0;
  let failed = 0;
  for (const document of input.documents) {
    if (document.format === "pdf") pdf += 1;
    else if (document.format === "epub") epub += 1;
    else markdown += 1;

    if (document.indexStatus === "partial") partial += 1;
    else if (document.indexStatus === "failed" || document.indexStatus === "unsupported") {
      failed += 1;
    }
  }

  const parts: string[] = [];
  if (markdown > 0) parts.push(`MD ${markdown}`);
  if (pdf > 0) parts.push(`PDF ${pdf}`);
  if (epub > 0) parts.push(`EPUB ${epub}`);
  if (partial > 0) parts.push(`部分 ${partial}`);
  if (failed > 0) parts.push(`失败 ${failed}`);
  return parts.join(" · ");
}
