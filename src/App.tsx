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
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  BarChart3,
  BookOpen,
  Clock3,
  Columns2,
  FolderOpen,
  FolderPlus,
  Globe2,
  HardDrive,
  Highlighter,
  House,
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
  SERIES_FONT_PRESET,
  THEME_META,
  THEME_SERIES,
  type ThemeSeriesId,
} from "./lib/themes";
import "./App.css";
import { AnnotatedMarkdown } from "./components/AnnotatedMarkdown";
import { ArticleErrorBoundary } from "./components/ArticleErrorBoundary";
import { BookshelfView } from "./components/BookshelfView";
import { DocumentTree } from "./components/DocumentTree";
import { EpubReader, epubChapterTocId } from "./components/EpubReader";
import { buildLibraryStatusDetail } from "./lib/libraryStatus";
// 主题墨水扩散(plan-theme-ink-transition):点击处理器写入一次性
// origin,主题 effect 消费;full 档才会用到,其余档位照旧。
import {
  applyThemeMutation,
  consumeThemeTransitionOrigin,
  setNextThemeTransitionOrigin,
} from "./lib/themeTransition";
import {
  APP_RUNTIME,
  DEFAULT_LIBRARY_ROOT,
  assetDataUrl,
  detectMovedDocuments,
  findRelatedPassages,
  importAnnotations,
  listAnnotations,
  listCollectionItems,
  listCollections,
  listDocumentLinks,
  listAnnotationsForTransfer,
  listDocumentExtents,
  listDocumentFingerprints,
  listReadingSessions,
  onDocumentIndexStatus,
  onLibraryChanged,
  onLibraryIndexProgress,
  openExternalLink,
  pickAnnotationImportFile,
  probeLibraryPath,
  readAsset,
  readDocument,
  readPdfReadingMode,
  rebindDocumentAnnotations,
  recordReadingSession,
  reviewSummary,
  saveAnnotationExportFile,
  searchAnnotations,
  type Annotation,
  type AnnotationColor,
  type CollectionSummary,
  type DocumentExtent,
  type LibrarySnapshot,
  type MovedDocumentCandidate,
  type ReviewSummary,
  type SearchResult,
} from "./lib/backend";
import { CommandPalette } from "./components/CommandPalette";
import type { PaletteEntry } from "./lib/commandPalette";
import { canNavBack, canNavForward, type NavLocation } from "./lib/navHistory";
// 最近书库 MRU(plan-library-mru):localStorage 纯函数,打开动作仍走
// openLibrary 的完整校验边界。
import {
  formatLastOpened,
  migrateLibraryMru,
  normalizeLibraryPathKey,
  removeLibraryMru,
  upsertLibraryMru,
  type LibraryMruEntry,
} from "./lib/libraryMru";
import { RELATED_MIN_SELECTION_CHARS } from "./lib/relatedFragments";
import { RelatedPassagesPopover, type RelatedPassagesStatus } from "./components/RelatedPassages";
// 库内链接悬停预览(plan-hover-preview):状态机在 lib,App 只做开关
// 条件(触屏/浮层竞争)与「打开」回放。
import { HoverPreviewCard } from "./components/HoverPreviewCard";
import { useHoverPreview } from "./lib/useHoverPreview";
// 富滚动条刻度层(plan-rich-scrollbar):纯映射在 lib,测量与点击语义在此。
import { ScrollMap } from "./components/ScrollMap";
import {
  buildScrollMapMarks,
  collectAnnotationScrollPoints,
  collectSearchScrollPoints,
  ttsRatioFromRect,
  type ScrollMapMark,
} from "./lib/scrollMap";
// 双链落地时的去重(plan-backlinks §3.4):resolveLibraryPath 的唯一实现在
// documentLinks.ts(与 Rust links.rs 契约对齐);markdown 展示/图片收集的唯一
// 实现在 splitView.ts(主栏与副栏共用),此处仅保留原调用名。
import { resolveLibraryPath } from "./lib/documentLinks";
import {
  clampSplitPos,
  collectReferencedImages as referencedImages,
  paneDisplayMarkdown as displayMarkdown,
  SPLIT_MEDIA_QUERY,
  SPLIT_POS_DEFAULT,
} from "./lib/splitView";
import { LinksPanel, type LinksPanelState } from "./components/LinksPanel";
import {
  CollectionMembershipPopover,
  CollectionsSection,
} from "./components/CollectionsSection";
import { createReadingTracker, type ReadingTracker } from "./lib/readingTracker";
import {
  ANNOTATION_COLORS,
  ANNOTATION_COLOR_NAME_MAX_CHARS,
  ANNOTATION_COLOR_WORDS,
  buildTextIndex,
  clearAnnotationMarks,
  collectElementText,
  findTextQuote,
  isAnnotationMarkKind,
  rangeFromOffsets,
  rangeFromTextIndex,
  rangeOffsetsWithinRoot,
  wrapRangeWithMark,
} from "./lib/annotations";
import {
  applyRelocatedAnnotation,
  captureRelocatedSelection,
  findRelocationRange,
  isRelocatableAnnotation,
  type QuoteBearingLocator,
} from "./lib/annotationRelocate";
import {
  dryRunTextQuoteAnchors,
  flattenEpubDocumentText,
  type RebindDryRunReport,
} from "./lib/rebindDryRun";
import {
  buildAnnotationsMarkdown,
  compareAnnotationSortKeys,
  type AnnotationSortKey,
} from "./lib/annotationExport";
import {
  buildAnnotationEnvelope,
  buildReadwiseCsv,
  getOrCreateDeviceId,
  parseAnnotationEnvelope,
  planAnnotationImport,
  serializeAnnotationEnvelope,
  type AnnotationImportPlan,
} from "./lib/annotationTransfer";
import { groupAnnotationsByDocument } from "./lib/annotationHub";
import { filterAnnotations, normalizeAnnotationQuery } from "./lib/annotationSearch";
import {
  buildBookmarkForContext,
  buildMarkFromPending,
  captureReaderSelection,
  type PendingSelection,
} from "./lib/annotationCapture";
import { useDocumentAnnotations } from "./lib/useDocumentAnnotations";
import { useReadAloud } from "./lib/useReadAloud";
// 聚焦模式(plan-focus-mode):spotlight/打字机共享驱动在 lib,
// 标尺是纯视觉组件;PDF 原版式无段落 DOM,三者一律不接线。
import { useFocusMode, type FocusContentKind } from "./lib/useFocusMode";
import { ReadingRuler } from "./components/ReadingRuler";
import { ReadAloudBar } from "./components/ReadAloudBar";
import {
  AnnotationEditBubble,
  AnnotationImportConfirm,
  AnnotationList,
  AnnotationLibraryPanel,
  AnnotationToolsPanel,
  SelectionToolbar,
  type AnnotationLibraryFilters,
  type AnnotationLibraryGroup,
  type AnnotationLibraryStatus,
  type AnnotationListSort,
  type LibraryDocumentOption,
  type LostDocumentEntry,
} from "./components/AnnotationUi";
import {
  CONTINUE_READING_WINDOW_MS,
  hasContinueCandidates,
  writeHomeBaseline,
  type HomeProgress,
} from "./lib/homeData";
// 阅读时间预估(plan-reading-time-estimate):纯函数在 lib,数据装配在此。
import {
  CALIBRATION_WINDOW_MS,
  DEFAULT_READING_SPEED,
  aggregateActiveSeconds,
  calibrateReadingSpeed,
  estimateReadingMinutes,
  estimateRemainingMinutes,
  extentSupportsEstimate,
  formatReadingEstimate,
  formatRemainingEstimate,
  highWaterCoverage,
  type ReadingSpeed,
} from "./lib/readingTimeEstimate";
import { extractToc, type TocItem } from "./lib/markdown";
import {
  listLibraryReadingPositions,
  readReadingPosition,
  writeReadingPosition,
  type ReadingPosition,
} from "./lib/readingPositions";
// 读完接着读(plan-read-next):三级回落纯逻辑在 lib,App 只负责哨兵
// 触发、会话级 dismiss 与朗读互斥。
import {
  READ_NEXT_DWELL_MS,
  resolveReadNextSuggestion,
  shouldTriggerReadNext,
  type ReadNextSuggestion,
} from "./lib/readNext";
import { documentTreeName } from "./lib/tree";
import { buildTocHeat, type TocHeatResult } from "./lib/tocHeat";
import {
  buildPdfTocCoverage,
  coverageFromRatios,
  measureHeadingRatios,
} from "./lib/tocCoverage";
import { buildWebRouteUrl, parseWebRoute } from "./lib/webRouting";
// Web 段落分享深链(plan-web-text-deeplink):归一定位纯函数在 lib,
// 高亮复用朗读同款 CSS Custom Highlight(第二注册名,零 DOM 侵入)。
import { locateNormalizedText, normalizeShareText } from "./lib/textLocate";
import {
  applySentenceHighlight,
  clearSentenceHighlight,
} from "./lib/sentenceHighlight";
import { scrollContainerByRatio, scrollElementWithinContainer, scrollToOffsetWithinElement } from "./lib/scroll";
import {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  useReaderStore,
  type ReaderFontFamily,
  type ReaderMotionLevel,
} from "./store/useReaderStore";
import { cancelMotion, runMotion } from "./lib/motion";
import type { PdfPagePosition, PdfReaderHandle } from "./components/PdfReader";
import type { HomeReviewSummary } from "./components/HomeView";
import type { QuoteCardSource } from "./components/QuoteCardDialog";
import type { ReviewSession } from "./components/ReviewView";

const LAST_LIBRARY_KEY = "reade-last-library";
const IS_WEB_RUNTIME = APP_RUNTIME === "web";
/** 命令面板条目 + 执行动作(plan-command-palette §3.3):匹配纯数据进 lib,动作留在 App。 */
type AppPaletteEntry = PaletteEntry & { run: () => void };
/** data-annotation-id of the temporary relocate preview mark (§5.6 B). */
const RELOCATE_PREVIEW_ID = "reade-relocate-preview";
/** PDF 阅读模式的大小上限,与 PdfReader 工具栏的禁用判定保持一致(RA-D5)。 */
const PDF_READING_MODE_MAX_BYTES = 128 * 1024 * 1024;
const EXTERNAL_PROTOCOL = /^(?:https?:|mailto:)/i;
/** 深链高亮的 CSS Custom Highlight 注册名(与 TTS 同 API 不同名,DL-D3)。 */
const DEEPLINK_HIGHLIGHT_NAME = "reade-deeplink";
/** 深链高亮驻留时长;到时移除注册即消失(一次性强调,不持久化)。 */
const DEEPLINK_HIGHLIGHT_MS = 2400;
const PdfReader = lazy(() => import("./components/PdfReader").then((module) => ({ default: module.PdfReader })));
const QuoteCardDialog = lazy(() => import("./components/QuoteCardDialog").then((module) => ({ default: module.QuoteCardDialog })));
const ReadNextCard = lazy(() => import("./components/ReadNextCard").then((module) => ({ default: module.ReadNextCard })));
const SecondaryPane = lazy(() => import("./components/SecondaryPane").then((module) => ({ default: module.SecondaryPane })));
const StatsView = lazy(() => import("./components/StatsView").then((module) => ({ default: module.StatsView })));
const HomeView = lazy(() => import("./components/HomeView").then((module) => ({ default: module.HomeView })));
const ReviewView = lazy(() => import("./components/ReviewView").then((module) => ({ default: module.ReviewView })));
const AnnotationHubView = lazy(() => import("./components/AnnotationHubView").then((module) => ({ default: module.AnnotationHubView })));
const BookDigestView = lazy(() => import("./components/BookDigestView").then((module) => ({ default: module.BookDigestView })));

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

/** 本地日期戳(YYYYMMDD),用于导出文件的默认文件名。 */
function transferDateStamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
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

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Search roots for the §5.6 relocate pass, matching where the annotation's
 * quote could live. PDF roots are ordered by page proximity to the stored
 * page so the nearest rendered occurrence wins.
 */
function collectRelocationRoots(
  article: HTMLElement,
  locator: QuoteBearingLocator,
): HTMLElement[] {
  if (locator.kind === "markdown") {
    const root = article.querySelector<HTMLElement>(".markdown-body");
    return root ? [root] : [];
  }
  if (locator.kind === "epub") {
    const root = article.querySelector<HTMLElement>(".epub-reader");
    return root ? [root] : [];
  }
  const pageSelector = locator.view === "reading" ? ".pdf-reading-page" : ".pdf-page";
  const entries: Array<{ page: number; root: HTMLElement }> = [];
  for (const page of Array.from(article.querySelectorAll<HTMLElement>(pageSelector))) {
    const root =
      locator.view === "reading"
        ? page.querySelector<HTMLElement>(".markdown-body")
        : page.querySelector<HTMLElement>(".pdf-text-layer, .textLayer");
    if (!root || !root.textContent?.trim()) continue;
    const pageNumber = Number(page.dataset.pageNumber);
    entries.push({ page: Number.isFinite(pageNumber) ? pageNumber : 0, root });
  }
  entries.sort(
    (a, b) => Math.abs(a.page - locator.page) - Math.abs(b.page - locator.page),
  );
  return entries.map((entry) => entry.root);
}

/** 欢迎页"最近打开"列表（plan-library-mru §2.2）：桌面专属。 */
function WelcomeRecentLibraries({
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

function Welcome({
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
function LibrarySwitcherPopover({
  entries,
  currentKey,
  unavailableKeys,
  onOpen,
  onRemove,
  onBrowse,
  onClose,
}: {
  entries: LibraryMruEntry[];
  currentKey: string | null;
  unavailableKeys: ReadonlySet<string>;
  onOpen: (entry: LibraryMruEntry) => void;
  onRemove: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="library-switcher reade-motion-panel"
      role="dialog"
      aria-label="最近书库"
    >
      <div className="settings-heading">
        <span>最近书库</span>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="关闭最近书库"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <ul className="library-switcher-list">
        {entries.map((entry) => {
          const key = normalizeLibraryPathKey(entry.path);
          const missing = unavailableKeys.has(key);
          const isCurrent = currentKey === key;
          const meta = [
            entry.documentCount !== null ? `${entry.documentCount.toLocaleString()} 篇` : null,
            formatLastOpened(entry.lastOpenedAt),
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li
              className={`library-switcher-item${missing ? " library-switcher-item--missing" : ""}`}
              key={key}
            >
              <button
                className="library-switcher-open"
                type="button"
                disabled={missing}
                aria-current={isCurrent ? "true" : undefined}
                title={missing ? "路径不可访问" : entry.path}
                // 点当前库无需重扫,关掉菜单即可。
                onClick={() => (isCurrent ? onClose() : onOpen(entry))}
              >
                <span className="library-switcher-name">
                  {entry.title}
                  {isCurrent && <span className="library-switcher-badge">当前</span>}
                </span>
                <span className="library-switcher-meta">
                  {missing ? "路径不可访问" : meta || entry.path}
                </span>
              </button>
              {!isCurrent && (
                <button
                  className="icon-button library-switcher-remove"
                  type="button"
                  aria-label={`从最近书库中移除 ${entry.title}`}
                  title="从列表中移除"
                  onClick={() => onRemove(entry.path)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button className="library-switcher-browse" type="button" onClick={onBrowse}>
        <FolderOpen size={14} aria-hidden="true" />
        选择新文件夹…
      </button>
    </div>
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
  focusUnavailableReason = null,
}: {
  open: boolean;
  onClose: () => void;
  onNotice: (message: string) => void;
  /** 聚焦模式在当前内容不适用的原因(如 PDF 原版式);null = 可用。 */
  focusUnavailableReason?: string | null;
}) {
  const settings = useReaderStore((state) => state.readingSettings);
  const update = useReaderStore((state) => state.updateReadingSettings);
  const motionLevel = useReaderStore((state) => state.motionLevel);
  const setMotionLevel = useReaderStore((state) => state.setMotionLevel);
  const fuzzyAnnotationAnchoring = useReaderStore((state) => state.fuzzyAnnotationAnchoring);
  const setFuzzyAnnotationAnchoring = useReaderStore(
    (state) => state.setFuzzyAnnotationAnchoring,
  );
  const showScrollMap = useReaderStore((state) => state.showScrollMap);
  const setShowScrollMap = useReaderStore((state) => state.setShowScrollMap);
  const focusSpotlight = useReaderStore((state) => state.focusSpotlight);
  const setFocusSpotlight = useReaderStore((state) => state.setFocusSpotlight);
  const typewriterScroll = useReaderStore((state) => state.typewriterScroll);
  const setTypewriterScroll = useReaderStore((state) => state.setTypewriterScroll);
  const readingRuler = useReaderStore((state) => state.readingRuler);
  const setReadingRuler = useReaderStore((state) => state.setReadingRuler);
  const readNextEnabled = useReaderStore((state) => state.readNextEnabled);
  const setReadNextEnabled = useReaderStore((state) => state.setReadNextEnabled);
  const annotationColorNames = useReaderStore((state) => state.annotationColorNames);
  const setAnnotationColorName = useReaderStore((state) => state.setAnnotationColorName);
  const resetAnnotationColorNames = useReaderStore(
    (state) => state.resetAnnotationColorNames,
  );
  const resetReaderPreferences = useReaderStore((state) => state.resetReaderPreferences);
  const clearDocumentCache = useReaderStore((state) => state.clearDocumentCache);
  const [clearingCache, setClearingCache] = useState(false);
  // 命名输入草稿:空值回落默认只在提交(blur/Enter)时发生,而非每个键击。
  const [colorNameDrafts, setColorNameDrafts] = useState(annotationColorNames);
  useEffect(() => {
    setColorNameDrafts(annotationColorNames);
  }, [annotationColorNames]);

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

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">标注模糊定位</legend>
        <div className="motion-level-control" role="group" aria-label="标注模糊定位开关">
          {([
            [false, "关闭"],
            [true, "开启"],
          ] as const).map(([enabled, label]) => (
            <button
              type="button"
              key={label}
              aria-pressed={fuzzyAnnotationAnchoring === enabled}
              className={fuzzyAnnotationAnchoring === enabled ? "active" : undefined}
              onClick={() => setFuzzyAnnotationAnchoring(enabled)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          文档修改后按相似度匹配失锚标注；可能把标注定位到相似但不同的文本。
        </p>
      </fieldset>

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">文档地图</legend>
        <div className="motion-level-control" role="group" aria-label="文档地图开关">
          {([
            [false, "关闭"],
            [true, "开启"],
          ] as const).map(([enabled, label]) => (
            <button
              type="button"
              key={label}
              aria-pressed={showScrollMap === enabled}
              className={showScrollMap === enabled ? "active" : undefined}
              onClick={() => setShowScrollMap(enabled)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          正文右缘的刻度层：标出标注四色、书签、搜索命中与朗读位置，点击可跳转。
        </p>
      </fieldset>

      <fieldset className="setting-row motion-setting">
        <legend className="setting-label">读完接着读</legend>
        <div className="motion-level-control" role="group" aria-label="读完接着读开关">
          {([
            [false, "关闭"],
            [true, "开启"],
          ] as const).map(([enabled, label]) => (
            <button
              type="button"
              key={label}
              aria-pressed={readNextEnabled === enabled}
              className={readNextEnabled === enabled ? "active" : undefined}
              onClick={() => setReadNextEnabled(enabled)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          滚动到文档末尾时推荐下一篇：合集顺序优先，其次同文件夹，再次互链最多的文档。
        </p>
      </fieldset>

      <fieldset className="setting-row motion-setting focus-mode-setting">
        <legend className="setting-label">聚焦模式</legend>
        {([
          ["段落聚焦", focusSpotlight, setFocusSpotlight, "focus-spotlight"],
          ["打字机滚动", typewriterScroll, setTypewriterScroll, "typewriter-scroll"],
          ["阅读标尺", readingRuler, setReadingRuler, "reading-ruler"],
        ] as const).map(([label, value, setValue, key]) => (
          <div className="focus-mode-row" key={key}>
            <span className="focus-mode-row-label">{label}</span>
            <div
              className="motion-level-control"
              role="group"
              aria-label={`${label}开关`}
            >
              {([
                [false, "关闭"],
                [true, "开启"],
              ] as const).map(([enabled, optionLabel]) => (
                <button
                  type="button"
                  key={optionLabel}
                  aria-pressed={value === enabled}
                  className={value === enabled ? "active" : undefined}
                  disabled={focusUnavailableReason !== null}
                  onClick={() => setValue(enabled)}
                >
                  {optionLabel}
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="setting-hint">
          {focusUnavailableReason ??
            "段落聚焦淡化当前段落以外的内容；打字机滚动把阅读行保持在视口中部；阅读标尺是跟随指针的横向色带。"}
        </p>
      </fieldset>

      <fieldset className="setting-row color-names-setting">
        <legend className="setting-label">标注颜色命名</legend>
        <div className="color-name-grid">
          {ANNOTATION_COLORS.map((color) => (
            <label className="color-name-row" key={color}>
              <span
                className={`annotation-color-dot annotation-color-dot--${color}`}
                aria-hidden="true"
              />
              <input
                type="text"
                className="color-name-input"
                value={colorNameDrafts[color]}
                maxLength={ANNOTATION_COLOR_NAME_MAX_CHARS}
                aria-label={`${ANNOTATION_COLOR_WORDS[color]}色的语义名`}
                onChange={(event) =>
                  setColorNameDrafts((drafts) => ({
                    ...drafts,
                    [color]: event.target.value,
                  }))
                }
                onBlur={(event) => setAnnotationColorName(color, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </label>
          ))}
        </div>
        <p className="setting-hint">
          命名显示在颜色选择、筛选与图例中；清空某项则恢复该色默认名。
        </p>
        <button
          className="settings-reset color-names-reset"
          type="button"
          onClick={resetAnnotationColorNames}
        >
          <RotateCcw size={13} aria-hidden="true" />
          恢复默认命名
        </button>
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

/**
 * 「界面风格」popover: one swatch tile per theme series (5.5). Selecting a tile
 * applies the series immediately, keeping the current light/dark mode; the
 * series' typography preset lands with it (D4) and a hint line explains the
 * serif preset. Reuses the settings-popover / reade-motion-panel pattern.
 */
export function ThemeStylePicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const theme = useReaderStore((state) => state.theme);
  const setThemeSeries = useReaderStore((state) => state.setThemeSeries);
  const [hint, setHint] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const activeSeries = THEME_META[theme].series;
  const mode = THEME_META[theme].mode;

  useEffect(() => {
    if (!open) setHint(null);
  }, [open]);

  const pickSeries = (series: ThemeSeriesId, anchor?: HTMLElement | null) => {
    if (series === activeSeries) return;
    // 墨水扩散以色卡中心为圆心(TT-D3 定稿修订);等值早退在上一行,
    // 不会留下陈旧 origin。
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      setNextThemeTransitionOrigin({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    }
    setThemeSeries(series);
    setHint(
      SERIES_FONT_PRESET[series] === "serif"
        ? "已切换为书刊衬线，可在阅读设置中调整"
        : null,
    );
  };

  // Radio-group keyboard pattern: arrows cycle (with wrap) and select as they
  // move — the instant-preview behavior of the tiles — Home/End jump.
  const onGroupKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const { key } = event;
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(key)) {
      return;
    }
    event.preventDefault();
    const focused = groupRef.current?.querySelector<HTMLButtonElement>(
      ".theme-style-tile:focus",
    );
    const focusedIndex = THEME_SERIES.findIndex(
      (series) => series.id === focused?.dataset.series,
    );
    const currentIndex =
      focusedIndex >= 0
        ? focusedIndex
        : THEME_SERIES.findIndex((series) => series.id === activeSeries);
    let nextIndex = currentIndex;
    if (key === "Home") nextIndex = 0;
    else if (key === "End") nextIndex = THEME_SERIES.length - 1;
    else {
      const delta = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
      nextIndex = (currentIndex + delta + THEME_SERIES.length) % THEME_SERIES.length;
    }
    const nextSeries = THEME_SERIES[nextIndex].id;
    const tile = groupRef.current?.querySelector<HTMLButtonElement>(
      `.theme-style-tile[data-series="${nextSeries}"]`,
    );
    tile?.focus();
    pickSeries(nextSeries, tile);
  };

  return (
    <div
      className="settings-popover reade-motion-panel theme-style-popover"
      role="dialog"
      aria-label="界面风格"
      aria-hidden={!open}
      data-open={open}
      inert={!open}
    >
      <div className="settings-heading">
        <span>界面风格</span>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭界面风格">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={groupRef}
        className="theme-style-options"
        role="radiogroup"
        aria-label="界面风格系列"
        onKeyDown={onGroupKeyDown}
      >
        {THEME_SERIES.map((series) => {
          const meta = THEME_META[`${series.id}-${mode}`];
          const active = series.id === activeSeries;
          return (
            <button
              key={series.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-series={series.id}
              tabIndex={active ? 0 : -1}
              className={`theme-style-tile${active ? " active" : ""}`}
              aria-label={`${series.label}系列${active ? "（当前使用）" : ""}`}
              onClick={(event) => pickSeries(series.id, event.currentTarget)}
            >
              <span className="theme-style-swatch" aria-hidden="true">
                <i style={{ background: meta.swatch.paper }} />
                <i style={{ background: meta.swatch.chrome }} />
                <i style={{ background: meta.swatch.accent }} />
              </span>
              <span className="theme-style-name">{series.label}</span>
            </button>
          );
        })}
      </div>
      {hint && (
        <p className="theme-style-hint" role="status">
          {hint}
        </p>
      )}
    </div>
  );
}

export function TocNavigation({
  items,
  activeId,
  onSelect,
  heat,
  reachedIds,
  onSelectTop,
  estimateLine,
}: {
  items: TocItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** 方案三 T1 批注密度;不传时渲染与传统输出逐字节一致。 */
  heat?: TocHeatResult | null;
  /** 方案三 T2 已读覆盖:已达条目集合;缓存未就绪传 null 即全部未达。 */
  reachedIds?: ReadonlySet<string> | null;
  /** 文首/失效章节说明行的跳转目标(滚动到文档顶部)。 */
  onSelectTop?: () => void;
  /** 阅读时间预估(plan-reading-time-estimate §3.3):目录顶部一行;
      不传时渲染与传统输出逐字节一致。 */
  estimateLine?: string | null;
}) {
  return (
    <div className="toc-section">
      {estimateLine ? <p className="toc-estimate">{estimateLine}</p> : null}
      {heat && heat.unassignedCount > 0 ? (
        <button type="button" className="toc-unassigned" onClick={onSelectTop}>
          文首或已变更章节另有 {heat.unassignedCount} 条标注
        </button>
      ) : null}
      {items.length ? (
        <ol className="toc-list">
          {items.map((item, index) => {
            const heatEntry = heat?.byId.get(item.id);
            const heatLabel = heatEntry ? `本节 ${heatEntry.count} 条标注` : null;
            const reached = Boolean(reachedIds?.has(item.id));
            return (
              <li key={`${item.id}:${index}`}>
                <a
                  className={`toc-link${activeId === item.id ? " active" : ""}${
                    reached ? " is-reached" : ""
                  }${heatEntry ? " has-heat" : ""}`}
                  style={{ "--toc-depth": item.level } as CSSProperties}
                  href={`#${item.id}`}
                  aria-current={activeId === item.id ? "location" : undefined}
                  title={heatLabel ? `${item.title}（${heatLabel}）` : item.title}
                  aria-label={heatLabel ? `${item.title}，${heatLabel}` : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    onSelect(item.id);
                  }}
                >
                  {item.title}
                  {heatEntry ? (
                    <span
                      className="toc-heat"
                      data-level={heatEntry.level}
                      aria-hidden="true"
                    />
                  ) : null}
                </a>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="toc-empty">这篇文档没有可导航的标题。</p>
      )}
    </div>
  );
}

type SidePanelTab = "toc" | "annotations" | "library" | "links";

function SidePanel({
  tab,
  onTabChange,
  tocItems,
  activeId,
  onSelectHeading,
  tocHeat,
  tocReachedIds,
  onSelectDocumentTop,
  tocEstimateLine,
  annotations,
  brokenIds,
  approximateIds,
  annotationsLoading,
  annotationSort,
  onAnnotationSortChange,
  onExportAnnotations,
  onSelectAnnotation,
  onDeleteAnnotation,
  onEditAnnotationNote,
  onChangeAnnotationColor,
  onRelocateAnnotation,
  onGenerateAnnotationCard,
  onCompileAnnotationsDigest,
  onClearAnnotations,
  linksState,
  onSelectLinkDocument,
  onPreviewLinkTarget,
  onPreviewLinkCancel,
  libraryStatus,
  libraryGroups,
  libraryError,
  currentPath,
  lostDocuments,
  libraryDocuments,
  libraryFilters,
  onLibraryFiltersChange,
  libraryFilterActive,
  onDryRunRebind,
  onRebindLostDocument,
  onRefreshLibraryAnnotations,
  onExportLibraryAnnotations,
  onExportLibraryGroup,
  onExportLibraryJson,
  onExportLibraryCsv,
  onImportLibraryAnnotations,
  onSelectLibraryAnnotation,
  onOpenLibraryHub,
}: {
  tab: SidePanelTab;
  onTabChange: (tab: SidePanelTab) => void;
  tocItems: TocItem[];
  activeId: string | null;
  onSelectHeading: (id: string) => void;
  tocHeat?: TocHeatResult | null;
  tocReachedIds?: ReadonlySet<string> | null;
  onSelectDocumentTop?: () => void;
  tocEstimateLine?: string | null;
  annotations: Annotation[];
  brokenIds: Set<string>;
  approximateIds: Set<string>;
  annotationsLoading: boolean;
  annotationSort: AnnotationListSort;
  onAnnotationSortChange: (sort: AnnotationListSort) => void;
  onExportAnnotations: () => void;
  onSelectAnnotation: (annotation: Annotation) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  onEditAnnotationNote: (annotation: Annotation) => void;
  onChangeAnnotationColor: (annotation: Annotation, color: AnnotationColor) => void;
  onRelocateAnnotation: (annotation: Annotation) => void;
  onGenerateAnnotationCard?: (annotation: Annotation) => void;
  /** 全书回顾编纂(plan-book-digest):标注 tab 工具条入口。 */
  onCompileAnnotationsDigest?: () => void;
  onClearAnnotations: () => void;
  /** 「链接」tab(BL-D3):只读双链数据与跳转。 */
  linksState: LinksPanelState;
  onSelectLinkDocument: (relativePath: string) => void;
  /** 链接行悬停预览(plan-hover-preview HP-D5),可选。 */
  onPreviewLinkTarget?: (
    relativePath: string,
    anchor: HTMLElement,
    trigger: "hover" | "focus",
  ) => void;
  onPreviewLinkCancel?: () => void;
  libraryStatus: AnnotationLibraryStatus;
  libraryGroups: AnnotationLibraryGroup[];
  libraryError: string | null;
  currentPath: string | null;
  lostDocuments: LostDocumentEntry[];
  libraryDocuments: LibraryDocumentOption[];
  libraryFilters: AnnotationLibraryFilters;
  onLibraryFiltersChange: (filters: AnnotationLibraryFilters) => void;
  libraryFilterActive: boolean;
  onDryRunRebind: (oldPath: string, newPath: string) => Promise<RebindDryRunReport>;
  onRebindLostDocument: (oldPath: string, newPath: string) => Promise<void>;
  onRefreshLibraryAnnotations: () => void;
  onExportLibraryAnnotations: () => void;
  onExportLibraryGroup: (group: AnnotationLibraryGroup) => void;
  onExportLibraryJson: () => void;
  onExportLibraryCsv: () => void;
  onImportLibraryAnnotations: () => void;
  onSelectLibraryAnnotation: (annotation: Annotation) => void;
  onOpenLibraryHub?: () => void;
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
          aria-selected={tab === "links"}
          className={tab === "links" ? "active" : ""}
          onClick={() => onTabChange("links")}
        >
          链接
          {linksState.status === "ready" && linksState.data.backlinks.length > 0 ? (
            <span className="side-panel-count">
              {linksState.data.backlinks.reduce((sum, entry) => sum + entry.count, 0)}
            </span>
          ) : null}
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
        <TocNavigation
          items={tocItems}
          activeId={activeId}
          onSelect={onSelectHeading}
          heat={tocHeat}
          reachedIds={tocReachedIds}
          onSelectTop={onSelectDocumentTop}
          estimateLine={tocEstimateLine}
        />
      ) : tab === "annotations" ? (
        <AnnotationList
          annotations={annotations}
          brokenIds={brokenIds}
          approximateIds={approximateIds}
          loading={annotationsLoading}
          sort={annotationSort}
          onSortChange={onAnnotationSortChange}
          onExport={onExportAnnotations}
          onSelect={onSelectAnnotation}
          onDelete={onDeleteAnnotation}
          onEditNote={onEditAnnotationNote}
          onChangeColor={onChangeAnnotationColor}
          onRelocate={onRelocateAnnotation}
          onGenerateCard={onGenerateAnnotationCard}
          onCompileDigest={onCompileAnnotationsDigest}
          onClearAll={onClearAnnotations}
        />
      ) : tab === "links" ? (
        <LinksPanel
          state={linksState}
          onSelectDocument={onSelectLinkDocument}
          onPreviewTarget={onPreviewLinkTarget}
          onPreviewCancel={onPreviewLinkCancel}
        />
      ) : (
        <AnnotationLibraryPanel
          status={libraryStatus}
          groups={libraryGroups}
          error={libraryError}
          currentPath={currentPath}
          lostDocuments={lostDocuments}
          documents={libraryDocuments}
          filters={libraryFilters}
          onFiltersChange={onLibraryFiltersChange}
          filterActive={libraryFilterActive}
          onDryRunRebind={onDryRunRebind}
          onRebindLostDocument={onRebindLostDocument}
          onRefresh={onRefreshLibraryAnnotations}
          onExport={onExportLibraryAnnotations}
          onExportGroup={onExportLibraryGroup}
          onExportJson={onExportLibraryJson}
          onExportCsv={onExportLibraryCsv}
          onImport={onImportLibraryAnnotations}
          onSelect={onSelectLibraryAnnotation}
          onOpenHub={onOpenLibraryHub}
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
  const fuzzyAnchoring = useReaderStore((state) => state.fuzzyAnnotationAnchoring);
  const showScrollMap = useReaderStore((state) => state.showScrollMap);
  const focusSpotlight = useReaderStore((state) => state.focusSpotlight);
  const typewriterScroll = useReaderStore((state) => state.typewriterScroll);
  const readingRuler = useReaderStore((state) => state.readingRuler);
  const readNextEnabled = useReaderStore((state) => state.readNextEnabled);
  // 书架视图(plan-bookshelf-covers BC-D4):库 tab 的树/书架切换。
  const libraryViewMode = useReaderStore((state) => state.libraryViewMode);
  const setLibraryViewMode = useReaderStore((state) => state.setLibraryViewMode);
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
  const setThemeSeries = useReaderStore((state) => state.setThemeSeries);
  const clearError = useReaderStore((state) => state.clearError);
  const applyDocumentIndexStatus = useReaderStore((state) => state.applyDocumentIndexStatus);
  const setIndexProgress = useReaderStore((state) => state.setIndexProgress);
  const retryCurrentDocumentIndex = useReaderStore((state) => state.retryCurrentDocumentIndex);
  const activeView = useReaderStore((state) => state.activeView);
  const setActiveView = useReaderStore((state) => state.setActiveView);
  const ttsRate = useReaderStore((state) => state.ttsRate);
  const ttsVoiceName = useReaderStore((state) => state.ttsVoiceName);
  const setTtsRate = useReaderStore((state) => state.setTtsRate);
  const setTtsVoiceName = useReaderStore((state) => state.setTtsVoiceName);
  const navHistory = useReaderStore((state) => state.navHistory);
  const recordNavLocation = useReaderStore((state) => state.recordNavLocation);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const [annotationPanelOpen, setAnnotationPanelOpen] = useState(false);
  // 最近书库 MRU(plan-library-mru):列表、失效探测结果与侧栏菜单开关。
  // 挂载时做一次旧单值键播种迁移;Web 端无文件系统语义,恒空。
  const [libraryMru, setLibraryMru] = useState<LibraryMruEntry[]>(() =>
    IS_WEB_RUNTIME ? [] : migrateLibraryMru(),
  );
  const [mruUnavailable, setMruUnavailable] = useState<ReadonlySet<string>>(new Set());
  const [librarySwitcherOpen, setLibrarySwitcherOpen] = useState(false);
  // 合集(CO-D2):topbar popover 开关;写操作后 version 递增驱动分区重拉。
  const [collectionsPopoverOpen, setCollectionsPopoverOpen] = useState(false);
  const [collectionsVersion, setCollectionsVersion] = useState(0);
  // 命令面板(plan-command-palette):开关、打开时拉取的合集快照、
  // 以及"切换到合集"对侧栏分区的展开请求(CP-D2)。
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteCollections, setPaletteCollections] = useState<CollectionSummary[]>([]);
  const [collectionsReveal, setCollectionsReveal] = useState<
    { id: string; token: number } | null
  >(null);
  // 分栏对照(plan-split-view,SP-D1):session-only App state,不进 store。
  // splitState 在窄窗退化时保留,窗口恢复 ≥1080px 自动回到分栏(SP-D6)。
  const [splitState, setSplitState] = useState<{ path: string } | null>(null);
  const [splitPos, setSplitPos] = useState(SPLIT_POS_DEFAULT);
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
  // 金句卡片浮层(QC-D5):引文与出处捕获进 state,选区随后即可释放。
  const [quoteCardSource, setQuoteCardSource] = useState<QuoteCardSource | null>(null);
  // 全书回顾编纂(plan-book-digest BD-D1):reader 之上的全屏 overlay,
  // 不进 ReaderView 枚举;数据全部来自当前文档已有 state(toc/标注)。
  const [bookDigestOpen, setBookDigestOpen] = useState(false);
  // 相关段落浮层(RP-D4):挂在工具条位置旁;请求带序号守卫防过期结果。
  const [relatedPassages, setRelatedPassages] = useState<
    | (RelatedPassagesStatus & { x: number; y: number })
    | null
  >(null);
  const relatedRequest = useRef(0);
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
  // Non-exact anchor hits (§5.6 weak hint): recomputed on every paint, like
  // the broken set, never persisted.
  const [markdownApproximateIds, setMarkdownApproximateIds] = useState<string[]>([]);
  const [readerApproximateIds, setReaderApproximateIds] = useState<string[]>([]);
  const approximateAnnotationIds = useMemo(
    () => new Set([...markdownApproximateIds, ...readerApproximateIds]),
    [markdownApproximateIds, readerApproximateIds],
  );
  // §5.5 fingerprint move candidates, kept so declined/ambiguous pairings can
  // surface in the lost-documents rebind list (§5.6 C).
  const [moveCandidates, setMoveCandidates] = useState<MovedDocumentCandidate[]>([]);
  // Pending relocate preview: the annotation keeps its original locator until
  // the user confirms; cancel removes the preview marks and changes nothing.
  const [relocatePreview, setRelocatePreview] = useState<{
    annotation: Annotation;
    captured: PendingSelection;
    fuzzyHit: boolean;
  } | null>(null);
  // §5.7 导入确认:dry-run 计划先展示,用户确认后才落库。
  const [importReview, setImportReview] = useState<{
    fileName: string | null;
    plan: AnnotationImportPlan;
  } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const compactLibraryLayout = useMediaQuery("(max-width: 640px)");
  /** ≥1080px 才允许分栏;窄窗自动退化、恢复宽度自动回来(SP-D6)。 */
  const splitWide = useMediaQuery(SPLIT_MEDIA_QUERY);
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
  // H0 阅读位置持久化:滚动 rAF 内只采样,真正的 localStorage 写入走
  // 500ms trailing debounce;PDF 在落盘时才做页面测量。
  const persistPositionTimer = useRef<number | null>(null);
  const pendingPositionSample = useRef<
    { root: string; path: string; kind: "scroll" | "pdf"; ratio: number } | null
  >(null);
  const pdfRestoreTimer = useRef<number | null>(null);
  const pendingAnnotationJump = useRef<Annotation | null>(null);
  const jumpRetryTimer = useRef<number | null>(null);
  const trackerRef = useRef<ReadingTracker | null>(null);
  const {
    annotations,
    loading: annotationsLoading,
    canUndo,
    reload: reloadAnnotations,
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
  // 深链定位消费一次;shareTextFragment 供 replaceWebRoute 在停留于
  // 深链文档期间保留 `#text=`(未命中时 URL 仍可再分享,DL-D4)。
  const pendingTextFragment = useRef<string | null>(
    initialWebRoute.current?.textFragment ?? null,
  );
  const shareTextFragment = useRef<{ path: string; text: string } | null>(
    initialWebRoute.current?.textFragment
      ? {
          path: initialWebRoute.current.documentPath,
          text: initialWebRoute.current.textFragment,
        }
      : null,
  );
  const deeplinkHighlightTimer = useRef<number | null>(null);
  const restoredLibrary = useRef(false);
  // H-D1 方案 A:桌面冷启动落点只判定一次;之后库刷新/切换维持
  // "自动打开第一篇"的现状行为。
  const coldStartDecided = useRef(false);
  // 5.5 文档移动检测:每个库快照只检测一次;同一对 old→new 在一次会话内
  // 只询问一次,避免监听刷新反复弹确认。
  const lastMoveCheckSnapshot = useRef<LibrarySnapshot | null>(null);
  const promptedMovePairs = useRef(new Set<string>());

  const currentDocument = useMemo(
    () => documents.find((document) => document.relativePath === currentPath) ?? null,
    [currentPath, documents],
  );
  const statsOpen = !IS_WEB_RUNTIME && activeView === "stats";
  const homeOpen = activeView === "home";
  const reviewOpen = activeView === "review";
  const annotationsOpen = activeView === "annotations";
  /** 任一全屏视图打开时,阅读面保持挂载但隐藏(stats 的既有挂载模式)。 */
  const overlayViewOpen = statsOpen || homeOpen || reviewOpen || annotationsOpen;
  const themeMode = THEME_META[theme].mode;
  // 回顾会话跨视图保留(App 内存 state):「打开原文」跳走后同日回来续接。
  const [reviewSession, setReviewSession] = useState<ReviewSession | null>(null);

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

  // 会话跟随当前文档;离开阅读面(统计或主页)时结束当前会话(顺带落盘)。
  const trackedFormat = currentDocument?.format ?? null;
  const trackedTitle = currentDocument?.title ?? null;
  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    if (activeView === "reader" && currentPath && trackedFormat) {
      tracker.openDocument({
        relativePath: currentPath,
        format: trackedFormat,
        title: trackedTitle,
      });
    } else {
      tracker.openDocument(null);
    }
  }, [activeView, currentPath, trackedFormat, trackedTitle]);

  // 主页「库内新动态」的 baseline 在离开主页时推进(方案 §3.3 ③):
  // 停留期间列表保持稳定,离开即视为已读完这批动态。
  const previousHomeOpen = useRef(false);
  useEffect(() => {
    if (previousHomeOpen.current && !homeOpen) {
      const rootPath = useReaderStore.getState().snapshot?.rootPath;
      if (rootPath) writeHomeBaseline(rootPath, Date.now());
    }
    previousHomeOpen.current = homeOpen;
  }, [homeOpen]);

  // 方案二 R1:主页④卡的数据探测。本地日界由前端计算后传给后端(后端不做
  // 时区推断);探测失败 → null → 卡整体不渲染,不留死 UI。
  const [homeReviewProbe, setHomeReviewProbe] = useState<ReviewSummary | null>(null);
  useEffect(() => {
    if (!homeOpen || !snapshot) return;
    let cancelled = false;
    const nowMs = Date.now();
    const dayStart = new Date(nowMs);
    dayStart.setHours(0, 0, 0, 0);
    reviewSummary(dayStart.getTime(), nowMs).then(
      (summary) => {
        if (!cancelled) setHomeReviewProbe(summary);
      },
      () => {
        if (!cancelled) setHomeReviewProbe(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [homeOpen, snapshot]);

  const homeReviewSummary = useMemo<HomeReviewSummary | null>(() => {
    if (!homeReviewProbe) return null;
    // 既无到期也无今日记录时不渲染卡片(从未使用回顾的用户不被打扰)。
    if (homeReviewProbe.dueCount <= 0 && homeReviewProbe.reviewedToday <= 0) return null;
    return {
      pendingCount: homeReviewProbe.dueCount,
      reviewedToday: homeReviewProbe.reviewedToday,
      onStart: () => setActiveView("review"),
    };
  }, [homeReviewProbe, setActiveView]);

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

  // 方案三 T1:批注密度归属(纯数据,零 DOM 测量),批注增删实时重算。
  // epub 的 TOC id 是 domId 哈希,由 EpubReader 的公开封装建立映射。
  const epubChapterTocIds = useMemo(() => {
    if (currentContent?.kind !== "epub") return undefined;
    return new Map(
      currentContent.document.chapters.map((chapter) => [
        chapter.id,
        epubChapterTocId(chapter.id),
      ]),
    );
  }, [currentContent]);

  const tocHeat = useMemo<TocHeatResult | null>(() => {
    if (!currentContent || !toc.length) return null;
    return buildTocHeat({
      items: toc,
      annotations,
      format: currentContent.kind,
      epubChapterTocIds,
    });
  }, [annotations, currentContent, epubChapterTocIds, toc]);

  // 方案三 T2:已读覆盖。持久化高水位(maxScrollRatio/maxPage)进内存 state,
  // 500ms 落盘节流时同步推进;标题纵向位置渲染后一次性测量并缓存。
  const [readingHighWater, setReadingHighWater] = useState<
    { path: string; maxScrollRatio: number; maxPage: number } | null
  >(null);
  const [headingRatios, setHeadingRatios] = useState<
    { path: string; ratios: Map<string, number> } | null
  >(null);

  useEffect(() => {
    const rootPath = snapshot?.rootPath;
    if (!currentPath || !rootPath) {
      setReadingHighWater(null);
      return;
    }
    const persisted = readReadingPosition(rootPath, currentPath);
    setReadingHighWater({
      path: currentPath,
      maxScrollRatio: persisted?.kind === "scroll" ? persisted.maxScrollRatio : 0,
      maxPage: persisted?.kind === "pdf" ? persisted.maxPage : 0,
    });
  }, [currentPath, snapshot?.rootPath]);

  /** 高水位随每次位置落盘推进(已被 500ms 节流,滚动热路径零新增工作)。 */
  const applyStoredHighWater = useCallback(
    (path: string, stored: ReadingPosition | null) => {
      if (!stored) return;
      setReadingHighWater((current) => {
        if (!current || current.path !== path) return current;
        const maxScrollRatio =
          stored.kind === "scroll"
            ? Math.max(current.maxScrollRatio, stored.maxScrollRatio)
            : current.maxScrollRatio;
        const maxPage =
          stored.kind === "pdf" ? Math.max(current.maxPage, stored.maxPage) : current.maxPage;
        if (
          maxScrollRatio === current.maxScrollRatio &&
          maxPage === current.maxPage
        ) {
          return current;
        }
        return { path: current.path, maxScrollRatio, maxPage };
      });
    },
    [],
  );

  // T2 测量点:渲染后在空闲期对 TOC 目标元素做一次 offset/scrollHeight 测量,
  // 内容(toc/currentContent)或排版参数变化时缓存失效重测;滚动路径不测量。
  useEffect(() => {
    setHeadingRatios(null);
    if (!currentPath || !toc.length) return;
    if (!currentContent || currentContent.kind === "pdf") return;
    const path = currentPath;
    const ids = toc.map((item) => item.id);
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const reader = readerRef.current;
      if (!reader) return;
      const ratios = measureHeadingRatios(reader, ids);
      if (ratios) setHeadingRatios({ path, ratios });
    };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(() => measure());
      return () => {
        cancelled = true;
        window.cancelIdleCallback(handle);
      };
    }
    const handle = window.setTimeout(measure, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [currentContent, currentPath, readingSettings, toc]);

  const tocReachedIds = useMemo<ReadonlySet<string> | null>(() => {
    if (!currentPath || !readingHighWater || readingHighWater.path !== currentPath) {
      return null;
    }
    if (currentContent?.kind === "pdf") {
      return buildPdfTocCoverage(
        toc,
        readingHighWater.maxPage > 0 ? readingHighWater.maxPage : null,
      );
    }
    if (!headingRatios || headingRatios.path !== currentPath) return null;
    return coverageFromRatios(headingRatios.ratios, readingHighWater.maxScrollRatio);
  }, [currentContent?.kind, currentPath, headingRatios, readingHighWater, toc]);

  const scrollToDocumentTop = useCallback(() => {
    const reader = readerRef.current;
    if (!reader) return;
    const behavior: ScrollBehavior = motionLevel === "off" ? "auto" : "smooth";
    if (behavior === "smooth" && typeof reader.scrollTo === "function") {
      reader.scrollTo({ top: 0, behavior });
    } else {
      reader.scrollTop = 0;
    }
    setCompactTocOpen(false);
  }, [motionLevel]);

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

  // ---- 阅读回退栈:出发点捕获(plan-nav-history NH-D1/NH-D2) ----
  /** PDF 记页+页内偏移(测量不可用退 scroll),markdown/EPUB 记容器滚动。 */
  const captureCurrentNavLocation = useCallback((): NavLocation | null => {
    const state = useReaderStore.getState();
    const path = state.currentPath;
    if (!path || !state.currentContent) return null;
    if (state.currentContent.kind === "pdf") {
      const position = pdfReaderHandleRef.current?.getPosition();
      if (position) {
        return {
          path,
          position: { kind: "pdf", page: position.page, offsetRatio: position.offsetRatio },
        };
      }
    }
    return {
      path,
      position: { kind: "scroll", scrollTop: readerRef.current?.scrollTop ?? 0 },
    };
  }, []);

  /** 跳转发生前记录出发点(恢复导航不经此路径,无需抑制标志)。 */
  const recordNavDeparture = useCallback(() => {
    const location = captureCurrentNavLocation();
    if (location) recordNavLocation(location);
  }, [captureCurrentNavLocation, recordNavLocation]);

  // 本地朗读(plan-read-aloud):hook 负责切句/队列/句级 mark 跟随,
  // App 只负责入口、控制条与 PDF 原版式引导(RA-D5)。
  const readAloud = useReadAloud({
    articleRef,
    readerRef,
    contentKind: currentContent?.kind ?? null,
    contentKey: currentPath,
    active: activeView === "reader",
    motionLevel,
    rate: ttsRate,
    voiceName: ttsVoiceName,
    languageHint: typeof navigator !== "undefined" ? navigator.language : null,
    onSentenceEnd: IS_WEB_RUNTIME
      ? undefined
      : () => trackerRef.current?.recordActivity(),
    onNotice: showNotice,
  });

  // Esc 分支与控制条的稳定引用(hook 返回的回调都是 identity-stable)。
  const { barOpen: readAloudBarOpen, stop: stopReadAloud } = readAloud;

  /** 朗读入口的禁用原因;null 即可用(RA-D1/RA-D5)。 */
  const readAloudDisabledReason = !readAloud.supported
    ? "此环境不支持语音合成"
    : !readAloud.voicesReady
      ? "正在加载本地语音…"
      : readAloud.voices.length === 0
        ? "未检测到本地语音，可在系统设置安装语音后重试"
        : currentContent?.kind === "pdf" &&
            (currentContent.indexStatus === "unsupported" ||
              currentContent.size > PDF_READING_MODE_MAX_BYTES)
          ? "此 PDF 不支持阅读模式，无法朗读"
          : null;

  const handleReadAloudButton = useCallback(() => {
    if (readAloud.barOpen) {
      readAloud.stop();
      return;
    }
    // PDF 原版式文本层按需加载,不直接朗读;引导一键切阅读模式(RA-D5)。
    if (
      currentContent?.kind === "pdf" &&
      pdfReaderHandleRef.current?.getMode() === "original"
    ) {
      showNotice("PDF 原版式暂不支持朗读，请切换到阅读模式后再开始。", {
        actionLabel: "切换阅读模式",
        onAction: () => pdfReaderHandleRef.current?.setMode("reading"),
      });
      return;
    }
    readAloud.start();
  }, [currentContent?.kind, readAloud, showNotice]);

  // 金句卡片入口 1(M1):实时选区 → 关工具条 → 打开预览浮层。
  const handleMakeCardFromSelection = useCallback(() => {
    if (!pendingSelection) return;
    setQuoteCardSource({
      quote: pendingSelection.text,
      sourceTitle:
        currentDocument?.title ?? (currentPath ? fileName(currentPath) : ""),
    });
    closeToolbar();
  }, [closeToolbar, currentDocument?.title, currentPath, pendingSelection]);

  /** 选区去空白后 ≥8 字符才可查相关段落(RP §3.3)。 */
  const canFindRelated = Boolean(
    pendingSelection &&
      pendingSelection.text.replace(/\s+/g, "").length >= RELATED_MIN_SELECTION_CHARS,
  );

  const closeRelatedPassages = useCallback(() => {
    relatedRequest.current += 1;
    setRelatedPassages(null);
  }, []);

  // 相关段落(RP-D4):点击触发,无防抖;序号守卫丢弃过期响应。
  const handleFindRelated = useCallback(() => {
    if (!pendingSelection) return;
    const text = pendingSelection.text;
    const padding = 12;
    const width = 400;
    const x = Math.min(
      Math.max(padding, window.innerWidth - width - padding),
      Math.max(padding, toolbarPos.x),
    );
    const y = Math.max(padding, Math.min(window.innerHeight - 240, toolbarPos.y + 44));
    closeToolbar();
    const request = ++relatedRequest.current;
    setRelatedPassages({ status: "loading", x, y });
    findRelatedPassages(text, currentPath).then(
      (results) => {
        if (relatedRequest.current === request) {
          setRelatedPassages({ status: "ready", results, x, y });
        }
      },
      (cause: unknown) => {
        if (relatedRequest.current === request) {
          setRelatedPassages({
            status: "error",
            message: cause instanceof Error ? cause.message : "相关段落检索失败",
            x,
            y,
          });
        }
      },
    );
  }, [closeToolbar, currentPath, pendingSelection, toolbarPos]);

  const handleSelectRelated = useCallback(
    (result: SearchResult) => {
      closeRelatedPassages();
      recordNavDeparture();
      void selectDocument(result.relativePath, result.locator);
    },
    [closeRelatedPassages, recordNavDeparture, selectDocument],
  );

  // ---- 库内链接悬停预览(plan-hover-preview) ----
  // 触屏无 hover 语义时不触发(HP-D8);任一会与卡片竞争的浮层打开时
  // 挂起计时器并收起已开卡片。
  const hoverCapable = useMediaQuery("(hover: hover)");
  const hoverPreviewSuppressed = Boolean(
    pendingSelection ||
      markEditor ||
      relatedPassages ||
      quoteCardSource ||
      commandPaletteOpen ||
      noteDraft ||
      relocatePreview ||
      importReview,
  );
  const hoverPreview = useHoverPreview({
    enabled: hoverCapable && !hoverPreviewSuppressed && activeView === "reader",
    currentPath,
    documents,
    articleRef,
  });
  const { previewTarget: hoverPreviewTarget, cancelPreview: hoverPreviewCancel } = hoverPreview;
  /** 侧栏链接行的悬停入口:目标已解析,fragment 数据未存,取文档开头。 */
  const handlePreviewPanelTarget = useCallback(
    (relativePath: string, anchor: HTMLElement, trigger: "hover" | "focus") => {
      hoverPreviewTarget(relativePath, null, anchor, trigger);
    },
    [hoverPreviewTarget],
  );

  // ---- 富滚动条刻度层(plan-rich-scrollbar) ----
  const [scrollMapMarks, setScrollMapMarks] = useState<ScrollMapMark[]>([]);
  const [ttsMapRatio, setTtsMapRatio] = useState<number | null>(null);

  // ---- 聚焦模式(plan-focus-mode) ----
  // PDF 视图模式经 onModeChange 外报:原版式没有段落 DOM,三开关置灰
  // 且效果整体不接线(FM-D4);阅读模式恢复可用。
  const [pdfViewMode, setPdfViewMode] = useState<"original" | "reading">("original");
  const focusContentKind: FocusContentKind | null = !currentContent
    ? null
    : currentContent.kind === "markdown"
      ? "markdown"
      : currentContent.kind === "epub"
        ? "epub"
        : pdfViewMode === "reading"
          ? "pdf-reading"
          : null;
  const focusUnavailableReason =
    currentContent?.kind === "pdf" && pdfViewMode === "original"
      ? "PDF 原版式没有段落结构，聚焦模式不适用；切换到阅读模式后可用。"
      : null;
  useFocusMode({
    readerRef,
    articleRef,
    enabledKind: activeView === "reader" ? focusContentKind : null,
    contentKey: `${currentPath ?? ""}::${pdfViewMode}`,
    spotlight: focusSpotlight,
    typewriter: typewriterScroll,
    // TTS 的滚动跟随优先(§3.4):控制条打开期间打字机让位。
    typewriterSuspended: readAloudBarOpen,
    motionLevel,
  });

  // ---- 分栏对照(plan-split-view) ----
  // 副栏的会话记忆由 App 持有:窄窗退化会卸载副栏组件,恢复分栏后仍能回位。
  const paneScrollMemory = useRef(new Map<string, number>());
  const panePdfMemory = useRef(new Map<string, PdfPagePosition>());
  const splitDragging = useRef(false);
  const splitDragFrame = useRef<number | null>(null);
  const pendingSplitPos = useRef<number | null>(null);
  /** 分栏实际渲染条件:已开启且窗口足够宽。 */
  const splitActive = splitState !== null && splitWide;

  const handleToggleSplit = useCallback(() => {
    setSplitState((current) => {
      if (current) return null;
      // 默认加载当前文档:同一文档两个位置对照零成本可用(SP-D4)。
      return currentPath ? { path: currentPath } : current;
    });
  }, [currentPath]);

  /** 文档树/搜索结果 Alt+点击 → 在副栏打开(SP-D4 入口 2)。 */
  const handleOpenSecondary = useCallback(
    (path: string) => {
      if (!splitWide) {
        showNotice("窗口宽度不足（需 ≥1080px），无法开启分栏。");
        return;
      }
      setSplitState({ path });
      setMobileLibraryOpen(false);
    },
    [showNotice, splitWide],
  );

  const handleSplitDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      splitDragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [],
  );

  const handleSplitDividerPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!splitDragging.current) return;
      const grid = event.currentTarget.parentElement;
      if (!grid) return;
      const rect = grid.getBoundingClientRect();
      if (rect.width <= 0) return;
      pendingSplitPos.current = clampSplitPos((event.clientX - rect.left) / rect.width);
      // rAF 节流:拖拽期间每帧最多一次布局写入(两栏 PDF 重排的成本可控)。
      if (splitDragFrame.current === null) {
        splitDragFrame.current = window.requestAnimationFrame(() => {
          splitDragFrame.current = null;
          if (pendingSplitPos.current !== null) setSplitPos(pendingSplitPos.current);
        });
      }
    },
    [],
  );

  const handleSplitDividerPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!splitDragging.current) return;
      splitDragging.current = false;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const handleSplitDividerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -0.02 : 0.02;
      setSplitPos((value) => clampSplitPos(value + delta));
    },
    [],
  );

  useEffect(
    () => () => {
      if (splitDragFrame.current !== null) cancelAnimationFrame(splitDragFrame.current);
    },
    [],
  );


  // ---- 命令面板(plan-command-palette) ----
  // 打开面板时拉一次合集(collectionsVersion 变化代表写操作,顺带重拉);
  // 失败静默为空,面板降级为文档 + 命令。
  useEffect(() => {
    setPaletteCollections([]);
  }, [snapshot?.rootPath]);

  useEffect(() => {
    if (!commandPaletteOpen || !snapshot) return;
    let cancelled = false;
    listCollections().then(
      (collections) => {
        if (!cancelled) setPaletteCollections(collections);
      },
      () => {
        if (!cancelled) setPaletteCollections([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [commandPaletteOpen, collectionsVersion, snapshot]);

  // 条目构建:文档 → 合集 → 命令(空查询默认顺序);命令只列当前可执行的
  // (CP-D3),动作全部复用既有回调,面板自身不新增任何能力。
  const paletteEntries = useMemo<AppPaletteEntry[]>(() => {
    const entries: AppPaletteEntry[] = documents.map((document) => ({
      kind: "document" as const,
      id: `doc:${document.relativePath}`,
      title: document.title,
      subtitle: document.relativePath,
      badge: document.format === "markdown" ? "MD" : document.format.toUpperCase(),
      run: () => {
        setMobileLibraryOpen(false);
        recordNavDeparture();
        void selectDocument(document.relativePath);
      },
    }));
    if (snapshot) {
      for (const collection of paletteCollections) {
        entries.push({
          kind: "collection",
          id: `col:${collection.id}`,
          title: collection.name,
          subtitle: `${collection.presentCount}/${collection.itemCount} 在库`,
          badge: "合集",
          run: () => {
            // 展开侧栏合集分区(搜索模式下分区隐藏,先清空搜索)。
            setSearchQuery("");
            if (compactLibraryLayout) setMobileLibraryOpen(true);
            setCollectionsReveal((current) => ({
              id: collection.id,
              token: (current?.token ?? 0) + 1,
            }));
          },
        });
      }
    }
    const commands: Array<AppPaletteEntry | null> = [
      {
        kind: "command" as const,
        id: "cmd:toggle-theme",
        title: themeMode === "light" ? "切换到深色主题" : "切换到浅色主题",
        keywords: "theme dark light 明暗 深色 浅色 主题",
        badge: "命令",
        run: toggleTheme,
      },
      ...THEME_SERIES.map((series) => ({
        kind: "command" as const,
        id: `cmd:series-${series.id}`,
        title: `界面风格：${series.label}`,
        keywords: "theme style series 主题 风格 系列",
        badge: "命令",
        run: () => setThemeSeries(series.id),
      })),
      snapshot
        ? {
            kind: "command" as const,
            id: "cmd:home",
            title: homeOpen ? "返回阅读" : "打开主页",
            keywords: "home 主页 首页",
            badge: "命令",
            run: () => {
              setActiveView(homeOpen ? "reader" : "home");
              setMobileLibraryOpen(false);
            },
          }
        : null,
      !IS_WEB_RUNTIME
        ? {
            kind: "command" as const,
            id: "cmd:stats",
            title: statsOpen ? "关闭阅读统计" : "打开阅读统计",
            keywords: "stats statistics 统计 时长",
            badge: "命令",
            run: () => {
              setActiveView(statsOpen ? "reader" : "stats");
              setMobileLibraryOpen(false);
            },
          }
        : null,
      currentContent && (splitState || splitWide)
        ? {
            kind: "command" as const,
            id: "cmd:split",
            title: splitState ? "退出分栏对照" : "开启分栏对照",
            keywords: "split view 分栏 对照 双栏",
            badge: "命令",
            run: handleToggleSplit,
          }
        : null,
      currentContent && !readAloudDisabledReason
        ? {
            kind: "command" as const,
            id: "cmd:read-aloud",
            title: readAloud.barOpen ? "停止朗读" : "开始朗读",
            keywords: "tts speech read aloud 朗读 语音",
            badge: "命令",
            run: handleReadAloudButton,
          }
        : null,
      {
        kind: "command" as const,
        id: "cmd:reading-settings",
        title: "打开阅读设置",
        keywords: "settings font size 设置 字号 行高",
        badge: "命令",
        run: () => {
          setSettingsOpen(true);
          setAnnotationPanelOpen(false);
        },
      },
      snapshot
        ? {
            kind: "command" as const,
            id: "cmd:focus-search",
            title: "聚焦全文搜索",
            keywords: "search find 搜索 检索",
            badge: "命令",
            run: () => {
              if (compactLibraryLayout) setMobileLibraryOpen(true);
              // 窄窗抽屉解除 inert 后才能聚焦,推迟到下一帧。
              window.requestAnimationFrame(() => searchRef.current?.focus());
            },
          }
        : null,
      snapshot
        ? {
            kind: "command" as const,
            id: "cmd:refresh-library",
            title: "刷新文档库",
            keywords: "refresh reload rescan 刷新 重扫",
            badge: "命令",
            run: () => void refreshLibrary(),
          }
        : null,
      !IS_WEB_RUNTIME
        ? {
            kind: "command" as const,
            id: "cmd:choose-library",
            title: "选择文档库",
            keywords: "open library folder 打开 书库 文件夹",
            badge: "命令",
            run: () => void chooseAndOpenLibrary(),
          }
        : null,
    ];
    for (const command of commands) {
      if (command) entries.push(command);
    }
    return entries;
  }, [
    chooseAndOpenLibrary,
    compactLibraryLayout,
    currentContent,
    documents,
    handleReadAloudButton,
    handleToggleSplit,
    homeOpen,
    paletteCollections,
    readAloud.barOpen,
    readAloudDisabledReason,
    recordNavDeparture,
    refreshLibrary,
    selectDocument,
    setActiveView,
    setSearchQuery,
    setThemeSeries,
    snapshot,
    splitState,
    splitWide,
    statsOpen,
    themeMode,
    toggleTheme,
  ]);

  const handleExecutePaletteEntry = useCallback((entry: AppPaletteEntry) => {
    setCommandPaletteOpen(false);
    entry.run();
  }, []);

  const readingScrollRatio = useCallback(() => {
    const reader = readerRef.current;
    if (!reader) return 0;
    const max = reader.scrollHeight - reader.clientHeight;
    return max > 0 ? reader.scrollTop / max : 0;
  }, []);

  /**
   * H0 写入支路的落盘端:scroll 类直接用采样时的 ratio(即使文档已切换,
   * 采样值自身仍是自洽的);pdf 类需要现场测量,仅当文档未变时执行。
   */
  const flushPendingPosition = useCallback(() => {
    const sample = pendingPositionSample.current;
    if (!sample) return;
    pendingPositionSample.current = null;
    if (sample.kind === "pdf") {
      if (useReaderStore.getState().currentPath !== sample.path) return;
      const position = pdfReaderHandleRef.current?.getPosition();
      if (!position) return;
      const stored = writeReadingPosition(sample.root, sample.path, {
        kind: "pdf",
        page: position.page,
        offsetRatio: position.offsetRatio,
      });
      applyStoredHighWater(sample.path, stored);
      return;
    }
    const stored = writeReadingPosition(sample.root, sample.path, {
      kind: "scroll",
      scrollRatio: sample.ratio,
    });
    applyStoredHighWater(sample.path, stored);
  }, [applyStoredHighWater]);

  /**
   * H0 恢复支路(pdf):PDF 页懒加载、阅读器组件本身经 Suspense 异步挂载,
   * 复用书签跳转的重试兜底模式,直到 restorePosition 命中或轮次耗尽。
   */
  const schedulePdfPositionRestore = useCallback(
    (path: string, position: PdfPagePosition) => {
      if (pdfRestoreTimer.current !== null) {
        window.clearTimeout(pdfRestoreTimer.current);
        pdfRestoreTimer.current = null;
      }
      const MAX_ROUNDS = 20;
      const attempt = (round: number) => {
        pdfRestoreTimer.current = null;
        if (useReaderStore.getState().currentPath !== path) return;
        const restored = pdfReaderHandleRef.current?.restorePosition(position) ?? false;
        if (restored || round >= MAX_ROUNDS) return;
        pdfRestoreTimer.current = window.setTimeout(() => attempt(round + 1), 200);
      };
      attempt(0);
    },
    [],
  );

  useEffect(() => {
    // 关闭前把尚未落盘的位置刷出去;卸载时同样兜底。
    const flushNow = () => {
      if (persistPositionTimer.current !== null) {
        window.clearTimeout(persistPositionTimer.current);
        persistPositionTimer.current = null;
      }
      flushPendingPosition();
    };
    window.addEventListener("pagehide", flushNow);
    return () => {
      window.removeEventListener("pagehide", flushNow);
      flushNow();
      if (pdfRestoreTimer.current !== null) {
        window.clearTimeout(pdfRestoreTimer.current);
        pdfRestoreTimer.current = null;
      }
    };
  }, [flushPendingPosition]);

  // ---- 阅读回退栈:恢复与前进/后退(plan-nav-history,捕获函数在前文) ----
  /**
   * 恢复:scroll 类种子进会话 scrollPositions(跨文档交给既有 layout
   * effect,同文档直接赋值);PDF 走既有重试恢复循环,同/跨文档通吃。
   */
  const applyNavLocation = useCallback(
    (target: NavLocation) => {
      const state = useReaderStore.getState();
      if (target.position.kind === "scroll") {
        scrollPositions.current.set(target.path, target.position.scrollTop);
        if (state.currentPath === target.path) {
          const reader = readerRef.current;
          if (reader) reader.scrollTop = target.position.scrollTop;
          return;
        }
      } else {
        schedulePdfPositionRestore(target.path, {
          page: target.position.page,
          offsetRatio: target.position.offsetRatio,
        });
        if (state.currentPath === target.path) return;
      }
      void state.selectDocument(target.path);
    },
    [schedulePdfPositionRestore],
  );

  const handleNavBack = useCallback(() => {
    const target = useReaderStore.getState().navBack(captureCurrentNavLocation());
    if (target) applyNavLocation(target);
  }, [applyNavLocation, captureCurrentNavLocation]);

  const handleNavForward = useCallback(() => {
    const target = useReaderStore.getState().navForward(captureCurrentNavLocation());
    if (target) applyNavLocation(target);
  }, [applyNavLocation, captureCurrentNavLocation]);

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
      // 标注跳转也是跳转:先记出发点(同文档内定位同样可回退)。
      recordNavDeparture();
      if (ensurePdfViewForAnnotation(annotation)) {
        // 切换视图后内容异步加载,交给重试兜底。
        scheduleAnnotationJump(annotation);
        return;
      }
      const done = performAnnotationJump(annotation, { fallback: false, notify: true });
      if (!done) scheduleAnnotationJump(annotation);
    },
    [ensurePdfViewForAnnotation, performAnnotationJump, recordNavDeparture, scheduleAnnotationJump],
  );

  // 刻度测量:布局变化(内容/字号/窗口/标注增删/搜索会话)时 rAF 合并
  // 重算一次;滚动本身不参与(§3.2)。ResizeObserver 盯正文壳,Shiki/
  // Mermaid/图片异步落地引起的高度变化都会经它触发重测。
  useEffect(() => {
    if (!showScrollMap || overlayViewOpen || !currentPath || !currentContent) {
      setScrollMapMarks([]);
      return;
    }
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const reader = readerRef.current;
      const article = articleRef.current;
      if (!reader || !article) return;
      const hits = searchQuery.trim()
        ? searchResults.filter(
            (result) => result.relativePath === currentPath && result.locator,
          )
        : [];
      setScrollMapMarks(
        buildScrollMapMarks(
          [
            ...collectAnnotationScrollPoints(reader, article, annotations),
            ...collectSearchScrollPoints(reader, article, hits),
          ],
          reader.scrollHeight,
        ),
      );
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(measure);
    };
    schedule();
    const article = articleRef.current;
    const observer =
      typeof ResizeObserver === "function" && article ? new ResizeObserver(schedule) : null;
    if (article && observer) observer.observe(article);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [
    annotations,
    currentContent,
    currentPath,
    overlayViewOpen,
    readingSettings,
    searchQuery,
    searchResults,
    showScrollMap,
    splitActive,
  ]);

  // 朗读刻度:sentenceIndex 变化只更新这一枚(RS-D8),不重测全量。
  const {
    sentenceIndex: ttsSentenceIndex,
    barOpen: ttsBarOpen,
    getActiveSentenceRect,
  } = readAloud;
  useEffect(() => {
    if (!showScrollMap || !ttsBarOpen || ttsSentenceIndex === null) {
      setTtsMapRatio(null);
      return;
    }
    const reader = readerRef.current;
    if (!reader) return;
    setTtsMapRatio(ttsRatioFromRect(reader, getActiveSentenceRect()));
  }, [getActiveSentenceRect, showScrollMap, ttsBarOpen, ttsSentenceIndex]);

  /** 刻度点击(RS-D7):标注/书签走既有跳转链,其余按比例滚动。 */
  const handleScrollMapSelect = useCallback(
    (mark: ScrollMapMark) => {
      if (mark.kind === "annotation" || mark.kind === "bookmark") {
        const annotation = annotations.find((candidate) => candidate.id === mark.targetId);
        if (annotation) {
          jumpToAnnotation(annotation);
          return;
        }
      }
      recordNavDeparture();
      scrollContainerByRatio(
        readerRef.current,
        mark.ratio,
        motionLevel === "off" ? "auto" : "smooth",
      );
    },
    [annotations, jumpToAnnotation, motionLevel, recordNavDeparture],
  );

  const handleScrollMapSelectTts = useCallback(
    (ratio: number) => {
      recordNavDeparture();
      scrollContainerByRatio(
        readerRef.current,
        ratio,
        motionLevel === "off" ? "auto" : "smooth",
      );
    },
    [motionLevel, recordNavDeparture],
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

  const clearRelocatePreview = useCallback(() => {
    const article = articleRef.current;
    if (article) clearAnnotationMarks(article, RELOCATE_PREVIEW_ID);
    setRelocatePreview(null);
  }, []);

  /**
   * §5.6 B「在文档中定位此文本」: 用宽松档(空白规范化 + 临时 fuzzy)找最近似
   * 位置,画临时预览高亮并滚动到位。此处只预览;确认之前不改写任何 locator。
   * PDF 需先切到标注所属视图,内容异步就绪,对"根尚未渲染"做有限重试。
   */
  const handleRelocateAnnotation = useCallback(
    (annotation: Annotation) => {
      if (!isRelocatableAnnotation(annotation)) return;
      clearRelocatePreview();
      const locator = annotation.locator as QuoteBearingLocator;
      const viewSwitched = ensurePdfViewForAnnotation(annotation);
      const behavior: ScrollBehavior = motionLevel === "off" ? "auto" : "smooth";
      const MAX_ROUNDS = 8;
      const attempt = (round: number) => {
        const article = articleRef.current;
        const reader = readerRef.current;
        if (!article || !reader) return;
        const roots = collectRelocationRoots(article, locator);
        if (!roots.length) {
          if (round < MAX_ROUNDS) window.setTimeout(() => attempt(round + 1), 200);
          else showNotice("当前视图尚未渲染可搜索的正文，未找到近似位置，标注保持原样。");
          return;
        }
        const match = findRelocationRange(roots, locator);
        if (!match) {
          // 明确告知,不提供删除以外的建议;locator 原样保留。
          showNotice("未在当前文档中找到近似文本，标注保持原样。");
          return;
        }
        // 先采集(wrap 会拆分文本节点,必须在测量之后)。
        const captured = captureRelocatedSelection({
          readerRoot: reader,
          kind: locator.kind,
          range: match.range,
          pdfMode: locator.kind === "pdf" ? locator.view : undefined,
        });
        if (!captured) {
          showNotice("未能重新采集定位信息，标注保持原样。");
          return;
        }
        const markKind = isAnnotationMarkKind(annotation.kind) ? annotation.kind : "highlight";
        const elements = wrapRangeWithMark(
          match.range,
          RELOCATE_PREVIEW_ID,
          annotation.color ?? "yellow",
          markKind,
        );
        for (const element of elements) element.classList.add("annotation-relocate-preview");
        if (elements[0]) scrollElementWithinContainer(reader, elements[0], behavior);
        setRelocatePreview({ annotation, captured, fuzzyHit: match.method === "fuzzy" });
      };
      if (viewSwitched) window.setTimeout(() => attempt(0), 350);
      else attempt(0);
    },
    [clearRelocatePreview, ensurePdfViewForAnnotation, motionLevel, showNotice],
  );

  const confirmRelocateAnnotation = useCallback(async () => {
    if (!relocatePreview) return;
    // 用户确认是改写 locator 的唯一路径:全套 quote/prefix/suffix/hint 重新
    // 采集,sortIndex 重算,经 upsert 持久化。
    const updated = applyRelocatedAnnotation(relocatePreview.annotation, relocatePreview.captured);
    try {
      await saveAnnotation(updated, { recordUndo: false });
      clearRelocatePreview();
      showNotice("已把标注移动到新位置");
    } catch (cause) {
      showNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [clearRelocatePreview, relocatePreview, saveAnnotation, showNotice]);

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
    if (
      (sidePanelTab === "library" || activeView === "annotations") &&
      libraryAnnotations.status === "idle"
    ) {
      void loadLibraryAnnotations();
    }
  }, [activeView, libraryAnnotations.status, loadLibraryAnnotations, sidePanelTab]);

  // 「链接」tab(plan-backlinks §3.4):首次切到 tab 时拉取;文档或库快照
  // 变化时置 idle,下次进 tab 重拉(照抄全库 tab 的 idle 模式)。
  const [documentLinksState, setDocumentLinksState] = useState<LinksPanelState>({
    status: "idle",
  });
  const documentLinksRequest = useRef(0);

  useEffect(() => {
    documentLinksRequest.current += 1;
    setDocumentLinksState({ status: "idle" });
  }, [currentPath, documents]);

  useEffect(() => {
    if (sidePanelTab !== "links" || documentLinksState.status !== "idle") return;
    if (!currentPath) return;
    const request = ++documentLinksRequest.current;
    setDocumentLinksState({ status: "loading" });
    listDocumentLinks(currentPath).then(
      (data) => {
        if (documentLinksRequest.current === request) {
          setDocumentLinksState({ status: "ready", data });
        }
      },
      (cause: unknown) => {
        if (documentLinksRequest.current === request) {
          setDocumentLinksState({
            status: "error",
            message: cause instanceof Error ? cause.message : "链接数据读取失败",
          });
        }
      },
    );
  }, [currentPath, documentLinksState.status, sidePanelTab]);

  const handleSelectLinkDocument = useCallback(
    (relativePath: string) => {
      setCompactTocOpen(false);
      recordNavDeparture();
      void selectDocument(relativePath);
    },
    [recordNavDeparture, selectDocument],
  );

  // 方案四 A1:全库检索与筛选。检索输入 240ms 防抖(沿库搜索的既有模式),
  // 桌面走 search_annotations(FTS5 trigram),Web 由 wrapper 走同构内存过滤;
  // 类型/颜色筛选保持纯前端,与检索结果求交。
  const [libraryFilters, setLibraryFilters] = useState<AnnotationLibraryFilters>({
    query: "",
    kinds: [],
    colors: [],
  });
  const [librarySearch, setLibrarySearch] = useState<
    { query: string; items: Annotation[] } | null
  >(null);
  const librarySearchRequest = useRef(0);

  useEffect(() => {
    const request = ++librarySearchRequest.current;
    if (!normalizeAnnotationQuery(libraryFilters.query)) {
      setLibrarySearch(null);
      return;
    }
    const timer = window.setTimeout(() => {
      searchAnnotations(libraryFilters.query).then(
        (items) => {
          if (librarySearchRequest.current === request) {
            setLibrarySearch({ query: libraryFilters.query, items });
          }
        },
        (cause) => {
          console.error("Reade: 标注检索失败", cause);
          if (librarySearchRequest.current === request) {
            setLibrarySearch({ query: libraryFilters.query, items: [] });
          }
        },
      );
    }, 240);
    return () => window.clearTimeout(timer);
  }, [libraryFilters.query]);

  const documentTitles = useMemo(
    () => new Map(documents.map((document) => [document.relativePath, document.title])),
    [documents],
  );
  const presentDocumentPaths = useMemo(
    () => new Set(documents.map((document) => document.relativePath)),
    [documents],
  );

  // 金句卡片入口 2(M2):已有高亮/下划线的摘录,出处取所属文档标题。
  const handleGenerateCardFromAnnotation = useCallback(
    (annotation: Annotation) => {
      const quote = annotation.selectedText?.trim();
      if (!quote) return;
      setQuoteCardSource({
        quote,
        sourceTitle:
          documentTitles.get(annotation.relativePath) ?? fileName(annotation.relativePath),
      });
      setMarkEditor(null);
    },
    [documentTitles],
  );

  // 全书回顾编纂入口(plan-book-digest):数据全在前端 state(toc/标注),
  // 开即算;编纂依赖当前文档的 TOC,因此入口都作用于当前文档。
  const handleOpenBookDigest = useCallback(() => {
    setCompactTocOpen(false);
    setMobileLibraryOpen(false);
    setBookDigestOpen(true);
  }, []);

  const libraryFilterActive =
    librarySearch !== null ||
    libraryFilters.kinds.length > 0 ||
    libraryFilters.colors.length > 0;

  const libraryHubItems = useMemo(() => {
    const base = librarySearch
      ? librarySearch.items
      : libraryAnnotations.status === "ready"
        ? libraryAnnotations.items
        : [];
    if (!libraryFilters.kinds.length && !libraryFilters.colors.length) return base;
    return filterAnnotations(base, {
      kinds: libraryFilters.kinds,
      colors: libraryFilters.colors,
    });
  }, [libraryAnnotations, libraryFilters.colors, libraryFilters.kinds, librarySearch]);

  // 分组走 annotationHub 纯函数:普通组按路径排序,失联组(路径不在当前
  // 扫描中)置尾灰显;组内按 sortIndex 位置排序(决策 A-D2)。
  const libraryGroups = useMemo<AnnotationLibraryGroup[]>(() => {
    if (!librarySearch && libraryAnnotations.status !== "ready") return [];
    return groupAnnotationsByDocument(libraryHubItems, presentDocumentPaths).map((group) => ({
      path: group.relativePath,
      title: documentTitles.get(group.relativePath) ?? fileName(group.relativePath),
      missing: group.missing,
      annotations: group.annotations,
    }));
  }, [
    documentTitles,
    libraryAnnotations.status,
    libraryHubItems,
    librarySearch,
    presentDocumentPaths,
  ]);

  const handleSelectLibraryAnnotation = useCallback(
    (annotation: Annotation) => {
      setCompactTocOpen(false);
      if (annotation.relativePath === currentPath) {
        // 从全屏视图(中枢/回顾)点击当前文档的标注时,先切回阅读面再定位;
        // 跨文档路径由 selectDocument 自动切回(store 契约)。
        if (useReaderStore.getState().activeView !== "reader") setActiveView("reader");
        jumpToAnnotation(annotation);
        return;
      }
      // pendingHash 模式:等目标文档内容就绪后再跳转。
      recordNavDeparture();
      pendingAnnotationJump.current = annotation;
      void selectDocument(annotation.relativePath);
    },
    [currentPath, jumpToAnnotation, recordNavDeparture, selectDocument, setActiveView],
  );

  /** 编纂条目点击:关 overlay 再走标注跳转链(视图切换与重试都在链内)。 */
  const handleDigestJump = useCallback(
    (annotation: Annotation) => {
      setBookDigestOpen(false);
      handleSelectLibraryAnnotation(annotation);
    },
    [handleSelectLibraryAnnotation],
  );

  /** 全屏中枢入口(方案四 A2):来自全库 tab 顶部链接,footer 不加第四图标。 */
  const openAnnotationHub = useCallback(() => {
    setCompactTocOpen(false);
    setMobileLibraryOpen(false);
    setActiveView("annotations");
  }, [setActiveView]);

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

  // 复制段落链接(plan-web-text-deeplink §3.3):选区文本归一截断为
  // 120 字符后构造 `?doc=…#text=…`,仅 Web 运行时接线。
  const handleCopySelectionLink = useCallback(async () => {
    if (!pendingSelection || !currentPath) return;
    const text = normalizeShareText(pendingSelection.text);
    closeToolbar();
    if (!text) {
      showNotice("选区没有可分享的文本。");
      return;
    }
    try {
      const url = buildWebRouteUrl(window.location.href, currentPath, { text });
      const copied = await copyTextToClipboard(url);
      showNotice(copied ? "已复制段落链接" : "复制失败，请重试。");
    } catch {
      showNotice("无法生成安全的分享链接。");
    }
  }, [closeToolbar, copyTextToClipboard, currentPath, pendingSelection, showNotice]);

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

  // 导出范围跟随当前视图:检索/筛选激活时导出的即是命中集合(方案四 §3.2)。
  const handleExportLibraryAnnotations = useCallback(async () => {
    if (!libraryHubItems.length) return;
    const markdown = buildAnnotationsMarkdown(libraryHubItems, { documentTitles });
    const copied = await copyTextToClipboard(markdown);
    showNotice(copied ? `已复制 ${libraryHubItems.length} 条标注` : "复制失败，请重试。");
  }, [copyTextToClipboard, documentTitles, libraryHubItems, showNotice]);

  const handleExportLibraryGroup = useCallback(
    async (group: AnnotationLibraryGroup) => {
      if (!group.annotations.length) return;
      const markdown = buildAnnotationsMarkdown(group.annotations, {
        documentTitles: new Map([[group.path, group.title]]),
      });
      const copied = await copyTextToClipboard(markdown);
      showNotice(copied ? `已复制 ${group.annotations.length} 条标注` : "复制失败，请重试。");
    },
    [copyTextToClipboard, showNotice],
  );

  // ---- §5.7 文件级导出/导入(JSON 信封 + Readwise CSV) ----

  const handleExportAnnotationsJson = useCallback(async () => {
    try {
      const [records, fingerprints] = await Promise.all([
        listAnnotationsForTransfer(),
        listDocumentFingerprints(),
      ]);
      if (!records.length) {
        showNotice("当前文档库还没有可导出的标注。");
        return;
      }
      const envelope = buildAnnotationEnvelope(records, {
        deviceId: getOrCreateDeviceId(),
        includeDeleted: true,
        contentHashes: new Map(
          fingerprints.map((entry) => [entry.relativePath, entry.contentHash]),
        ),
      });
      const saved = await saveAnnotationExportFile(
        `reade-annotations-${transferDateStamp()}.json`,
        serializeAnnotationEnvelope(envelope),
        "application/json",
      );
      if (saved) showNotice(`已导出 ${records.length} 条标注记录（含删除记录）`);
    } catch (cause) {
      showNotice(cause instanceof Error ? `导出失败：${cause.message}` : "导出失败");
    }
  }, [showNotice]);

  const handleExportAnnotationsCsv = useCallback(async () => {
    try {
      const records = await listAnnotationsForTransfer();
      const { csv, rows } = buildReadwiseCsv(records, { documentTitles });
      if (!rows) {
        // 书签没有 Highlight 正文、墓碑属于本地状态,都不出现在 CSV 里。
        showNotice("没有可导出为 CSV 的高亮或下划线。");
        return;
      }
      const saved = await saveAnnotationExportFile(
        `reade-annotations-${transferDateStamp()}.csv`,
        csv,
        "text/csv",
      );
      if (saved) showNotice(`已导出 ${rows} 条高亮到 Readwise CSV`);
    } catch (cause) {
      showNotice(cause instanceof Error ? `导出失败：${cause.message}` : "导出失败");
    }
  }, [documentTitles, showNotice]);

  const handleImportAnnotations = useCallback(async () => {
    let picked: { fileName: string; contents: string } | null;
    try {
      picked = await pickAnnotationImportFile();
    } catch (cause) {
      showNotice(cause instanceof Error ? `导入失败：${cause.message}` : "导入失败");
      return;
    }
    if (!picked) return;
    try {
      // 不可信输入:严格 schema 校验失败即整体拒绝,不部分导入。
      const envelope = parseAnnotationEnvelope(picked.contents);
      const [existing, fingerprints] = await Promise.all([
        listAnnotationsForTransfer(),
        listDocumentFingerprints(),
      ]);
      const presentPaths = new Set(documents.map((document) => document.relativePath));
      const plan = planAnnotationImport(envelope, {
        existing,
        presentPaths,
        presentHashes: new Map(
          fingerprints
            .filter((entry) => presentPaths.has(entry.relativePath))
            .map((entry) => [entry.relativePath, entry.contentHash]),
        ),
      });
      setImportReview({ fileName: picked.fileName, plan });
    } catch (cause) {
      showNotice(cause instanceof Error ? `导入失败：${cause.message}` : "导入失败");
    }
  }, [documents, showNotice]);

  const confirmImportAnnotations = useCallback(async () => {
    if (!importReview) return;
    const { plan } = importReview;
    setImportBusy(true);
    try {
      const written = await importAnnotations(plan.toUpsert, plan.fingerprintRows);
      setImportReview(null);
      // 当前文档与全库列表都可能包含刚导入的记录。
      await reloadAnnotations();
      setLibraryAnnotations({ status: "idle" });
      try {
        setMoveCandidates(await detectMovedDocuments());
      } catch {
        // 导入已成功;重绑候选下次打开/刷新库时再校准。
      }
      showNotice(
        plan.rebindSuggestions.length
          ? `已导入 ${written} 条标注记录；请在「失联文档」区完成 ${plan.rebindSuggestions.length} 个文档的迁移`
          : `已导入 ${written} 条标注记录`,
      );
    } catch (cause) {
      showNotice(cause instanceof Error ? `导入失败：${cause.message}` : "导入失败");
    } finally {
      setImportBusy(false);
    }
  }, [importReview, reloadAnnotations, showNotice]);

  useEffect(() => {
    setPendingSelection(null);
    setNoteDraft(null);
    setMarkEditor(null);
    setRelatedPassages(null);
    setCollectionsPopoverOpen(false);
    setSidePanelTab((current) => (current === "library" ? current : "toc"));
    setAnnotationPanelOpen(false);
    // 编纂视图是单文档的:换文档即关闭,防 overlay 展示上一篇的报告。
    setBookDigestOpen(false);
    setMarkdownBrokenIds([]);
    setReaderBrokenIds([]);
    setMarkdownApproximateIds([]);
    setReaderApproximateIds([]);
    // PdfReader 换文档会自回原版式;这里同步归位,避免聚焦模式在
    // 新 PDF 上短暂沿用上一篇的"阅读模式可用"判定。
    setPdfViewMode("original");
    // Preview marks die with the swapped-out content; only the state remains.
    setRelocatePreview(null);
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
      setReaderApproximateIds([]);
      return;
    }
    setMarkdownBrokenIds([]);
    setMarkdownApproximateIds([]);
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
      // 停留在深链目标文档且未跳章节时保留 `#text=`;一旦切文档或
      // 跳 heading,深链片段随之退役。
      const keep = shareTextFragment.current;
      const text = !heading && keep && keep.path === relativePath ? keep.text : null;
      if (!text) shareTextFragment.current = null;
      try {
        const nextUrl = buildWebRouteUrl(window.location.href, relativePath, {
          heading: heading ?? null,
          text,
        });
        window.history.replaceState(null, "", nextUrl);
      } catch {
        showNotice("无法生成安全的分享链接，已保留当前页面。");
      }
    },
    [showNotice],
  );

  useEffect(() => {
    const applyTheme = () => {
      document.documentElement.dataset.theme = theme;
      const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      themeColor?.setAttribute("content", getThemeColor(theme));
    };
    // Mount (theme-boot.ts already wrote data-theme) and motion-level changes
    // re-apply the current value: keep those writes instant so only a real
    // theme switch can cross-fade (M3/D5).
    if (document.documentElement.dataset.theme === theme) {
      applyTheme();
      return;
    }
    // 真正的主题变更才消费扩散 origin;来自日/月按钮或风格色卡时
    // full 档做圆形揭示,其余入口(命令面板等)保持交叉淡入。
    applyThemeMutation(applyTheme, motionLevel, consumeThemeTransitionOrigin());
  }, [theme, motionLevel]);

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
    if (IS_WEB_RUNTIME || !snapshot?.rootPath) return;
    // 旧单值键继续双写(启动自动重开仍读它,plan-library-mru §3.1)。
    localStorage.setItem(LAST_LIBRARY_KEY, snapshot.rootPath);
    // 打开成功即 upsert 置顶;documentCount 取打开时刻的扫描结果。
    setLibraryMru(
      upsertLibraryMru({
        path: snapshot.rootPath,
        title: fileName(snapshot.rootPath),
        documentCount: useReaderStore.getState().documents.length,
        lastOpenedAt: Date.now(),
      }),
    );
  }, [snapshot?.rootPath]);

  /** 失效探测:异步逐项;未返回/探测失败视为未知(保持可点,MR-D2)。 */
  const probeMruEntries = useCallback((entries: LibraryMruEntry[]) => {
    if (IS_WEB_RUNTIME) return;
    for (const entry of entries) {
      const key = normalizeLibraryPathKey(entry.path);
      void probeLibraryPath(entry.path)
        .then((exists) => {
          setMruUnavailable((current) => {
            if (current.has(key) === !exists) return current;
            const next = new Set(current);
            if (exists) next.delete(key);
            else next.add(key);
            return next;
          });
        })
        .catch(() => undefined);
    }
  }, []);

  // 列表变化(挂载/迁移/upsert/移除)后重探,欢迎页与菜单共用结果。
  useEffect(() => {
    if (libraryMru.length > 0) probeMruEntries(libraryMru);
  }, [libraryMru, probeMruEntries]);

  const handleOpenMruLibrary = useCallback(
    (entry: LibraryMruEntry) => {
      setLibrarySwitcherOpen(false);
      setMobileLibraryOpen(false);
      // 打开完全复用既有 openLibrary 校验;失败走 error 通道展示,
      // 并把该项就地标记失效(探测通过但打开失败,如权限)。
      void openLibrary(entry.path).then(() => {
        const opened = useReaderStore.getState().snapshot?.rootPath;
        const key = normalizeLibraryPathKey(entry.path);
        if (!opened || normalizeLibraryPathKey(opened) !== key) {
          setMruUnavailable((current) => {
            if (current.has(key)) return current;
            const next = new Set(current);
            next.add(key);
            return next;
          });
        }
      });
    },
    [openLibrary],
  );

  const handleRemoveMruLibrary = useCallback((path: string) => {
    setLibraryMru(removeLibraryMru(path));
  }, []);

  /** 侧栏书库名点击:Web 刷新;桌面无 MRU 保持直弹对话框(MR-D3)。 */
  const handleLibraryButton = useCallback(() => {
    if (IS_WEB_RUNTIME) {
      void refreshLibrary();
      return;
    }
    if (libraryMru.length === 0) {
      void chooseAndOpenLibrary();
      return;
    }
    if (!librarySwitcherOpen) probeMruEntries(libraryMru);
    setLibrarySwitcherOpen((open) => !open);
  }, [chooseAndOpenLibrary, libraryMru, librarySwitcherOpen, probeMruEntries, refreshLibrary]);

  // ---- 阅读时间预估(plan-reading-time-estimate §3.2) ----
  // extents:一次 GROUP BY 聚合;随 snapshot(打开/刷新)与后台索引完成重取。
  const [documentExtents, setDocumentExtents] = useState<Map<string, DocumentExtent> | null>(null);
  const [readingSpeed, setReadingSpeed] = useState<ReadingSpeed>(DEFAULT_READING_SPEED);
  const indexingDone = !indexProgress || indexProgress.completed >= indexProgress.total;

  useEffect(() => {
    if (!snapshot) {
      setDocumentExtents(null);
      return;
    }
    if (!indexingDone) return;
    let cancelled = false;
    void listDocumentExtents()
      .then((extents) => {
        if (cancelled) return;
        setDocumentExtents((current) => {
          // 空结果且本就无数据时保持引用不变,不触发多余重渲染
          // (索引尚未产出任何段时的常见情形)。
          if (extents.length === 0 && !current) return current;
          return new Map(extents.map((extent) => [extent.relativePath, extent]));
        });
      })
      .catch(() => {
        // 预估是装饰性信息:读取失败静默降级为不显示。
        if (!cancelled) setDocumentExtents(null);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot, indexingDone]);

  // 个人速度:近 90 天会话 ÷ 有效读过字符,中位数 + clamp(TE-D1/D2);
  // Web 无会话数据,恒默认速度档。
  useEffect(() => {
    if (IS_WEB_RUNTIME || !snapshot?.rootPath || !documentExtents) {
      setReadingSpeed(DEFAULT_READING_SPEED);
      return;
    }
    let cancelled = false;
    const rootPath = snapshot.rootPath;
    const now = Date.now();
    void listReadingSessions(now - CALIBRATION_WINDOW_MS, now)
      .then((sessions) => {
        if (cancelled) return;
        const positions = listLibraryReadingPositions(rootPath);
        const charsByPath = new Map<string, number>();
        const coverageByPath = new Map<string, number>();
        for (const [path, extent] of documentExtents) {
          charsByPath.set(path, extent.charCount);
          const coverage = highWaterCoverage(positions[path], extent.segmentCount);
          if (coverage !== null) coverageByPath.set(path, coverage);
        }
        setReadingSpeed(
          calibrateReadingSpeed({
            activeSecondsByPath: aggregateActiveSeconds(sessions),
            charsByPath,
            coverageByPath,
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setReadingSpeed(DEFAULT_READING_SPEED);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot?.rootPath, documentExtents]);

  // 书架封面(plan-bookshelf-covers 定稿补记 §0.2):EPUB 封面在文档打开时
  // 捕获——read_epub_asset 只服务当前打开的 EPUB,书架端无法为任意 EPUB
  // 取图。已缓存跳过;失败静默,书架回落生成式封面。
  useEffect(() => {
    if (IS_WEB_RUNTIME || currentContent?.kind !== "epub") return;
    const { relativePath, document } = currentContent;
    void import("./lib/coverCapture")
      .then(({ captureEpubCoverThumbnail }) =>
        captureEpubCoverThumbnail(relativePath, document),
      )
      .catch(() => undefined);
  }, [currentContent]);

  /** 树条目徽标:全文预估;扫描版/无字符不显示(TE-D5)。 */
  const estimateForPath = useCallback(
    (path: string): string | null => {
      const extent = documentExtents?.get(path);
      if (!extent || !extentSupportsEstimate(extent)) return null;
      return formatReadingEstimate(
        estimateReadingMinutes(extent.charCount, readingSpeed.charsPerMinute),
      );
    },
    [documentExtents, readingSpeed.charsPerMinute],
  );

  /** 继续阅读卡:剩余时长 = chars × (1 - 高水位覆盖率)。 */
  const remainingEstimateForItem = useCallback(
    (path: string, progress: HomeProgress | null): string | null => {
      const extent = documentExtents?.get(path);
      if (!extent) return null;
      const minutes = estimateRemainingMinutes(extent, progress, readingSpeed.charsPerMinute);
      return minutes === null ? null : formatRemainingEstimate(minutes);
    },
    [documentExtents, readingSpeed.charsPerMinute],
  );

  /** 目录面板顶部一行:全文预估 + 校准状态后缀。 */
  const tocEstimateLine = useMemo(() => {
    if (!currentPath) return null;
    const label = estimateForPath(currentPath);
    if (!label) return null;
    // "约 N 分钟"直接连写;"1 分钟内"补空格避免"全文1"粘连。
    const line = label.startsWith("约") ? `全文${label}` : `全文 ${label}`;
    return readingSpeed.calibrated ? `${line} · 个人速度已校准` : line;
  }, [currentPath, estimateForPath, readingSpeed.calibrated]);

  // ---- 读完接着读(plan-read-next) ----
  // 哨兵可见 + 高水位 ≥0.98 + 800ms 驻留才出卡(RN-D2);dismiss 是
  // 会话级 Set(RN-D4),换库清空;推荐结果按文档缓存,反链 IPC 至多一次。
  const [readNextCard, setReadNextCard] = useState<
    { path: string; suggestion: ReadNextSuggestion } | null
  >(null);
  const readNextDismissed = useRef(new Set<string>());
  const readNextCache = useRef(new Map<string, ReadNextSuggestion | null>());
  const readNextRequest = useRef(0);

  useEffect(() => {
    readNextDismissed.current.clear();
    readNextCache.current.clear();
    setReadNextCard(null);
  }, [snapshot?.rootPath]);

  useEffect(() => {
    // 换文档收卡;合集增删改(version 递增)后推荐可能变化,缓存作废。
    setReadNextCard(null);
    readNextCache.current.clear();
  }, [currentPath, collectionsVersion]);

  const dismissReadNext = useCallback(() => {
    setReadNextCard((current) => {
      // Set 去重,StrictMode 双调 updater 也幂等。
      if (current) readNextDismissed.current.add(current.path);
      return null;
    });
  }, []);

  useEffect(() => {
    const reader = readerRef.current;
    const article = articleRef.current;
    if (!reader || !article) return;
    if (!readNextEnabled || !currentPath || !currentContent) return;
    if (activeView !== "reader" || readAloudBarOpen) return;
    if (readNextDismissed.current.has(currentPath)) return;
    const sentinel = article.querySelector("[data-read-next-sentinel]");
    if (!sentinel) return;

    const path = currentPath;
    let visible = false;
    let dwellTimer: number | null = null;
    let evalFrame: number | null = null;
    let disposed = false;

    const clearDwell = () => {
      if (dwellTimer !== null) {
        window.clearTimeout(dwellTimer);
        dwellTimer = null;
      }
    };

    const fire = async () => {
      dwellTimer = null;
      // dismiss 发生在本 effect 存续期间(依赖不变不重建),触发时必须
      // 复查会话级 Set,否则缓存的推荐会在下一次滚到底时复活。
      if (disposed || readNextDismissed.current.has(path)) return;
      let suggestion = readNextCache.current.get(path);
      if (suggestion === undefined) {
        const request = ++readNextRequest.current;
        const rootPath = useReaderStore.getState().snapshot?.rootPath;
        suggestion = await resolveReadNextSuggestion({
          currentPath: path,
          documents,
          positions: rootPath ? listLibraryReadingPositions(rootPath) : {},
          extents: documentExtents,
          listCollections,
          listCollectionItems,
          listDocumentLinks,
        }).catch(() => null);
        if (disposed || request !== readNextRequest.current) return;
        readNextCache.current.set(path, suggestion);
      }
      if (disposed || !suggestion || !visible) return;
      setReadNextCard({ path, suggestion });
    };

    const evaluate = () => {
      evalFrame = null;
      if (disposed) return;
      if (shouldTriggerReadNext(visible, readingScrollRatio())) {
        if (dwellTimer === null) {
          dwellTimer = window.setTimeout(() => void fire(), READ_NEXT_DWELL_MS);
        }
        return;
      }
      clearDwell();
      // 离开末尾后收起未 dismiss 的卡;滚回末尾重新驻留计时。
      if (!visible) {
        setReadNextCard((current) => (current?.path === path ? null : current));
      }
    };
    const scheduleEvaluate = () => {
      if (evalFrame === null) evalFrame = window.requestAnimationFrame(evaluate);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible = entry.isIntersecting;
        scheduleEvaluate();
      },
      { root: reader, threshold: 0 },
    );
    observer.observe(sentinel);
    reader.addEventListener("scroll", scheduleEvaluate, { passive: true });
    return () => {
      disposed = true;
      observer.disconnect();
      reader.removeEventListener("scroll", scheduleEvaluate);
      clearDwell();
      if (evalFrame !== null) window.cancelAnimationFrame(evalFrame);
    };
  }, [
    activeView,
    currentContent,
    currentPath,
    documentExtents,
    documents,
    readAloudBarOpen,
    readNextEnabled,
    readingScrollRatio,
  ]);

  /** 推荐目标的展示数据;目标已不在库(极端竞态)时整卡不渲染。 */
  const readNextTarget = useMemo(() => {
    if (!readNextCard) return null;
    const target = documents.find(
      (document) => document.relativePath === readNextCard.suggestion.relativePath,
    );
    if (!target) return null;
    return {
      document: target,
      reason: readNextCard.suggestion.reason,
      title: documentTreeName(target),
      estimate: estimateForPath(target.relativePath),
    };
  }, [documents, estimateForPath, readNextCard]);

  const openReadNext = useCallback(() => {
    const target = readNextTarget?.document;
    if (!target) return;
    dismissReadNext();
    recordNavDeparture();
    void selectDocument(target.relativePath);
  }, [dismissReadNext, readNextTarget, recordNavDeparture, selectDocument]);

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

  // 5.5 指纹重绑链:打开/刷新库后检测"路径消失但内容指纹在新路径出现"的
  // 文档,提示一次性迁移其标注。确认交互复用外链确认的 window.confirm 模式;
  // 全部候选(含歧义与被拒绝的配对)进入 state,供 5.6 的"失联文档"集中
  // 重绑列表消费。
  useEffect(() => {
    if (!snapshot || lastMoveCheckSnapshot.current === snapshot) return;
    lastMoveCheckSnapshot.current = snapshot;
    void (async () => {
      let candidates: MovedDocumentCandidate[];
      try {
        candidates = await detectMovedDocuments();
      } catch (cause) {
        console.error("Reade: 文档移动检测失败", cause);
        return;
      }
      setMoveCandidates(candidates);
      const pairs = candidates.filter(
        (candidate) =>
          !candidate.ambiguous &&
          !promptedMovePairs.current.has(`${candidate.oldPath}\u0000${candidate.newPath}`),
      );
      if (pairs.length === 0) return;
      for (const pair of pairs) {
        promptedMovePairs.current.add(`${pair.oldPath}\u0000${pair.newPath}`);
      }
      const total = pairs.reduce((sum, pair) => sum + pair.annotationCount, 0);
      const confirmed = window.confirm(
        `检测到 ${pairs.length} 个文档已移动，迁移 ${total} 条标注到新路径？`,
      );
      if (!confirmed) return;
      try {
        let migrated = 0;
        for (const pair of pairs) {
          migrated += await rebindDocumentAnnotations(pair.oldPath, pair.newPath);
        }
        // 当前文档可能正是迁移目标;全库标注列表也需要重新拉取。
        await reloadAnnotations();
        setLibraryAnnotations({ status: "idle" });
        try {
          setMoveCandidates(await detectMovedDocuments());
        } catch {
          // 迁移已成功;候选列表下次打开/刷新库时再校准。
        }
        showNotice(`已迁移 ${migrated} 条标注记录`);
      } catch (cause) {
        showNotice(cause instanceof Error ? `标注迁移失败：${cause.message}` : "标注迁移失败");
      }
    })();
  }, [reloadAnnotations, showNotice, snapshot]);

  const libraryDocumentOptions = useMemo<LibraryDocumentOption[]>(
    () =>
      documents.map((document) => ({
        relativePath: document.relativePath,
        title: document.title,
      })),
    [documents],
  );

  // §5.6 C「失联文档」= 有标注但路径不在当前扫描里的文档;指纹候选(含歧义
  // 与被拒绝的无歧义配对)作为建议目标,指纹也失配的进入纯手动选择。
  const lostDocuments = useMemo<LostDocumentEntry[]>(() => {
    if (!snapshot || libraryAnnotations.status !== "ready") return [];
    const present = presentDocumentPaths;
    const counts = new Map<string, number>();
    for (const annotation of libraryAnnotations.items) {
      if (present.has(annotation.relativePath)) continue;
      counts.set(annotation.relativePath, (counts.get(annotation.relativePath) ?? 0) + 1);
    }
    const candidatesByOldPath = new Map<string, string[]>();
    for (const candidate of moveCandidates) {
      if (present.has(candidate.oldPath) || !present.has(candidate.newPath)) continue;
      const bucket = candidatesByOldPath.get(candidate.oldPath) ?? [];
      if (!bucket.includes(candidate.newPath)) bucket.push(candidate.newPath);
      candidatesByOldPath.set(candidate.oldPath, bucket);
    }
    return Array.from(counts.entries())
      .map(([path, annotationCount]) => ({
        path,
        annotationCount,
        candidates: candidatesByOldPath.get(path) ?? [],
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }, [libraryAnnotations, moveCandidates, presentDocumentPaths, snapshot]);

  /**
   * Dry run for a manual rebind (KOReader wizard idea): resolve every quote
   * of the lost path against the candidate's body text via read_document —
   * no storage is touched here.
   */
  const handleDryRunRebind = useCallback(
    async (oldPath: string, newPath: string): Promise<RebindDryRunReport> => {
      const [annotationsToMove, content] = await Promise.all([
        listAnnotations(oldPath),
        readDocument(newPath),
      ]);
      let targetText: string;
      if (content.kind === "markdown") {
        targetText = content.markdown;
      } else if (content.kind === "epub") {
        targetText = flattenEpubDocumentText(content.document);
      } else {
        const reading = await readPdfReadingMode(newPath);
        targetText = reading.pages.map((page) => page.markdown).join("\n");
      }
      return dryRunTextQuoteAnchors(annotationsToMove, targetText);
    },
    [],
  );

  const handleRebindLostDocument = useCallback(
    async (oldPath: string, newPath: string) => {
      const migrated = await rebindDocumentAnnotations(oldPath, newPath);
      await reloadAnnotations();
      setLibraryAnnotations({ status: "idle" });
      try {
        setMoveCandidates(await detectMovedDocuments());
      } catch {
        setMoveCandidates((current) =>
          current.filter((candidate) => candidate.oldPath !== oldPath),
        );
      }
      showNotice(`已迁移 ${migrated} 条标注记录`);
    },
    [reloadAnnotations, showNotice],
  );

  useEffect(() => {
    if (snapshot && documents.length > 0 && !currentPath && !loading) {
      // H-D1 方案 A:桌面冷启动若「继续阅读」有候选(持久化位置或
      // 30 天内会话非空)则落在主页且不自动打开第一篇;无候选维持现状。
      // Web 端(含 ?doc= 直达路由)完全不走这个分支。
      if (!IS_WEB_RUNTIME && !coldStartDecided.current) {
        coldStartDecided.current = true;
        const rootPath = snapshot.rootPath;
        const scannedDocuments = documents;
        void (async () => {
          let hasCandidates = hasContinueCandidates(
            scannedDocuments,
            listLibraryReadingPositions(rootPath),
            [],
          );
          if (!hasCandidates) {
            try {
              const nowMs = Date.now();
              hasCandidates = hasContinueCandidates(
                scannedDocuments,
                {},
                await listReadingSessions(nowMs - CONTINUE_READING_WINDOW_MS, nowMs),
              );
            } catch {
              hasCandidates = false;
            }
          }
          // 等待会话查询期间用户可能已自行打开文档或切换库。
          const state = useReaderStore.getState();
          if (state.currentPath || state.loading || state.snapshot?.rootPath !== rootPath) {
            return;
          }
          if (hasCandidates) {
            setActiveView("home");
          } else if (state.documents.length > 0) {
            void state.selectDocument(state.documents[0].relativePath);
          }
        })();
        return;
      }
      // 主页停留期间(冷启动落点或手动打开)不被自动打开第一篇抢占,
      // 例如文件监听触发的库刷新。
      if (activeView === "home") return;
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
  }, [activeView, currentPath, documents, loading, selectDocument, setActiveView, snapshot]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query || !snapshot) return;
    const timer = window.setTimeout(() => void runSearch(query), 240);
    return () => window.clearTimeout(timer);
  }, [runSearch, searchQuery, snapshot]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Alt+←/→:阅读回退栈(plan-nav-history)。必须 preventDefault,
      // 否则 WebView2/浏览器把 Alt+← 当整页 history back。
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          handleNavBack();
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          handleNavForward();
          return;
        }
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) {
        if (event.key === "Escape") {
          // RA-D6:朗读激活时 Esc 只负责停止朗读,优先级高于其余关闭职责。
          if (readAloudBarOpen) {
            stopReadAloud();
            return;
          }
          if (annotationTool !== "view") {
            setAnnotationTool("view");
          }
          setSettingsOpen(false);
          setStylePickerOpen(false);
          setAnnotationPanelOpen(false);
          setCollectionsPopoverOpen(false);
          setLibrarySwitcherOpen(false);
          setCommandPaletteOpen(false);
          setCompactTocOpen(false);
          setMobileLibraryOpen(false);
          setPendingSelection(null);
          setNoteDraft(null);
          setMarkEditor(null);
          setQuoteCardSource(null);
          setBookDigestOpen(false);
          dismissReadNext();
          closeRelatedPassages();
          clearRelocatePreview();
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
      } else if (event.key.toLowerCase() === "p" && !event.shiftKey && !event.altKey) {
        // WebView2/浏览器把 Ctrl+P 默认给系统打印;开与关都要拦掉。
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
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
    clearRelocatePreview,
    currentContent,
    currentPath,
    dismissReadNext,
    handleCreateBookmark,
    handleNavBack,
    handleNavForward,
    handleUndoAnnotation,
    closeRelatedPassages,
    readAloudBarOpen,
    setAnnotationTool,
    stopReadAloud,
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
    const sessionTop = scrollPositions.current.get(currentPath);
    reader.scrollTop = sessionTop ?? 0;
    // H0 恢复支路:会话内 Map 未命中时查持久化位置。显式导航目标
    // (搜索定位、标注跳转、分享链接锚点)优先,持久化恢复让位。
    if (
      sessionTop === undefined &&
      !currentLocator &&
      !pendingAnnotationJump.current &&
      !pendingHash.current &&
      !pendingTextFragment.current
    ) {
      const rootPath = snapshot?.rootPath;
      const persisted = rootPath ? readReadingPosition(rootPath, currentPath) : null;
      if (persisted?.kind === "scroll" && currentContent && currentContent.kind !== "pdf") {
        const range = reader.scrollHeight - reader.clientHeight;
        if (range > 0) reader.scrollTop = persisted.scrollRatio * range;
      } else if (persisted?.kind === "pdf" && currentContent?.kind === "pdf") {
        schedulePdfPositionRestore(currentPath, {
          page: persisted.page,
          offsetRatio: persisted.offsetRatio,
        });
      }
    }
    const range = reader.scrollHeight - reader.clientHeight;
    const value = range <= 0 ? 0 : Math.min(100, (reader.scrollTop / range) * 100);
    progressBarRef.current?.style.setProperty(
      "--reading-progress",
      String(Math.min(1, Math.max(0, value / 100))),
    );
  }, [currentPath, currentContent, currentLocator, schedulePdfPositionRestore, snapshot?.rootPath]);

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

  // Web 段落分享深链定位:文档渲染完成后在正文文本索引中检索目标文本,
  // 命中则滚动至视口上 1/3 并短暂高亮;Shiki/图片异步落地会改动文本节点,
  // 沿标注跳转的重试语义(2 次 × 600ms)后仍未命中才给降级提示,不静默。
  useEffect(() => {
    if (
      !IS_WEB_RUNTIME ||
      currentContent?.kind !== "markdown" ||
      !pendingTextFragment.current
    ) {
      return;
    }
    const fragment = pendingTextFragment.current;
    pendingTextFragment.current = null;
    let cancelled = false;
    let timer: number | null = null;
    const attempt = (round: number) => {
      timer = null;
      if (cancelled) return;
      const article = articleRef.current;
      const reader = readerRef.current;
      const root = article?.querySelector<HTMLElement>(".markdown-body") ?? article;
      if (root && reader) {
        const index = buildTextIndex(root);
        const match = locateNormalizedText(index.text, fragment);
        const range = match ? rangeFromTextIndex(index, match.start, match.end) : null;
        if (range) {
          const rangeRect = range.getBoundingClientRect();
          const readerRect = reader.getBoundingClientRect();
          const top = Math.max(
            0,
            reader.scrollTop + rangeRect.top - readerRect.top - reader.clientHeight / 3,
          );
          if (motionLevel === "off" || typeof reader.scrollTo !== "function") {
            reader.scrollTop = top;
          } else {
            reader.scrollTo({ top, behavior: "smooth" });
          }
          // 不支持 CSS Custom Highlight 的环境只失去视觉强调,定位不受影响。
          if (applySentenceHighlight(DEEPLINK_HIGHLIGHT_NAME, range)) {
            if (deeplinkHighlightTimer.current !== null) {
              window.clearTimeout(deeplinkHighlightTimer.current);
            }
            deeplinkHighlightTimer.current = window.setTimeout(() => {
              deeplinkHighlightTimer.current = null;
              clearSentenceHighlight(DEEPLINK_HIGHLIGHT_NAME);
            }, DEEPLINK_HIGHLIGHT_MS);
          }
          return;
        }
      }
      if (round >= 2) {
        showNotice("链接指向的段落未找到，文档可能已更新。");
        return;
      }
      timer = window.setTimeout(() => attempt(round + 1), 600);
    };
    window.requestAnimationFrame(() => attempt(0));
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [currentContent, motionLevel, showNotice]);

  // 离开文档即清掉一次性深链高亮,防止残留注册跟到下一篇。
  useEffect(
    () => () => {
      if (deeplinkHighlightTimer.current !== null) {
        window.clearTimeout(deeplinkHighlightTimer.current);
        deeplinkHighlightTimer.current = null;
      }
      clearSentenceHighlight(DEEPLINK_HIGHLIGHT_NAME);
    },
    [currentPath],
  );

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

      // H0 写入支路:同一 rAF 里只采样(ratio 上面已算好),真正落盘交给
      // 500ms trailing debounce,避免每帧写 localStorage。
      const contentKind = currentContent?.kind;
      if (currentPath && contentKind) {
        const root = useReaderStore.getState().snapshot?.rootPath;
        if (root) {
          pendingPositionSample.current = {
            root,
            path: currentPath,
            kind: contentKind === "pdf" ? "pdf" : "scroll",
            ratio: range > 0 ? Math.min(1, Math.max(0, reader.scrollTop / range)) : 0,
          };
          if (persistPositionTimer.current !== null) {
            window.clearTimeout(persistPositionTimer.current);
          }
          persistPositionTimer.current = window.setTimeout(() => {
            persistPositionTimer.current = null;
            flushPendingPosition();
          }, 500);
        }
      }

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
  }, [currentContent?.kind, currentPath, flushPendingPosition]);

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
        // 文档内锚点跳转:先记出发点,Alt+← 可回到点击处。
        if (target) recordNavDeparture();
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
      recordNavDeparture();
      pendingHash.current = hash ? decodePath(hash) : null;
      if (IS_WEB_RUNTIME) replaceWebRoute(target.relativePath, pendingHash.current);
      await selectDocument(target.relativePath);
    },
    [currentPath, documents, motionLevel, recordNavDeparture, replaceWebRoute, selectDocument, showNotice],
  );

  /**
   * AnnotatedMarkdown 是 memo 组件:onNavigate 必须保持稳定引用,否则
   * App 的任何 state 变化都会击穿 memo 触发标注重绘(富文档上重绘
   * 会分离 DOM 节点,悬停预览卡会被随之而来的滚动锚定事件立即关闭)。
   */
  const handleMarkdownNavigate = useCallback(
    (href: string) => {
      void handleNavigate(href);
    },
    [handleNavigate],
  );

  const scrollToHeading = useCallback((id: string) => {
    const target = articleRef.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null;
    // 目录跳转(MD 标题/PDF 页/EPUB 章节)前记出发点。
    if (target) recordNavDeparture();
    scrollElementWithinContainer(
      readerRef.current,
      target,
      currentContent?.kind === "pdf" || motionLevel === "off" ? "auto" : "smooth",
    );
    if (currentPath) replaceWebRoute(currentPath, id);
    setCompactTocOpen(false);
  }, [currentContent?.kind, currentPath, motionLevel, recordNavDeparture, replaceWebRoute]);

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

  // 文章级 error boundary 的恢复动作:boundary 已卸载出错子树,这里再从
  // backend 重读当前文档,重挂后即是全新内容与全新 DOM。
  const handleArticleRetry = useCallback(() => {
    const path = useReaderStore.getState().currentPath;
    if (path) void useReaderStore.getState().selectDocument(path);
  }, []);

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
              onClick={handleLibraryButton}
              aria-haspopup={!IS_WEB_RUNTIME && libraryMru.length > 0 ? "dialog" : undefined}
              aria-expanded={
                !IS_WEB_RUNTIME && libraryMru.length > 0 ? librarySwitcherOpen : undefined
              }
              title={
                IS_WEB_RUNTIME
                  ? "重新加载在线文档"
                  : snapshot?.rootPath
                    ? `${snapshot.rootPath}（点击切换最近书库）`
                    : "选择文档文件夹"
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
            {librarySwitcherOpen && !IS_WEB_RUNTIME && (
              <LibrarySwitcherPopover
                entries={libraryMru}
                currentKey={
                  snapshot ? normalizeLibraryPathKey(snapshot.rootPath) : null
                }
                unavailableKeys={mruUnavailable}
                onOpen={handleOpenMruLibrary}
                onRemove={handleRemoveMruLibrary}
                onBrowse={() => {
                  setLibrarySwitcherOpen(false);
                  void chooseAndOpenLibrary();
                }}
                onClose={() => setLibrarySwitcherOpen(false)}
              />
            )}
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
          {snapshot && !searchQuery.trim() && (
            <CollectionsSection
              rootPath={snapshot.rootPath}
              documents={documents}
              refreshToken={collectionsVersion}
              reveal={collectionsReveal}
              onNotice={showNotice}
              onSelectDocument={(path) => {
                setMobileLibraryOpen(false);
                recordNavDeparture();
                void selectDocument(path);
              }}
            />
          )}
          {snapshot && !searchQuery.trim() && (
            <div className="library-view-toggle" role="group" aria-label="库浏览形态">
              <button
                type="button"
                aria-pressed={libraryViewMode === "tree"}
                onClick={() => setLibraryViewMode("tree")}
              >
                树形
              </button>
              <button
                type="button"
                aria-pressed={libraryViewMode === "shelf"}
                onClick={() => setLibraryViewMode("shelf")}
              >
                书架
              </button>
            </div>
          )}
          {libraryViewMode === "shelf" && snapshot && !searchQuery.trim() ? (
            <BookshelfView
              onOpenSecondary={handleOpenSecondary}
              onBeforeSelect={recordNavDeparture}
              extents={documentExtents}
            />
          ) : (
            <DocumentTree
              onOpenSecondary={handleOpenSecondary}
              onBeforeSelect={recordNavDeparture}
              estimateForPath={estimateForPath}
            />
          )}
        </div>

        <footer className="sidebar-footer">
          <div className="sidebar-status">
            <strong>{snapshot ? `${documents.length.toLocaleString()} 篇文档` : "尚未打开文档库"}</strong>
            <span ref={statusDetailRef}>{statusDetail}</span>
          </div>
          <div className="theme-controls">
            <button
              className="theme-series-label"
              type="button"
              aria-haspopup="dialog"
              aria-expanded={stylePickerOpen}
              aria-label={`界面风格：${getThemeSeriesLabel(theme)}，点击选择界面风格`}
              title={`界面风格：${THEME_META[theme].label}`}
              onClick={() => setStylePickerOpen((open) => !open)}
            >
              {getThemeSeriesLabel(theme)}
            </button>
            <button
              className={`icon-button${homeOpen ? " is-armed" : ""}`}
              type="button"
              aria-label={homeOpen ? "返回阅读" : "打开主页"}
              title="主页"
              aria-pressed={homeOpen}
              // 无库时不进主页(Welcome 现状,方案 §3.3 空态)。
              disabled={!snapshot}
              onClick={() => {
                setActiveView(homeOpen ? "reader" : "home");
                setMobileLibraryOpen(false);
              }}
            >
              <House size={16} aria-hidden="true" />
            </button>
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
              aria-label={themeMode === "light" ? "切换到深色主题" : "切换到浅色主题"}
              title={themeMode === "light" ? "深色主题" : "浅色主题"}
              onClick={(event) => {
                // 墨水扩散从日/月按钮圆心晕开(plan-theme-ink-transition)。
                const rect = event.currentTarget.getBoundingClientRect();
                setNextThemeTransitionOrigin({
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                });
                toggleTheme();
              }}
            >
              <span className="theme-state-icon" aria-hidden="true">
                <Moon className={themeMode === "light" ? "active" : undefined} size={16} />
                <Sun className={themeMode === "dark" ? "active" : undefined} size={16} />
              </span>
            </button>
          </div>
          <ThemeStylePicker open={stylePickerOpen} onClose={() => setStylePickerOpen(false)} />
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
              className="icon-button"
              type="button"
              aria-label="后退"
              title="后退（Alt+←）"
              disabled={!canNavBack(navHistory)}
              onClick={handleNavBack}
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="前进"
              title="前进（Alt+→）"
              disabled={!canNavForward(navHistory)}
              onClick={handleNavForward}
            >
              <ArrowRight size={16} aria-hidden="true" />
            </button>
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
            {currentContent && !overlayViewOpen && (
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
            {currentContent && !overlayViewOpen && (
              <button
                className={`icon-button${splitState ? " is-armed" : ""}`}
                type="button"
                aria-label={splitState ? "退出分栏对照" : "开启分栏对照"}
                title={
                  splitState
                    ? "退出分栏对照"
                    : splitWide
                      ? "分栏对照（默认打开当前文档；文档树 Alt+点击可在右侧打开）"
                      : "窗口过窄，无法开启分栏（需 ≥1080px）"
                }
                aria-pressed={Boolean(splitState)}
                disabled={!splitState && !splitWide}
                onClick={handleToggleSplit}
              >
                <Columns2 size={16} aria-hidden="true" />
              </button>
            )}
            {currentContent && !overlayViewOpen && (
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
            {currentContent && currentPath && !overlayViewOpen && (
              <>
                <button
                  className={`icon-button${collectionsPopoverOpen ? " is-armed" : ""}`}
                  type="button"
                  aria-label="加入合集"
                  title="把当前文档加入合集"
                  aria-expanded={collectionsPopoverOpen}
                  onClick={() => {
                    setCollectionsPopoverOpen((open) => !open);
                    setSettingsOpen(false);
                    setAnnotationPanelOpen(false);
                  }}
                >
                  <FolderPlus size={16} aria-hidden="true" />
                </button>
                {collectionsPopoverOpen && (
                  <CollectionMembershipPopover
                    currentPath={currentPath}
                    onClose={() => setCollectionsPopoverOpen(false)}
                    onChanged={() => setCollectionsVersion((version) => version + 1)}
                    onNotice={showNotice}
                  />
                )}
              </>
            )}
            {currentContent && !overlayViewOpen && (
              <button
                className={`icon-button${readAloud.barOpen ? " is-armed" : ""}`}
                type="button"
                aria-label={readAloud.barOpen ? "停止朗读" : "朗读正文"}
                title={readAloudDisabledReason ?? (readAloud.barOpen ? "停止朗读" : "朗读正文（仅本地语音）")}
                aria-pressed={readAloud.barOpen}
                disabled={Boolean(readAloudDisabledReason)}
                onClick={handleReadAloudButton}
              >
                <AudioLines size={16} aria-hidden="true" />
              </button>
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
            <ReadingSettingsPanel
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              onNotice={showNotice}
              focusUnavailableReason={focusUnavailableReason}
            />
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
          <div
            className="content-grid"
            hidden={overlayViewOpen}
            {...(splitActive
              ? {
                  "data-split": "true",
                  style: {
                    "--split-pos": `${(splitPos * 100).toFixed(2)}%`,
                  } as CSSProperties,
                }
              : {})}
          >
            {/* reading-frame(RS-D5):替 reading-scroll 占据原 grid 轨道,
                为右缘刻度层提供定位锚;副栏不挂刻度层。 */}
            <div className="reading-frame">
            <div className="reading-scroll" ref={readerRef} onScroll={handleReaderScroll}>
              <div className={`article-shell article-shell--${currentContent.kind}`} ref={articleRef}>
                {/* 文章级 error boundary:单篇渲染错误显示可恢复错误卡,
                    不再把整个应用打成白屏(chrome、面板、侧栏都在边界外)。 */}
                <ArticleErrorBoundary resetKey={currentPath} onRetry={handleArticleRetry}>
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
                    fuzzyAnchoring={fuzzyAnchoring}
                    resolveImageSrc={resolveImageSrc}
                    onNavigate={handleMarkdownNavigate}
                    onLinkPreview={hoverPreview.previewLink}
                    onLinkPreviewCancel={hoverPreviewCancel}
                    onBrokenIdsChange={setMarkdownBrokenIds}
                    onApproximateIdsChange={setMarkdownApproximateIds}
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
                  fuzzyAnchoring={fuzzyAnchoring}
                  readerRef={pdfReaderHandleRef}
                  onRegionCard={({ canvas, page }) =>
                    // 区域引用卡片(plan-pdf-region-card):即用即走,不落库。
                    setQuoteCardSource({
                      kind: "region",
                      image: canvas,
                      sourceTitle: currentDocument.title,
                      page,
                    })
                  }
                  onModeChange={setPdfViewMode}
                  onBrokenAnnotationsChange={setReaderBrokenIds}
                  onApproximateAnnotationsChange={setReaderApproximateIds}
                  onTocChange={handleTocChange}
                  onActiveChange={handleActiveHeadingChange}
                /></Suspense>}
                {currentContent.kind === "epub" && <EpubReader
                  relativePath={currentContent.relativePath}
                  document={currentContent.document}
                  locator={currentLocator}
                  motionLevel={motionLevel}
                  annotations={annotations}
                  fuzzyAnchoring={fuzzyAnchoring}
                  onBrokenAnnotationsChange={setReaderBrokenIds}
                  onApproximateAnnotationsChange={setReaderApproximateIds}
                  onTocChange={handleTocChange}
                  onActiveChange={handleActiveHeadingChange}
                />}
                </ArticleErrorBoundary>
                {/* 读完接着读的末尾哨兵(plan-read-next §3.2):三格式通用。 */}
                <div data-read-next-sentinel aria-hidden="true" />
              </div>
            </div>
            {showScrollMap && (
              <ScrollMap
                marks={scrollMapMarks}
                ttsRatio={ttsMapRatio}
                onSelect={handleScrollMapSelect}
                onSelectTts={handleScrollMapSelectTts}
              />
            )}
            {readingRuler && hoverCapable && focusContentKind && (
              <ReadingRuler
                readerRef={readerRef}
                fontSize={readingSettings.fontSize}
                lineHeight={readingSettings.lineHeight}
              />
            )}
            </div>

            {splitActive && splitState && (
              <>
                <div
                  className="split-divider"
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整分栏比例"
                  aria-valuemin={30}
                  aria-valuemax={70}
                  aria-valuenow={Math.round(splitPos * 100)}
                  tabIndex={0}
                  title="拖拽或用 ←/→ 调整主栏宽度（30%–70%）"
                  onPointerDown={handleSplitDividerPointerDown}
                  onPointerMove={handleSplitDividerPointerMove}
                  onPointerUp={handleSplitDividerPointerEnd}
                  onPointerCancel={handleSplitDividerPointerEnd}
                  onKeyDown={handleSplitDividerKeyDown}
                />
                <Suspense
                  fallback={
                    <section className="secondary-pane" aria-label="副栏阅读">
                      <div className="secondary-pane-state" role="status">
                        <span className="spinner" aria-hidden="true" />
                        正在加载副栏…
                      </div>
                    </section>
                  }
                >
                  <SecondaryPane
                    path={splitState.path}
                    documents={documents}
                    motionLevel={motionLevel}
                    scrollMemory={paneScrollMemory.current}
                    pdfPositionMemory={panePdfMemory.current}
                    onClose={() => setSplitState(null)}
                    onPathChange={(path) => setSplitState({ path })}
                  />
                </Suspense>
              </>
            )}

            <aside className="toc-panel" aria-label="本文目录与标注">
              <SidePanel
                tab={sidePanelTab}
                onTabChange={setSidePanelTab}
                tocItems={toc}
                activeId={activeHeading}
                onSelectHeading={scrollToHeading}
                tocHeat={tocHeat}
                tocReachedIds={tocReachedIds}
                onSelectDocumentTop={scrollToDocumentTop}
                tocEstimateLine={tocEstimateLine}
                annotations={sortedAnnotations}
                brokenIds={brokenAnnotationIds}
                approximateIds={approximateAnnotationIds}
                annotationsLoading={annotationsLoading}
                annotationSort={annotationSort}
                onAnnotationSortChange={setAnnotationSort}
                onExportAnnotations={() => void handleExportAnnotations()}
                onSelectAnnotation={jumpToAnnotation}
                onDeleteAnnotation={(annotation) => void handleDeleteAnnotation(annotation)}
                onEditAnnotationNote={handleEditAnnotationNote}
                onChangeAnnotationColor={(annotation, color) => void handleChangeAnnotationColor(annotation, color)}
                onRelocateAnnotation={handleRelocateAnnotation}
                onGenerateAnnotationCard={handleGenerateCardFromAnnotation}
                onCompileAnnotationsDigest={handleOpenBookDigest}
                onClearAnnotations={() => void handleClearAnnotations()}
                linksState={documentLinksState}
                onSelectLinkDocument={handleSelectLinkDocument}
                onPreviewLinkTarget={handlePreviewPanelTarget}
                onPreviewLinkCancel={hoverPreviewCancel}
                libraryStatus={libraryAnnotations.status}
                libraryGroups={libraryGroups}
                libraryError={libraryAnnotations.status === "error" ? libraryAnnotations.message : null}
                currentPath={currentPath}
                lostDocuments={lostDocuments}
                libraryDocuments={libraryDocumentOptions}
                libraryFilters={libraryFilters}
                onLibraryFiltersChange={setLibraryFilters}
                libraryFilterActive={libraryFilterActive}
                onDryRunRebind={handleDryRunRebind}
                onRebindLostDocument={handleRebindLostDocument}
                onRefreshLibraryAnnotations={() => void loadLibraryAnnotations()}
                onExportLibraryAnnotations={() => void handleExportLibraryAnnotations()}
                onExportLibraryGroup={(group) => void handleExportLibraryGroup(group)}
                onExportLibraryJson={() => void handleExportAnnotationsJson()}
                onExportLibraryCsv={() => void handleExportAnnotationsCsv()}
                onImportLibraryAnnotations={() => void handleImportAnnotations()}
                onSelectLibraryAnnotation={handleSelectLibraryAnnotation}
                onOpenLibraryHub={openAnnotationHub}
              />
            </aside>
          </div>
        ) : (
          !overlayViewOpen && (
            <Welcome
              hasLibrary={Boolean(snapshot)}
              documentCount={documents.length}
              onOpen={() =>
                void (IS_WEB_RUNTIME ? refreshLibrary() : chooseAndOpenLibrary())
              }
              isWeb={IS_WEB_RUNTIME}
              recentLibraries={libraryMru}
              unavailableKeys={mruUnavailable}
              onOpenRecent={handleOpenMruLibrary}
              onRemoveRecent={handleRemoveMruLibrary}
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

        {homeOpen && (
          <Suspense
            fallback={
              <div className="stats-state">
                <span className="spinner" aria-hidden="true" />
                正在加载主页…
              </div>
            }
          >
            <HomeView
              reviewSummary={homeReviewSummary}
              remainingEstimate={remainingEstimateForItem}
              onOpenAnnotation={handleSelectLibraryAnnotation}
            />
          </Suspense>
        )}

        {reviewOpen && (
          <Suspense
            fallback={
              <div className="stats-state">
                <span className="spinner" aria-hidden="true" />
                正在加载回顾…
              </div>
            }
          >
            <ReviewView
              session={reviewSession}
              onSessionChange={setReviewSession}
              onOpenAnnotation={handleSelectLibraryAnnotation}
              onExit={() => setActiveView("home")}
            />
          </Suspense>
        )}

        {annotationsOpen && (
          <Suspense
            fallback={
              <div className="stats-state">
                <span className="spinner" aria-hidden="true" />
                正在加载标注中枢…
              </div>
            }
          >
            <AnnotationHubView
              status={libraryAnnotations.status}
              groups={libraryGroups}
              error={libraryAnnotations.status === "error" ? libraryAnnotations.message : null}
              currentPath={currentPath}
              filters={libraryFilters}
              onFiltersChange={setLibraryFilters}
              filterActive={libraryFilterActive}
              onRefresh={() => void loadLibraryAnnotations()}
              onExport={() => void handleExportLibraryAnnotations()}
              onExportGroup={(group) => void handleExportLibraryGroup(group)}
              onCompileCurrentGroup={handleOpenBookDigest}
              onSelect={handleSelectLibraryAnnotation}
              onExit={() => setActiveView("reader")}
            />
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
            tocHeat={tocHeat}
            tocReachedIds={tocReachedIds}
            onSelectDocumentTop={scrollToDocumentTop}
            tocEstimateLine={tocEstimateLine}
            annotations={sortedAnnotations}
            brokenIds={brokenAnnotationIds}
            approximateIds={approximateAnnotationIds}
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
            onRelocateAnnotation={(annotation) => {
              // 抽屉挡住正文,先收起再定位预览。
              setCompactTocOpen(false);
              handleRelocateAnnotation(annotation);
            }}
            onGenerateAnnotationCard={(annotation) => {
              setCompactTocOpen(false);
              handleGenerateCardFromAnnotation(annotation);
            }}
            onCompileAnnotationsDigest={handleOpenBookDigest}
            onClearAnnotations={() => void handleClearAnnotations()}
            linksState={documentLinksState}
            onSelectLinkDocument={handleSelectLinkDocument}
            onPreviewLinkTarget={handlePreviewPanelTarget}
            onPreviewLinkCancel={hoverPreviewCancel}
            libraryStatus={libraryAnnotations.status}
            libraryGroups={libraryGroups}
            libraryError={libraryAnnotations.status === "error" ? libraryAnnotations.message : null}
            currentPath={currentPath}
            lostDocuments={lostDocuments}
            libraryDocuments={libraryDocumentOptions}
            libraryFilters={libraryFilters}
            onLibraryFiltersChange={setLibraryFilters}
            libraryFilterActive={libraryFilterActive}
            onDryRunRebind={handleDryRunRebind}
            onRebindLostDocument={handleRebindLostDocument}
            onRefreshLibraryAnnotations={() => void loadLibraryAnnotations()}
            onExportLibraryAnnotations={() => void handleExportLibraryAnnotations()}
            onExportLibraryGroup={(group) => void handleExportLibraryGroup(group)}
            onExportLibraryJson={() => void handleExportAnnotationsJson()}
            onExportLibraryCsv={() => void handleExportAnnotationsCsv()}
            onImportLibraryAnnotations={() => void handleImportAnnotations()}
            onSelectLibraryAnnotation={handleSelectLibraryAnnotation}
            onOpenLibraryHub={openAnnotationHub}
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
          onMakeCard={handleMakeCardFromSelection}
          onFindRelated={handleFindRelated}
          canFindRelated={canFindRelated}
          onCopyDeepLink={
            IS_WEB_RUNTIME ? () => void handleCopySelectionLink() : undefined
          }
          onClose={closeToolbar}
          canHighlight={Boolean(pendingSelection)}
        />

        {relatedPassages && (
          <RelatedPassagesPopover
            state={relatedPassages}
            x={relatedPassages.x}
            y={relatedPassages.y}
            onSelect={handleSelectRelated}
            onClose={closeRelatedPassages}
          />
        )}

        {hoverPreview.preview && (
          <HoverPreviewCard
            preview={hoverPreview.preview}
            onOpen={(href) => {
              hoverPreview.closePreview();
              void handleNavigate(href);
            }}
            onHold={hoverPreview.holdPreview}
            onRelease={hoverPreviewCancel}
          />
        )}

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
            onGenerateCard={handleGenerateCardFromAnnotation}
            onClose={() => setMarkEditor(null)}
          />
        )}

        {quoteCardSource && (
          <Suspense fallback={null}>
            <QuoteCardDialog
              source={quoteCardSource}
              onClose={() => setQuoteCardSource(null)}
              onNotice={showNotice}
            />
          </Suspense>
        )}

        {bookDigestOpen && currentDocument && currentContent && (
          <Suspense fallback={null}>
            <BookDigestView
              docTitle={currentDocument.title}
              format={currentContent.kind}
              toc={toc}
              annotations={annotations}
              epubChapterTocIds={epubChapterTocIds}
              onClose={() => setBookDigestOpen(false)}
              onJump={handleDigestJump}
              onNotice={showNotice}
            />
          </Suspense>
        )}

        <CommandPalette
          open={commandPaletteOpen}
          entries={paletteEntries}
          onExecute={handleExecutePaletteEntry}
          onClose={() => setCommandPaletteOpen(false)}
        />


        {/* 读完接着读:与朗读条同区位,朗读中不出卡(RN-D3)。 */}
        {readNextTarget && !readAloud.barOpen && !overlayViewOpen && (
          <Suspense fallback={null}>
            <ReadNextCard
              title={readNextTarget.title}
              format={readNextTarget.document.format}
              reason={readNextTarget.reason}
              estimate={readNextTarget.estimate}
              motionLevel={motionLevel}
              onOpen={openReadNext}
              onDismiss={dismissReadNext}
            />
          </Suspense>
        )}

        {readAloud.barOpen && !overlayViewOpen && (
          <ReadAloudBar
            status={readAloud.status}
            sentenceIndex={readAloud.sentenceIndex}
            sentenceCount={readAloud.sentenceCount}
            rate={ttsRate}
            voices={readAloud.voices}
            voiceName={readAloud.voice?.name ?? ""}
            onToggle={readAloud.toggle}
            onPrevious={readAloud.previous}
            onNext={readAloud.next}
            onRestart={readAloud.startFromTop}
            onRateChange={setTtsRate}
            onVoiceChange={setTtsVoiceName}
            onStop={readAloud.stop}
          />
        )}

        {relocatePreview && (
          <div
            className="annotation-relocate-bar reade-motion-panel"
            role="dialog"
            aria-label="确认重新定位标注"
          >
            <span className="annotation-relocate-message">
              {relocatePreview.fuzzyHit
                ? "已按相似度找到近似位置（非精确匹配），确认把标注移动到高亮处？"
                : "已在文档中找到匹配位置，确认把标注移动到高亮处？"}
            </span>
            <div className="annotation-relocate-actions">
              <button type="button" onClick={clearRelocatePreview}>
                取消
              </button>
              <button
                type="button"
                className="annotation-relocate-confirm"
                onClick={() => void confirmRelocateAnnotation()}
              >
                移动标注
              </button>
            </div>
          </div>
        )}

        {importReview && (
          <AnnotationImportConfirm
            summary={{
              fileName: importReview.fileName,
              added: importReview.plan.added,
              skipped: importReview.plan.skipped,
              updated: importReview.plan.updated,
              deletions: importReview.plan.deletions,
              rebindDocuments: importReview.plan.rebindSuggestions.length,
              totalWrites: importReview.plan.toUpsert.length,
            }}
            busy={importBusy}
            onConfirm={() => void confirmImportAnnotations()}
            onCancel={() => {
              if (!importBusy) setImportReview(null);
            }}
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
