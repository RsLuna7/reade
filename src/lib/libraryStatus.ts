import type { DocumentInfo, IndexProgress } from "./backend";

export interface LibraryStatusDetailInput {
  isWeb: boolean;
  searchQuery: string;
  searchResultCount: number;
  indexProgress: IndexProgress | null;
  documents: DocumentInfo[];
}

/**
 * Compact footer line under the document count in the library sidebar.
 * 仅在瞬态(搜索、索引中)或空库时给出提示;平时不再显示格式统计,
 * 文档数量由上方的"N 篇文档"承担。
 */
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

  return "";
}
