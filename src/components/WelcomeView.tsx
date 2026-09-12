// D12：从 App.tsx 提取的欢迎页组件对（行为/hook 顺序不变，仅移动）。
import { BookOpen, FolderOpen, Search, ShieldCheck, X } from "lucide-react";
import { formatLastOpened, normalizeLibraryPathKey, type LibraryMruEntry } from "../lib/libraryMru";

/** 欢迎页"最近打开"列表（plan-library-mru §2.2）：桌面专属。 */
export function WelcomeRecentLibraries({
  entries,
  unavailableKeys,
  onOpen,
  onRemove,
}: {
  entries: LibraryMruEntry[];
  unavailableKeys: ReadonlySet<string>;
  onOpen: (entry: LibraryMruEntry) => void;
  onRemove: (path: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="welcome-recent">
      <p className="welcome-recent-title" id="welcome-recent-title">
        最近打开
      </p>
      <ul className="welcome-recent-list" aria-labelledby="welcome-recent-title">
        {entries.map((entry) => {
          const missing = unavailableKeys.has(normalizeLibraryPathKey(entry.path));
          const meta = [
            entry.documentCount !== null ? `${entry.documentCount.toLocaleString()} 篇` : null,
            formatLastOpened(entry.lastOpenedAt),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li
              className={`welcome-recent-item${missing ? " welcome-recent-item--missing" : ""}`}
              key={normalizeLibraryPathKey(entry.path)}
            >
              <button
                className="welcome-recent-open"
                type="button"
                disabled={missing}
                title={missing ? "路径不可访问" : entry.path}
                onClick={() => onOpen(entry)}
              >
                <span className="welcome-recent-name">{entry.title}</span>
                <span className="welcome-recent-path">{entry.path}</span>
                {(missing || meta) && (
                  <span className="welcome-recent-meta">
                    {missing ? "路径不可访问" : meta}
                  </span>
                )}
              </button>
              <button
                className="icon-button welcome-recent-remove"
                type="button"
                aria-label={`从最近书库中移除 ${entry.title}`}
                title="从列表中移除"
                onClick={() => onRemove(entry.path)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Welcome({
  hasLibrary,
  documentCount,
  onOpen,
  isWeb,
  recentLibraries = [],
  unavailableKeys = new Set<string>(),
  onOpenRecent,
  onRemoveRecent,
}: {
  hasLibrary: boolean;
  documentCount: number;
  onOpen: () => void;
  isWeb: boolean;
  recentLibraries?: LibraryMruEntry[];
  unavailableKeys?: ReadonlySet<string>;
  onOpenRecent?: (entry: LibraryMruEntry) => void;
  onRemoveRecent?: (path: string) => void;
}) {
  return (
    <section className="welcome" aria-labelledby="welcome-title">
      <div className="welcome-card">
        <div className="welcome-eyebrow">
          {isWeb ? "Published reading" : "Local-first reading"}
        </div>
        <h1 id="welcome-title">
          {hasLibrary
            ? "文档库已经就绪。"
            : isWeb
              ? "正在打开在线文档。"
              : "把屏幕，重新留给文字。"}
        </h1>
        <p className="welcome-lead">
          {hasLibrary
            ? documentCount > 0
              ? `已发现 ${documentCount.toLocaleString()} 篇 Markdown 文档，正在打开第一篇。`
              : "这个文件夹中暂时没有 Markdown 文档，可以换一个文件夹继续。"
            : isWeb
              ? "Reade Web 从 GitHub Pages 按需读取公开 Markdown，并保留桌面版的排版、目录、检索与安全渲染体验。"
              : "Reade 专注本地长文的阅读体验。选择一个文件夹，即可在不上传内容、不依赖网络的前提下浏览、检索与阅读。"}
        </p>
        <div className="welcome-actions">
          <button className="primary-button" type="button" onClick={onOpen}>
            <FolderOpen size={17} aria-hidden="true" />
            {isWeb
              ? "重新加载在线文档"
              : hasLibrary
                ? "更换文档库"
                : "选择文档文件夹"}
          </button>
          <span
            className="secondary-button"
            aria-label={isWeb ? "由 GitHub Pages 发布" : "快捷键 Control O"}
          >
            {isWeb ? "GitHub Pages" : "Ctrl + O"}
          </span>
        </div>
        {!isWeb && onOpenRecent && onRemoveRecent && (
          <WelcomeRecentLibraries
            entries={recentLibraries}
            unavailableKeys={unavailableKeys}
            onOpen={onOpenRecent}
            onRemove={onRemoveRecent}
          />
        )}
        <div className="welcome-features" aria-label="核心能力">
          <div className="welcome-feature">
            <span className="welcome-feature-icon">
              <BookOpen size={15} aria-hidden="true" />
            </span>
            <strong>长文优先</strong>
            <p>稳定版心、章节目录与阅读进度，让技术文档也有书页般的节奏。</p>
          </div>
          <div className="welcome-feature">
            <span className="welcome-feature-icon">
              <Search size={15} aria-hidden="true" />
            </span>
            <strong>{isWeb ? "静态检索" : "本地检索"}</strong>
            <p>
              {isWeb
                ? "搜索数据随站点构建生成，浏览器按需加载并快速定位标题和正文。"
                : "索引留在电脑中，快速定位大型文档库里的标题和正文。"}
            </p>
          </div>
          <div className="welcome-feature">
            <span className="welcome-feature-icon">
              <ShieldCheck size={15} aria-hidden="true" />
            </span>
            <strong>默认安全</strong>
            <p>不执行原始 HTML；危险协议和越界资源默认拦截。</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * 侧栏书库名点击弹出的最近书库菜单（plan-library-mru §2.3，MR-D3）。
 * 打开动作复用 openLibrary 的全部校验；"选择新文件夹…"直达原对话框。
 */
