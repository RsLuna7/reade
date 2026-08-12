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
  BarChart3,
  BookOpen,
  Clock3,
  FolderOpen,
  Globe2,
  HardDrive,
  Highlighter,
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
import {
  getThemeColor,
  getThemeSeriesLabel,
  THEME_META,
} from "./lib/themes";
import "./App.css";
import { AnnotatedMarkdown } from "./components/AnnotatedMarkdown";
import { DocumentTree } from "./components/DocumentTree";
import { EpubReader } from "./components/EpubReader";
import { buildLibraryStatusDetail } from "./lib/libraryStatus";
import {
  APP_RUNTIME,
  DEFAULT_LIBRARY_ROOT,
  assetDataUrl,
  listAnnotations,
  onDocumentIndexStatus,
  onLibraryChanged,
  onLibraryIndexProgress,
  openExternalLink,
  readAsset,
  recordReadingSession,
  type Annotation,
  type AnnotationColor,
} from "./lib/backend";
import { createReadingTracker, type ReadingTracker } from "./lib/readingTracker";
import {
  collectElementText,
  findTextQuote,
  rangeFromOffsets,
  rangeOffsetsWithinRoot,
} from "./lib/annotations";
import {
  buildAnnotationsMarkdown,
  compareAnnotationSortKeys,
  type AnnotationSortKey,
} from "./lib/annotationExport";
import {
  buildBookmarkForContext,
  buildMarkFromPending,
  captureReaderSelection,
  type PendingSelection,
} from "./lib/annotationCapture";
import { useDocumentAnnotations } from "./lib/useDocumentAnnotations";
import {
  AnnotationEditBubble,
  AnnotationList,
  AnnotationLibraryPanel,
  AnnotationToolsPanel,
  SelectionToolbar,
  type AnnotationLibraryGroup,
  type AnnotationLibraryStatus,
  type AnnotationListSort,
} from "./components/AnnotationUi";
import { extractToc, type TocItem } from "./lib/markdown";
import { buildWebRouteUrl, parseWebRoute } from "./lib/webRouting";
import { scrollContainerByRatio, scrollElementWithinContainer, scrollToOffsetWithinElement } from "./lib/scroll";
import {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  useReaderStore,
  type ReaderFontFamily,
  type ReaderMotionLevel,
} from "./store/useReaderStore";
import { cancelMotion, runMotion } from "./lib/motion";
import type { PdfReaderHandle } from "./components/PdfReader";

const LAST_LIBRARY_KEY = "reade-last-library";
const IS_WEB_RUNTIME = APP_RUNTIME === "web";
const EXTERNAL_PROTOCOL = /^(?:https?:|mailto:)/i;
const ABSOLUTE_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;
const PdfReader = lazy(() => import("./components/PdfReader").then((module) => ({ default: module.PdfReader })));
const StatsView = lazy(() => import("./components/StatsView").then((module) => ({ default: module.StatsView })));

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
  actionLabel,
  onAction,
  onClose,
}: {
  id: number | string;
  message: string;
  kind?: "status" | "error";
  motionLevel: ReaderMotionLevel;
  autoDismiss?: boolean;
  actionLabel?: string;
  onAction?: () => void;
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
      {onAction && actionLabel && (
        <button
          className="notice-action"
          type="button"
          onClick={() => {
            onAction();
            closeWithMotion();
          }}
        >
          {actionLabel}
        </button>
      )}
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
    <div className="toc-section">
      {items.length ? (
        <ol className="toc-list">
          {items.map((item, index) => (
            <li key={`${item.id}:${index}`}>
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

type SidePanelTab = "toc" | "annotations" | "library";

function SidePanel({
  tab,
  onTabChange,
  tocItems,
  activeId,
  onSelectHeading,
  annotations,
  brokenIds,
  annotationsLoading,
  annotationSort,
  onAnnotationSortChange,
  onExportAnnotations,
  onSelectAnnotation,
  onDeleteAnnotation,
  onEditAnnotationNote,
  onChangeAnnotationColor,
  onClearAnnotations,
  libraryStatus,
  libraryGroups,
  libraryError,
  currentPath,
  onRefreshLibraryAnnotations,
  onExportLibraryAnnotations,
  onSelectLibraryAnnotation,
}: {
  tab: SidePanelTab;
  onTabChange: (tab: SidePanelTab) => void;
  tocItems: TocItem[];
  activeId: string | null;
  onSelectHeading: (id: string) => void;
  annotations: Annotation[];
  brokenIds: Set<string>;
  annotationsLoading: boolean;
  annotationSort: AnnotationListSort;
  onAnnotationSortChange: (sort: AnnotationListSort) => void;
  onExportAnnotations: () => void;
  onSelectAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  onEditAnnotationNote: (annotation: Annotation) => void;
  onChangeAnnotationColor: (annotation: Annotation, color: AnnotationColor) => void;
  onClearAnnotations: () => void;
  libraryStatus: AnnotationLibraryStatus;
  libraryGroups: AnnotationLibraryGroup[];
  libraryError: string | null;
  currentPath: string | null;
  onRefreshLibraryAnnotations: () => void;
  onExportLibraryAnnotations: () => void;
  onSelectLibraryAnnotation: (annotation: Annotation) => void;
}) {
  return (
    <div className="toc-inner">
      <div className="side-panel-tabs" role="tablist" aria-label="目录与标注">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "toc"}
          className={tab === "toc" ? "active" : ""}
          onClick={() => onTabChange("toc")}
        >
          目录
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "annotations"}
          className={tab === "annotations" ? "active" : ""}
          onClick={() => onTabChange("annotations")}
        >
          标注
          {annotations.length > 0 ? <span className="side-panel-count">{annotations.length}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "library"}
          className={tab === "library" ? "active" : ""}
          onClick={() => onTabChange("library")}
        >
          全库
        </button>
      </div>
      {tab === "toc" ? (
        <TocNavigation items={tocItems} activeId={activeId} onSelect={onSelectHeading} />
      ) : tab === "annotations" ? (
        <AnnotationList
          annotations={annotations}
          brokenIds={brokenIds}
          loading={annotationsLoading}
          sort={annotationSort}
          onSortChange={onAnnotationSortChange}
          onExport={onExportAnnotations}
          onSelect={onSelectAnnotation}
          onDelete={onDeleteAnnotation}
          onEditNote={onEditAnnotationNote}
          onChangeColor={onChangeAnnotationColor}
          onClearAll={onClearAnnotations}
        />
      ) : (
        <AnnotationLibraryPanel
          status={libraryStatus}
          groups={libraryGroups}
          error={libraryError}
          currentPath={currentPath}
          onRefresh={onRefreshLibraryAnnotations}
          onExport={onExportLibraryAnnotations}
          onSelect={onSelectLibraryAnnotation}
        />
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
  const annotationTool = useReaderStore((state) => state.annotationTool);
  const highlightColor = useReaderStore((state) => state.highlightColor);
  const underlineColor = useReaderStore((state) => state.underlineColor);
  const setAnnotationTool = useReaderStore((state) => state.setAnnotationTool);
  const setHighlightColor = useReaderStore((state) => state.setHighlightColor);
  const setUnderlineColor = useReaderStore((state) => state.setUnderlineColor);
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
  const activeView = useReaderStore((state) => state.activeView);
  const setActiveView = useReaderStore((state) => state.setActiveView);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  const [compactTocOpen, setCompactTocOpen] = useState(false);
  const [mobileLibraryOpen, setMobileLibraryOpen] = useState(false);
  const [tocState, setTocState] = useState<{ path: string; items: TocItem[] } | null>(null);
  const [activeHeadingState, setActiveHeadingState] = useState<{ path: string; id: string | null } | null>(null);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{
    id: number;
    message: string;
    action?: { label: string; onAction: () => void };
  } | null>(null);
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>("toc");
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [toolbarPos, setToolbarPos] = useState({ x: 0, y: 0 });
  const [markEditor, setMarkEditor] = useState<{ annotationId: string; x: number; y: number } | null>(null);
  const [annotationSort, setAnnotationSort] = useState<AnnotationListSort>("time");
  const [libraryAnnotations, setLibraryAnnotations] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; items: Annotation[] }
  >({ status: "idle" });
  const [noteDraft, setNoteDraft] = useState<
    | { mode: "edit"; annotationId: string; text: string }
    | {
        mode: "create";
        pending: PendingSelection;
        kind: "highlight" | "underline";
        color: AnnotationColor;
        text: string;
      }
    | null
  >(null);
  const [markdownBrokenIds, setMarkdownBrokenIds] = useState<string[]>([]);
  const [readerBrokenIds, setReaderBrokenIds] = useState<string[]>([]);
  const brokenAnnotationIds = useMemo(
    () => new Set([...markdownBrokenIds, ...readerBrokenIds]),
    [markdownBrokenIds, readerBrokenIds],
  );
  const compactLibraryLayout = useMediaQuery("(max-width: 640px)");
  const readerRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const statusDetailRef = useRef<HTMLSpanElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const pdfReaderHandleRef = useRef<PdfReaderHandle | null>(null);
  const noticeSequence = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const pendingAnnotationJump = useRef<Annotation | null>(null);
  const jumpRetryTimer = useRef<number | null>(null);
  const trackerRef = useRef<ReadingTracker | null>(null);
  const {
    annotations,
    loading: annotationsLoading,
    canUndo,
    save: saveAnnotation,
    remove: removeAnnotation,
    clearAll: clearAnnotations,
    undo: undoAnnotation,
    updateNote,
    updateColor,
  } = useDocumentAnnotations(currentPath);
  const activeMarkColor = annotationTool === "underline" ? underlineColor : highlightColor;
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
  const statsOpen = !IS_WEB_RUNTIME && activeView === "stats";

  // 阅读时长追踪:仅桌面端;窗口聚焦可见且近期有交互才计时。
  useEffect(() => {
    if (IS_WEB_RUNTIME) return;
    const tracker = createReadingTracker({ persist: recordReadingSession });
    trackerRef.current = tracker;
    const syncWindowActive = () => {
      tracker.setWindowActive(!document.hidden && document.hasFocus());
    };
    const onActivity = () => tracker.recordActivity();
    const onPageHide = () => tracker.flush();
    syncWindowActive();
    window.addEventListener("focus", syncWindowActive);
    window.addEventListener("blur", syncWindowActive);
    document.addEventListener("visibilitychange", syncWindowActive);
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("pointermove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    window.addEventListener("wheel", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { capture: true, passive: true });
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("focus", syncWindowActive);
      window.removeEventListener("blur", syncWindowActive);
      document.removeEventListener("visibilitychange", syncWindowActive);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("wheel", onActivity);
      window.removeEventListener("scroll", onActivity, true);
      window.removeEventListener("pagehide", onPageHide);
      tracker.dispose();
      trackerRef.current = null;
    };
  }, []);

  // 会话跟随当前文档;统计视图打开时结束当前会话(顺带落盘)。
  const trackedFormat = currentDocument?.format ?? null;
  const trackedTitle = currentDocument?.title ?? null;
  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    if (!statsOpen && currentPath && trackedFormat) {
      tracker.openDocument({
        relativePath: currentPath,
        format: trackedFormat,
        title: trackedTitle,
      });
    } else {
      tracker.openDocument(null);
    }
  }, [statsOpen, currentPath, trackedFormat, trackedTitle]);

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

  const showNotice = useCallback(
    (message: string, options?: { actionLabel?: string; onAction?: () => void }) => {
      noticeSequence.current += 1;
      setNotice({
        id: noticeSequence.current,
        message,
        ...(options?.actionLabel && options.onAction
          ? { action: { label: options.actionLabel, onAction: options.onAction } }
          : {}),
      });
    },
    [],
  );

  const dismissNotice = useCallback((id: number) => {
    setNotice((current) => (current?.id === id ? null : current));
  }, []);
  const closeCurrentNotice = useCallback(() => {
    if (notice) dismissNotice(notice.id);
  }, [dismissNotice, notice]);

  const closeToolbar = useCallback(() => {
    setPendingSelection(null);
  }, []);

  const readingScrollRatio = useCallback(() => {
    const reader = readerRef.current;
    if (!reader) return 0;
    const max = reader.scrollHeight - reader.clientHeight;
    return max > 0 ? reader.scrollTop / max : 0;
  }, []);

  const handleCreateBookmark = useCallback(async () => {
    if (!currentPath || !currentContent) return;
    const epubChapter =
      currentContent.kind === "epub"
        ? articleRef.current?.querySelector<HTMLElement>(".epub-chapter")?.dataset.chapterId ??
          currentContent.document.chapters[0]?.id ??
          null
        : null;
    const annotation = buildBookmarkForContext({
      relativePath: currentPath,
      kind: currentContent.kind,
      activeHeading,
      scrollRatio: readingScrollRatio(),
      pdfPosition: pdfReaderHandleRef.current?.getPosition() ?? null,
      epubChapterId:
        (activeHeading && currentContent.kind === "epub"
          ? articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(activeHeading)}`)?.closest<HTMLElement>("[data-chapter-id]")
              ?.dataset.chapterId
          : null) ?? epubChapter,
    });
    try {
      await saveAnnotation(annotation);
      setSidePanelTab("annotations");
      showNotice("已添加书签");
      closeToolbar();
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [
    activeHeading,
    closeToolbar,
    currentContent,
    currentPath,
    readingScrollRatio,
    saveAnnotation,
    showNotice,
  ]);

  const handleUndoAnnotation = useCallback(async () => {
    try {
      const undone = await undoAnnotation();
      if (undone) showNotice("已撤销上一步标注操作");
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [showNotice, undoAnnotation]);

  const handleSaveMark = useCallback(
    async (
      pending: PendingSelection,
      kind: "highlight" | "underline",
      color: AnnotationColor,
      note: string | null = null,
      options?: { undoable?: boolean },
    ) => {
      if (!currentPath) return;
      const annotation = buildMarkFromPending(
        currentPath,
        pending,
        color,
        kind,
        note?.trim() || null,
      );
      try {
        await saveAnnotation(annotation);
        setSidePanelTab("annotations");
        const message = note?.trim()
          ? kind === "underline"
            ? "已保存下划线与笔记"
            : "已保存高亮与笔记"
          : kind === "underline"
            ? "已保存下划线"
            : "已保存高亮";
        showNotice(
          message,
          options?.undoable
            ? { actionLabel: "撤销", onAction: () => void handleUndoAnnotation() }
            : undefined,
        );
        window.getSelection()?.removeAllRanges();
        closeToolbar();
      } catch (cause) {
        showNotice(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [closeToolbar, currentPath, handleUndoAnnotation, saveAnnotation, showNotice],
  );

  const handleSaveHighlight = useCallback(
    async (withNote: boolean) => {
      if (!pendingSelection) return;
      if (withNote) {
        setNoteDraft({
          mode: "create",
          pending: pendingSelection,
          kind: "highlight",
          color: highlightColor,
          text: "",
        });
        closeToolbar();
        return;
      }
      await handleSaveMark(pendingSelection, "highlight", highlightColor, null);
    },
    [closeToolbar, handleSaveMark, highlightColor, pendingSelection],
  );

  const handleSaveUnderline = useCallback(async () => {
    if (!pendingSelection) return;
    await handleSaveMark(pendingSelection, "underline", underlineColor, null);
  }, [handleSaveMark, pendingSelection, underlineColor]);

  const handlePickColor = useCallback(
    async (color: AnnotationColor) => {
      setHighlightColor(color);
      if (!pendingSelection) return;
      await handleSaveMark(pendingSelection, "highlight", color, null);
    },
    [handleSaveMark, pendingSelection, setHighlightColor],
  );

  const handleClearAnnotations = useCallback(async () => {
    if (!annotations.length) return;
    const confirmed = window.confirm(`清除当前文档的全部 ${annotations.length} 条标注？此操作可用撤销恢复。`);
    if (!confirmed) return;
    try {
      await clearAnnotations();
      showNotice("已清除本文档标注");
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [annotations.length, clearAnnotations, showNotice]);

  /**
   * PDF 标注的 locator.view 与当前视图不一致时切换视图。
   * 返回是否发起了切换(reading 视图异步加载,调用方需重试兜底)。
   */
  const ensurePdfViewForAnnotation = useCallback((annotation: Annotation): boolean => {
    if (annotation.locator.kind !== "pdf") return false;
    const handle = pdfReaderHandleRef.current;
    if (!handle || typeof handle.setMode !== "function") return false;
    if (handle.getMode() === annotation.locator.view) return false;
    handle.setMode(annotation.locator.view);
    return true;
  }, []);

  /**
   * 尝试把阅读容器滚动到标注处;返回是否已完成定位。
   * `fallback` 允许在 mark 元素缺失时降级到页面/章节;`notify`
   * 控制是否允许弹出提示(重试的中间轮次保持安静)。
   */
  const performAnnotationJump = useCallback(
    (annotation: Annotation, options: { fallback: boolean; notify: boolean }): boolean => {
      const reader = readerRef.current;
      const article = articleRef.current;
      if (!reader || !article) return false;
      const behavior: ScrollBehavior = motionLevel === "off" ? "auto" : "smooth";

      if (annotation.locator.kind === "bookmark") {
        const target = annotation.locator.target;
        if (target.format === "pdf") {
          const restored = pdfReaderHandleRef.current?.restorePosition({
            page: target.page,
            offsetRatio: target.offsetRatio,
          });
          if (restored) return true;
          const page = article.querySelector<HTMLElement>(`#pdf-page-${target.page}`);
          if (!page) return false;
          scrollToOffsetWithinElement(reader, page, target.offsetRatio, behavior);
          return true;
        }
        const heading = target.headingId
          ? article.querySelector<HTMLElement>(`#${CSS.escape(target.headingId)}`)
          : null;
        if (heading) {
          scrollElementWithinContainer(reader, heading, behavior);
        } else {
          scrollContainerByRatio(reader, target.scrollRatio, behavior);
        }
        return true;
      }

      if (annotation.locator.kind === "pdf") {
        const mark = article.querySelector<HTMLElement>(
          `[data-annotation-id="${CSS.escape(annotation.id)}"]`,
        );
        if (mark) {
          scrollElementWithinContainer(reader, mark, behavior);
          return true;
        }
        if (!options.fallback) return false;
        const page = article.querySelector<HTMLElement>(`#pdf-page-${annotation.locator.page}`);
        if (!page) return false;
        scrollElementWithinContainer(reader, page, behavior);
        return true;
      }

      if (annotation.locator.kind === "epub") {
        const mark = article.querySelector<HTMLElement>(
          `[data-annotation-id="${CSS.escape(annotation.id)}"]`,
        );
        if (mark) {
          scrollElementWithinContainer(reader, mark, behavior);
          return true;
        }
        if (!options.fallback) return false;
        const chapter = article.querySelector<HTMLElement>(
          `[data-chapter-id="${CSS.escape(annotation.locator.chapterId)}"]`,
        );
        const block = chapter?.querySelector<HTMLElement>(
          `[data-block-index="${annotation.locator.blockIndex}"]`,
        );
        if (!block && !chapter) return false;
        scrollElementWithinContainer(reader, block ?? chapter, behavior);
        return true;
      }

      // Markdown 同步渲染,一次即可判定,不进入重试。
      // 已渲染的 mark 元素是最可靠的定位锚点,优先使用。
      const existingMark = article.querySelector<HTMLElement>(
        `[data-annotation-id="${CSS.escape(annotation.id)}"]`,
      );
      if (existingMark) {
        scrollElementWithinContainer(reader, existingMark, behavior);
        return true;
      }
      const markdownRoot = article.querySelector<HTMLElement>(".markdown-body") ?? article;
      const match = findTextQuote(
        collectElementText(markdownRoot),
        annotation.locator.quote,
        annotation.locator.prefix,
        annotation.locator.suffix,
      );
      if (!match) {
        const headingId = annotation.locator.headingId;
        const heading = headingId
          ? article.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`)
          : null;
        if (heading) {
          scrollElementWithinContainer(reader, heading, behavior);
          if (options.notify) showNotice("已跳至标注附近（原文可能已变更）。");
          return true;
        }
        if (options.notify) showNotice("无法定位该标注，文档可能已变更。");
        return true;
      }
      const range = rangeFromOffsets(markdownRoot, match.start, match.end);
      if (range) {
        // 不能用 startContainer.parentElement:当引文恰好从块级元素
        // 开头开始时,start 边界会落在前一个分隔文本节点的末尾,
        // 其父元素是整个正文容器。直接用 range 自身的矩形定位。
        const rangeRect = range.getBoundingClientRect();
        const readerRect = reader.getBoundingClientRect();
        const top = Math.max(0, reader.scrollTop + rangeRect.top - readerRect.top - 16);
        if (behavior === "smooth" && typeof reader.scrollTo === "function") {
          reader.scrollTo({ top, behavior });
        } else {
          reader.scrollTop = top;
        }
      }
      return true;
    },
    [motionLevel, showNotice],
  );

  /**
   * 带重试的跳转:PDF 阅读视图与懒加载页面是异步就绪的,
   * 先等待精确的 mark,几轮后允许降级到页面/章节。
   */
  const scheduleAnnotationJump = useCallback(
    (annotation: Annotation) => {
      if (jumpRetryTimer.current !== null) {
        window.clearTimeout(jumpRetryTimer.current);
        jumpRetryTimer.current = null;
      }
      const MAX_ROUNDS = 12;
      const attempt = (round: number) => {
        jumpRetryTimer.current = null;
        ensurePdfViewForAnnotation(annotation);
        const isLast = round >= MAX_ROUNDS;
        const done = performAnnotationJump(annotation, {
          fallback: isLast || round >= 4,
          notify: isLast,
        });
        if (done || isLast) return;
        jumpRetryTimer.current = window.setTimeout(() => attempt(round + 1), 150);
      };
      attempt(0);
    },
    [ensurePdfViewForAnnotation, performAnnotationJump],
  );

  const jumpToAnnotation = useCallback(
    (annotation: Annotation) => {
      if (ensurePdfViewForAnnotation(annotation)) {
        // 切换视图后内容异步加载,交给重试兜底。
        scheduleAnnotationJump(annotation);
        return;
      }
      const done = performAnnotationJump(annotation, { fallback: false, notify: true });
      if (!done) scheduleAnnotationJump(annotation);
    },
    [ensurePdfViewForAnnotation, performAnnotationJump, scheduleAnnotationJump],
  );

  const handleDeleteAnnotation = useCallback(
    async (annotation: Annotation) => {
      try {
        await removeAnnotation(annotation.id);
        showNotice("已删除标注");
      } catch (cause) {
        showNotice(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [removeAnnotation, showNotice],
  );

  const handleEditAnnotationNote = useCallback(
    (annotation: Annotation) => {
      setNoteDraft({ mode: "edit", annotationId: annotation.id, text: annotation.note ?? "" });
    },
    [],
  );

  const handleChangeAnnotationColor = useCallback(
    async (annotation: Annotation, color: AnnotationColor) => {
      if (annotation.color === color) return;
      try {
        await updateColor(annotation, color);
        showNotice("已更新颜色");
      } catch (cause) {
        showNotice(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [showNotice, updateColor],
  );

  const commitNoteDraft = useCallback(async () => {
    if (!noteDraft) return;
    if (noteDraft.mode === "create") {
      await handleSaveMark(
        noteDraft.pending,
        noteDraft.kind,
        noteDraft.color,
        noteDraft.text.trim() || null,
      );
      setNoteDraft(null);
      return;
    }
    const annotation = annotations.find((item) => item.id === noteDraft.annotationId);
    if (!annotation) {
      setNoteDraft(null);
      return;
    }
    try {
      await updateNote(annotation, noteDraft.text.trim() || null);
      setNoteDraft(null);
      showNotice("笔记已更新");
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [annotations, handleSaveMark, noteDraft, showNotice, updateNote]);

  // B6:按位置排序的键。pdf 用页码、epub 用章节序+段落偏移;
  // markdown 引文需对照正文 DOM 解析,memo 避免每次 render 全文遍历
  // (annotationSort 加入依赖:仅在切到"按位置"时才做解析)。
  const annotationSortKeys = useMemo(() => {
    const keys = new Map<string, AnnotationSortKey>();
    if (annotationSort !== "position" || !currentContent || !annotations.length) return keys;

    if (currentContent.kind === "pdf") {
      for (const annotation of annotations) {
        if (annotation.locator.kind === "pdf") {
          keys.set(annotation.id, [annotation.locator.page, 0, 0]);
        } else if (
          annotation.locator.kind === "bookmark" &&
          annotation.locator.target.format === "pdf"
        ) {
          keys.set(annotation.id, [annotation.locator.target.page, 0, 0]);
        }
      }
      return keys;
    }

    if (currentContent.kind === "epub") {
      const chapterOrder = new Map<string, number>();
      currentContent.document.chapters.forEach((chapter, index) => {
        chapterOrder.set(chapter.id, index);
      });
      for (const annotation of annotations) {
        if (annotation.locator.kind === "epub") {
          const order = chapterOrder.get(annotation.locator.chapterId);
          if (order === undefined) continue;
          keys.set(annotation.id, [order, annotation.locator.blockIndex, annotation.locator.startOffset]);
        } else if (
          annotation.locator.kind === "bookmark" &&
          annotation.locator.target.format === "epub"
        ) {
          const order = chapterOrder.get(annotation.locator.target.chapterId);
          if (order === undefined) continue;
          keys.set(annotation.id, [order, -1, 0]);
        }
      }
      return keys;
    }

    const markdownRoot = articleRef.current?.querySelector<HTMLElement>(".markdown-body") ?? null;
    if (!markdownRoot) return keys;
    const fullText = collectElementText(markdownRoot);
    const headingOffset = (headingId: string): number | null => {
      const heading = markdownRoot.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`);
      if (!heading) return null;
      const range = document.createRange();
      range.selectNodeContents(heading);
      return rangeOffsetsWithinRoot(markdownRoot, range)?.start ?? null;
    };
    for (const annotation of annotations) {
      if (annotation.locator.kind === "markdown") {
        const match = findTextQuote(
          fullText,
          annotation.locator.quote,
          annotation.locator.prefix,
          annotation.locator.suffix,
        );
        if (match) keys.set(annotation.id, [match.start]);
        continue;
      }
      if (annotation.locator.kind === "bookmark" && annotation.locator.target.format === "markdown") {
        const target = annotation.locator.target;
        const offset = target.headingId ? headingOffset(target.headingId) : null;
        keys.set(annotation.id, [offset ?? Math.round(target.scrollRatio * fullText.length)]);
      }
    }
    return keys;
  }, [annotations, annotationSort, currentContent]);

  const sortedAnnotations = useMemo(() => {
    if (annotationSort !== "position") return annotations;
    return [...annotations].sort(
      (a, b) =>
        compareAnnotationSortKeys(annotationSortKeys.get(a.id), annotationSortKeys.get(b.id)) ||
        a.createdAt - b.createdAt ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }, [annotationSort, annotationSortKeys, annotations]);

  const markEditorAnnotation = useMemo(
    () =>
      markEditor
        ? annotations.find((item) => item.id === markEditor.annotationId) ?? null
        : null,
    [annotations, markEditor],
  );

  // B7:全库标注总览。首次打开"全库"tab 时拉取;当前文档标注
  // 变化时置为过期,下次打开(或正打开时)自动重新拉取。
  const loadLibraryAnnotations = useCallback(async () => {
    setLibraryAnnotations({ status: "loading" });
    try {
      const items = await listAnnotations();
      setLibraryAnnotations({ status: "ready", items });
    } catch (cause) {
      setLibraryAnnotations({
        status: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }, []);

  useEffect(() => {
    setLibraryAnnotations((current) => (current.status === "idle" ? current : { status: "idle" }));
  }, [annotations]);

  useEffect(() => {
    if (sidePanelTab === "library" && libraryAnnotations.status === "idle") {
      void loadLibraryAnnotations();
    }
  }, [libraryAnnotations.status, loadLibraryAnnotations, sidePanelTab]);

  const libraryGroups = useMemo<AnnotationLibraryGroup[]>(() => {
    if (libraryAnnotations.status !== "ready") return [];
    const titles = new Map(documents.map((document) => [document.relativePath, document.title]));
    const grouped = new Map<string, Annotation[]>();
    for (const annotation of libraryAnnotations.items) {
      const list = grouped.get(annotation.relativePath);
      if (list) list.push(annotation);
      else grouped.set(annotation.relativePath, [annotation]);
    }
    return Array.from(grouped.entries())
      .map(([path, items]) => ({
        path,
        title: titles.get(path) ?? fileName(path),
        annotations: [...items].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }, [documents, libraryAnnotations]);

  const handleSelectLibraryAnnotation = useCallback(
    (annotation: Annotation) => {
      setCompactTocOpen(false);
      if (annotation.relativePath === currentPath) {
        jumpToAnnotation(annotation);
        return;
      }
      // pendingHash 模式:等目标文档内容就绪后再跳转。
      pendingAnnotationJump.current = annotation;
      void selectDocument(annotation.relativePath);
    },
    [currentPath, jumpToAnnotation, selectDocument],
  );

  useEffect(() => {
    const pending = pendingAnnotationJump.current;
    if (!pending || !currentContent) return;
    if (currentContent.relativePath !== pending.relativePath) return;
    pendingAnnotationJump.current = null;
    scheduleAnnotationJump(pending);
  }, [currentContent, scheduleAnnotationJump]);

  // B8:导出为 Markdown 并复制到剪贴板(不落盘、不加权限)。
  const copyTextToClipboard = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // 剪贴板 API 被拒绝时回退到隐藏 textarea。
    }
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }, []);

  const handleExportAnnotations = useCallback(async () => {
    if (!currentPath || !annotations.length) return;
    const titles = new Map([[currentPath, currentDocument?.title ?? fileName(currentPath)]]);
    const markdown = buildAnnotationsMarkdown(annotations, {
      documentTitles: titles,
      sortKeys: annotationSortKeys.size ? annotationSortKeys : undefined,
    });
    const copied = await copyTextToClipboard(markdown);
    showNotice(copied ? `已复制 ${annotations.length} 条标注` : "复制失败，请重试。");
  }, [annotationSortKeys, annotations, copyTextToClipboard, currentDocument?.title, currentPath, showNotice]);

  const handleExportLibraryAnnotations = useCallback(async () => {
    if (libraryAnnotations.status !== "ready" || !libraryAnnotations.items.length) return;
    const titles = new Map(documents.map((document) => [document.relativePath, document.title]));
    const markdown = buildAnnotationsMarkdown(libraryAnnotations.items, { documentTitles: titles });
    const copied = await copyTextToClipboard(markdown);
    showNotice(
      copied ? `已复制 ${libraryAnnotations.items.length} 条标注` : "复制失败，请重试。",
    );
  }, [copyTextToClipboard, documents, libraryAnnotations, showNotice]);

  useEffect(() => {
    setPendingSelection(null);
    setNoteDraft(null);
    setMarkEditor(null);
    setSidePanelTab((current) => (current === "library" ? current : "toc"));
    setAnnotationPanelOpen(false);
    setMarkdownBrokenIds([]);
    setReaderBrokenIds([]);
    if (jumpRetryTimer.current !== null) {
      window.clearTimeout(jumpRetryTimer.current);
      jumpRetryTimer.current = null;
    }
  }, [currentPath]);

  useEffect(
    () => () => {
      if (jumpRetryTimer.current !== null) window.clearTimeout(jumpRetryTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (currentContent?.kind === "markdown") {
      setReaderBrokenIds([]);
      return;
    }
    setMarkdownBrokenIds([]);
  }, [currentContent?.kind]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || !currentContent) return;
    // pointerup(替代 mouseup,兼容触屏)+ 防抖 selectionchange
    // (覆盖 iOS 长按选词与键盘 Shift+方向键选区)双通道捕获。
    let debounceTimer: number | undefined;
    let disposed = false;
    let pointerActive = false;

    const evaluate = () => {
      if (disposed) return;
      const pending = captureReaderSelection({
        root: reader,
        kind: currentContent.kind,
        pdfMode: pdfReaderHandleRef.current?.getMode(),
      });
      if (!pending) {
        // 保存后 removeAllRanges 触发的 selectionchange 落到这里:
        // 只清空待选状态,不再写选区,因此不会形成循环。
        setPendingSelection(null);
        return;
      }
      if (annotationTool === "highlight" || annotationTool === "underline") {
        const color = annotationTool === "underline" ? underlineColor : highlightColor;
        void handleSaveMark(pending, annotationTool, color, null, { undoable: true });
        return;
      }
      const padding = 12;
      setToolbarPos({
        x: Math.min(window.innerWidth - 360, Math.max(padding, pending.rect.left)),
        y: Math.max(padding, pending.rect.top - 48),
      });
      setPendingSelection(pending);
    };

    const onPointerDown = () => {
      pointerActive = true;
    };
    const onPointerEnd = (event: PointerEvent | Event) => {
      if (!pointerActive) return;
      pointerActive = false;
      void event;
      window.clearTimeout(debounceTimer);
      // 选区在 pointerup 后一拍才稳定,推迟到下一轮事件循环。
      debounceTimer = window.setTimeout(evaluate, 0);
    };
    const onSelectionChange = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        // 指针仍按住(划选中)时先不落笔,交给 pointerup 收尾。
        if (pointerActive) return;
        evaluate();
      }, 220);
    };

    reader.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerEnd);
    document.addEventListener("pointercancel", onPointerEnd);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      disposed = true;
      window.clearTimeout(debounceTimer);
      reader.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerEnd);
      document.removeEventListener("pointercancel", onPointerEnd);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [annotationTool, currentContent, handleSaveMark, highlightColor, underlineColor]);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || !currentContent) return;
    // 事件委托:点击正文中的标注 mark 打开编辑气泡。
    const onClick = (event: MouseEvent) => {
      const selection = window.getSelection();
      // 刚结束一次划选(选区未折叠)时不视为点击标注。
      if (selection && !selection.isCollapsed) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("a")) return;

      let annotationId: string | null =
        target.closest<HTMLElement>("[data-annotation-id]")?.dataset.annotationId ?? null;

      if (!annotationId && currentContent.kind === "pdf" && pdfReaderHandleRef.current?.getMode() === "original") {
        // PDF 原文视图的高亮层保持 pointer-events:none(避免挡住文本
        // 选择),因此按点击坐标对本页高亮矩形做包含检测。
        const page = target.closest<HTMLElement>("[data-page-number]");
        if (page) {
          const highlights = Array.from(
            page.querySelectorAll<HTMLElement>(".pdf-user-highlight[data-annotation-id]"),
          );
          for (const highlight of highlights) {
            const rect = highlight.getBoundingClientRect();
            if (
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom
            ) {
              annotationId = highlight.dataset.annotationId ?? annotationId;
            }
          }
        }
      }

      if (!annotationId) return;
      const padding = 12;
      const bubbleWidth = 240;
      const bubbleHeight = 96;
      // 键盘激活或合成点击没有坐标(0,0),退回标注元素矩形。
      let anchorX = event.clientX;
      let anchorY = event.clientY;
      if (anchorX === 0 && anchorY === 0) {
        const anchor = target.closest<HTMLElement>("[data-annotation-id]");
        const rect = anchor?.getBoundingClientRect();
        if (rect) {
          anchorX = rect.left + rect.width / 2;
          anchorY = rect.bottom;
        }
      }
      const x = Math.min(window.innerWidth - bubbleWidth - padding, Math.max(padding, anchorX - 24));
      const rawY = anchorY + 14;
      const y = rawY > window.innerHeight - bubbleHeight - padding
        ? Math.max(padding, anchorY - bubbleHeight - 10)
        : rawY;
      setMarkEditor({ annotationId, x, y });
      setPendingSelection(null);
    };
    reader.addEventListener("click", onClick);
    return () => reader.removeEventListener("click", onClick);
  }, [currentContent]);

  useEffect(() => {
    // 阅读容器滚动时,浮动工具条依据 live selection 重新定位,
    // 选区已消失则关闭,避免气泡悬空脱节。
    const reader = readerRef.current;
    if (!reader || !pendingSelection) return;
    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          setPendingSelection(null);
          return;
        }
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        const padding = 12;
        setToolbarPos({
          x: Math.min(window.innerWidth - 360, Math.max(padding, rect.left)),
          y: Math.max(padding, rect.top - 48),
        });
      });
    };
    reader.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      reader.removeEventListener("scroll", onScroll);
    };
  }, [pendingSelection]);

  const markEditorId = markEditor?.annotationId ?? null;
  useEffect(() => {
    // 编辑气泡跟随其锚定的标注元素滚动;元素不可见时关闭。
    const reader = readerRef.current;
    if (!reader || !markEditorId) return;
    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const anchor = articleRef.current?.querySelector<HTMLElement>(
          `[data-annotation-id="${CSS.escape(markEditorId)}"]`,
        );
        if (!anchor) {
          setMarkEditor(null);
          return;
        }
        const rect = anchor.getBoundingClientRect();
        const padding = 12;
        const bubbleWidth = 240;
        setMarkEditor((current) =>
          current
            ? {
                ...current,
                x: Math.min(window.innerWidth - bubbleWidth - padding, Math.max(padding, rect.left)),
                y: Math.max(padding, rect.bottom + 10),
              }
            : current,
        );
      });
    };
    reader.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      reader.removeEventListener("scroll", onScroll);
    };
  }, [markEditorId]);

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
    themeColor?.setAttribute("content", getThemeColor(theme));
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
          if (annotationTool !== "view") {
            setAnnotationTool("view");
          }
          setSettingsOpen(false);
          setAnnotationPanelOpen(false);
          setCompactTocOpen(false);
          setMobileLibraryOpen(false);
          setPendingSelection(null);
          setNoteDraft(null);
          setMarkEditor(null);
        }
        return;
      }
      if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        if (!canUndo) return;
        event.preventDefault();
        void handleUndoAnnotation();
        return;
      }
      if (event.key.toLowerCase() === "o") {
        if (IS_WEB_RUNTIME) return;
        event.preventDefault();
        void chooseAndOpenLibrary();
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key.toLowerCase() === "b") {
        if (!currentPath || !currentContent) return;
        event.preventDefault();
        void handleCreateBookmark();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    annotationTool,
    canUndo,
    chooseAndOpenLibrary,
    currentContent,
    currentPath,
    handleCreateBookmark,
    handleUndoAnnotation,
    setAnnotationTool,
  ]);

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
    const range = reader.scrollHeight - reader.clientHeight;
    const value = range <= 0 ? 0 : Math.min(100, (reader.scrollTop / range) * 100);
    progressBarRef.current?.style.setProperty(
      "--reading-progress",
      String(Math.min(1, Math.max(0, value / 100))),
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
      const value = range <= 0 ? 0 : Math.min(100, (reader.scrollTop / range) * 100);
      progressBarRef.current?.style.setProperty(
        "--reading-progress",
        String(Math.min(1, Math.max(0, value / 100))),
      );

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
      if (!currentPath) return;
      setActiveHeadingState((current) => {
        if (current?.path === currentPath && current.id === nextActive) return current;
        return { path: currentPath, id: nextActive };
      });
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
  const statusDetail = buildLibraryStatusDetail({
    isWeb: IS_WEB_RUNTIME,
    searchQuery,
    searchResultCount: searchResults.length,
    indexProgress,
    documents,
  });

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
          <div className="theme-controls">
            <span
              className="theme-series-label"
              title={`${THEME_META[theme].label}（后续可在此扩展更多主题系列）`}
            >
              {getThemeSeriesLabel(theme)}
            </span>
            {!IS_WEB_RUNTIME && (
              <button
                className={`icon-button${statsOpen ? " is-armed" : ""}`}
                type="button"
                aria-label={statsOpen ? "返回阅读" : "打开阅读统计"}
                title="阅读统计"
                aria-pressed={statsOpen}
                onClick={() => {
                  setActiveView(statsOpen ? "reader" : "stats");
                  setMobileLibraryOpen(false);
                }}
              >
                <BarChart3 size={16} aria-hidden="true" />
              </button>
            )}
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
          </div>
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
            {currentContent && !statsOpen && (
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
            {currentContent && !statsOpen && (
              <>
                <button
                  className={`icon-button${annotationTool !== "view" ? " is-armed" : ""}`}
                  type="button"
                  aria-label="标注工具"
                  title={
                    annotationTool === "highlight"
                      ? "标注工具（高亮模式）"
                      : annotationTool === "underline"
                        ? "标注工具（下划线模式）"
                        : "标注工具"
                  }
                  aria-expanded={annotationPanelOpen}
                  onClick={() => {
                    setAnnotationPanelOpen((open) => !open);
                    setSettingsOpen(false);
                  }}
                >
                  <Highlighter size={16} aria-hidden="true" />
                </button>
                <AnnotationToolsPanel
                  open={annotationPanelOpen}
                  tool={annotationTool}
                  color={activeMarkColor}
                  canUndo={canUndo}
                  canClear={annotations.length > 0}
                  onToolChange={setAnnotationTool}
                  onColorChange={(color) => {
                    if (annotationTool === "underline") setUnderlineColor(color);
                    else setHighlightColor(color);
                  }}
                  onUndo={() => void handleUndoAnnotation()}
                  onClear={() => void handleClearAnnotations()}
                />
              </>
            )}
            <button
              className="icon-button"
              type="button"
              aria-label="阅读设置"
              title="阅读设置"
              aria-expanded={settingsOpen}
              onClick={() => {
                setSettingsOpen((open) => !open);
                setAnnotationPanelOpen(false);
              }}
            >
              <Settings2 size={16} aria-hidden="true" />
            </button>
            <ReadingSettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} onNotice={showNotice} />
          </div>
          <div className="reading-progress" aria-hidden="true">
            <div
              className="reading-progress-bar"
              ref={progressBarRef}
              style={{ "--reading-progress": "0" } as CSSProperties}
            />
          </div>
        </header>

        {currentContent && currentDocument ? (
          <div className="content-grid" hidden={statsOpen}>
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
                {currentContent.kind === "markdown" && (
                  <AnnotatedMarkdown
                    content={renderedMarkdown}
                    annotations={annotations}
                    resolveImageSrc={resolveImageSrc}
                    onNavigate={(href) => void handleNavigate(href)}
                    onBrokenIdsChange={setMarkdownBrokenIds}
                  />
                )}
                {currentContent.kind === "pdf" && <Suspense fallback={<div className="pdf-state"><span className="spinner" />正在加载 PDF 阅读器…</div>}><PdfReader
                  relativePath={currentContent.relativePath}
                  size={currentContent.size}
                  modified={currentDocument.modified}
                  indexStatus={currentContent.indexStatus}
                  indexError={currentContent.indexError}
                  locator={currentLocator}
                  motionLevel={motionLevel}
                  annotations={annotations}
                  readerRef={pdfReaderHandleRef}
                  onBrokenAnnotationsChange={setReaderBrokenIds}
                  onTocChange={handleTocChange}
                  onActiveChange={handleActiveHeadingChange}
                /></Suspense>}
                {currentContent.kind === "epub" && <EpubReader
                  relativePath={currentContent.relativePath}
                  document={currentContent.document}
                  locator={currentLocator}
                  motionLevel={motionLevel}
                  annotations={annotations}
                  onBrokenAnnotationsChange={setReaderBrokenIds}
                  onTocChange={handleTocChange}
                  onActiveChange={handleActiveHeadingChange}
                />}
              </div>
            </div>

            <aside className="toc-panel" aria-label="本文目录与标注">
              <SidePanel
                tab={sidePanelTab}
                onTabChange={setSidePanelTab}
                tocItems={toc}
                activeId={activeHeading}
                onSelectHeading={scrollToHeading}
                annotations={sortedAnnotations}
                brokenIds={brokenAnnotationIds}
                annotationsLoading={annotationsLoading}
                annotationSort={annotationSort}
                onAnnotationSortChange={setAnnotationSort}
                onExportAnnotations={() => void handleExportAnnotations()}
                onSelectAnnotation={jumpToAnnotation}
                onDeleteAnnotation={(annotation) => void handleDeleteAnnotation(annotation)}
                onEditAnnotationNote={handleEditAnnotationNote}
                onChangeAnnotationColor={(annotation, color) => void handleChangeAnnotationColor(annotation, color)}
                onClearAnnotations={() => void handleClearAnnotations()}
                libraryStatus={libraryAnnotations.status}
                libraryGroups={libraryGroups}
                libraryError={libraryAnnotations.status === "error" ? libraryAnnotations.message : null}
                currentPath={currentPath}
                onRefreshLibraryAnnotations={() => void loadLibraryAnnotations()}
                onExportLibraryAnnotations={() => void handleExportLibraryAnnotations()}
                onSelectLibraryAnnotation={handleSelectLibraryAnnotation}
              />
            </aside>
          </div>
        ) : (
          !statsOpen && (
            <Welcome
              hasLibrary={Boolean(snapshot)}
              documentCount={documents.length}
              onOpen={() =>
                void (IS_WEB_RUNTIME ? refreshLibrary() : chooseAndOpenLibrary())
              }
              isWeb={IS_WEB_RUNTIME}
            />
          )
        )}

        {statsOpen && (
          <Suspense
            fallback={
              <div className="stats-state">
                <span className="spinner" aria-hidden="true" />
                正在加载统计视图…
              </div>
            }
          >
            <StatsView />
          </Suspense>
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
          aria-label="本文目录与标注"
          aria-hidden={!currentContent || !compactTocOpen}
          data-open={Boolean(currentContent && compactTocOpen)}
          inert={!currentContent || !compactTocOpen}
        >
          <SidePanel
            tab={sidePanelTab}
            onTabChange={setSidePanelTab}
            tocItems={toc}
            activeId={activeHeading}
            onSelectHeading={(id) => {
              scrollToHeading(id);
              setCompactTocOpen(false);
            }}
            annotations={sortedAnnotations}
            brokenIds={brokenAnnotationIds}
            annotationsLoading={annotationsLoading}
            annotationSort={annotationSort}
            onAnnotationSortChange={setAnnotationSort}
            onExportAnnotations={() => void handleExportAnnotations()}
            onSelectAnnotation={(annotation) => {
              jumpToAnnotation(annotation);
              setCompactTocOpen(false);
            }}
            onDeleteAnnotation={(annotation) => void handleDeleteAnnotation(annotation)}
            onEditAnnotationNote={handleEditAnnotationNote}
            onChangeAnnotationColor={(annotation, color) => void handleChangeAnnotationColor(annotation, color)}
            onClearAnnotations={() => void handleClearAnnotations()}
            libraryStatus={libraryAnnotations.status}
            libraryGroups={libraryGroups}
            libraryError={libraryAnnotations.status === "error" ? libraryAnnotations.message : null}
            currentPath={currentPath}
            onRefreshLibraryAnnotations={() => void loadLibraryAnnotations()}
            onExportLibraryAnnotations={() => void handleExportLibraryAnnotations()}
            onSelectLibraryAnnotation={handleSelectLibraryAnnotation}
          />
        </aside>

        <SelectionToolbar
          open={Boolean(pendingSelection) && annotationTool === "view"}
          x={toolbarPos.x}
          y={toolbarPos.y}
          color={highlightColor}
          onPickColor={(color) => void handlePickColor(color)}
          onHighlight={() => void handleSaveHighlight(false)}
          onUnderline={() => void handleSaveUnderline()}
          onAddNote={() => void handleSaveHighlight(true)}
          onBookmark={() => void handleCreateBookmark()}
          onClose={closeToolbar}
          canHighlight={Boolean(pendingSelection)}
        />

        {markEditorAnnotation && markEditor && (
          <AnnotationEditBubble
            annotation={markEditorAnnotation}
            x={markEditor.x}
            y={markEditor.y}
            onChangeColor={(annotation, color) => void handleChangeAnnotationColor(annotation, color)}
            onEditNote={(annotation) => {
              handleEditAnnotationNote(annotation);
              setMarkEditor(null);
            }}
            onDelete={(annotation) => {
              void handleDeleteAnnotation(annotation);
              setMarkEditor(null);
            }}
            onClose={() => setMarkEditor(null)}
          />
        )}

        {noteDraft && (
          <div
            className="annotation-note-editor reade-motion-panel"
            role="dialog"
            aria-label={noteDraft.mode === "create" ? "添加标注笔记" : "编辑标注笔记"}
          >
            <label>
              笔记
              <textarea
                value={noteDraft.text}
                onChange={(event) =>
                  setNoteDraft({ ...noteDraft, text: event.target.value })
                }
                rows={4}
                autoFocus
              />
            </label>
            <div className="annotation-note-actions">
              <button type="button" onClick={() => setNoteDraft(null)}>取消</button>
              <button type="button" onClick={() => void commitNoteDraft()}>保存</button>
            </div>
          </div>
        )}

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
          actionLabel={notice.action?.label}
          onAction={notice.action?.onAction}
          onClose={closeCurrentNotice}
        />}
      </main>
    </div>
  );
}

export default App;
