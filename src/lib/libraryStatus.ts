import type { IndexProgress } from "./backend";

export interface LibraryStatusDetailInput {
  searchQuery: string;
  searchResultCount: number;
  indexProgress: IndexProgress | null;
}

/**
 * Compact footer line in the library sidebar.
 * 仅在搜索或索引进行中给出提示;平时底栏只留主题控件。
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

  return "";
}
