import {
  useCallback,
  useEffect,
  lazy,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
  type ChangeEvent,
} from "react";
import {
  AlertCircle,
  BookOpen,
  Clock3,
  FolderOpen,
  Globe2,
  HardDrive,
  Library,
  ListTree,
  Moon,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Type,
  X,
} from "lucide-react";
import "./App.css";
import { DocumentTree } from "./components/DocumentTree";
import { EpubReader } from "./components/EpubReader";
import { MarkdownRenderer } from "./components/MarkdownRenderer";
import {
  APP_RUNTIME,
  DEFAULT_LIBRARY_ROOT,
  assetDataUrl,
  onDocumentIndexStatus,
  onLibraryChanged,
  onLibraryIndexProgress,
  openExternalLink,
  readAsset,
} from "./lib/backend";
import { extractToc, type TocItem } from "./lib/markdown";
import { buildWebRouteUrl, parseWebRoute } from "./lib/webRouting";
import { scrollElementWithinContainer } from "./lib/scroll";
import {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  useReaderStore,
  type ReaderFontFamily,
  type ReaderMotionLevel,
} from "./store/useReaderStore";
import { cancelMotion, runMotion } from "./lib/motion";

const LAST_LIBRARY_KEY = "reade-last-library";
const IS_WEB_RUNTIME = APP_RUNTIME === "web";
const EXTERNAL_PROTOCOL = /^(?:https?:|mailto:)/i;
const ABSOLUTE_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;
const PdfReader = lazy(() => import("./components/PdfReader").then((module) => ({ default: module.PdfReader })));

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);

  return matches;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatModified(value: number): string {
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return "修改时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function displayMarkdown(markdown: string): string {
  let content = markdown.replace(/^\uFEFF/, "");
  content = content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
  return content.replace(/^\s*#\s+[^\r\n]+(?:\r?\n|$)/, "").trimStart();
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveLibraryPath(source: string, documentPath: string): string | null {
  const pathOnly = decodePath(source.split(/[?#]/, 1)[0] ?? "")
    .trim()
    .replace(/\\/g, "/");
  if (!pathOnly || pathOnly.startsWith("//") || ABSOLUTE_PROTOCOL.test(pathOnly)) {
    return null;
  }

  const base = pathOnly.startsWith("/")
    ? []
    : documentPath.replace(/\\/g, "/").split("/").slice(0, -1);

  for (const segment of pathOnly.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (base.length === 0) return null;
      base.pop();
    } else {
      base.push(segment);
    }
  }

  return base.join("/");
}

function referencedImages(markdown: string): string[] {
  const sources = new Set<string>();
  const imagePattern = /!\[[^\]]*]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of markdown.matchAll(imagePattern)) {
    if (match[1]) sources.add(match[1]);
  }
  return [...sources];
}

function Welcome({
  hasLibrary,
  documentCount,
  onOpen,
  isWeb,
}: {
  hasLibrary: boolean;
  documentCount: number;
  onOpen: () => void;
  isWeb: boolean;
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

export function MotionNotice({
  id,
  message,
  kind = "status",
  motionLevel,
  autoDismiss = false,
  onClose,
}: {
  id: number | string;
  message: string;
  kind?: "status" | "error";
  motionLevel: ReaderMotionLevel;
  autoDismiss?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);

  const closeWithMotion = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const element = ref.current;
    if (!element || motionLevel === "off") {
      onClose();
      return;
    }
    const scale = motionLevel === "full" ? 0.98 : 0.99;
    const animation = runMotion(
      element,
      "notice-exit",
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: `scale(${scale})` },
      ],
      {
        duration: motionLevel === "full" ? 220 : 180,
        easing: "cubic-bezier(0.4, 0, 1, 1)",
        fill: "forwards",
      },
      motionLevel,
    );
    if (!animation) {
      onClose();
      return;
    }
    void animation.finished.then(onClose).catch(() => undefined);
  }, [motionLevel, onClose]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    closingRef.current = false;
    const scale = motionLevel === "full" ? 0.98 : 0.99;
    runMotion(
      element,
      "notice-enter",
      [
        { opacity: 0, transform: `scale(${scale})` },
        { opacity: 1, transform: "scale(1)" },
      ],
      {
        duration: motionLevel === "full" ? 220 : 180,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
      motionLevel,
    );
    return () => cancelMotion(element);
  }, [id, motionLevel]);

  useEffect(() => {
    if (!autoDismiss) return;
    const timer = window.setTimeout(closeWithMotion, 4200);
    return () => window.clearTimeout(timer);
  }, [autoDismiss, closeWithMotion, id]);

  return (
    <div ref={ref} className={`notice${kind === "error" ? " error" : ""}`} role={kind === "error" ? "alert" : "status"}>
      {kind === "error" ? <AlertCircle size={17} aria-hidden="true" /> : <ShieldCheck size={17} aria-hidden="true" />}
      <span>{message}</span>
      {kind === "error" && (
        <button className="icon-button" type="button" onClick={closeWithMotion} aria-label="关闭错误提示">
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ReadingSettingsPanel({
  open,
  onClose,
  onNotice,
}: {
  open: boolean;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const settings = useReaderStore((state) => state.readingSettings);
  const update = useReaderStore((state) => state.updateReadingSettings);
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const setMotionLevel = useReaderStore((state) => state.setMotionLevel);
  const resetReaderPreferences = useReaderStore((state) => state.resetReaderPreferences);
  const clearDocumentCache = useReaderStore((state) => state.clearDocumentCache);
  const [clearingCache, setClearingCache] = useState(false);

  const numericSetting =
    (key: "fontSize" | "lineHeight" | "contentWidth" | "paragraphSpacing") =>
    (event: ChangeEvent<HTMLInputElement>) => {
      update({ [key]: Number(event.target.value) });
    };

  return (
    <div
      className="settings-popover reade-motion-panel"
      role="dialog"
      aria-label="阅读设置"
      aria-hidden={!open}
      data-open={open}
      inert={!open}
    >
      <div className="settings-heading">
        <span>阅读设置</span>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭阅读设置">
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <label className="setting-row">
        <span className="setting-label">
          <span>正文字号</span>
          <span className="setting-value">{settings.fontSize}px</span>
        </span>
        <input
          type="range"
          min="13"
          max="26"
          step="1"
          value={settings.fontSize}
          onChange={numericSetting("fontSize")}
        />
      </label>

      <label className="setting-row">
        <span className="setting-label">
          <span>正文行高</span>
          <span className="setting-value">{settings.lineHeight.toFixed(2)}</span>
        </span>
        <input
          type="range"
          min="1.4"
          max="2.4"
          step="0.05"
          value={settings.lineHeight}
          onChange={numericSetting("lineHeight")}
        />
      </label>

      <label className="setting-row">
        <span className="setting-label">
          <span>最大正文宽度</span>
          <span className="setting-value">
            {settings.contentWidth >= CONTENT_WIDTH_MAX
              ? "随窗口"
              : `${settings.contentWidth}px`}
          </span>
        </span>
        <input
          type="range"
          min={CONTENT_WIDTH_MIN}
          max={CONTENT_WIDTH_MAX}
          step="20"
          value={settings.contentWidth}
          onChange={numericSetting("contentWidth")}
        />
      </label>

      <label className="setting-row">
        <span className="setting-label">
          <span>段落间距</span>
          <span className="setting-value">{settings.paragraphSpacing.toFixed(1)}×</span>
        </span>
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={settings.paragraphSpacing}
          onChange={numericSetting("paragraphSpacing")}
        />
      </label>

      <label className="setting-row">
        <span className="setting-label">字体风格</span>
        <select
          className="setting-select"
          value={settings.fontFamily}
          onChange={(event) =>
            update({ fontFamily: event.target.value as ReaderFontFamily })
          }
        >
          <option value="system">系统均衡</option>
          <option value="sans">清晰无衬线</option>
          <option value="serif">书刊衬线</option>
        </select>
      </label>

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">动态效果</legend>
        <div className="motion-level-control" role="group" aria-label="动态效果级别">
          {([
            ["off", "关闭"],
            ["subtle", "克制"],
            ["full", "完整"],
          ] as const).map(([level, label]) => (
            <button
              type="button"
              key={level}
              aria-pressed={motionLevel === level}
              className={motionLevel === level ? "active" : undefined}
              onClick={() => setMotionLevel(level)}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <button
        className="settings-reset"
        type="button"
        onClick={resetReaderPreferences}
      >
        <RotateCcw size={13} aria-hidden="true" />
        恢复默认
      </button>
      {!IS_WEB_RUNTIME && <button
        className="settings-reset settings-cache-clear"
        type="button"
        disabled={clearingCache}
        onClick={() => {
          if (clearingCache) return;
          setClearingCache(true);
          void clearDocumentCache().then((succeeded) => {
            if (succeeded) onNotice("文档索引缓存已清理，将在后台重新建立索引。");
          }).finally(() => setClearingCache(false));
        }}
      >
        <RotateCcw size={13} aria-hidden="true" />
        {clearingCache ? "正在清理缓存…" : "清理文档索引缓存"}
      </button>}
    </div>
  );
}

function TocNavigation({
  items,
  activeId,
  onSelect,
}: {
  items: TocItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="toc-inner">
      <p className="toc-label">
        <ListTree size={13} aria-hidden="true" />
        本文目录
      </p>
      {items.length ? (
        <ol className="toc-list">
          {items.map((item) => (
            <li key={item.id}>
              <a
                className={`toc-link${activeId === item.id ? " active" : ""}`}
                style={{ "--toc-depth": item.level } as CSSProperties}
                href={`#${item.id}`}
                aria-current={activeId === item.id ? "location" : undefined}
                title={item.title}
                onClick={(event) => {
                  event.preventDefault();
                  onSelect(item.id);
                }}
              >
                {item.title}
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <p className="toc-empty">这篇文档没有可导航的标题。</p>
      )}
    </div>
  );
}

function App() {
  const snapshot = useReaderStore((state) => state.snapshot);
  const documents = useReaderStore((state) => state.documents);
  const currentPath = useReaderStore((state) => state.currentPath);
  const currentContent = useReaderStore((state) => state.currentContent);
  const currentLocator = useReaderStore((state) => state.currentLocator);
  const indexProgress = useReaderStore((state) => state.indexProgress);
  const searchQuery = useReaderStore((state) => state.searchQuery);
  const searchResults = useReaderStore((state) => state.searchResults);
  const theme = useReaderStore((state) => state.theme);
  const readingSettings = useReaderStore((state) => state.readingSettings);
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const loading = useReaderStore((state) => state.loading);
  const error = useReaderStore((state) => state.error);
  const chooseAndOpenLibrary = useReaderStore((state) => state.chooseAndOpenLibrary);
  const openLibrary = useReaderStore((state) => state.openLibrary);
  const refreshLibrary = useReaderStore((state) => state.refreshLibrary);
  const selectDocument = useReaderStore((state) => state.selectDocument);
  const setSearchQuery = useReaderStore((state) => state.setSearchQuery);
  const runSearch = useReaderStore((state) => state.runSearch);
  const toggleTheme = useReaderStore((state) => state.toggleTheme);
  const clearError = useReaderStore((state) => state.clearError);
  const applyDocumentIndexStatus = useReaderStore((state) => state.applyDocumentIndexStatus);
  const setIndexProgress = useReaderStore((state) => state.setIndexProgress);
  const retryCurrentDocumentIndex = useReaderStore((state) => state.retryCurrentDocumentIndex);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [compactTocOpen, setCompactTocOpen] = useState(false);
  const [mobileLibraryOpen, setMobileLibraryOpen] = useState(false);
  const [tocState, setTocState] = useState<{ path: string; items: TocItem[] } | null>(null);
  const [activeHeadingState, setActiveHeadingState] = useState<{ path: string; id: string | null } | null>(null);
  const [progress, setProgress] = useState(0);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);
  const compactLibraryLayout = useMediaQuery("(max-width: 640px)");
  const readerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const statusDetailRef = useRef<HTMLSpanElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const noticeSequence = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const initialWebRoute = useRef(
    IS_WEB_RUNTIME ? parseWebRoute(window.location) : null,
  );
  const requestedWebDocument = useRef(
    initialWebRoute.current?.documentPath ?? null,
  );
  const pendingHash = useRef<string | null>(
    initialWebRoute.current?.heading ?? null,
  );
  const restoredLibrary = useRef(false);

  const currentDocument = useMemo(
    () => documents.find((document) => document.relativePath === currentPath) ?? null,
    [currentPath, documents],
  );
  const renderedMarkdown = useMemo(
    () => displayMarkdown(currentContent?.kind === "markdown" ? currentContent.markdown : ""),
    [currentContent],
  );
  const toc = tocState?.path === currentPath ? tocState.items : [];
  const activeHeading = activeHeadingState?.path === currentPath ? activeHeadingState.id : null;
  const handleTocChange = useCallback((items: TocItem[]) => {
    if (currentPath) setTocState({ path: currentPath, items });
  }, [currentPath]);
  const handleActiveHeadingChange = useCallback((id: string | null) => {
    if (currentPath) setActiveHeadingState({ path: currentPath, id });
  }, [currentPath]);

  const readerStyle = {
    "--reader-font-size": `${readingSettings.fontSize}px`,
    "--reader-line-height": readingSettings.lineHeight,
    "--reader-measure":
      readingSettings.contentWidth >= CONTENT_WIDTH_MAX
        ? "none"
        : `${readingSettings.contentWidth}px`,
    "--reader-paragraph-spacing": readingSettings.paragraphSpacing,
    "--reader-font-family":
      readingSettings.fontFamily === "serif"
        ? '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif'
        : readingSettings.fontFamily === "sans"
          ? '"Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", sans-serif'
          : '"Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", sans-serif',
  } as CSSProperties;

  const showNotice = useCallback((message: string) => {
    noticeSequence.current += 1;
    setNotice({ id: noticeSequence.current, message });
  }, []);

  const dismissNotice = useCallback((id: number) => {
    setNotice((current) => (current?.id === id ? null : current));
  }, []);
  const closeCurrentNotice = useCallback(() => {
    if (notice) dismissNotice(notice.id);
  }, [dismissNotice, notice]);

  const replaceWebRoute = useCallback(
    (relativePath: string, heading?: string | null) => {
      if (!IS_WEB_RUNTIME) return;
      try {
        const nextUrl = buildWebRouteUrl(window.location.href, relativePath, heading);
        window.history.replaceState(null, "", nextUrl);
      } catch {
        showNotice("无法生成安全的分享链接，已保留当前页面。");
      }
    },
    [showNotice],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    themeColor?.setAttribute("content", theme === "dark" ? "#1e2222" : "#f5f1e8");
  }, [theme]);

  useLayoutEffect(() => {
    document.documentElement.dataset.motion = motionLevel;
  }, [motionLevel]);

  useEffect(() => {
    if (restoredLibrary.current) return;
    restoredLibrary.current = true;
    if (IS_WEB_RUNTIME) {
      void openLibrary(DEFAULT_LIBRARY_ROOT);
      return;
    }
    const previousLibrary = localStorage.getItem(LAST_LIBRARY_KEY);
    if (previousLibrary) void openLibrary(previousLibrary);
  }, [openLibrary]);

  useEffect(() => {
    if (IS_WEB_RUNTIME) return;
    if (snapshot?.rootPath) localStorage.setItem(LAST_LIBRARY_KEY, snapshot.rootPath);
  }, [snapshot?.rootPath]);

  useEffect(() => {
    if (!snapshot || IS_WEB_RUNTIME) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let refreshTimer: number | undefined;

    void onLibraryChanged(() => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refreshLibrary(), 280);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      unlisten?.();
    };
  }, [refreshLibrary, snapshot]);

  useEffect(() => {
    if (IS_WEB_RUNTIME || !snapshot) return;
    let disposed = false;
    const stops: Array<() => void> = [];
    void onLibraryIndexProgress(setIndexProgress).then((stop) => disposed ? stop() : stops.push(stop));
    void onDocumentIndexStatus(applyDocumentIndexStatus).then((stop) => disposed ? stop() : stops.push(stop));
    return () => { disposed = true; stops.forEach((stop) => stop()); };
  }, [applyDocumentIndexStatus, setIndexProgress, snapshot]);

  useEffect(() => {
    if (snapshot && documents.length > 0 && !currentPath && !loading) {
      const requestedPath = requestedWebDocument.current;
      requestedWebDocument.current = null;
      const requestedDocument = requestedPath
        ? documents.find(
            (document) =>
              document.relativePath.replace(/\\/g, "/") === requestedPath,
          )
        : null;
      if (requestedPath && !requestedDocument) pendingHash.current = null;
      void selectDocument(
        requestedDocument?.relativePath ?? documents[0].relativePath,
      );
    }
  }, [currentPath, documents, loading, selectDocument, snapshot]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query || !snapshot) return;
    const timer = window.setTimeout(() => void runSearch(query), 240);
    return () => window.clearTimeout(timer);
  }, [runSearch, searchQuery, snapshot]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        if (event.key === "Escape") {
          setSettingsOpen(false);
          setCompactTocOpen(false);
          setMobileLibraryOpen(false);
        }
        return;
      }
      if (event.key.toLowerCase() === "o") {
        if (IS_WEB_RUNTIME) return;
        event.preventDefault();
        void chooseAndOpenLibrary();
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseAndOpenLibrary]);

  useEffect(() => {
    if (!currentContent || currentContent.kind !== "markdown" || !currentPath) {
      setAssetUrls({});
      return;
    }

    let cancelled = false;
    setAssetUrls({});
    const sources = referencedImages(currentContent.markdown);
    for (const source of sources) {
      if (source.startsWith("data:") || EXTERNAL_PROTOCOL.test(source)) continue;
      const relativePath = resolveLibraryPath(source, currentPath);
      if (!relativePath) continue;
      void readAsset(relativePath)
        .then((asset) => {
          if (!cancelled) {
            setAssetUrls((current) => ({ ...current, [source]: assetDataUrl(asset) }));
          }
        })
        .catch(() => {
          // Missing and out-of-library images stay visibly blocked in the document.
        });
    }

    return () => {
      cancelled = true;
    };
  }, [currentContent, currentPath]);

  useEffect(() => {
    const article = articleRef.current;
    if (!article || currentContent?.kind !== "markdown" || !currentPath) return;
    const nextToc = extractToc(article);
    setTocState({ path: currentPath, items: nextToc });
    setActiveHeadingState({ path: currentPath, id: nextToc[0]?.id ?? null });
  }, [currentContent, currentPath, renderedMarkdown]);

  useLayoutEffect(() => {
    const reader = readerRef.current;
    if (!reader || !currentPath) return;
    reader.scrollTop = scrollPositions.current.get(currentPath) ?? 0;
    setProgress(
      reader.scrollHeight <= reader.clientHeight
        ? 0
        : (reader.scrollTop / (reader.scrollHeight - reader.clientHeight)) * 100,
    );
  }, [currentPath, currentContent]);

  useEffect(() => {
    if (!IS_WEB_RUNTIME || !currentPath) return;
    replaceWebRoute(currentPath, pendingHash.current);
    if (currentDocument) {
      document.title = `${currentDocument.title} · ${snapshot?.rootPath ?? "Reade"}`;
    }
  }, [currentDocument, currentPath, replaceWebRoute, snapshot?.rootPath]);

  useEffect(() => {
    if (currentContent?.kind !== "markdown" || !pendingHash.current) return;
    const id = pendingHash.current;
    pendingHash.current = null;
    window.requestAnimationFrame(() => {
      const target = articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null;
      scrollElementWithinContainer(
        readerRef.current,
        target,
        motionLevel === "off" ? "auto" : "smooth",
      );
    });
  }, [currentContent, motionLevel]);

  useEffect(() => {
    setCompactTocOpen(false);
    setMobileLibraryOpen(false);
  }, [currentPath]);

  const handleReaderScroll = useCallback(() => {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = null;
      const reader = readerRef.current;
      const article = articleRef.current;
      if (!reader || !article) return;
      if (currentPath) scrollPositions.current.set(currentPath, reader.scrollTop);

      const range = reader.scrollHeight - reader.clientHeight;
      setProgress(range <= 0 ? 0 : Math.min(100, (reader.scrollTop / range) * 100));

      if (currentContent?.kind !== "markdown") return;
      const headings = Array.from(
        article.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]"),
      );
      const threshold = reader.getBoundingClientRect().top + 126;
      let nextActive = headings[0]?.id ?? null;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top <= threshold) nextActive = heading.id;
        else break;
      }
      if (currentPath) setActiveHeadingState({ path: currentPath, id: nextActive });
    });
  }, [currentContent?.kind, currentPath]);

  useEffect(
    () => () => {
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );

  const resolveImageSrc = useCallback(
    (source: string) => {
      if (source.startsWith("data:image/")) return source;
      if (EXTERNAL_PROTOCOL.test(source)) return null;
      return assetUrls[source] ?? null;
    },
    [assetUrls],
  );

  const handleNavigate = useCallback(
    async (href: string) => {
      if (href.startsWith("#")) {
        const id = decodePath(href.slice(1));
        const target = articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null;
        scrollElementWithinContainer(
          readerRef.current,
          target,
          motionLevel === "off" ? "auto" : "smooth",
        );
        if (currentPath) replaceWebRoute(currentPath, id);
        return;
      }

      if (EXTERNAL_PROTOCOL.test(href)) {
        if (window.confirm(`将在系统应用中打开外部链接：\n\n${href}\n\n是否继续？`)) {
          try {
            await openExternalLink(href);
          } catch (linkError) {
            showNotice(linkError instanceof Error ? linkError.message : "外部链接打开失败");
          }
        }
        return;
      }

      if (!currentPath) return;
      const [pathPart, hash] = href.split("#", 2);
      const targetPath = resolveLibraryPath(pathPart, currentPath);
      const target = documents.find(
        (document) => document.relativePath.replace(/\\/g, "/") === targetPath,
      );
      if (!target) {
        showNotice("目标不在当前 Markdown 文档库中，已阻止打开。");
        return;
      }
      pendingHash.current = hash ? decodePath(hash) : null;
      if (IS_WEB_RUNTIME) replaceWebRoute(target.relativePath, pendingHash.current);
      await selectDocument(target.relativePath);
    },
    [currentPath, documents, motionLevel, replaceWebRoute, selectDocument, showNotice],
  );

  const scrollToHeading = useCallback((id: string) => {
    const target = articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null;
    scrollElementWithinContainer(
      readerRef.current,
      target,
      currentContent?.kind === "pdf" || motionLevel === "off" ? "auto" : "smooth",
    );
    if (currentPath) replaceWebRoute(currentPath, id);
    setCompactTocOpen(false);
  }, [currentContent?.kind, currentPath, motionLevel, replaceWebRoute]);

  const libraryName = snapshot
    ? IS_WEB_RUNTIME
      ? snapshot.rootPath
      : fileName(snapshot.rootPath)
    : IS_WEB_RUNTIME
      ? "在线文档库"
      : "选择文档库";
  const pathParts = currentPath?.replace(/\\/g, "/").split("/") ?? [];
  const statusDetail = searchQuery
    ? `${searchResults.length} 条搜索结果`
    : indexProgress && indexProgress.completed < indexProgress.total
      ? `索引 ${indexProgress.completed}/${indexProgress.total} · 部分 ${indexProgress.partial} · 失败 ${indexProgress.failed}`
      : IS_WEB_RUNTIME
        ? "GitHub Pages · 公开阅读"
        : "完全本地 · 离线可用";

  useEffect(() => {
    const element = statusDetailRef.current;
    if (!element || motionLevel !== "full") return;
    runMotion(
      element,
      "status-change",
      [{ opacity: 0.46 }, { opacity: 1 }],
      { duration: 150, easing: "ease-out" },
      motionLevel,
    );
    return () => cancelMotion(element, "status-change");
  }, [motionLevel, statusDetail]);

  const handleRetryIndex = useCallback(async () => {
    const succeeded = await retryCurrentDocumentIndex();
    if (succeeded) {
      showNotice("已将当前文档重新加入索引队列。");
      return;
    }
    const button = retryButtonRef.current;
    if (!button || motionLevel !== "full") return;
    runMotion(
      button,
      "retry-failed",
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-2px)" },
        { transform: "translateX(2px)" },
        { transform: "translateX(-2px)" },
        { transform: "translateX(0)" },
      ],
      { duration: 220, easing: "ease-in-out" },
      motionLevel,
    );
  }, [motionLevel, retryCurrentDocumentIndex, showNotice]);

  return (
    <div className="reader-shell" data-motion={motionLevel} style={readerStyle}>
      <aside
        className="library-sidebar"
        aria-label="文档库"
        aria-hidden={compactLibraryLayout && !mobileLibraryOpen}
        data-open={mobileLibraryOpen}
        inert={compactLibraryLayout && !mobileLibraryOpen}
      >
        <header className="sidebar-header">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">R</div>
            <div className="brand-copy">
              <p className="brand-name">Reade</p>
              <p className="brand-tagline">
                {IS_WEB_RUNTIME ? "Published Reader" : "Local Reader"}
              </p>
            </div>
          </div>

          <div className="library-row">
            <button
              className="library-button"
              type="button"
              onClick={() =>
                void (IS_WEB_RUNTIME ? refreshLibrary() : chooseAndOpenLibrary())
              }
              title={
                IS_WEB_RUNTIME
                  ? "重新加载在线文档"
                  : snapshot?.rootPath ?? "选择文档文件夹"
              }
            >
              {IS_WEB_RUNTIME ? (
                <Globe2 size={15} aria-hidden="true" />
              ) : (
                <Library size={15} aria-hidden="true" />
              )}
              <span className="library-button-copy">{libraryName}</span>
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="刷新文档库"
              title="刷新文档库"
              disabled={!snapshot || loading}
              onClick={() => void refreshLibrary()}
            >
              <RefreshCw size={15} className={loading ? "spin-icon" : undefined} aria-hidden="true" />
            </button>
          </div>

          <div className="search-box">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              className="search-input"
              type="search"
              value={searchQuery}
              disabled={!snapshot}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void runSearch();
              }}
              placeholder="搜索标题与正文"
              aria-label="搜索文档"
            />
            {!searchQuery && <span className="search-shortcut">Ctrl K</span>}
          </div>
        </header>

        <div className="sidebar-content">
          <DocumentTree />
        </div>

        <footer className="sidebar-footer">
          <div className="sidebar-status">
            <strong>{snapshot ? `${documents.length.toLocaleString()} 篇文档` : "尚未打开文档库"}</strong>
            <span ref={statusDetailRef}>{statusDetail}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={theme === "light" ? "切换到深色主题" : "切换到浅色主题"}
            title={theme === "light" ? "深色主题" : "浅色主题"}
            onClick={toggleTheme}
          >
            <span className="theme-state-icon" aria-hidden="true">
              <Moon className={theme === "light" ? "active" : undefined} size={16} />
              <Sun className={theme === "dark" ? "active" : undefined} size={16} />
            </span>
          </button>
        </footer>
      </aside>

      <button
        className="sidebar-drawer-backdrop reade-motion-backdrop"
        type="button"
        aria-label="关闭文档库"
        aria-hidden={!mobileLibraryOpen}
        data-open={mobileLibraryOpen}
        tabIndex={mobileLibraryOpen ? 0 : -1}
        onClick={() => setMobileLibraryOpen(false)}
      />

      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb" aria-label="当前文档路径">
            {IS_WEB_RUNTIME ? (
              <Globe2 size={14} aria-hidden="true" />
            ) : (
              <HardDrive size={14} aria-hidden="true" />
            )}
            <span>{libraryName}</span>
            {pathParts.map((part, index) => (
              <span className={index === pathParts.length - 1 ? "current" : undefined} key={`${part}-${index}`}>
                <span aria-hidden="true">/</span> {part}
              </span>
            ))}
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button library-toggle"
              type="button"
              aria-label="打开文档库"
              title="文档库"
              aria-expanded={mobileLibraryOpen}
              onClick={() => setMobileLibraryOpen((open) => !open)}
            >
              {IS_WEB_RUNTIME ? (
                <Globe2 size={16} aria-hidden="true" />
              ) : (
                <Library size={16} aria-hidden="true" />
              )}
            </button>
            {currentContent && (
              <button
                className="icon-button toc-toggle"
                type="button"
                aria-label="打开本文目录"
                title="本文目录"
                aria-expanded={compactTocOpen}
                onClick={() => setCompactTocOpen((open) => !open)}
              >
                <ListTree size={16} aria-hidden="true" />
              </button>
            )}
            <button
              className="icon-button"
              type="button"
              aria-label="阅读设置"
              title="阅读设置"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings2 size={16} aria-hidden="true" />
            </button>
            <ReadingSettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} onNotice={showNotice} />
          </div>
          <div className="reading-progress" aria-hidden="true">
            <div
              className="reading-progress-bar"
              style={{ "--reading-progress": Math.min(1, Math.max(0, progress / 100)) } as CSSProperties}
            />
          </div>
        </header>

        {currentContent && currentDocument ? (
          <div className="content-grid">
            <div className="reading-scroll" ref={readerRef} onScroll={handleReaderScroll}>
              <div className={`article-shell article-shell--${currentContent.kind}`} ref={articleRef}>
                <header className="article-header">
                  <div className="article-kicker">{currentContent.kind === "pdf" ? "Portable document" : currentContent.kind === "epub" ? "Reflowable book" : "Markdown document"}</div>
                  <h1 className="article-title">{currentDocument.title}</h1>
                  <div className="article-meta">
                    <span>
                      <Clock3 size={12} aria-hidden="true" />
                      {formatModified(currentDocument.modified)}
                    </span>
                    <span>
                      <HardDrive size={12} aria-hidden="true" />
                      {formatFileSize(currentDocument.size)}
                    </span>
                    <span>
                      <Type size={12} aria-hidden="true" />
                      {currentDocument.format === "mdx" ? "MDX（只读 Markdown）" : currentDocument.format.toUpperCase()}
                    </span>
                  </div>
                  {(currentDocument.indexStatus === "failed" || currentDocument.indexStatus === "partial" || currentDocument.indexStatus === "unsupported") && <div className="article-index-status">
                    <span>{currentDocument.indexError ?? (currentDocument.indexStatus === "partial" ? "部分内容不可检索" : "该文档未建立索引")}</span>
                    {currentDocument.indexStatus !== "unsupported" && <button ref={retryButtonRef} type="button" onClick={() => void handleRetryIndex()}>重试索引</button>}
                  </div>}
                </header>
                {currentContent.kind === "markdown" && <MarkdownRenderer content={renderedMarkdown} resolveImageSrc={resolveImageSrc} onNavigate={(href) => void handleNavigate(href)} />}
                {currentContent.kind === "pdf" && <Suspense fallback={<div className="pdf-state"><span className="spinner" />正在加载 PDF 阅读器…</div>}><PdfReader
                  relativePath={currentContent.relativePath}
                  size={currentContent.size}
                  modified={currentDocument.modified}
                  indexStatus={currentContent.indexStatus}
                  indexError={currentContent.indexError}
                  locator={currentLocator}
                  motionLevel={motionLevel}
                  onTocChange={handleTocChange}
                  onActiveChange={handleActiveHeadingChange}
                /></Suspense>}
                {currentContent.kind === "epub" && <EpubReader
                  relativePath={currentContent.relativePath}
                  document={currentContent.document}
                  locator={currentLocator}
                  motionLevel={motionLevel}
                  onTocChange={handleTocChange}
                  onActiveChange={handleActiveHeadingChange}
                />}
              </div>
            </div>

            <aside className="toc-panel" aria-label="本文目录">
              <TocNavigation items={toc} activeId={activeHeading} onSelect={scrollToHeading} />
            </aside>
          </div>
        ) : (
          <Welcome
            hasLibrary={Boolean(snapshot)}
            documentCount={documents.length}
            onOpen={() =>
              void (IS_WEB_RUNTIME ? refreshLibrary() : chooseAndOpenLibrary())
            }
            isWeb={IS_WEB_RUNTIME}
          />
        )}

        <button
          className="toc-drawer-backdrop reade-motion-backdrop"
          type="button"
          aria-label="关闭本文目录"
          aria-hidden={!currentContent || !compactTocOpen}
          data-open={Boolean(currentContent && compactTocOpen)}
          tabIndex={currentContent && compactTocOpen ? 0 : -1}
          onClick={() => setCompactTocOpen(false)}
        />
        <aside
          className="toc-drawer reade-motion-panel"
          aria-label="本文目录"
          aria-hidden={!currentContent || !compactTocOpen}
          data-open={Boolean(currentContent && compactTocOpen)}
          inert={!currentContent || !compactTocOpen}
        >
          <TocNavigation items={toc} activeId={activeHeading} onSelect={scrollToHeading} />
        </aside>

        {loading && (
          <div className="loading-overlay" aria-live="polite">
            <div className="loading-card">
              <span className="spinner" aria-hidden="true" />
              {IS_WEB_RUNTIME ? "正在读取在线文档…" : "正在整理本地文档…"}
            </div>
          </div>
        )}

        {error && <MotionNotice key={`error-${error}`} id={error} message={error} kind="error" motionLevel={motionLevel} onClose={clearError} />}

        {notice && !error && <MotionNotice
          key={notice.id}
          id={notice.id}
          message={notice.message}
          motionLevel={motionLevel}
          autoDismiss
          onClose={closeCurrentNotice}
        />}
      </main>
    </div>
  );
}

export default App;
