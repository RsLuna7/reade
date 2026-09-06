use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ignore::{DirEntry, WalkBuilder};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};

use crate::documents::{
    allowed_epub_asset, parse_epub, DocumentFormat, EpubDocument, IndexStatus, PdfPageContent,
    PdfReadingMode, MAX_CONVERTIBLE_BYTES,
};
use crate::links::{extract_document_links, wiki_file_stem, wiki_path_stem, ExtractedLink};
use crate::user_store::{sync_document_fingerprints, UserState};

pub(crate) const MAX_MARKDOWN_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 25 * 1024 * 1024;
const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;
const CACHE_SCHEMA_VERSION: i64 = 1;
/// Bookshelf cover thumbnails (docs/plan-bookshelf-covers.md §3.2): the
/// frontend renders the PNG (pdf.js page 1 / EPUB cover downscale), the
/// backend only validates and stores the bytes — no image decoding here.
const THUMBNAIL_MAX_PNG_BYTES: usize = 512 * 1024;
const THUMBNAIL_MAX_DIMENSION: u32 = 640;
const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const CACHE_SOFT_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;
const CACHE_LOW_WATER_BYTES: u64 = CACHE_SOFT_LIMIT_BYTES * 9 / 10;
/// Read snapshots (docs/plan-incremental-reread.md IR-D5): an independent
/// 256 MiB LRU sub-budget so "last read version" copies never eat into the
/// 1 GiB conversion-cache budget above. Unlike the main eviction, snapshot
/// eviction may drop rows of the active library (pure LRU by last_accessed).
const SNAPSHOT_SOFT_LIMIT_BYTES: u64 = 256 * 1024 * 1024;
const SNAPSHOT_LOW_WATER_BYTES: u64 = SNAPSHOT_SOFT_LIMIT_BYTES * 9 / 10;
/// Multi-segment formats (PDF pages / EPUB chapters) join their segment
/// texts with this record separator inside `document_read_snapshots.content`;
/// the diff splits both sides through the same join+split transform.
const SNAPSHOT_UNIT_SEPARATOR: &str = "\u{1E}";
/// Diff degradation ladder (IR-D3): beyond this many units on either side
/// the diff reports a whole-document update instead of per-unit marks.
const DIFF_MAX_UNITS: usize = 5_000;
/// Mid-section LCS table cap (u16 cells ≈ 8 MiB); larger middles fall back
/// to the multiset approximation (moves stop being flagged, still exact
/// about fresh/removed counts).
const DIFF_MAX_LCS_CELLS: usize = 4_000_000;
const DEFAULT_SEARCH_LIMIT: u32 = 30;
const MAX_SEARCH_LIMIT: u32 = 100;
/// `list_document_links` truncates each of its lists to this many entries.
const LINKS_LIST_LIMIT: usize = 500;
/// Related-passage fragment contract (`docs/plan-related-passages.md`
/// §3.2, RP-D1). The TS twin lives in `src/lib/relatedFragments.ts`; the
/// numbered cases F01.. in `relatedFragments.test.ts` are mirrored below.
pub(crate) const RELATED_MAX_FRAGMENTS: usize = 6;
const RELATED_MAX_TEXT_CHARS: usize = 2_000;
const RELATED_LONG_RUN_CHARS: usize = 12;
const RELATED_FRAGMENT_SLICE_CHARS: usize = 8;
const RELATED_MIN_FRAGMENT_CHARS: usize = 3;
const RELATED_DEFAULT_LIMIT: u32 = 12;
const RELATED_MAX_LIMIT: u32 = 50;
/// Common CJK punctuation that splits selection runs, on top of ASCII
/// punctuation and whitespace. Must stay identical to
/// `RELATED_CJK_DELIMITERS` in `src/lib/relatedFragments.ts`.
const RELATED_CJK_DELIMITERS: &str =
    "，。；：！？、「」『』（）《》…—·\u{201c}\u{201d}\u{2018}\u{2019}";
const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);
const CONVERTER_REVISION: &str =
    "reade-multiformat-v2:anydoc-0.1.8:pdf-inspector-0.1.8:epub-toc-level";

const EXCLUDED_DIRECTORIES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".next",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".turbo",
    ".vite",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "vendor",
];

pub(crate) type CommandResult<T> = Result<T, String>;
pub(crate) use crate::library_paths::{
    canonical_library_root, normalize_relative_path, normalize_root, resolve_existing_in_root,
    validate_relative_library_path,
};

/// Result of `open_library` / `refresh_library` (D02): the scanned
/// documents plus the backend-normalized library identity the frontend
/// uses to filter stale events. `root_key` is `normalize_root(canonical)`,
/// independent of the user-typed path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LibraryOpenResult {
    pub root_key: String,
    pub documents: Vec<DocumentInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub relative_path: String,
    pub title: String,
    pub size: u64,
    pub modified: u64,
    pub format: DocumentFormat,
    pub index_status: IndexStatus,
    pub index_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchLocator {
    PdfPage { page: u32 },
    EpubChapter { chapter_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub result_id: String,
    pub relative_path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
    pub format: DocumentFormat,
    pub locator: Option<SearchLocator>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DocumentContent {
    Markdown {
        relative_path: String,
        markdown: String,
    },
    Pdf {
        relative_path: String,
        size: u64,
        index_status: IndexStatus,
        index_error: Option<String>,
    },
    Epub {
        relative_path: String,
        document: EpubDocument,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetData {
    pub relative_path: String,
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct IndexProgress {
    /// Normalized identity of the library this progress belongs to, so the
    /// frontend can drop progress emitted for a library it has already
    /// switched away from (D02: events must carry their origin context).
    library_root: String,
    total: usize,
    completed: usize,
    ready: usize,
    partial: usize,
    failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DocumentIndexEvent {
    library_root: String,
    relative_path: String,
    title: String,
    status: IndexStatus,
    error: Option<String>,
}

struct OpenEpubAssets {
    size: u64,
    modified: u64,
    assets: Vec<(String, Vec<u8>)>,
    /// Sum of asset byte lengths, for the LRU budget below.
    bytes_total: u64,
    /// Monotonic last-use stamp (`epub_asset_stamp` counter); eviction input.
    last_used: u64,
}

/// D07: EPUB asset sessions are keyed by (library identity, document path)
/// instead of a single global slot, so main/secondary panes, multiple books
/// and same-named documents in different libraries each hold their own
/// immutable asset set. Same-path dual panes share one session (the asset
/// bytes are immutable for a given file version).
type EpubAssetSessions = HashMap<(String, String), OpenEpubAssets>;

/// D07 初始预算（计划 §4 D07.3 建议值；最终由 D10 样本校准）：全部活跃
/// EPUB 资产会话的字节总预算。超限时按 last_used 淘汰最久未用的会话；
/// 被淘汰会话的后续读取返回"重新打开"错误（明确降级，不静默卡死）。
const EPUB_ASSET_BUDGET_BYTES: u64 = 128 * 1024 * 1024;

struct LibraryState {
    root: Option<PathBuf>,
    /// Normalized identity of the open library (`normalize_root` of `root`).
    /// Events and open results carry this so the frontend can filter stale
    /// context without string-comparing user-typed paths.
    root_key: String,
    documents: Vec<DocumentInfo>,
    cache: Connection,
    watcher: Option<RecommendedWatcher>,
    /// Scan revision: bumped by every successful open and every refresh.
    generation: u64,
    /// Open-session identity: bumped ONLY by successful library opens, so
    /// A→B→A yields three distinct sessions while a same-library refresh
    /// keeps the reading session valid (plan §3.1).
    open_session: u64,
    /// D07: per-document EPUB asset sessions (see `EpubAssetSessions`).
    open_epub_assets: EpubAssetSessions,
    /// Monotonic stamp for LRU bookkeeping on `open_epub_assets`.
    epub_asset_stamp: u64,
}

/// Ticket counter for in-flight `open_library` requests. A commit whose
/// ticket is no longer the newest must not overwrite the root committed by
/// a later open (A slow + B fast must not leave the backend rooted at A).
static OPEN_REQUEST: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<LibraryState>>,
    index_gate: Arc<Mutex<()>>,
    /// D09: on-disk cache path (None for in-memory test states). Lets scans
    /// run on a dedicated connection outside the state lock.
    cache_path: Option<PathBuf>,
}

impl AppState {
    pub fn new(cache_directory: PathBuf) -> CommandResult<Self> {
        fs::create_dir_all(&cache_directory)
            .map_err(|error| format!("Cannot create application cache directory: {error}"))?;
        let cache_path = cache_directory.join("reade-cache.sqlite3");
        let connection = open_cache_connection(&cache_path)?;
        Self::from_connection(connection, Some(cache_path))
    }

    fn from_connection(connection: Connection, cache_path: Option<PathBuf>) -> CommandResult<Self> {
        initialize_cache(&connection)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(LibraryState {
                root: None,
                root_key: String::new(),
                documents: Vec::new(),
                cache: connection,
                watcher: None,
                generation: 0,
                open_session: 0,
                open_epub_assets: HashMap::new(),
                epub_asset_stamp: 0,
            })),
            index_gate: Arc::new(Mutex::new(())),
            cache_path,
        })
    }

    pub(crate) fn failed_index_count(&self) -> u32 {
        self.inner
            .lock()
            .map(|current| {
                current
                    .documents
                    .iter()
                    .filter(|document| {
                        document.index_status == crate::documents::IndexStatus::Failed
                    })
                    .count() as u32
            })
            .unwrap_or(0)
    }

    /// D09: a short-lived connection for out-of-lock scans. WAL lets the
    /// scan's reads and cache-row clears coexist with the main connection's
    /// short background-index transactions; busy_timeout resolves writer
    /// overlaps deterministically instead of failing fast.
    fn scan_connection(&self) -> CommandResult<Connection> {
        let path = self
            .cache_path
            .as_ref()
            .ok_or_else(|| "Document cache path is unavailable for scanning".to_owned())?;
        let connection = open_cache_connection(path)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|error| format!("Cannot configure scan busy timeout: {error}"))?;
        Ok(connection)
    }

    #[cfg(test)]
    fn in_memory() -> CommandResult<Self> {
        Self::from_connection(
            Connection::open_in_memory()
                .map_err(|error| format!("Cannot create test cache: {error}"))?,
            None,
        )
    }

    #[cfg(test)]
    fn file_backed(directory: &Path) -> CommandResult<Self> {
        Self::new(directory.to_path_buf())
    }
}

#[derive(Debug)]
struct IndexSegment {
    locator_kind: Option<&'static str>,
    locator_value: Option<String>,
    ordinal: u32,
    content: String,
    needs_ocr: bool,
    ocr_reason: Option<String>,
}

#[derive(Debug)]
struct IndexedDocument {
    title: String,
    status: IndexStatus,
    error: Option<String>,
    segments: Vec<IndexSegment>,
    /// Outgoing library links extracted from markdown sources; always
    /// empty for the other formats (backlinks plan §2: PDF/EPUB are link
    /// targets only).
    links: Vec<ExtractedLink>,
}

/// Aggregated backlinks: one row per source document that links to the
/// queried path, with the first link text as an excerpt.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkEntry {
    pub source_path: String,
    pub source_title: String,
    pub link_text: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingEntry {
    /// `"document" | "asset" | "wiki"`.
    pub kind: String,
    /// Resolved library path; also filled for wiki links that resolve to
    /// exactly one candidate.
    pub target_path: Option<String>,
    /// Display form: the stored path for standard links, the stem for
    /// wiki links.
    pub raw_target: String,
    pub link_text: String,
    /// Whether the target is in the current scan set (wiki: uniquely
    /// resolved). Asset existence is never checked on disk.
    pub present: bool,
    /// Wiki candidate count when ambiguous (> 1); 0 otherwise.
    pub ambiguous_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentLinks {
    pub backlinks: Vec<BacklinkEntry>,
    pub outgoing: Vec<OutgoingEntry>,
    /// Outgoing document targets missing from the scan set (unresolved
    /// wiki stems included, ambiguous ones excluded). Assets are never
    /// counted (plan §3.3/§7).
    pub broken_count: u64,
}

#[tauri::command]
pub async fn open_library(
    root_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<LibraryOpenResult> {
    // Take the open ticket BEFORE any blocking work: a later open that
    // finishes first wins the commit, and this request's commit must fail
    // once a newer ticket exists (D02: opening A then B cannot commit A last).
    let request = OPEN_REQUEST.fetch_add(1, Ordering::SeqCst) + 1;
    let root = run_blocking(move || canonical_library_root(Path::new(&root_path))).await?;
    // D09: the filesystem walk runs on the blocking pool against a dedicated
    // cache connection — it holds neither the async runtime thread nor the
    // state lock, so searches and reads stay responsive during a scan.
    let scan_root = root.clone();
    let scan_state = state.inner().clone();
    let documents = run_blocking(move || {
        let mut scan_cache = scan_state.scan_connection()?;
        scan_documents(&scan_root, &mut scan_cache)
    })
    .await?;
    record_scan_fingerprints(&user, &root, &documents).await;
    let watcher = create_watcher(&root, app.clone())?;
    let (root_key, generation) =
        commit_open_library(&state, root.clone(), documents, Some(watcher), request)?;
    let snapshot = lock_state(&state)?.documents.clone();
    spawn_background_index(app, root_key.clone(), generation, snapshot.clone());
    Ok(LibraryOpenResult {
        root_key,
        documents: snapshot,
    })
}

/// Commits a completed open for `root`. Fails when a newer `open_library`
/// request has started since this one took its ticket: the stale open must
/// not repoint the backend root at the old library (its watcher is dropped
/// with the failed commit). On success, bumps both the scan revision
/// (`generation`) and the open-session identity, and returns the new
/// `root_key` plus `generation` for follow-up indexing.
fn commit_open_library(
    state: &AppState,
    root: PathBuf,
    documents: Vec<DocumentInfo>,
    watcher: Option<RecommendedWatcher>,
    request: u64,
) -> CommandResult<(String, u64)> {
    let mut current = state
        .inner
        .lock()
        .map_err(|_| "Library state lock was poisoned".to_owned())?;
    if OPEN_REQUEST.load(Ordering::SeqCst) != request {
        return Err(
            "A newer open_library request superseded this open; ignore the stale result".to_owned(),
        );
    }
    let root_key = normalize_root(&root);
    current.generation = current.generation.wrapping_add(1);
    current.open_session = current.open_session.wrapping_add(1);
    current.root = Some(root);
    current.root_key = root_key.clone();
    current.documents = documents;
    current.watcher = watcher;
    // A library switch invalidates every EPUB asset session of the old
    // library (D07: sessions are keyed by library identity).
    current.open_epub_assets.clear();
    Ok((root_key, current.generation))
}

/// Read-only existence probe for the recent-libraries list
/// (plan-library-mru §3.2): reports only whether the path is a directory,
/// never its contents. Opening still goes through `open_library` with the
/// full canonicalize + scan boundary. Runs on the blocking pool because a
/// disconnected network drive can stall the metadata call for seconds.
#[tauri::command]
pub async fn probe_library_path(path: String) -> CommandResult<bool> {
    run_blocking(move || Ok(probe_path_is_directory(&path))).await
}

fn probe_path_is_directory(path: &str) -> bool {
    Path::new(path).is_dir()
}

#[tauri::command]
pub async fn refresh_library(
    app: AppHandle,
    state: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<LibraryOpenResult> {
    let root = current_root(&state)?;
    let scan_root = root.clone();
    let app_state = state.inner().clone();
    // D09: scan on the blocking pool against a dedicated connection, same
    // as open_library — the state lock is only taken to publish the result.
    let documents = run_blocking(move || {
        let mut scan_cache = app_state.scan_connection()?;
        scan_documents(&scan_root, &mut scan_cache)
    })
    .await?;
    record_scan_fingerprints(&user, &root, &documents).await;
    let (root_key, generation) = {
        let mut current = lock_state(&state)?;
        if current.root.as_ref() != Some(&root) {
            return Err("The library changed while it was being refreshed; retry".to_owned());
        }
        // A refresh keeps the open-session identity: same-library scans must
        // not invalidate still-valid reading contexts (plan §3.1). EPUB
        // asset sessions also stay; a changed file fails its size/modified
        // check on the next read and is dropped then (D07).
        current.generation = current.generation.wrapping_add(1);
        current.documents = documents;
        (current.root_key.clone(), current.generation)
    };
    let snapshot = lock_state(&state)?.documents.clone();
    spawn_background_index(app, root_key.clone(), generation, snapshot.clone());
    Ok(LibraryOpenResult {
        root_key,
        documents: snapshot,
    })
}

/// Opens the system file manager and selects a library file or folder.
/// The frontend only sends a relative path; canonicalize + library-root
/// containment happen here so the UI never learns or opens arbitrary paths.
#[tauri::command]
pub async fn reveal_in_file_manager(
    relative_path: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let root = current_root(&state)?;
    run_blocking(move || reveal_path_in_file_manager(&root, &relative_path)).await
}

fn reveal_path_in_file_manager(root: &Path, relative_path: &str) -> CommandResult<()> {
    let path = resolve_existing_in_root(root, relative_path)?;
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|error| format!("Cannot reveal path in file manager: {error}"))
}

#[tauri::command]
pub async fn open_document(
    relative_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<DocumentContent> {
    let root = current_root(&state)?;
    let path = resolve_existing_in_root(&root, &relative_path)?;
    let format =
        DocumentFormat::from_path(&path).ok_or_else(|| "Unsupported document format".to_owned())?;
    // D07: opening a Markdown/PDF no longer clears EPUB asset sessions —
    // a secondary-pane EPUB keeps its images while the main pane reads
    // something else. Sessions are keyed per document and expire on their
    // own size/modified check.
    match format {
        DocumentFormat::Markdown | DocumentFormat::Mdx => {
            let markdown = run_blocking(move || {
                read_utf8_lossy_with_limit(&path, MAX_MARKDOWN_BYTES, "Markdown document")
            })
            .await?;
            Ok(DocumentContent::Markdown {
                relative_path,
                markdown,
            })
        }
        DocumentFormat::Pdf => {
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Cannot inspect PDF document: {error}"))?;
            let current = lock_state(&state)?;
            let info = current
                .documents
                .iter()
                .find(|document| document.relative_path == relative_path)
                .cloned();
            let content = DocumentContent::Pdf {
                relative_path,
                size: metadata.len(),
                index_status: info
                    .as_ref()
                    .map_or(IndexStatus::Pending, |value| value.index_status),
                index_error: info.as_ref().and_then(|value| value.index_error.clone()),
            };
            let generation = current.generation;
            let root_key = current.root_key.clone();
            drop(current);
            if let Some(document) = info.filter(|value| {
                matches!(
                    value.index_status,
                    IndexStatus::Pending | IndexStatus::Failed
                )
            }) {
                spawn_background_index(app, root_key, generation, vec![document]);
            }
            Ok(content)
        }
        DocumentFormat::Epub => {
            let metadata = fs::metadata(&path)
                .map_err(|error| format!("Cannot inspect EPUB document: {error}"))?;
            if metadata.len() > MAX_CONVERTIBLE_BYTES {
                return Err(format!(
                    "EPUB 文件过大（{} MiB）；最大支持 128 MiB",
                    metadata.len() / (1024 * 1024)
                ));
            }
            let fallback = fallback_title(&path);
            let bytes = run_blocking(move || {
                fs::read(path).map_err(|error| format!("Cannot read EPUB document: {error}"))
            })
            .await?;
            let index_gate = state.index_gate.clone();
            let parsed = run_blocking(move || {
                let _guard = index_gate
                    .lock()
                    .map_err(|_| "Document index gate was poisoned".to_owned())?;
                parse_epub(&bytes, &fallback)
            })
            .await?;
            let indexed = IndexedDocument {
                title: parsed.payload.title.clone(),
                status: IndexStatus::Ready,
                error: None,
                segments: parsed
                    .search_segments
                    .iter()
                    .enumerate()
                    .map(|(ordinal, (chapter, _, content))| IndexSegment {
                        locator_kind: Some("epubChapter"),
                        locator_value: Some(chapter.clone()),
                        ordinal: ordinal as u32,
                        content: content.clone(),
                        needs_ocr: false,
                        ocr_reason: None,
                    })
                    .collect(),
                links: Vec::new(),
            };
            let committed = commit_epub_open_result(
                state.inner(),
                &root,
                &relative_path,
                &indexed,
                parsed.asset_bytes,
            )?;
            if committed {
                emit_document_status(&app, &normalize_root(&root), &relative_path, &indexed);
            }
            Ok(DocumentContent::Epub {
                relative_path,
                document: parsed.payload,
            })
        }
    }
}

/// Applies a finished EPUB parse to the open library (state writes + cache
/// index). Returns `false` when the library switched while the parse was in
/// flight: the stale result must not mutate the new library's documents,
/// status, or single EPUB asset cache (D02). The caller only emits the
/// status event when this returns `true`.
fn commit_epub_open_result(
    state: &AppState,
    captured_root: &Path,
    relative_path: &str,
    indexed: &IndexedDocument,
    assets: Vec<(String, Vec<u8>)>,
) -> CommandResult<bool> {
    let mut current = state
        .inner
        .lock()
        .map_err(|_| "Library state lock was poisoned".to_owned())?;
    if current.root.as_ref() != Some(&captured_root.to_path_buf()) {
        return Ok(false);
    }
    let document = current
        .documents
        .iter()
        .find(|document| document.relative_path == relative_path)
        .cloned()
        .ok_or_else(|| "Document is not in the current library".to_owned())?;
    store_index_result(&mut current.cache, captured_root, &document, indexed)?;
    update_document_status(&mut current, relative_path, indexed);
    // D07: register this document's asset session under (library, path).
    current.epub_asset_stamp += 1;
    let stamp = current.epub_asset_stamp;
    let root_key = current.root_key.clone();
    let bytes_total = assets.iter().map(|(_, bytes)| bytes.len() as u64).sum();
    current.open_epub_assets.insert(
        (root_key, relative_path.to_owned()),
        OpenEpubAssets {
            size: document.size,
            modified: document.modified,
            assets,
            bytes_total,
            last_used: stamp,
        },
    );
    enforce_epub_asset_budget(&mut current);
    Ok(true)
}

/// D07: keeps the total bytes of live EPUB asset sessions within
/// `EPUB_ASSET_BUDGET_BYTES`, evicting least-recently-used sessions first.
/// An evicted session fails its next asset read with a "reopen" error —
/// explicit degradation instead of unbounded memory or silent corruption.
fn enforce_epub_asset_budget(current: &mut LibraryState) {
    let mut total: u64 = current
        .open_epub_assets
        .values()
        .map(|s| s.bytes_total)
        .sum();
    while total > EPUB_ASSET_BUDGET_BYTES && current.open_epub_assets.len() > 1 {
        let victim = current
            .open_epub_assets
            .iter()
            .min_by_key(|(_, session)| session.last_used)
            .map(|(key, _)| key.clone());
        let Some(key) = victim else { break };
        if let Some(removed) = current.open_epub_assets.remove(&key) {
            total = total.saturating_sub(removed.bytes_total);
        }
    }
}

#[tauri::command]
pub async fn read_document_range(
    relative_path: String,
    offset: u64,
    length: u64,
    state: State<'_, AppState>,
) -> CommandResult<Response> {
    if length == 0 || length > MAX_RANGE_BYTES {
        return Err(format!(
            "Range length must be between 1 and {MAX_RANGE_BYTES} bytes"
        ));
    }
    // Root and session are captured atomically: the read always uses the
    // captured root, and a library switch after the read fails the request
    // instead of delivering old-library bytes into the new context (D02).
    let (root, open_session) = current_root_and_session(&state)?;
    let bytes =
        run_blocking(move || read_pdf_range_from_root(&root, &relative_path, offset, length))
            .await?;
    ensure_same_open_session(&state, open_session)?;
    Ok(Response::new(bytes))
}

fn read_pdf_range_from_root(
    root: &Path,
    relative_path: &str,
    offset: u64,
    length: u64,
) -> CommandResult<Vec<u8>> {
    if length == 0 || length > MAX_RANGE_BYTES {
        return Err(format!(
            "Range length must be between 1 and {MAX_RANGE_BYTES} bytes"
        ));
    }
    let path = resolve_existing_in_root(root, relative_path)?;
    if DocumentFormat::from_path(&path) != Some(DocumentFormat::Pdf) {
        return Err("Range reads are only available for PDF documents".to_owned());
    }
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Cannot inspect PDF document: {error}"))?;
    if offset >= metadata.len() {
        return Err("Range starts past the end of the PDF".to_owned());
    }
    // D06: legitimate requests stay within the size captured at open time
    // (the transport length). A request crossing EOF means the file shrank
    // since the document was opened — fail with a stable error instead of
    // returning a silently truncated chunk that PDF.js would treat as
    // complete data.
    if offset.saturating_add(length) > metadata.len() {
        return Err("The PDF file changed while it was being read; reopen the document".to_owned());
    }
    let read_length = length.min(metadata.len() - offset) as usize;
    let mut file =
        File::open(&path).map_err(|error| format!("Cannot open PDF document: {error}"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Cannot seek PDF document: {error}"))?;
    let mut bytes = vec![0; read_length];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Cannot read PDF range: {error}"))?;
    Ok(bytes)
}

#[tauri::command]
pub async fn read_pdf_reading_mode(
    relative_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<PdfReadingMode> {
    let root = current_root(&state)?;
    let document = {
        let current = lock_state(&state)?;
        current
            .documents
            .iter()
            .find(|document| document.relative_path == relative_path)
            .cloned()
            .ok_or_else(|| "Document is not in the current library".to_owned())?
    };
    if document.format != DocumentFormat::Pdf {
        return Err("Reading mode is only available for PDF documents".to_owned());
    }
    if document.size > MAX_CONVERTIBLE_BYTES {
        return Err("超过 128 MiB 的 PDF 仅支持原版式阅读".to_owned());
    }

    if !matches!(
        document.index_status,
        IndexStatus::Ready | IndexStatus::Partial
    ) {
        let path = resolve_existing_in_root(&root, &relative_path)?;
        let index_gate = state.index_gate.clone();
        let indexed = run_blocking(move || {
            let _guard = index_gate
                .lock()
                .map_err(|_| "Document index gate was poisoned".to_owned())?;
            index_document_path(&path, &document)
        })
        .await?;
        {
            let mut current = lock_state(&state)?;
            if current.root.as_ref() != Some(&root) {
                // The library switched while indexing: the new library's
                // documents/status must not be touched by the stale result.
                return Err(
                    "The library changed while the PDF was being indexed; reopen it".to_owned(),
                );
            }
            let stored_document = current
                .documents
                .iter()
                .find(|candidate| candidate.relative_path == relative_path)
                .cloned()
                .ok_or_else(|| "Document is not in the current library".to_owned())?;
            store_index_result(&mut current.cache, &root, &stored_document, &indexed)?;
            update_document_status(&mut current, &relative_path, &indexed);
        }
        emit_document_status(&app, &normalize_root(&root), &relative_path, &indexed);
    }

    let current = lock_state(&state)?;
    load_pdf_reading_mode(&current.cache, &root, &relative_path)
}

#[tauri::command]
pub async fn read_epub_asset(
    relative_path: String,
    asset_id: usize,
    state: State<'_, AppState>,
) -> CommandResult<Response> {
    // Capture root + session atomically so a same-named EPUB in another
    // library can never satisfy this request (D02). The session re-check
    // below rejects assets resolved before the user switched libraries.
    let (root, open_session) = current_root_and_session(&state)?;
    let path = resolve_existing_in_root(&root, &relative_path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Cannot inspect EPUB document: {error}"))?;
    let mut current = lock_state(&state)?;
    if current.open_session != open_session {
        // Same guard as ensure_same_open_session, inlined: a second lock
        // acquisition here would deadlock on the non-reentrant mutex.
        return Err("The library changed while the document was being read; reopen it".to_owned());
    }
    // D07: the asset session is looked up per (library, document). A stale
    // session (file changed on disk) is dropped so a later reopen re-reads
    // the fresh bytes instead of failing forever.
    let session_key = (current.root_key.clone(), relative_path.clone());
    let stale = current
        .open_epub_assets
        .get(&session_key)
        .is_some_and(|open| {
            open.size != metadata.len() || open.modified != modified_millis(&metadata)
        });
    if stale {
        current.open_epub_assets.remove(&session_key);
    }
    let payload: (String, Vec<u8>) = {
        let open = current
            .open_epub_assets
            .get(&session_key)
            .ok_or_else(|| "EPUB assets are no longer active; reopen the document".to_owned())?;
        let (media_type, bytes) = open
            .assets
            .get(asset_id)
            .ok_or_else(|| "EPUB asset does not exist".to_owned())?;
        if !allowed_epub_asset(media_type) {
            return Err(format!("EPUB asset type is blocked: {media_type}"));
        }
        (media_type.clone(), bytes.clone())
    };
    // Touch for LRU bookkeeping (after the immutable borrow ends).
    current.epub_asset_stamp += 1;
    let stamp = current.epub_asset_stamp;
    if let Some(session) = current.open_epub_assets.get_mut(&session_key) {
        session.last_used = stamp;
    }
    Ok(Response::new(payload.1))
}

#[tauri::command]
pub fn search_documents(
    query: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<SearchResult>> {
    let current = lock_state(&state)?;
    let root = current
        .root
        .as_ref()
        .ok_or_else(|| "No library is open".to_owned())?;
    search_index(
        &current.cache,
        &normalize_root(root),
        &query,
        limit.unwrap_or(DEFAULT_SEARCH_LIMIT),
    )
}

/// Per-document indexed-text extent, aggregated from the cached search
/// segments (plan-reading-time-estimate §3.2). The shape is shared with the
/// coverage-treemap plan: `char_count` sizes tiles / feeds time estimates,
/// `segment_count` is the page count for PDFs (high-water coverage
/// denominator) and `needs_ocr_segments` lets both features skip scanned
/// documents whose extracted text is unreliable.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentExtent {
    pub relative_path: String,
    pub char_count: u64,
    pub segment_count: u64,
    pub needs_ocr_segments: u64,
}

/// One GROUP BY over `search_segments`: read-only, no file access, never
/// returns content. Documents whose background indexing has not produced
/// segments yet are simply absent.
#[tauri::command]
pub fn list_document_extents(state: State<'_, AppState>) -> CommandResult<Vec<DocumentExtent>> {
    let current = lock_state(&state)?;
    let root = current
        .root
        .as_ref()
        .ok_or_else(|| "No library is open".to_owned())?;
    document_extents(&current.cache, &normalize_root(root))
}

fn document_extents(connection: &Connection, root_key: &str) -> CommandResult<Vec<DocumentExtent>> {
    let mut statement = connection
        .prepare(
            "SELECT relative_path,
                    COALESCE(SUM(LENGTH(content)), 0),
                    COUNT(*),
                    COALESCE(SUM(needs_ocr != 0), 0)
             FROM search_segments
             WHERE library_root = ?1
             GROUP BY relative_path
             ORDER BY relative_path",
        )
        .map_err(|error| format!("Cannot prepare document extents query: {error}"))?;
    let rows = statement
        .query_map(params![root_key], |row| {
            Ok(DocumentExtent {
                relative_path: row.get(0)?,
                char_count: row.get::<_, i64>(1)?.max(0) as u64,
                segment_count: row.get::<_, i64>(2)?.max(0) as u64,
                needs_ocr_segments: row.get::<_, i64>(3)?.max(0) as u64,
            })
        })
        .map_err(|error| format!("Cannot query document extents: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot read document extents: {error}"))
}

/// Cached bookshelf cover thumbnail (docs/plan-bookshelf-covers.md §3.2).
/// `png` is base64, mirroring the `read_asset` wire precedent.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentThumbnail {
    pub png: String,
    pub width: u32,
    pub height: u32,
}

/// Returns the cached cover thumbnail for a scanned document, or `None`
/// when absent or stale. A stale fingerprint (source size/modified moved
/// on) deletes the row so the shelf regenerates it. Never touches files.
#[tauri::command]
pub fn read_document_thumbnail(
    relative_path: String,
    state: State<'_, AppState>,
) -> CommandResult<Option<DocumentThumbnail>> {
    validate_relative_library_path(&relative_path)?;
    let current = lock_state(&state)?;
    let root = current
        .root
        .as_ref()
        .ok_or_else(|| "No library is open".to_owned())?;
    let document = current
        .documents
        .iter()
        .find(|document| document.relative_path == relative_path)
        .ok_or_else(|| "Document is not in the current library".to_owned())?;
    read_thumbnail_record(
        &current.cache,
        &normalize_root(root),
        &relative_path,
        document.size,
        document.modified,
    )
}

/// Stores a frontend-rendered cover thumbnail. The payload is untrusted:
/// base64 must decode to a PNG (magic bytes) within 512 KiB and 640 px per
/// side, and the path must belong to the current scan set. The bytes are
/// never parsed by any backend pipeline — only handed back verbatim.
#[tauri::command]
pub fn store_document_thumbnail(
    relative_path: String,
    png: String,
    width: u32,
    height: u32,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    validate_relative_library_path(&relative_path)?;
    let current = lock_state(&state)?;
    let root = current
        .root
        .as_ref()
        .ok_or_else(|| "No library is open".to_owned())?;
    let document = current
        .documents
        .iter()
        .find(|document| document.relative_path == relative_path)
        .ok_or_else(|| "Document is not in the current library".to_owned())?;
    store_thumbnail_record(
        &current.cache,
        &normalize_root(root),
        &relative_path,
        document.size,
        document.modified,
        &png,
        width,
        height,
    )
}

fn read_thumbnail_record(
    connection: &Connection,
    root_key: &str,
    relative_path: &str,
    source_size: u64,
    source_modified: u64,
) -> CommandResult<Option<DocumentThumbnail>> {
    let row = connection
        .query_row(
            "SELECT source_size, source_modified, width, height, png
             FROM document_thumbnails
             WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read document thumbnail: {error}"))?;
    let Some((size, modified, width, height, png)) = row else {
        return Ok(None);
    };
    if size != source_size as i64 || modified != source_modified as i64 {
        connection
            .execute(
                "DELETE FROM document_thumbnails
                 WHERE library_root = ?1 AND relative_path = ?2",
                params![root_key, relative_path],
            )
            .map_err(|error| format!("Cannot drop stale document thumbnail: {error}"))?;
        return Ok(None);
    }
    connection
        .execute(
            "UPDATE document_thumbnails SET last_accessed = ?3
             WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path, now_millis()],
        )
        .map_err(|error| format!("Cannot touch document thumbnail: {error}"))?;
    Ok(Some(DocumentThumbnail {
        png: BASE64.encode(png),
        width: width.max(0) as u32,
        height: height.max(0) as u32,
    }))
}

#[allow(clippy::too_many_arguments)]
fn store_thumbnail_record(
    connection: &Connection,
    root_key: &str,
    relative_path: &str,
    source_size: u64,
    source_modified: u64,
    png_base64: &str,
    width: u32,
    height: u32,
) -> CommandResult<()> {
    if width == 0
        || height == 0
        || width > THUMBNAIL_MAX_DIMENSION
        || height > THUMBNAIL_MAX_DIMENSION
    {
        return Err(format!(
            "Thumbnail dimensions must be 1–{THUMBNAIL_MAX_DIMENSION} pixels"
        ));
    }
    // Reject oversized payloads before decoding (base64 inflates by 4/3).
    if png_base64.len() > THUMBNAIL_MAX_PNG_BYTES / 3 * 4 + 4 {
        return Err("Thumbnail exceeds the 512 KiB limit".to_owned());
    }
    let bytes = BASE64
        .decode(png_base64)
        .map_err(|error| format!("Thumbnail is not valid base64: {error}"))?;
    if bytes.len() > THUMBNAIL_MAX_PNG_BYTES {
        return Err("Thumbnail exceeds the 512 KiB limit".to_owned());
    }
    if bytes.len() < PNG_MAGIC.len() || bytes[..PNG_MAGIC.len()] != PNG_MAGIC {
        return Err("Thumbnail must be a PNG image".to_owned());
    }
    connection
        .execute(
            "INSERT INTO document_thumbnails(
                 library_root, relative_path, source_size, source_modified,
                 width, height, png, created_at, last_accessed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT(library_root, relative_path) DO UPDATE SET
                 source_size = excluded.source_size,
                 source_modified = excluded.source_modified,
                 width = excluded.width,
                 height = excluded.height,
                 png = excluded.png,
                 created_at = excluded.created_at,
                 last_accessed = excluded.last_accessed",
            params![
                root_key,
                relative_path,
                source_size,
                source_modified,
                width,
                height,
                bytes,
                now_millis(),
            ],
        )
        .map_err(|error| format!("Cannot store document thumbnail: {error}"))?;
    Ok(())
}

/// Captures the "last read version" snapshot for incremental re-reading
/// (docs/plan-incremental-reread.md §3.2/§8). The content is copied from
/// `search_segments` inside one transaction together with the fingerprint
/// of the matching `document_cache` row, so a concurrent background
/// re-index can never produce a snapshot whose text and fingerprint
/// disagree. Returns false when nothing indexed exists to snapshot or the
/// text exceeds the 10 MiB per-document cap.
#[tauri::command]
pub fn capture_read_snapshot(
    relative_path: String,
    state: State<'_, AppState>,
) -> CommandResult<bool> {
    validate_relative_library_path(&relative_path)?;
    let mut current = lock_state(&state)?;
    let root_key = {
        let root = current
            .root
            .as_ref()
            .ok_or_else(|| "No library is open".to_owned())?;
        normalize_root(root)
    };
    if !current
        .documents
        .iter()
        .any(|document| document.relative_path == relative_path)
    {
        return Err("Document is not in the current library".to_owned());
    }
    capture_snapshot_record(&mut current.cache, &root_key, &relative_path)
}

/// Compares the stored read snapshot with the currently indexed text and
/// returns the changed units (paragraphs / chapters / pages), or None when
/// there is no snapshot, nothing changed, or the index has not caught up
/// with the on-disk file yet (IR-D8; the frontend re-queries after the
/// index-status event).
#[tauri::command]
pub fn read_snapshot_diff(
    relative_path: String,
    state: State<'_, AppState>,
) -> CommandResult<Option<ReadSnapshotDiff>> {
    validate_relative_library_path(&relative_path)?;
    let current = lock_state(&state)?;
    let root = current
        .root
        .as_ref()
        .ok_or_else(|| "No library is open".to_owned())?;
    let document = current
        .documents
        .iter()
        .find(|document| document.relative_path == relative_path)
        .ok_or_else(|| "Document is not in the current library".to_owned())?;
    snapshot_diff_record(
        &current.cache,
        &normalize_root(root),
        &relative_path,
        document.format,
        document.size,
        document.modified,
    )
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedSegment {
    /// Unit ordinal in the NEW document: paragraph index for markdown,
    /// chapter ordinal for EPUB, zero-based page for PDF.
    pub index: u32,
    pub kind: &'static str,
    /// 1-based source line range of the paragraph (markdown only).
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadSnapshotDiff {
    /// "paragraph" (markdown/mdx), "chapter" (EPUB) or "page" (PDF).
    pub granularity: &'static str,
    pub changed_segments: Vec<ChangedSegment>,
    pub removed_count: u32,
    pub captured_at: u64,
    /// True when the diff degraded to a whole-document hint (unit count
    /// beyond DIFF_MAX_UNITS); changed_segments is empty in that case.
    pub truncated: bool,
}

fn capture_snapshot_record(
    connection: &mut Connection,
    root_key: &str,
    relative_path: &str,
) -> CommandResult<bool> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start snapshot capture: {error}"))?;
    let fingerprint = transaction
        .query_row(
            "SELECT source_size, source_modified FROM document_cache
             WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Cannot read snapshot fingerprint: {error}"))?;
    let Some((source_size, source_modified)) = fingerprint else {
        return Ok(false);
    };
    let segments = read_segment_contents(&transaction, root_key, relative_path)?;
    if segments.is_empty() {
        return Ok(false);
    }
    let content = segments.join(SNAPSHOT_UNIT_SEPARATOR);
    if content.len() as u64 > MAX_MARKDOWN_BYTES {
        return Ok(false);
    }
    let now = now_millis();
    transaction
        .execute(
            "INSERT INTO document_read_snapshots(
                 library_root, relative_path, content, source_size, source_modified,
                 captured_at, last_accessed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(library_root, relative_path) DO UPDATE SET
                 content = excluded.content,
                 source_size = excluded.source_size,
                 source_modified = excluded.source_modified,
                 captured_at = excluded.captured_at,
                 last_accessed = excluded.last_accessed",
            params![
                root_key,
                relative_path,
                content,
                source_size,
                source_modified,
                now,
            ],
        )
        .map_err(|error| format!("Cannot store read snapshot: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit read snapshot: {error}"))?;
    enforce_snapshot_budget(connection)?;
    Ok(true)
}

fn snapshot_diff_record(
    connection: &Connection,
    root_key: &str,
    relative_path: &str,
    format: DocumentFormat,
    disk_size: u64,
    disk_modified: u64,
) -> CommandResult<Option<ReadSnapshotDiff>> {
    let row = connection
        .query_row(
            "SELECT content, source_size, source_modified, captured_at
             FROM document_read_snapshots
             WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read document snapshot: {error}"))?;
    let Some((snapshot_content, snapshot_size, snapshot_modified, captured_at)) = row else {
        return Ok(None);
    };
    connection
        .execute(
            "UPDATE document_read_snapshots SET last_accessed = ?3
             WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path, now_millis()],
        )
        .map_err(|error| format!("Cannot touch document snapshot: {error}"))?;
    if snapshot_size == disk_size as i64 && snapshot_modified == disk_modified as i64 {
        return Ok(None);
    }
    // IR-D8: only diff against segments that describe the on-disk file; a
    // pending background re-index would otherwise produce stale marks.
    let cached = connection
        .query_row(
            "SELECT source_size, source_modified FROM document_cache
             WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Cannot read cached fingerprint: {error}"))?;
    let Some((cached_size, cached_modified)) = cached else {
        return Ok(None);
    };
    if cached_size != disk_size as i64 || cached_modified != disk_modified as i64 {
        return Ok(None);
    }
    let segments = read_segment_contents(connection, root_key, relative_path)?;
    if segments.is_empty() {
        return Ok(None);
    }
    let current_content = segments.join(SNAPSHOT_UNIT_SEPARATOR);
    let diff = diff_snapshot_texts(&snapshot_content, &current_content, format);
    if diff.changed.is_empty() && diff.removed_count == 0 && !diff.truncated {
        // Fingerprints moved but the normalized text did not (e.g. a pure
        // CRLF→LF rewrite): stay silent instead of nagging.
        return Ok(None);
    }
    let granularity = match format {
        DocumentFormat::Markdown | DocumentFormat::Mdx => "paragraph",
        DocumentFormat::Epub => "chapter",
        DocumentFormat::Pdf => "page",
    };
    Ok(Some(ReadSnapshotDiff {
        granularity,
        changed_segments: diff.changed,
        removed_count: diff.removed_count,
        captured_at: captured_at.max(0) as u64,
        truncated: diff.truncated,
    }))
}

fn read_segment_contents(
    connection: &Connection,
    root_key: &str,
    relative_path: &str,
) -> CommandResult<Vec<String>> {
    let mut statement = connection
        .prepare(
            "SELECT content FROM search_segments
             WHERE library_root = ?1 AND relative_path = ?2
             ORDER BY ordinal ASC",
        )
        .map_err(|error| format!("Cannot prepare snapshot source query: {error}"))?;
    let rows = statement
        .query_map(params![root_key, relative_path], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("Cannot read snapshot source segments: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Cannot decode snapshot source segments: {error}"))
}

struct SnapshotTextDiff {
    changed: Vec<ChangedSegment>,
    removed_count: u32,
    truncated: bool,
}

/// Pure diff between the snapshot text and the current text
/// (docs/plan-incremental-reread.md IR-D3). Markdown diffs blank-line
/// paragraphs of the single segment and carries 1-based source line
/// ranges; EPUB/PDF diff whole units (chapters/pages) split on the
/// snapshot separator, which both sides pass through identically.
fn diff_snapshot_texts(old: &str, new: &str, format: DocumentFormat) -> SnapshotTextDiff {
    match format {
        DocumentFormat::Markdown | DocumentFormat::Mdx => {
            let old_units = split_markdown_paragraphs(old);
            let new_units = split_markdown_paragraphs(new);
            let old_hashes: Vec<u64> = old_units.iter().map(|unit| unit.hash).collect();
            let new_hashes: Vec<u64> = new_units.iter().map(|unit| unit.hash).collect();
            let outcome = diff_unit_hashes(&old_hashes, &new_hashes);
            SnapshotTextDiff {
                changed: outcome
                    .changed
                    .iter()
                    .map(|(index, kind)| ChangedSegment {
                        index: *index as u32,
                        kind: kind.as_str(),
                        start_line: Some(new_units[*index].start_line),
                        end_line: Some(new_units[*index].end_line),
                    })
                    .collect(),
                removed_count: outcome.removed_count,
                truncated: outcome.truncated,
            }
        }
        DocumentFormat::Epub | DocumentFormat::Pdf => {
            let old_hashes: Vec<u64> = old
                .split(SNAPSHOT_UNIT_SEPARATOR)
                .map(normalized_unit_hash)
                .collect();
            let new_hashes: Vec<u64> = new
                .split(SNAPSHOT_UNIT_SEPARATOR)
                .map(normalized_unit_hash)
                .collect();
            let outcome = diff_unit_hashes(&old_hashes, &new_hashes);
            SnapshotTextDiff {
                changed: outcome
                    .changed
                    .iter()
                    .map(|(index, kind)| ChangedSegment {
                        index: *index as u32,
                        kind: kind.as_str(),
                        start_line: None,
                        end_line: None,
                    })
                    .collect(),
                removed_count: outcome.removed_count,
                truncated: outcome.truncated,
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnitChangeKind {
    Added,
    Modified,
}

impl UnitChangeKind {
    fn as_str(self) -> &'static str {
        match self {
            UnitChangeKind::Added => "added",
            UnitChangeKind::Modified => "modified",
        }
    }
}

struct UnitDiffOutcome {
    /// (index into the new unit list, kind), ascending by index.
    changed: Vec<(usize, UnitChangeKind)>,
    removed_count: u32,
    truncated: bool,
}

struct MarkdownParagraph {
    start_line: u32,
    end_line: u32,
    hash: u64,
}

/// Splits markdown source into blank-line paragraphs with 1-based line
/// ranges. Normalization discipline: leading BOM stripped, CR/CRLF folded,
/// per-line trailing whitespace ignored for hashing.
fn split_markdown_paragraphs(text: &str) -> Vec<MarkdownParagraph> {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut paragraphs = Vec::new();
    let mut current_lines: Vec<&str> = Vec::new();
    let mut current_start = 0u32;
    let mut current_end = 0u32;
    let mut flush = |lines: &mut Vec<&str>, start: u32, end: u32| {
        if lines.is_empty() {
            return;
        }
        paragraphs.push(MarkdownParagraph {
            start_line: start,
            end_line: end,
            hash: hash_lines(lines),
        });
        lines.clear();
    };
    for (index, raw_line) in text.split('\n').enumerate() {
        let line_number = (index + 1) as u32;
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line).trim_end();
        if line.trim().is_empty() {
            flush(&mut current_lines, current_start, current_end);
        } else {
            if current_lines.is_empty() {
                current_start = line_number;
            }
            current_end = line_number;
            current_lines.push(line);
        }
    }
    flush(&mut current_lines, current_start, current_end);
    paragraphs
}

fn hash_lines(lines: &[&str]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for line in lines {
        line.hash(&mut hasher);
    }
    hasher.finish()
}

/// Whole-unit hash for chapter/page texts: line endings folded and
/// per-line trailing whitespace plus surrounding blank lines ignored.
fn normalized_unit_hash(text: &str) -> u64 {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).trim_end())
        .collect();
    let start = lines
        .iter()
        .position(|line| !line.is_empty())
        .unwrap_or(lines.len());
    let end = lines
        .iter()
        .rposition(|line| !line.is_empty())
        .map_or(start, |position| position + 1);
    hash_lines(&lines[start..end])
}

/// Hash-sequence diff (IR-D3): common prefix/suffix trim, then an exact
/// LCS over the middle while the DP table stays within DIFF_MAX_LCS_CELLS,
/// falling back to a multiset approximation beyond that (pure moves stop
/// being flagged). Fresh new units are paired in order with removed old
/// units as "modified"; the leftovers become "added" or removed_count.
fn diff_unit_hashes(old: &[u64], new: &[u64]) -> UnitDiffOutcome {
    if old.len() > DIFF_MAX_UNITS || new.len() > DIFF_MAX_UNITS {
        return UnitDiffOutcome {
            changed: Vec::new(),
            removed_count: 0,
            truncated: true,
        };
    }
    let mut prefix = 0;
    while prefix < old.len() && prefix < new.len() && old[prefix] == new[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < old.len() - prefix
        && suffix < new.len() - prefix
        && old[old.len() - 1 - suffix] == new[new.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let old_mid = &old[prefix..old.len() - suffix];
    let new_mid = &new[prefix..new.len() - suffix];
    let (fresh_mid_indices, removed_old) =
        if old_mid.len().saturating_mul(new_mid.len()) <= DIFF_MAX_LCS_CELLS {
            lcs_unmatched(old_mid, new_mid)
        } else {
            multiset_unmatched(old_mid, new_mid)
        };
    let modified_pairs = fresh_mid_indices.len().min(removed_old);
    let changed = fresh_mid_indices
        .iter()
        .enumerate()
        .map(|(order, mid_index)| {
            let kind = if order < modified_pairs {
                UnitChangeKind::Modified
            } else {
                UnitChangeKind::Added
            };
            (prefix + mid_index, kind)
        })
        .collect();
    UnitDiffOutcome {
        changed,
        removed_count: (removed_old - modified_pairs) as u32,
        truncated: false,
    }
}

/// Exact LCS walk: returns the new-side indices (relative to the slices)
/// that are not on the common subsequence, plus the count of unmatched old
/// units. Ties prefer consuming old units first so in-order edit pairing
/// stays aligned.
fn lcs_unmatched(old: &[u64], new: &[u64]) -> (Vec<usize>, usize) {
    let rows = old.len();
    let columns = new.len();
    let stride = columns + 1;
    let mut table = vec![0u16; (rows + 1) * stride];
    for i in (0..rows).rev() {
        for j in (0..columns).rev() {
            table[i * stride + j] = if old[i] == new[j] {
                table[(i + 1) * stride + j + 1] + 1
            } else {
                table[(i + 1) * stride + j].max(table[i * stride + j + 1])
            };
        }
    }
    let mut fresh = Vec::new();
    let mut removed = 0usize;
    let mut i = 0;
    let mut j = 0;
    while i < rows && j < columns {
        if old[i] == new[j] {
            i += 1;
            j += 1;
        } else if table[(i + 1) * stride + j] >= table[i * stride + j + 1] {
            removed += 1;
            i += 1;
        } else {
            fresh.push(j);
            j += 1;
        }
    }
    removed += rows - i;
    fresh.extend(j..columns);
    (fresh, removed)
}

/// Approximate fallback for very large middles: a hash multiset match.
/// Cheaper than LCS and never mislabels unchanged text, but a pure move
/// counts as unchanged here instead of one modified unit.
fn multiset_unmatched(old: &[u64], new: &[u64]) -> (Vec<usize>, usize) {
    let mut counts: HashMap<u64, usize> = HashMap::new();
    for hash in old {
        *counts.entry(*hash).or_default() += 1;
    }
    let mut fresh = Vec::new();
    for (index, hash) in new.iter().enumerate() {
        match counts.get_mut(hash) {
            Some(count) if *count > 0 => *count -= 1,
            _ => fresh.push(index),
        }
    }
    let removed = counts.values().sum();
    (fresh, removed)
}

fn snapshot_table_bytes(connection: &Connection) -> CommandResult<u64> {
    let bytes: i64 = connection
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0)
             FROM document_read_snapshots",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot measure snapshot storage: {error}"))?;
    Ok(bytes.max(0) as u64)
}

fn enforce_snapshot_budget(connection: &Connection) -> CommandResult<()> {
    enforce_snapshot_budget_with_limits(
        connection,
        SNAPSHOT_SOFT_LIMIT_BYTES,
        SNAPSHOT_LOW_WATER_BYTES,
    )
}

/// IR-D5: independent LRU over the snapshot table only. May evict rows of
/// the active library — snapshots are a convenience layer, unlike the
/// conversion cache the reader depends on right now.
fn enforce_snapshot_budget_with_limits(
    connection: &Connection,
    soft_limit: u64,
    low_water: u64,
) -> CommandResult<()> {
    let mut total = snapshot_table_bytes(connection)?;
    if total <= soft_limit {
        return Ok(());
    }
    let candidates = {
        let mut statement = connection
            .prepare(
                "SELECT library_root, relative_path, LENGTH(CAST(content AS BLOB))
                 FROM document_read_snapshots
                 ORDER BY last_accessed ASC",
            )
            .map_err(|error| format!("Cannot prepare snapshot eviction: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|error| format!("Cannot list snapshot eviction candidates: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode snapshot eviction candidates: {error}"))?
    };
    let mut evicted = false;
    for (root, relative_path, bytes) in candidates {
        connection
            .execute(
                "DELETE FROM document_read_snapshots
                 WHERE library_root = ?1 AND relative_path = ?2",
                params![root, relative_path],
            )
            .map_err(|error| format!("Cannot evict read snapshot: {error}"))?;
        evicted = true;
        total = total.saturating_sub(bytes.max(0) as u64);
        if total <= low_water {
            break;
        }
    }
    if evicted {
        reclaim_cache_space(connection)?;
    }
    Ok(())
}

/// Read-only backlink/outgoing view for one document
/// (`docs/plan-backlinks.md` §3.3). Pure SELECTs over the derived
/// `document_links` table plus the in-memory scan snapshot; the link table
/// never triggers file access.
#[tauri::command]
pub fn list_document_links(
    relative_path: String,
    state: State<'_, AppState>,
) -> CommandResult<DocumentLinks> {
    let current = lock_state(&state)?;
    let root = current
        .root
        .as_ref()
        .ok_or_else(|| "No library is open".to_owned())?;
    let root_key = normalize_root(root);
    document_links_for(
        &current.cache,
        &root_key,
        &current.documents,
        &relative_path,
    )
}

/// Hover preview payload (docs/plan-hover-preview.md HP-D9): title plus a
/// bounded plain-text excerpt; `pdf_pages` fills for PDF targets and
/// `index_status` lets the card explain an empty excerpt.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPreview {
    pub title: String,
    pub format: DocumentFormat,
    pub excerpt: String,
    pub pdf_pages: Option<u32>,
    pub index_status: IndexStatus,
}

/// Read-only preview for the hover card (docs/plan-hover-preview.md
/// §3.1): pure SELECTs over the cached `search_segments`, never file
/// access. The target must be part of the current scan set; the path is
/// validated like every other command input.
#[tauri::command]
pub fn read_document_preview(
    relative_path: String,
    fragment: Option<String>,
    state: State<'_, AppState>,
) -> CommandResult<DocumentPreview> {
    let current = lock_state(&state)?;
    let root = current
        .root
        .as_ref()
        .ok_or_else(|| "No library is open".to_owned())?;
    let root_key = normalize_root(root);
    document_preview_for(
        &current.cache,
        &root_key,
        &current.documents,
        &relative_path,
        fragment.as_deref(),
    )
}

/// Selection-driven related-passage search over the existing FTS5 trigram
/// index (`docs/plan-related-passages.md` §3). Returns plain
/// `SearchResult`s so the jump chain is shared with library search.
#[tauri::command]
pub fn find_related_passages(
    text: String,
    exclude_path: Option<String>,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<SearchResult>> {
    let current = lock_state(&state)?;
    let root = current
        .root
        .as_ref()
        .ok_or_else(|| "No library is open".to_owned())?;
    related_passages_index(
        &current.cache,
        &normalize_root(root),
        &text,
        exclude_path.as_deref(),
        limit.unwrap_or(RELATED_DEFAULT_LIMIT),
    )
}

#[tauri::command]
pub async fn retry_document_index(
    relative_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let root = current_root(&state)?;
    let document = {
        let mut current = lock_state(&state)?;
        clear_cached_document(&mut current.cache, &root, &relative_path)?;
        let document = current
            .documents
            .iter_mut()
            .find(|document| document.relative_path == relative_path)
            .ok_or_else(|| "Document is not in the current library".to_owned())?;
        document.index_status = IndexStatus::Pending;
        document.index_error = None;
        document.clone()
    };
    let generation = lock_state(&state)?.generation;
    let root_key = lock_state(&state)?.root_key.clone();
    spawn_background_index(app, root_key, generation, vec![document]);
    Ok(())
}

#[tauri::command]
pub fn clear_conversion_cache(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let generation;
    let root_key;
    let documents;
    {
        let mut current = lock_state(&state)?;
        clear_cache_storage(&mut current.cache)?;
        for document in &mut current.documents {
            document.index_status = IndexStatus::Pending;
            document.index_error = None;
        }
        current.open_epub_assets.clear();
        generation = current.generation;
        root_key = current.root_key.clone();
        documents = current.documents.clone();
    }
    spawn_background_index(app, root_key, generation, documents);
    Ok(())
}

#[tauri::command]
pub async fn read_asset(
    relative_path: String,
    state: State<'_, AppState>,
) -> CommandResult<AssetData> {
    let root = current_root(&state)?;
    run_blocking(move || read_asset_from_root(&root, &relative_path)).await
}

async fn run_blocking<T, F>(task: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CommandResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Background task failed: {error}"))?
}

/// Records content fingerprints for the scanned documents in the durable
/// user database (the move-detection input, `user_store.rs`). Runs before
/// the scan result is returned so a follow-up `detect_moved_documents` sees
/// fresh data. Failures are logged instead of failing the scan: a stale
/// fingerprint only weakens move detection, while opening the library must
/// keep working.
async fn record_scan_fingerprints(
    user: &State<'_, UserState>,
    root: &Path,
    documents: &[DocumentInfo],
) {
    let user_state = user.inner().clone();
    let root = root.to_path_buf();
    let documents = documents.to_vec();
    let result =
        run_blocking(move || sync_document_fingerprints(&user_state, &root, &documents)).await;
    if let Err(error) = result {
        eprintln!("reade: cannot record document fingerprints: {error}");
    }
}

fn spawn_background_index(
    app: AppHandle,
    root_key: String,
    generation: u64,
    documents: Vec<DocumentInfo>,
) {
    tauri::async_runtime::spawn(async move {
        let worker_app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            index_documents_background(worker_app, root_key, generation, documents)
        })
        .await;
    });
}

fn index_documents_background(
    app: AppHandle,
    root_key: String,
    generation: u64,
    documents: Vec<DocumentInfo>,
) -> CommandResult<()> {
    let total = documents.len();
    let mut progress = IndexProgress {
        library_root: root_key,
        total,
        completed: 0,
        ready: 0,
        partial: 0,
        failed: 0,
    };
    let _ = app.emit("library-index-progress", &progress);
    for document in documents {
        let state = app.state::<AppState>();
        let (root, still_current) = {
            let current = lock_state(&state)?;
            (current.root.clone(), current.generation == generation)
        };
        if !still_current {
            return Ok(());
        }
        let Some(root) = root else {
            return Ok(());
        };

        if matches!(
            document.index_status,
            IndexStatus::Ready | IndexStatus::Partial | IndexStatus::Unsupported
        ) {
            record_progress(&mut progress, document.index_status);
            let _ = app.emit("library-index-progress", &progress);
            continue;
        }

        // Conversion is globally single-threaded. A worker spawned for the
        // selected document waits here and can overtake the library worker
        // between documents without allowing concurrent parser executions.
        let _index_guard = state
            .index_gate
            .lock()
            .map_err(|_| "Document index gate was poisoned".to_owned())?;
        let live_status = {
            let current = lock_state(&state)?;
            if current.generation != generation {
                return Ok(());
            }
            current
                .documents
                .iter()
                .find(|candidate| candidate.relative_path == document.relative_path)
                .map(|candidate| candidate.index_status)
        };
        if let Some(
            status @ (IndexStatus::Ready | IndexStatus::Partial | IndexStatus::Unsupported),
        ) = live_status
        {
            record_progress(&mut progress, status);
            let _ = app.emit("library-index-progress", &progress);
            continue;
        }

        set_document_indexing(
            &app,
            &state,
            &progress.library_root,
            &document.relative_path,
        )?;
        let path = match resolve_existing_in_root(&root, &document.relative_path) {
            Ok(path) => path,
            Err(error) => {
                let indexed = IndexedDocument {
                    title: document.title.clone(),
                    status: IndexStatus::Failed,
                    error: Some(error),
                    segments: Vec::new(),
                    links: Vec::new(),
                };
                if !finish_background_document(
                    &app, &state, generation, &root, &document, &indexed,
                )? {
                    return Ok(());
                }
                record_progress(&mut progress, indexed.status);
                let _ = app.emit("library-index-progress", &progress);
                continue;
            }
        };
        let indexed =
            index_document_path(&path, &document).unwrap_or_else(|error| IndexedDocument {
                title: document.title.clone(),
                status: if error.contains("不支持") || error.contains("过大") {
                    IndexStatus::Unsupported
                } else {
                    IndexStatus::Failed
                },
                error: Some(error),
                segments: Vec::new(),
                links: Vec::new(),
            });
        if !finish_background_document(&app, &state, generation, &root, &document, &indexed)? {
            return Ok(());
        }
        record_progress(&mut progress, indexed.status);
        let _ = app.emit("library-index-progress", &progress);
    }
    Ok(())
}

fn set_document_indexing(
    app: &AppHandle,
    state: &State<'_, AppState>,
    library_root: &str,
    relative_path: &str,
) -> CommandResult<()> {
    let title = {
        let mut current = lock_state(state)?;
        let Some(document) = current
            .documents
            .iter_mut()
            .find(|document| document.relative_path == relative_path)
        else {
            return Ok(());
        };
        document.index_status = IndexStatus::Indexing;
        document.index_error = None;
        document.title.clone()
    };
    let _ = app.emit(
        "document-index-status",
        DocumentIndexEvent {
            library_root: library_root.to_owned(),
            relative_path: relative_path.to_owned(),
            title,
            status: IndexStatus::Indexing,
            error: None,
        },
    );
    Ok(())
}

fn finish_background_document(
    app: &AppHandle,
    state: &State<'_, AppState>,
    generation: u64,
    root: &Path,
    document: &DocumentInfo,
    indexed: &IndexedDocument,
) -> CommandResult<bool> {
    let stored = {
        let mut current = lock_state(state)?;
        store_background_result_if_current(&mut current, generation, root, document, indexed)?
    };
    if !stored {
        return Ok(false);
    }
    emit_document_status(app, &normalize_root(root), &document.relative_path, indexed);
    Ok(true)
}

fn store_background_result_if_current(
    current: &mut LibraryState,
    generation: u64,
    root: &Path,
    document: &DocumentInfo,
    indexed: &IndexedDocument,
) -> CommandResult<bool> {
    if current.generation != generation || current.root.as_deref() != Some(root) {
        return Ok(false);
    }
    store_index_result(&mut current.cache, root, document, indexed)?;
    update_document_status(current, &document.relative_path, indexed);
    enforce_cache_soft_limit(&mut current.cache, root)?;
    Ok(true)
}

fn record_progress(progress: &mut IndexProgress, status: IndexStatus) {
    progress.completed += 1;
    match status {
        IndexStatus::Ready => progress.ready += 1,
        IndexStatus::Partial => progress.partial += 1,
        IndexStatus::Unsupported | IndexStatus::Failed => progress.failed += 1,
        IndexStatus::Pending | IndexStatus::Indexing => {}
    }
}

fn emit_document_status(
    app: &AppHandle,
    library_root: &str,
    relative_path: &str,
    indexed: &IndexedDocument,
) {
    let _ = app.emit(
        "document-index-status",
        DocumentIndexEvent {
            library_root: library_root.to_owned(),
            relative_path: relative_path.to_owned(),
            title: indexed.title.clone(),
            status: indexed.status,
            error: indexed.error.clone(),
        },
    );
}

fn update_document_status(
    state: &mut LibraryState,
    relative_path: &str,
    indexed: &IndexedDocument,
) {
    if let Some(document) = state
        .documents
        .iter_mut()
        .find(|document| document.relative_path == relative_path)
    {
        document.title.clone_from(&indexed.title);
        document.index_status = indexed.status;
        document.index_error.clone_from(&indexed.error);
    }
}

fn index_document_path(path: &Path, document: &DocumentInfo) -> CommandResult<IndexedDocument> {
    match document.format {
        DocumentFormat::Markdown | DocumentFormat::Mdx => {
            let content =
                read_utf8_lossy_with_limit(path, MAX_MARKDOWN_BYTES, "Markdown document")?;
            // Outgoing links ride the same indexing pass, so link rows
            // inherit the incremental-invalidation semantics of the
            // conversion cache for free.
            let links = extract_document_links(&document.relative_path, &content);
            Ok(IndexedDocument {
                title: extract_title(&content).unwrap_or_else(|| document.title.clone()),
                status: IndexStatus::Ready,
                error: None,
                segments: vec![IndexSegment {
                    locator_kind: None,
                    locator_value: None,
                    ordinal: 0,
                    content,
                    needs_ocr: false,
                    ocr_reason: None,
                }],
                links,
            })
        }
        DocumentFormat::Pdf => index_pdf(path, document),
        DocumentFormat::Epub => index_epub(path, document),
    }
}

fn index_pdf(path: &Path, document: &DocumentInfo) -> CommandResult<IndexedDocument> {
    if document.size > MAX_CONVERTIBLE_BYTES {
        return Ok(IndexedDocument {
            title: document.title.clone(),
            status: IndexStatus::Unsupported,
            error: Some("超过 128 MiB，仅支持 PDF 原版式阅读".to_owned()),
            segments: Vec::new(),
            links: Vec::new(),
        });
    }
    let bytes = fs::read(path).map_err(|error| format!("Cannot read PDF document: {error}"))?;
    let pages = pdf_inspector::extract_pages_markdown_mem(&bytes, None)
        .map_err(|error| format!("PDF 文本提取失败：{error}"))?;
    let missing_pages = pages.pages_needing_ocr.clone();
    let segments = pages
        .pages
        .into_iter()
        .map(|page| IndexSegment {
            locator_kind: Some("pdfPage"),
            locator_value: Some((page.page + 1).to_string()),
            ordinal: page.page,
            content: page.markdown,
            needs_ocr: page.needs_ocr,
            ocr_reason: page.ocr_reason,
        })
        .collect();
    let partial = !missing_pages.is_empty();
    Ok(IndexedDocument {
        title: document.title.clone(),
        status: if partial {
            IndexStatus::Partial
        } else {
            IndexStatus::Ready
        },
        error: partial.then(|| format!("不可提取页：{}", join_pages(&missing_pages))),
        segments,
        links: Vec::new(),
    })
}

fn index_epub(path: &Path, document: &DocumentInfo) -> CommandResult<IndexedDocument> {
    if document.size > MAX_CONVERTIBLE_BYTES {
        return Ok(IndexedDocument {
            title: document.title.clone(),
            status: IndexStatus::Unsupported,
            error: Some("EPUB 文件超过 128 MiB".to_owned()),
            segments: Vec::new(),
            links: Vec::new(),
        });
    }
    let bytes = fs::read(path).map_err(|error| format!("Cannot read EPUB document: {error}"))?;
    let parsed = parse_epub(&bytes, &document.title)?;
    Ok(IndexedDocument {
        title: parsed.payload.title,
        status: IndexStatus::Ready,
        error: None,
        segments: parsed
            .search_segments
            .into_iter()
            .enumerate()
            .map(|(ordinal, (chapter, _, content))| IndexSegment {
                locator_kind: Some("epubChapter"),
                locator_value: Some(chapter),
                ordinal: ordinal as u32,
                content,
                needs_ocr: false,
                ocr_reason: None,
            })
            .collect(),
        links: Vec::new(),
    })
}

fn join_pages(pages: &[u32]) -> String {
    pages
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join("、")
}

fn open_cache_connection(path: &Path) -> CommandResult<Connection> {
    if path.exists() {
        let existing = Connection::open(path);
        if let Ok(connection) = existing {
            let version = cache_pragma_i64(&connection, "user_version");
            let auto_vacuum = cache_pragma_i64(&connection, "auto_vacuum");
            if version == Ok(CACHE_SCHEMA_VERSION) && auto_vacuum == Ok(2) {
                return Ok(connection);
            }
            drop(connection);
        }
        remove_cache_database(path)?;
    }

    Connection::open(path).map_err(|error| format!("Cannot open document cache: {error}"))
}

fn cache_pragma_i64(connection: &Connection, pragma: &str) -> rusqlite::Result<i64> {
    connection.query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))
}

fn remove_cache_database(path: &Path) -> CommandResult<()> {
    for candidate in [
        path.to_path_buf(),
        cache_sidecar_path(path, "-wal"),
        cache_sidecar_path(path, "-shm"),
    ] {
        match fs::remove_file(&candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Cannot replace outdated document cache {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
    Ok(())
}

fn cache_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn initialize_cache(connection: &Connection) -> CommandResult<()> {
    connection
        .pragma_update(None, "auto_vacuum", 2)
        .map_err(|error| format!("Cannot configure incremental cache vacuuming: {error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("Cannot configure cache busy timeout: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS document_cache(
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 title TEXT NOT NULL,
                 format TEXT NOT NULL,
                 source_size INTEGER NOT NULL,
                 source_modified INTEGER NOT NULL,
                 converter_revision TEXT NOT NULL,
                 status TEXT NOT NULL,
                 error TEXT,
                 last_accessed INTEGER NOT NULL,
                 PRIMARY KEY(library_root, relative_path)
             );
             CREATE TABLE IF NOT EXISTS search_segments(
                 id INTEGER PRIMARY KEY,
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 title TEXT NOT NULL,
                 format TEXT NOT NULL,
                 locator_kind TEXT,
                 locator_value TEXT,
                 ordinal INTEGER NOT NULL,
                 content TEXT NOT NULL,
                 needs_ocr INTEGER NOT NULL DEFAULT 0,
                 ocr_reason TEXT
             );
             CREATE INDEX IF NOT EXISTS search_segments_document
                 ON search_segments(library_root, relative_path, ordinal);
             CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
                 title,
                 content,
                 content = 'search_segments',
                 content_rowid = 'id',
                 tokenize = 'trigram'
             );
             CREATE TRIGGER IF NOT EXISTS search_segments_insert AFTER INSERT ON search_segments BEGIN
                 INSERT INTO search_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
             END;
             CREATE TRIGGER IF NOT EXISTS search_segments_delete AFTER DELETE ON search_segments BEGIN
                 INSERT INTO search_fts(search_fts, rowid, title, content)
                 VALUES ('delete', old.id, old.title, old.content);
             END;
             CREATE TRIGGER IF NOT EXISTS search_segments_update AFTER UPDATE ON search_segments BEGIN
                 INSERT INTO search_fts(search_fts, rowid, title, content)
                 VALUES ('delete', old.id, old.title, old.content);
                 INSERT INTO search_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
             END;
             -- Outgoing document links, extracted during markdown indexing
             -- (docs/plan-backlinks.md §3.2, BL-D2). Pure derived data that
             -- rebuilds losslessly from the sources, so it lives in the
             -- cache as an IF NOT EXISTS attachment without bumping
             -- CACHE_SCHEMA_VERSION; older cache files grow the table on
             -- the next start. Bump the version if the columns ever change.
             CREATE TABLE IF NOT EXISTS document_links(
                 id INTEGER PRIMARY KEY,
                 library_root TEXT NOT NULL,
                 source_path TEXT NOT NULL,
                 link_kind TEXT NOT NULL,
                 target_path TEXT,
                 wiki_stem TEXT,
                 target_kind TEXT NOT NULL,
                 link_text TEXT NOT NULL,
                 fragment TEXT,
                 ordinal INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS document_links_by_source
                 ON document_links(library_root, source_path, ordinal);
             CREATE INDEX IF NOT EXISTS document_links_by_target
                 ON document_links(library_root, target_path);
             CREATE INDEX IF NOT EXISTS document_links_by_stem
                 ON document_links(library_root, wiki_stem);
             -- Bookshelf cover thumbnails, rendered by the frontend and
             -- stored as validated PNG bytes (docs/plan-bookshelf-covers.md
             -- §3.1). Pure derived data that regenerates on demand, so it
             -- rides the same IF NOT EXISTS attachment precedent as
             -- document_links without bumping CACHE_SCHEMA_VERSION; older
             -- cache files grow the table on the next start. Bump the
             -- version if the columns ever change.
             CREATE TABLE IF NOT EXISTS document_thumbnails(
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 source_size INTEGER NOT NULL,
                 source_modified INTEGER NOT NULL,
                 width INTEGER NOT NULL,
                 height INTEGER NOT NULL,
                 png BLOB NOT NULL,
                 created_at INTEGER NOT NULL,
                 last_accessed INTEGER NOT NULL,
                 PRIMARY KEY(library_root, relative_path)
             );
             -- Last-read text snapshots for incremental re-reading
             -- (docs/plan-incremental-reread.md §3.1/§8). Pure derived data
             -- copied from search_segments, so it rides the same
             -- IF NOT EXISTS attachment precedent as document_links and
             -- document_thumbnails without bumping CACHE_SCHEMA_VERSION;
             -- older cache files grow the table on the next start. Bump the
             -- version if the columns ever change. Multi-segment formats
             -- join segment texts with U+001E; the fingerprint columns are
             -- read from document_cache in the same capture transaction.
             CREATE TABLE IF NOT EXISTS document_read_snapshots(
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 content TEXT NOT NULL,
                 source_size INTEGER NOT NULL,
                 source_modified INTEGER NOT NULL,
                 captured_at INTEGER NOT NULL,
                 last_accessed INTEGER NOT NULL,
                 PRIMARY KEY(library_root, relative_path)
             );
             -- Legacy annotation storage, frozen since annotations moved to
             -- reade-user.sqlite3 (user_store.rs). Kept for one release cycle
             -- as the rescue-migration source and fallback; nothing reads or
             -- writes it anymore.
             CREATE TABLE IF NOT EXISTS annotations (
                 id TEXT PRIMARY KEY,
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 color TEXT,
                 note TEXT,
                 selected_text TEXT,
                 title TEXT,
                 locator_json TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS annotations_by_doc
                 ON annotations(library_root, relative_path, updated_at DESC);",
        )
        .map_err(|error| format!("Cannot initialize document cache: {error}"))?;
    connection
        .pragma_update(None, "user_version", CACHE_SCHEMA_VERSION)
        .map_err(|error| format!("Cannot version document cache: {error}"))?;
    let auto_vacuum = cache_pragma_i64(connection, "auto_vacuum")
        .map_err(|error| format!("Cannot verify cache vacuum mode: {error}"))?;
    if auto_vacuum != 2 {
        return Err("Cannot enable incremental cache vacuuming".to_owned());
    }
    Ok(())
}

fn scan_documents(root: &Path, connection: &mut Connection) -> CommandResult<Vec<DocumentInfo>> {
    let root_key = normalize_root(root);
    let mut documents = Vec::new();
    let mut seen = HashSet::new();
    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| !is_excluded_directory(entry));

    for result in builder.build() {
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let Some(format) = DocumentFormat::from_path(entry.path()) else {
            continue;
        };
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        if matches!(format, DocumentFormat::Markdown | DocumentFormat::Mdx)
            && metadata.len() > MAX_MARKDOWN_BYTES
        {
            continue;
        }
        let relative_path = normalize_relative_path(
            entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "Scanned document resolved outside the library".to_owned())?,
        );
        let modified = modified_millis(&metadata);
        let cached = cached_document(
            connection,
            &root_key,
            &relative_path,
            metadata.len(),
            modified,
        )?;
        if cached.is_none() {
            clear_cached_document(connection, root, &relative_path)?;
        }
        let (cached_title, status, error) =
            cached.unwrap_or((String::new(), IndexStatus::Pending, None));
        let title = if !cached_title.is_empty() {
            cached_title
        } else {
            fallback_title(entry.path())
        };
        seen.insert(relative_path.clone());
        documents.push(DocumentInfo {
            relative_path,
            title,
            size: metadata.len(),
            modified,
            format,
            index_status: status,
            index_error: error,
        });
    }

    let cached_paths = {
        let mut statement = connection
            .prepare("SELECT relative_path FROM document_cache WHERE library_root = ?1")
            .map_err(|error| format!("Cannot inspect cached documents: {error}"))?;
        let rows = statement
            .query_map(params![root_key], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Cannot list cached documents: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode cached paths: {error}"))?
    };
    for path in cached_paths {
        if !seen.contains(&path) {
            clear_cached_document(connection, root, &path)?;
        }
    }
    // Thumbnails can exist for documents that never produced a
    // document_cache row (e.g. pending indexing), so sweep them separately.
    let thumbnail_paths = {
        let mut statement = connection
            .prepare("SELECT relative_path FROM document_thumbnails WHERE library_root = ?1")
            .map_err(|error| format!("Cannot inspect cached thumbnails: {error}"))?;
        let rows = statement
            .query_map(params![root_key], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Cannot list cached thumbnails: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode cached thumbnail paths: {error}"))?
    };
    for path in thumbnail_paths {
        if !seen.contains(&path) {
            connection
                .execute(
                    "DELETE FROM document_thumbnails
                     WHERE library_root = ?1 AND relative_path = ?2",
                    params![root_key, path],
                )
                .map_err(|error| format!("Cannot sweep stale document thumbnail: {error}"))?;
        }
    }
    // Same orphan sweep for read snapshots: their rows normally die with
    // clear_cached_document, but a snapshot without a document_cache row
    // (e.g. after a partial cleanup) must not outlive the source file.
    let snapshot_paths = {
        let mut statement = connection
            .prepare("SELECT relative_path FROM document_read_snapshots WHERE library_root = ?1")
            .map_err(|error| format!("Cannot inspect cached read snapshots: {error}"))?;
        let rows = statement
            .query_map(params![root_key], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Cannot list cached read snapshots: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode cached snapshot paths: {error}"))?
    };
    for path in snapshot_paths {
        if !seen.contains(&path) {
            connection
                .execute(
                    "DELETE FROM document_read_snapshots
                     WHERE library_root = ?1 AND relative_path = ?2",
                    params![root_key, path],
                )
                .map_err(|error| format!("Cannot sweep stale read snapshot: {error}"))?;
        }
    }
    documents.sort_by_cached_key(|document| document.relative_path.to_lowercase());
    Ok(documents)
}

fn cached_document(
    connection: &Connection,
    root: &str,
    relative_path: &str,
    size: u64,
    modified: u64,
) -> CommandResult<Option<(String, IndexStatus, Option<String>)>> {
    let cached = connection
        .query_row(
            "SELECT title, status, error
             FROM document_cache
             WHERE library_root = ?1 AND relative_path = ?2
               AND source_size = ?3 AND source_modified = ?4
               AND converter_revision = ?5",
            params![root, relative_path, size, modified, CONVERTER_REVISION],
            |row| {
                let status: String = row.get(1)?;
                Ok((row.get(0)?, IndexStatus::from_str(&status), row.get(2)?))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read cached document status: {error}"))?;
    if cached.is_some() {
        connection
            .execute(
                "UPDATE document_cache SET last_accessed = ?3
                 WHERE library_root = ?1 AND relative_path = ?2",
                params![root, relative_path, now_millis()],
            )
            .map_err(|error| format!("Cannot touch cached document status: {error}"))?;
    }
    Ok(cached)
}

fn store_index_result(
    connection: &mut Connection,
    root: &Path,
    document: &DocumentInfo,
    indexed: &IndexedDocument,
) -> CommandResult<()> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start cache transaction: {error}"))?;
    let root_key = normalize_root(root);
    transaction
        .execute(
            "DELETE FROM search_segments WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, document.relative_path],
        )
        .map_err(|error| format!("Cannot remove stale search segments: {error}"))?;
    transaction
        .execute(
            "DELETE FROM document_links WHERE library_root = ?1 AND source_path = ?2",
            params![root_key, document.relative_path],
        )
        .map_err(|error| format!("Cannot remove stale document links: {error}"))?;
    transaction
        .execute(
            "INSERT INTO document_cache(
                 library_root, relative_path, title, format, source_size, source_modified,
                 converter_revision, status, error, last_accessed
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(library_root, relative_path) DO UPDATE SET
                 title = excluded.title,
                 format = excluded.format,
                 source_size = excluded.source_size,
                 source_modified = excluded.source_modified,
                 converter_revision = excluded.converter_revision,
                 status = excluded.status,
                 error = excluded.error,
                 last_accessed = excluded.last_accessed",
            params![
                root_key,
                document.relative_path,
                indexed.title,
                document.format.as_str(),
                document.size,
                document.modified,
                CONVERTER_REVISION,
                indexed.status.as_str(),
                indexed.error,
                now_millis(),
            ],
        )
        .map_err(|error| format!("Cannot store document cache status: {error}"))?;
    for segment in &indexed.segments {
        transaction
            .execute(
                "INSERT INTO search_segments(
                     library_root, relative_path, title, format, locator_kind, locator_value,
                     ordinal, content, needs_ocr, ocr_reason
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    root_key,
                    document.relative_path,
                    indexed.title,
                    document.format.as_str(),
                    segment.locator_kind,
                    segment.locator_value,
                    segment.ordinal,
                    segment.content,
                    segment.needs_ocr,
                    segment.ocr_reason,
                ],
            )
            .map_err(|error| format!("Cannot store search segment: {error}"))?;
    }
    for (ordinal, link) in indexed.links.iter().enumerate() {
        let (link_kind, target_path, wiki_stem, target_kind, link_text, fragment) = match link {
            ExtractedLink::Relative {
                target_path,
                target_kind,
                link_text,
                fragment,
            } => (
                "relative",
                Some(target_path.as_str()),
                None,
                target_kind.as_str(),
                link_text.as_str(),
                fragment.as_deref(),
            ),
            ExtractedLink::Wiki {
                stem,
                link_text,
                fragment,
            } => (
                "wiki",
                None,
                Some(stem.as_str()),
                "document",
                link_text.as_str(),
                fragment.as_deref(),
            ),
        };
        transaction
            .execute(
                "INSERT INTO document_links(
                     library_root, source_path, link_kind, target_path, wiki_stem,
                     target_kind, link_text, fragment, ordinal
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    root_key,
                    document.relative_path,
                    link_kind,
                    target_path,
                    wiki_stem,
                    target_kind,
                    link_text,
                    fragment,
                    ordinal as u32,
                ],
            )
            .map_err(|error| format!("Cannot store document link: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit document cache: {error}"))
}

fn clear_cached_document(
    connection: &mut Connection,
    root: &Path,
    relative_path: &str,
) -> CommandResult<()> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start cache cleanup: {error}"))?;
    let root_key = normalize_root(root);
    transaction
        .execute(
            "DELETE FROM search_segments WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path],
        )
        .map_err(|error| format!("Cannot delete search segments: {error}"))?;
    transaction
        .execute(
            "DELETE FROM document_links WHERE library_root = ?1 AND source_path = ?2",
            params![root_key, relative_path],
        )
        .map_err(|error| format!("Cannot delete document links: {error}"))?;
    transaction
        .execute(
            "DELETE FROM document_thumbnails WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path],
        )
        .map_err(|error| format!("Cannot delete document thumbnail: {error}"))?;
    // document_read_snapshots intentionally survives this path: it doubles
    // as the invalidation hook for changed-on-disk documents, and the whole
    // point of a read snapshot is to outlive exactly that change
    // (docs/plan-incremental-reread.md IR-D6). Vanished documents lose
    // their snapshots in the scan_documents orphan sweep instead.
    transaction
        .execute(
            "DELETE FROM document_cache WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path],
        )
        .map_err(|error| format!("Cannot delete document cache record: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit cache cleanup: {error}"))
}

fn enforce_cache_soft_limit(connection: &mut Connection, active_root: &Path) -> CommandResult<()> {
    enforce_cache_soft_limit_with_limits(
        connection,
        active_root,
        CACHE_SOFT_LIMIT_BYTES,
        CACHE_LOW_WATER_BYTES,
    )
}

fn enforce_cache_soft_limit_with_limits(
    connection: &mut Connection,
    active_root: &Path,
    soft_limit: u64,
    low_water: u64,
) -> CommandResult<()> {
    // Snapshot bytes live under their own 256 MiB budget (IR-D5) and must
    // not push conversion-cache documents out of the 1 GiB budget.
    let snapshot_bytes = snapshot_table_bytes(connection)?;
    let mut total = cache_active_bytes(connection)?.saturating_sub(snapshot_bytes);
    if total <= soft_limit {
        return Ok(());
    }
    let active = normalize_root(active_root);
    let stale_documents = {
        let mut statement = connection
            .prepare(
                "SELECT library_root, relative_path
                 FROM document_cache
                 WHERE library_root != ?1
                 ORDER BY last_accessed ASC",
            )
            .map_err(|error| format!("Cannot prepare cache eviction: {error}"))?;
        let rows = statement
            .query_map(params![active], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("Cannot list cache eviction candidates: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode cache eviction candidates: {error}"))?
    };
    let mut evicted = false;
    for (root, relative_path) in stale_documents {
        clear_cached_document_by_key(connection, &root, &relative_path)?;
        evicted = true;
        total = cache_active_bytes(connection)?.saturating_sub(snapshot_bytes);
        if total <= low_water {
            break;
        }
    }
    if evicted {
        reclaim_cache_space(connection)?;
    }
    Ok(())
}

fn clear_cached_document_by_key(
    connection: &mut Connection,
    root: &str,
    relative_path: &str,
) -> CommandResult<()> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start cache eviction: {error}"))?;
    transaction
        .execute(
            "DELETE FROM search_segments WHERE library_root = ?1 AND relative_path = ?2",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot evict search cache: {error}"))?;
    transaction
        .execute(
            "DELETE FROM document_links WHERE library_root = ?1 AND source_path = ?2",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot evict document links: {error}"))?;
    transaction
        .execute(
            "DELETE FROM document_thumbnails WHERE library_root = ?1 AND relative_path = ?2",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot evict document thumbnail: {error}"))?;
    // Snapshots deliberately survive main-budget eviction: they live under
    // their own 256 MiB LRU (IR-D5) and stay useful after the evicted
    // library is reopened and re-indexed.
    transaction
        .execute(
            "DELETE FROM document_cache WHERE library_root = ?1 AND relative_path = ?2",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot evict document cache: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit cache eviction: {error}"))
}

fn cache_active_bytes(connection: &Connection) -> CommandResult<u64> {
    let page_count = cache_pragma_i64(connection, "page_count")
        .map_err(|error| format!("Cannot measure cache page count: {error}"))?;
    let free_pages = cache_pragma_i64(connection, "freelist_count")
        .map_err(|error| format!("Cannot measure cache free pages: {error}"))?;
    let page_size = cache_pragma_i64(connection, "page_size")
        .map_err(|error| format!("Cannot measure cache page size: {error}"))?;
    let active_pages = page_count.saturating_sub(free_pages);
    let bytes = active_pages.saturating_mul(page_size);
    u64::try_from(bytes).map_err(|_| "Document cache size is invalid".to_owned())
}

fn clear_cache_storage(connection: &mut Connection) -> CommandResult<()> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start document cache cleanup: {error}"))?;
    transaction
        .execute("DELETE FROM search_segments", [])
        .map_err(|error| format!("Cannot clear cached search segments: {error}"))?;
    transaction
        .execute("DELETE FROM document_links", [])
        .map_err(|error| format!("Cannot clear cached document links: {error}"))?;
    transaction
        .execute("DELETE FROM document_thumbnails", [])
        .map_err(|error| format!("Cannot clear cached document thumbnails: {error}"))?;
    transaction
        .execute("DELETE FROM document_read_snapshots", [])
        .map_err(|error| format!("Cannot clear cached read snapshots: {error}"))?;
    transaction
        .execute("DELETE FROM document_cache", [])
        .map_err(|error| format!("Cannot clear cached documents: {error}"))?;
    transaction
        .execute("INSERT INTO search_fts(search_fts) VALUES('rebuild')", [])
        .map_err(|error| format!("Cannot rebuild empty search cache: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit document cache cleanup: {error}"))?;
    reclaim_cache_space(connection)
}

fn ensure_document_in_library(
    current: &LibraryState,
    root: &Path,
    relative_path: &str,
) -> CommandResult<()> {
    if current
        .documents
        .iter()
        .any(|document| document.relative_path == relative_path)
    {
        return Ok(());
    }
    resolve_existing_in_root(root, relative_path)?;
    Ok(())
}

/// Checks that `relative_path` belongs to the currently open library, for
/// modules (e.g. the annotation store) that hold no library state themselves.
pub(crate) fn ensure_document_in_open_library(
    state: &State<'_, AppState>,
    relative_path: &str,
) -> CommandResult<()> {
    let current = lock_state(state)?;
    let root = current
        .root
        .clone()
        .ok_or_else(|| "No library is open".to_owned())?;
    ensure_document_in_library(&current, &root, relative_path)
}

fn reclaim_cache_space(connection: &Connection) -> CommandResult<()> {
    connection
        .execute_batch("PRAGMA incremental_vacuum; PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|error| format!("Cannot reclaim document cache space: {error}"))
}

fn search_index(
    connection: &Connection,
    root: &str,
    query: &str,
    limit: u32,
) -> CommandResult<Vec<SearchResult>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    if query.chars().count() < 3 {
        return search_index_like(connection, root, query, limit);
    }
    let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
    let mut statement = connection
        .prepare(
            "SELECT s.id, s.relative_path, s.title,
                    snippet(search_fts, 1, '', '', ' … ', 28),
                    -bm25(search_fts, 5.0, 1.0) AS score,
                    s.format, s.locator_kind, s.locator_value
             FROM search_fts
             JOIN search_segments s ON s.id = search_fts.rowid
             WHERE search_fts MATCH ?1 AND s.library_root = ?2
             ORDER BY score DESC, s.relative_path ASC, s.ordinal ASC
             LIMIT ?3",
        )
        .map_err(|error| format!("Cannot prepare full-text search: {error}"))?;
    let rows = statement
        .query_map(params![fts_query, root, limit], search_result_from_row)
        .map_err(|error| format!("Cannot execute full-text search: {error}"))?;
    collect_search_rows(rows)
}

fn search_index_like(
    connection: &Connection,
    root: &str,
    query: &str,
    limit: u32,
) -> CommandResult<Vec<SearchResult>> {
    let pattern = format!("%{}%", escape_like(query));
    let mut statement = connection
        .prepare(
            "SELECT id, relative_path, title,
                    CASE
                        WHEN instr(lower(content), lower(?1)) > 0 THEN
                            substr(content, max(1, instr(lower(content), lower(?1)) - 40), 160)
                        ELSE title
                    END AS snippet,
                    0.0 AS score,
                    format, locator_kind, locator_value
             FROM search_segments
             WHERE library_root = ?2
               AND (title LIKE ?3 ESCAPE '\\' COLLATE NOCASE
                    OR content LIKE ?3 ESCAPE '\\' COLLATE NOCASE)
             ORDER BY CASE WHEN title LIKE ?3 ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END,
                      relative_path ASC, ordinal ASC
             LIMIT ?4",
        )
        .map_err(|error| format!("Cannot prepare short-query search: {error}"))?;
    let rows = statement
        .query_map(params![query, root, pattern, limit], search_result_from_row)
        .map_err(|error| format!("Cannot execute short-query search: {error}"))?;
    collect_search_rows(rows)
}

fn search_result_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchResult> {
    let _: i64 = row.get(0)?;
    let relative_path: String = row.get(1)?;
    let format_value: String = row.get(5)?;
    let format = match format_value.as_str() {
        "mdx" => DocumentFormat::Mdx,
        "pdf" => DocumentFormat::Pdf,
        "epub" => DocumentFormat::Epub,
        _ => DocumentFormat::Markdown,
    };
    let locator_kind: Option<String> = row.get(6)?;
    let locator_value: Option<String> = row.get(7)?;
    let result_id = format!(
        "{}:{}:{}",
        relative_path,
        locator_kind.as_deref().unwrap_or("document"),
        locator_value.as_deref().unwrap_or("0")
    );
    let locator = match (locator_kind.as_deref(), locator_value) {
        (Some("pdfPage"), Some(value)) => value
            .parse::<u32>()
            .ok()
            .map(|page| SearchLocator::PdfPage { page }),
        (Some("epubChapter"), Some(chapter_id)) => Some(SearchLocator::EpubChapter { chapter_id }),
        _ => None,
    };
    Ok(SearchResult {
        result_id,
        relative_path,
        title: row.get(2)?,
        snippet: row.get(3)?,
        score: row.get(4)?,
        format,
        locator,
    })
}

fn collect_search_rows(
    rows: rusqlite::MappedRows<
        '_,
        impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<SearchResult>,
    >,
) -> CommandResult<Vec<SearchResult>> {
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Cannot decode search results: {error}"))
}

// ---- Document links (docs/plan-backlinks.md) ----

/// Query-time wiki resolution maps (BL-D1): lowercased file-name stems and
/// extension-less full paths of the current scan set. O(documents) to
/// build; ambiguity is decided per lookup, never persisted.
struct WikiIndex {
    by_name: HashMap<String, Vec<String>>,
    by_path: HashMap<String, Vec<String>>,
}

impl WikiIndex {
    fn build(documents: &[DocumentInfo]) -> Self {
        let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
        let mut by_path: HashMap<String, Vec<String>> = HashMap::new();
        for document in documents {
            by_name
                .entry(wiki_file_stem(&document.relative_path))
                .or_default()
                .push(document.relative_path.clone());
            by_path
                .entry(wiki_path_stem(&document.relative_path))
                .or_default()
                .push(document.relative_path.clone());
        }
        Self { by_name, by_path }
    }

    /// Unique hit → `(Some(path), 1)`; ambiguity → `(None, n)` — no edge
    /// is built (BL-D1); zero hits → `(None, 0)`.
    fn resolve(&self, stem: &str) -> (Option<&str>, u32) {
        let candidates = if stem.contains('/') {
            self.by_path.get(stem)
        } else {
            self.by_name.get(stem)
        };
        match candidates {
            Some(paths) if paths.len() == 1 => (Some(paths[0].as_str()), 1),
            Some(paths) => (None, paths.len() as u32),
            None => (None, 0),
        }
    }
}

fn document_links_for(
    connection: &Connection,
    root: &str,
    documents: &[DocumentInfo],
    relative_path: &str,
) -> CommandResult<DocumentLinks> {
    validate_relative_library_path(relative_path)?;
    let normalized = normalize_relative_path(Path::new(relative_path));
    if normalized.is_empty() {
        return Err("A non-empty relative path is required".to_owned());
    }
    let wiki_index = WikiIndex::build(documents);
    let present: HashSet<&str> = documents
        .iter()
        .map(|document| document.relative_path.as_str())
        .collect();
    let titles: HashMap<&str, &str> = documents
        .iter()
        .map(|document| (document.relative_path.as_str(), document.title.as_str()))
        .collect();

    // Backlinks: direct target hits plus wiki stems that uniquely resolve
    // to this document, aggregated per source with the first link text as
    // the excerpt.
    let mut mentions: Vec<(String, u32, String)> = Vec::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT source_path, ordinal, link_text FROM document_links
                 WHERE library_root = ?1 AND target_path = ?2",
            )
            .map_err(|error| format!("Cannot prepare the backlink lookup: {error}"))?;
        let rows = statement
            .query_map(params![root, normalized], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|error| format!("Cannot list backlinks: {error}"))?;
        mentions.extend(
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| format!("Cannot decode backlinks: {error}"))?,
        );
    }
    {
        let mut statement = connection
            .prepare(
                "SELECT source_path, ordinal, link_text, wiki_stem FROM document_links
                 WHERE library_root = ?1 AND link_kind = 'wiki' AND wiki_stem IS NOT NULL",
            )
            .map_err(|error| format!("Cannot prepare the wiki backlink lookup: {error}"))?;
        let rows = statement
            .query_map(params![root], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| format!("Cannot list wiki backlinks: {error}"))?;
        for row in rows {
            let (source_path, ordinal, link_text, stem) =
                row.map_err(|error| format!("Cannot decode wiki backlinks: {error}"))?;
            if wiki_index.resolve(&stem).0 == Some(normalized.as_str()) {
                mentions.push((source_path, ordinal, link_text));
            }
        }
    }
    mentions.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let mut backlinks: Vec<BacklinkEntry> = Vec::new();
    for (source_path, _, link_text) in mentions {
        match backlinks.last_mut() {
            Some(last) if last.source_path == source_path => last.count += 1,
            _ => {
                let source_title = titles
                    .get(source_path.as_str())
                    .map_or_else(|| source_path.clone(), |title| (*title).to_owned());
                backlinks.push(BacklinkEntry {
                    source_path,
                    source_title,
                    link_text,
                    count: 1,
                });
            }
        }
    }
    backlinks.truncate(LINKS_LIST_LIMIT);

    // Outgoing links in extraction order; the broken counter runs over the
    // full set before truncation.
    let mut outgoing: Vec<OutgoingEntry> = Vec::new();
    let mut broken_count: u64 = 0;
    let mut statement = connection
        .prepare(
            "SELECT link_kind, target_path, wiki_stem, target_kind, link_text
             FROM document_links
             WHERE library_root = ?1 AND source_path = ?2
             ORDER BY ordinal ASC",
        )
        .map_err(|error| format!("Cannot prepare the outgoing link lookup: {error}"))?;
    let rows = statement
        .query_map(params![root, normalized], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| format!("Cannot list outgoing links: {error}"))?;
    for row in rows {
        let (link_kind, target_path, wiki_stem, target_kind, link_text) =
            row.map_err(|error| format!("Cannot decode outgoing links: {error}"))?;
        let entry = if link_kind == "wiki" {
            let stem = wiki_stem.unwrap_or_default();
            let (resolved, candidates) = wiki_index.resolve(&stem);
            if candidates == 0 {
                broken_count += 1;
            }
            OutgoingEntry {
                kind: "wiki".to_owned(),
                target_path: resolved.map(str::to_owned),
                raw_target: stem,
                link_text,
                present: resolved.is_some(),
                ambiguous_count: if candidates > 1 { candidates } else { 0 },
            }
        } else {
            let target = target_path.unwrap_or_default();
            let is_present = present.contains(target.as_str());
            if target_kind == "document" && !is_present {
                broken_count += 1;
            }
            OutgoingEntry {
                kind: target_kind,
                target_path: Some(target.clone()),
                raw_target: target,
                link_text,
                present: is_present,
                ambiguous_count: 0,
            }
        };
        outgoing.push(entry);
    }
    outgoing.truncate(LINKS_LIST_LIMIT);

    Ok(DocumentLinks {
        backlinks,
        outgoing,
        broken_count,
    })
}

// ---- Hover preview (docs/plan-hover-preview.md) ----

/// Excerpt cap in Unicode code points (HP-D9); must stay identical to
/// `PREVIEW_EXCERPT_MAX_CHARS` in `src/lib/previewExcerpt.ts`.
pub(crate) const PREVIEW_EXCERPT_MAX_CHARS: usize = 600;

fn document_preview_for(
    connection: &Connection,
    root: &str,
    documents: &[DocumentInfo],
    relative_path: &str,
    fragment: Option<&str>,
) -> CommandResult<DocumentPreview> {
    validate_relative_library_path(relative_path)?;
    let normalized = normalize_relative_path(Path::new(relative_path));
    if normalized.is_empty() {
        return Err("A non-empty relative path is required".to_owned());
    }
    let document = documents
        .iter()
        .find(|document| document.relative_path == normalized)
        .ok_or_else(|| "Document is not in the current library".to_owned())?;

    let (excerpt, pdf_pages) = match document.format {
        DocumentFormat::Markdown | DocumentFormat::Mdx => {
            let content = preview_segment_content(connection, root, &normalized, None)?;
            (
                content
                    .map(|content| build_preview_excerpt(&content, fragment).0)
                    .unwrap_or_default(),
                None,
            )
        }
        DocumentFormat::Pdf => {
            let pages: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM search_segments
                     WHERE library_root = ?1 AND relative_path = ?2",
                    params![root, normalized],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Cannot count PDF preview pages: {error}"))?;
            let requested = fragment.and_then(|value| value.trim().parse::<u32>().ok());
            let mut content = match requested {
                Some(page) => preview_segment_content(
                    connection,
                    root,
                    &normalized,
                    Some(("pdfPage", page.to_string().as_str())),
                )?,
                None => None,
            };
            let has_text = content
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty());
            if !has_text {
                content = first_textual_segment_content(connection, root, &normalized)?;
            }
            (
                content
                    .map(|content| build_preview_excerpt(&content, None).0)
                    .unwrap_or_default(),
                Some(pages.max(0) as u32),
            )
        }
        DocumentFormat::Epub => {
            let mut content = match fragment.map(str::trim) {
                Some(chapter) if !chapter.is_empty() => preview_segment_content(
                    connection,
                    root,
                    &normalized,
                    Some(("epubChapter", chapter)),
                )?,
                _ => None,
            };
            if content.is_none() {
                content = preview_segment_content(connection, root, &normalized, None)?;
            }
            (
                content
                    .map(|content| build_preview_excerpt(&content, None).0)
                    .unwrap_or_default(),
                None,
            )
        }
    };

    Ok(DocumentPreview {
        title: document.title.clone(),
        format: document.format,
        excerpt,
        pdf_pages,
        index_status: document.index_status,
    })
}

/// First segment of the document (ordinal order), optionally restricted to
/// one locator (`pdfPage` page number / `epubChapter` chapter id).
fn preview_segment_content(
    connection: &Connection,
    root: &str,
    relative_path: &str,
    locator: Option<(&str, &str)>,
) -> CommandResult<Option<String>> {
    let result = match locator {
        Some((kind, value)) => connection
            .query_row(
                "SELECT content FROM search_segments
                 WHERE library_root = ?1 AND relative_path = ?2
                   AND locator_kind = ?3 AND locator_value = ?4
                 ORDER BY ordinal ASC LIMIT 1",
                params![root, relative_path, kind, value],
                |row| row.get(0),
            )
            .optional(),
        None => connection
            .query_row(
                "SELECT content FROM search_segments
                 WHERE library_root = ?1 AND relative_path = ?2
                 ORDER BY ordinal ASC LIMIT 1",
                params![root, relative_path],
                |row| row.get(0),
            )
            .optional(),
    };
    result.map_err(|error| format!("Cannot read preview segment: {error}"))
}

/// First segment that actually carries text (skips OCR-less PDF pages).
fn first_textual_segment_content(
    connection: &Connection,
    root: &str,
    relative_path: &str,
) -> CommandResult<Option<String>> {
    connection
        .query_row(
            "SELECT content FROM search_segments
             WHERE library_root = ?1 AND relative_path = ?2 AND TRIM(content) != ''
             ORDER BY ordinal ASC LIMIT 1",
            params![root, relative_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read preview segment: {error}"))
}

fn preview_regex(
    cell: &'static std::sync::OnceLock<regex::Regex>,
    pattern: &str,
) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("preview regex"))
}

fn atx_heading_rest(line: &str) -> Option<&str> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    preview_regex(&RE, r"^ {0,3}#{1,6}[ \t]+(.*)$")
        .captures(line)
        .and_then(|capture| capture.get(1))
        .map(|capture| capture.as_str())
}

/// Heading text with a trailing run of closing hashes removed
/// (`## title ##` → `title`), mirroring the TS twin.
fn heading_display_text(raw: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    preview_regex(&RE, r"[ \t]+#+[ \t]*$")
        .replace(raw, "")
        .trim()
        .to_owned()
}

/// Collapses inner whitespace runs and lowercases for direct comparison.
fn normalize_heading_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Slug approximation of the rehype-slug output (HP-D6); twin of
/// `previewSlug` in `src/lib/previewExcerpt.ts`.
fn preview_slug(value: &str) -> String {
    let mut slug = String::new();
    for ch in value.trim().to_lowercase().chars() {
        if ch == ' ' || ch == '\t' {
            slug.push('-');
        } else if ch == '-' || ch == '_' || ch.is_alphanumeric() {
            slug.push(ch);
        }
    }
    slug
}

fn find_fragment_heading(lines: &[&str], fragment: &str) -> Option<usize> {
    let target = normalize_heading_text(fragment);
    let target_slug = preview_slug(fragment);
    if target.is_empty() && target_slug.is_empty() {
        return None;
    }
    for (index, line) in lines.iter().enumerate() {
        let Some(rest) = atx_heading_rest(line) else {
            continue;
        };
        let text = heading_display_text(rest);
        if (!target.is_empty() && normalize_heading_text(&text) == target)
            || (!target_slug.is_empty() && preview_slug(&text) == target_slug)
        {
            return Some(index);
        }
    }
    None
}

/// One line of markdown reduced to plain text (block + inline markers);
/// twin of `cleanPreviewLine` in `src/lib/previewExcerpt.ts`.
fn clean_preview_line(line: &str) -> String {
    static SETEXT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static QUOTE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static LIST: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static TASK: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static IMAGE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static LINK: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WIKI_ALIAS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WIKI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();

    let mut text = line.trim().to_owned();
    if text.is_empty() {
        return text;
    }
    if preview_regex(&SETEXT, r"^(?:=+|-+|\*{3,}|_{3,})$").is_match(&text) {
        return String::new();
    }
    text = preview_regex(&QUOTE, r"^(?:> ?)+")
        .replace(&text, "")
        .into_owned();
    if let Some(rest) = atx_heading_rest(&text) {
        text = heading_display_text(rest);
    }
    text = preview_regex(&LIST, r"^(?:[-*+]|[0-9]{1,3}[.)])[ \t]+")
        .replace(&text, "")
        .into_owned();
    text = preview_regex(&TASK, r"^\[[ xX]\][ \t]+")
        .replace(&text, "")
        .into_owned();
    text = preview_regex(&IMAGE, r"!\[([^\]]*)\]\([^)]*\)")
        .replace_all(&text, "${1}")
        .into_owned();
    text = preview_regex(&LINK, r"\[([^\]]*)\]\([^)]*\)")
        .replace_all(&text, "${1}")
        .into_owned();
    text = preview_regex(&WIKI_ALIAS, r"\[\[([^\]|]*)\|([^\]]*)\]\]")
        .replace_all(&text, "${2}")
        .into_owned();
    text = preview_regex(&WIKI, r"\[\[([^\]]*)\]\]")
        .replace_all(&text, "${1}")
        .into_owned();
    text = text.replace("**", "").replace("__", "").replace('`', "");
    text.trim().to_owned()
}

/// Bounded plain-text excerpt, optionally starting after the heading a
/// fragment points at (HP-D6 best effort). Twin of `buildPreviewExcerpt`
/// in `src/lib/previewExcerpt.ts`; the numbered cases PE01.. in its test
/// file are mirrored by the tests below.
pub(crate) fn build_preview_excerpt(content: &str, fragment: Option<&str>) -> (String, bool) {
    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut start = 0usize;
    let mut matched_fragment = false;
    if let Some(fragment) = fragment {
        if !fragment.trim().is_empty() {
            if let Some(index) = find_fragment_heading(&lines, fragment) {
                start = index + 1;
                matched_fragment = true;
            }
        }
    }

    let mut collected: Vec<String> = Vec::new();
    let mut char_count = 0usize;
    for line in lines.iter().skip(start) {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            continue;
        }
        let clean = clean_preview_line(line);
        if clean.is_empty() {
            if collected.is_empty() || collected.last().is_some_and(|last| last.is_empty()) {
                continue;
            }
            collected.push(String::new());
            char_count += 1;
            continue;
        }
        char_count += clean.chars().count() + 1;
        collected.push(clean);
        if char_count > PREVIEW_EXCERPT_MAX_CHARS {
            break;
        }
    }
    while collected.last().is_some_and(|last| last.is_empty()) {
        collected.pop();
    }

    let text = collected.join("\n");
    let chars: Vec<char> = text.chars().collect();
    let excerpt = if chars.len() > PREVIEW_EXCERPT_MAX_CHARS {
        let mut capped: String = chars[..PREVIEW_EXCERPT_MAX_CHARS].iter().collect();
        capped.push('…');
        capped
    } else {
        text
    };
    (excerpt, matched_fragment)
}

// ---- Related passages (docs/plan-related-passages.md) ----

fn is_related_delimiter(ch: char) -> bool {
    ch.is_whitespace() || ch.is_ascii_punctuation() || RELATED_CJK_DELIMITERS.contains(ch)
}

/// Selection text → significant fragments, sorted by significance and
/// capped (RP-D1). Runs of non-delimiter characters survive line wrapping
/// differences between the selection and the indexed text; long runs are
/// sliced so CJK prose yields independently matchable pieces. The TS twin
/// (`extractRelatedFragments`) must produce identical output.
pub(crate) fn extract_related_fragments(text: &str) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    let mut run: Vec<char> = Vec::new();
    for ch in text.chars().take(RELATED_MAX_TEXT_CHARS) {
        if is_related_delimiter(ch) {
            flush_related_run(&mut run, &mut candidates);
        } else {
            run.push(ch);
        }
    }
    flush_related_run(&mut run, &mut candidates);

    let mut seen: HashSet<String> = HashSet::new();
    let mut fragments: Vec<String> = Vec::new();
    for candidate in candidates {
        if seen.insert(candidate.to_lowercase()) {
            fragments.push(candidate);
        }
    }
    // Longer fragments carry more trigram selectivity; the stable sort
    // keeps original text order for equal lengths.
    fragments.sort_by_key(|fragment| std::cmp::Reverse(fragment.chars().count()));
    fragments.truncate(RELATED_MAX_FRAGMENTS);
    fragments
}

fn flush_related_run(run: &mut Vec<char>, candidates: &mut Vec<String>) {
    if run.len() > RELATED_LONG_RUN_CHARS {
        for chunk in run.chunks(RELATED_FRAGMENT_SLICE_CHARS) {
            if chunk.len() >= RELATED_MIN_FRAGMENT_CHARS {
                candidates.push(chunk.iter().collect());
            }
        }
    } else if run.len() >= RELATED_MIN_FRAGMENT_CHARS {
        candidates.push(run.iter().collect());
    }
    run.clear();
}

/// Fragments → one FTS5 MATCH string: every fragment is a quoted phrase
/// (inner quotes doubled, the `fts_phrase` discipline), joined with OR so
/// segments hitting more fragments rank higher under bm25. `OR`, `NEAR`
/// and `*` inside fragments stay literal.
fn build_related_match(fragments: &[String]) -> Option<String> {
    if fragments.is_empty() {
        return None;
    }
    Some(
        fragments
            .iter()
            .map(|fragment| format!("\"{}\"", fragment.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

fn related_passages_index(
    connection: &Connection,
    root: &str,
    text: &str,
    exclude_path: Option<&str>,
    limit: u32,
) -> CommandResult<Vec<SearchResult>> {
    // RP-D3: the whole current document is excluded, empty string when no
    // exclusion applies (it never equals a stored path).
    let exclude = match exclude_path {
        Some(path) => {
            validate_relative_library_path(path)?;
            normalize_relative_path(Path::new(path))
        }
        None => String::new(),
    };
    let fragments = extract_related_fragments(text);
    let Some(match_query) = build_related_match(&fragments) else {
        return Ok(Vec::new());
    };
    let limit = limit.clamp(1, RELATED_MAX_LIMIT);
    let mut statement = connection
        .prepare(
            // Same shape as search_index with three deltas (plan §3.2):
            // the OR match string, the exclusion, and the (2.0, 1.0) bm25
            // weights of RP-D2 (body overlap is the main signal here).
            "SELECT s.id, s.relative_path, s.title,
                    snippet(search_fts, 1, '', '', ' … ', 28),
                    -bm25(search_fts, 2.0, 1.0) AS score,
                    s.format, s.locator_kind, s.locator_value
             FROM search_fts
             JOIN search_segments s ON s.id = search_fts.rowid
             WHERE search_fts MATCH ?1 AND s.library_root = ?2 AND s.relative_path != ?3
             ORDER BY score DESC, s.relative_path ASC, s.ordinal ASC
             LIMIT ?4",
        )
        .map_err(|error| format!("Cannot prepare the related-passage search: {error}"))?;
    let rows = statement
        .query_map(
            params![match_query, root, exclude, limit],
            search_result_from_row,
        )
        .map_err(|error| format!("Cannot execute the related-passage search: {error}"))?;
    collect_search_rows(rows)
}

fn load_pdf_reading_mode(
    connection: &Connection,
    root: &Path,
    relative_path: &str,
) -> CommandResult<PdfReadingMode> {
    let root_key = normalize_root(root);
    let (status, warning) = connection
        .query_row(
            "SELECT status, error FROM document_cache
             WHERE library_root = ?1 AND relative_path = ?2",
            params![root_key, relative_path],
            |row| {
                let status: String = row.get(0)?;
                Ok((
                    IndexStatus::from_str(&status),
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read PDF cache status: {error}"))?
        .unwrap_or((IndexStatus::Pending, None));
    let mut statement = connection
        .prepare(
            "SELECT locator_value, content, needs_ocr, ocr_reason
             FROM search_segments
             WHERE library_root = ?1 AND relative_path = ?2
             ORDER BY ordinal ASC",
        )
        .map_err(|error| format!("Cannot prepare PDF reading mode: {error}"))?;
    let rows = statement
        .query_map(params![root_key, relative_path], |row| {
            let page_value: String = row.get(0)?;
            Ok(PdfPageContent {
                page: page_value.parse().unwrap_or(1),
                markdown: row.get(1)?,
                needs_ocr: row.get(2)?,
                ocr_reason: row.get(3)?,
            })
        })
        .map_err(|error| format!("Cannot load PDF reading pages: {error}"))?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Cannot decode PDF reading pages: {error}"))?;
    let missing_pages = rows
        .iter()
        .filter(|page| page.needs_ocr)
        .map(|page| page.page)
        .collect();
    Ok(PdfReadingMode {
        relative_path: relative_path.to_owned(),
        status,
        pages: rows,
        missing_pages,
        warning,
    })
}

fn read_asset_from_root(root: &Path, relative_path: &str) -> CommandResult<AssetData> {
    let path = resolve_existing_in_root(root, relative_path)?;
    let metadata = fs::metadata(&path).map_err(|error| format!("Cannot inspect asset: {error}"))?;
    if !metadata.is_file() {
        return Err("Asset path does not point to a file".to_owned());
    }
    if metadata.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "Asset is too large ({} bytes; maximum is {MAX_ASSET_BYTES})",
            metadata.len()
        ));
    }
    let bytes = fs::read(&path).map_err(|error| format!("Cannot read asset: {error}"))?;
    let mime_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .essence_str()
        .to_owned();
    Ok(AssetData {
        relative_path: normalize_relative_path(
            path.strip_prefix(root)
                .map_err(|_| "Asset resolved outside the library".to_owned())?,
        ),
        mime_type,
        data: BASE64.encode(bytes),
    })
}

fn lock_state<'a>(
    state: &'a State<'_, AppState>,
) -> CommandResult<std::sync::MutexGuard<'a, LibraryState>> {
    state
        .inner
        .lock()
        .map_err(|_| "Library state lock was poisoned".to_owned())
}

pub(crate) fn current_root(state: &State<'_, AppState>) -> CommandResult<PathBuf> {
    lock_state(state)?
        .root
        .clone()
        .ok_or_else(|| "No library is open".to_owned())
}

/// Captures the open root and its open-session atomically (single lock
/// acquisition, D02): commands that do blocking work after this point can
/// re-check the session before touching shared state, converting a
/// library switch into a deterministic stale-context error instead of
/// delivering old-library bytes/state to the new one.
fn current_root_and_session(state: &State<'_, AppState>) -> CommandResult<(PathBuf, u64)> {
    let current = lock_state(state)?;
    let root = current
        .root
        .clone()
        .ok_or_else(|| "No library is open".to_owned())?;
    Ok((root, current.open_session))
}

/// Stale-context guard for commands that read with a captured root and must
/// not return old-library results after the user switched away. A same-library
/// refresh keeps the session (and therefore stays valid).
fn ensure_same_open_session(state: &State<'_, AppState>, open_session: u64) -> CommandResult<()> {
    let current = lock_state(state)?;
    if current.open_session != open_session {
        return Err("The library changed while the document was being read; reopen it".to_owned());
    }
    Ok(())
}

/// Snapshot of the open library root plus the relative paths found by the
/// latest scan, for modules (e.g. move detection in the annotation store)
/// that need the "currently present" set without holding the library lock.
pub(crate) fn current_root_and_document_paths(
    state: &State<'_, AppState>,
) -> CommandResult<(PathBuf, HashSet<String>)> {
    let current = lock_state(state)?;
    let root = current
        .root
        .clone()
        .ok_or_else(|| "No library is open".to_owned())?;
    let paths = current
        .documents
        .iter()
        .map(|document| document.relative_path.clone())
        .collect();
    Ok((root, paths))
}

fn create_watcher(root: &Path, app: AppHandle) -> CommandResult<RecommendedWatcher> {
    let last_emit = Arc::new(Mutex::new(None::<Instant>));
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let Ok(mut last_emit) = last_emit.lock() else {
            return;
        };
        if last_emit.is_some_and(|instant| instant.elapsed() < WATCH_DEBOUNCE) {
            return;
        }
        *last_emit = Some(Instant::now());
        let _ = app.emit("library-changed", ());
    })
    .map_err(|error| format!("Cannot create library watcher: {error}"))?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|error| format!("Cannot watch library root: {error}"))?;
    Ok(watcher)
}

fn is_excluded_directory(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_some_and(|kind| kind.is_dir()) {
        return false;
    }
    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
    EXCLUDED_DIRECTORIES.contains(&name.as_str())
}

fn read_utf8_lossy_with_limit(path: &Path, limit: u64, label: &str) -> CommandResult<String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("Cannot inspect {label}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{label} path does not point to a file"));
    }
    if metadata.len() > limit {
        return Err(format!(
            "{label} is too large ({} bytes; maximum is {limit})",
            metadata.len()
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("Cannot read {label}: {error}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn extract_title(markdown: &str) -> Option<String> {
    let mut in_fence = false;
    let mut previous_non_empty: Option<&str> = None;
    for line in markdown.trim_start_matches('\u{feff}').lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(title) = trimmed.strip_prefix("# ") {
            let title = title.trim_end_matches('#').trim();
            if !title.is_empty() {
                return Some(title.to_owned());
            }
        }
        if !trimmed.is_empty() && trimmed.chars().all(|character| character == '=') {
            if let Some(previous) = previous_non_empty {
                if !previous.starts_with('#') {
                    return Some(previous.to_owned());
                }
            }
        }
        if !trimmed.is_empty() {
            previous_non_empty = Some(trimmed);
        }
    }
    None
}

fn fallback_title(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Untitled")
        .to_owned()
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use lopdf::{
        content::{Content, Operation},
        dictionary, Document, Object, Stream,
    };
    use tempfile::tempdir;

    use super::*;

    fn insert_cache_document(
        connection: &Connection,
        root: &str,
        relative_path: &str,
        title: &str,
        last_accessed: i64,
    ) {
        connection
            .execute(
                "INSERT INTO document_cache(
                     library_root, relative_path, title, format, source_size, source_modified,
                     converter_revision, status, error, last_accessed
                 ) VALUES (?1, ?2, ?3, 'markdown', 0, 0, 'test', 'ready', NULL, ?4)",
                params![root, relative_path, title, last_accessed],
            )
            .expect("insert cache document fixture");
    }

    fn write_text_pdf(path: &Path, text: &str) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier"
        });
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id }
        });
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 18.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                Operation::new("Tj", vec![Object::string_literal(text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id = document.add_object(Stream::new(
            dictionary! {},
            content.encode().expect("encode content"),
        ));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content_id
        });
        document.objects.insert(pages_id, Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
            "Resources" => resources_id, "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()]
        }));
        let catalog_id =
            document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        document.trailer.set("Root", catalog_id);
        document.compress();
        document.save(path).expect("save PDF fixture");
    }

    fn png_base64(payload_len: usize) -> String {
        let mut bytes = PNG_MAGIC.to_vec();
        bytes.extend(std::iter::repeat_n(0u8, payload_len));
        BASE64.encode(bytes)
    }

    fn thumbnail_count(connection: &Connection, root: &str, path: &str) -> i64 {
        connection
            .query_row(
                "SELECT count(*) FROM document_thumbnails
                 WHERE library_root = ?1 AND relative_path = ?2",
                params![root, path],
                |row| row.get(0),
            )
            .expect("count thumbnails")
    }

    #[test]
    fn thumbnail_store_read_roundtrip_is_isolated_per_library() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        let png = png_base64(16);
        store_thumbnail_record(&current.cache, "lib-a", "book.pdf", 10, 20, &png, 240, 320)
            .expect("store thumbnail");

        let hit = read_thumbnail_record(&current.cache, "lib-a", "book.pdf", 10, 20)
            .expect("read thumbnail")
            .expect("thumbnail present");
        assert_eq!(hit.png, png);
        assert_eq!((hit.width, hit.height), (240, 320));
        // Same path under another library root stays a miss.
        assert_eq!(
            read_thumbnail_record(&current.cache, "lib-b", "book.pdf", 10, 20)
                .expect("read other library"),
            None
        );
        // Re-storing replaces the row instead of erroring.
        store_thumbnail_record(&current.cache, "lib-a", "book.pdf", 10, 20, &png, 120, 160)
            .expect("replace thumbnail");
        let replaced = read_thumbnail_record(&current.cache, "lib-a", "book.pdf", 10, 20)
            .expect("read replaced")
            .expect("replaced present");
        assert_eq!((replaced.width, replaced.height), (120, 160));
    }

    #[test]
    fn thumbnail_store_rejects_bad_magic_oversize_and_bad_dimensions() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        let jpeg = BASE64.encode([0xFFu8, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0]);
        assert!(
            store_thumbnail_record(&current.cache, "lib", "a.pdf", 1, 1, &jpeg, 240, 320).is_err(),
            "non-PNG magic must be rejected"
        );
        let oversize = png_base64(THUMBNAIL_MAX_PNG_BYTES + 1);
        assert!(
            store_thumbnail_record(&current.cache, "lib", "a.pdf", 1, 1, &oversize, 240, 320)
                .is_err(),
            "payloads over 512 KiB must be rejected"
        );
        let png = png_base64(16);
        for (width, height) in [(0, 320), (240, 0), (THUMBNAIL_MAX_DIMENSION + 1, 320)] {
            assert!(
                store_thumbnail_record(&current.cache, "lib", "a.pdf", 1, 1, &png, width, height)
                    .is_err(),
                "dimensions {width}×{height} must be rejected"
            );
        }
        let not_base64 = "not-base64!!";
        assert!(
            store_thumbnail_record(&current.cache, "lib", "a.pdf", 1, 1, not_base64, 240, 320)
                .is_err()
        );
        assert_eq!(thumbnail_count(&current.cache, "lib", "a.pdf"), 0);
    }

    #[test]
    fn thumbnail_read_drops_stale_fingerprints() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        let png = png_base64(16);
        store_thumbnail_record(&current.cache, "lib", "a.pdf", 10, 20, &png, 240, 320)
            .expect("store thumbnail");

        // The source file changed (new size/modified): miss + row deleted.
        assert_eq!(
            read_thumbnail_record(&current.cache, "lib", "a.pdf", 11, 21).expect("stale read"),
            None
        );
        assert_eq!(thumbnail_count(&current.cache, "lib", "a.pdf"), 0);
    }

    #[test]
    fn cache_cleanup_paths_remove_thumbnails() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let png = png_base64(16);
        let root = Path::new("lib");
        let root_key = normalize_root(root);
        for path in ["a.pdf", "b.pdf", "c.pdf"] {
            store_thumbnail_record(&current.cache, &root_key, path, 1, 1, &png, 240, 320)
                .expect("store thumbnail");
        }

        clear_cached_document(&mut current.cache, root, "a.pdf").expect("clear one document");
        assert_eq!(thumbnail_count(&current.cache, &root_key, "a.pdf"), 0);

        clear_cached_document_by_key(&mut current.cache, &root_key, "b.pdf")
            .expect("evict one document");
        assert_eq!(thumbnail_count(&current.cache, &root_key, "b.pdf"), 0);

        clear_cache_storage(&mut current.cache).expect("clear whole cache");
        assert_eq!(thumbnail_count(&current.cache, &root_key, "c.pdf"), 0);
    }

    // ---- 增量重读快照(docs/plan-incremental-reread.md §5/§8) ----

    fn insert_cache_document_with_fingerprint(
        connection: &Connection,
        root: &str,
        relative_path: &str,
        format: &str,
        size: i64,
        modified: i64,
    ) {
        connection
            .execute(
                "INSERT INTO document_cache(
                     library_root, relative_path, title, format, source_size, source_modified,
                     converter_revision, status, error, last_accessed
                 ) VALUES (?1, ?2, 't', ?3, ?4, ?5, 'test', 'ready', NULL, 1)
                 ON CONFLICT(library_root, relative_path) DO UPDATE SET
                     source_size = excluded.source_size,
                     source_modified = excluded.source_modified",
                params![root, relative_path, format, size, modified],
            )
            .expect("insert cache document fixture");
    }

    fn replace_segments(connection: &Connection, root: &str, path: &str, contents: &[&str]) {
        connection
            .execute(
                "DELETE FROM search_segments WHERE library_root = ?1 AND relative_path = ?2",
                params![root, path],
            )
            .expect("clear segment fixtures");
        for (ordinal, content) in contents.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO search_segments(
                         library_root, relative_path, title, format, ordinal, content, needs_ocr
                     ) VALUES (?1, ?2, 't', 'markdown', ?3, ?4, 0)",
                    params![root, path, ordinal as u32, content],
                )
                .expect("insert segment fixture");
        }
    }

    fn insert_snapshot(
        connection: &Connection,
        root: &str,
        path: &str,
        content: &str,
        last_accessed: i64,
    ) {
        connection
            .execute(
                "INSERT INTO document_read_snapshots(
                     library_root, relative_path, content, source_size, source_modified,
                     captured_at, last_accessed
                 ) VALUES (?1, ?2, ?3, 1, 1, ?4, ?4)",
                params![root, path, content, last_accessed],
            )
            .expect("insert snapshot fixture");
    }

    fn snapshot_count(connection: &Connection, root: &str, path: &str) -> i64 {
        connection
            .query_row(
                "SELECT count(*) FROM document_read_snapshots
                 WHERE library_root = ?1 AND relative_path = ?2",
                params![root, path],
                |row| row.get(0),
            )
            .expect("count snapshots")
    }

    #[test]
    fn paragraph_diff_reports_added_modified_removed_with_line_ranges() {
        let old = "# 标题\n\n第一段。\n\n第二段。\n\n第三段。\n";
        let new = "# 标题\n\n第一段改。\n\n新增段。\n\n第二段。\n\n第三段。\n";
        let diff = diff_snapshot_texts(old, new, DocumentFormat::Markdown);
        assert!(!diff.truncated);
        assert_eq!(diff.removed_count, 0);
        assert_eq!(
            diff.changed,
            vec![
                ChangedSegment {
                    index: 1,
                    kind: "modified",
                    start_line: Some(3),
                    end_line: Some(3),
                },
                ChangedSegment {
                    index: 2,
                    kind: "added",
                    start_line: Some(5),
                    end_line: Some(5),
                },
            ]
        );

        // Pure deletion: no marks to draw, only a removed count.
        let shrunk = "# 标题\n\n第一段。\n\n第三段。\n";
        let removed = diff_snapshot_texts(old, shrunk, DocumentFormat::Markdown);
        assert!(removed.changed.is_empty());
        assert_eq!(removed.removed_count, 1);

        // Multi-line paragraph carries its whole source range.
        let long = "开头。\n\n多行段第一行\n多行段第二行\n多行段第三行\n";
        let grown = diff_snapshot_texts("开头。\n", long, DocumentFormat::Markdown);
        assert_eq!(
            grown.changed,
            vec![ChangedSegment {
                index: 1,
                kind: "added",
                start_line: Some(3),
                end_line: Some(5),
            }]
        );

        // Brand-new document against an empty snapshot: everything added.
        let fresh = diff_snapshot_texts("", "唯一段落。\n", DocumentFormat::Markdown);
        assert_eq!(fresh.changed.len(), 1);
        assert_eq!(fresh.changed[0].kind, "added");
        // Emptied document: nothing to mark, everything counted as removed.
        let emptied = diff_snapshot_texts("甲\n\n乙\n", "", DocumentFormat::Markdown);
        assert!(emptied.changed.is_empty());
        assert_eq!(emptied.removed_count, 2);
    }

    #[test]
    fn paragraph_diff_normalizes_crlf_bom_and_flags_moves_once() {
        // CRLF→LF rewrite plus BOM removal is not a content change.
        let old = "\u{FEFF}第一段。\r\n\r\n第二段。  \r\n";
        let new = "第一段。\n\n第二段。\n";
        let diff = diff_snapshot_texts(old, new, DocumentFormat::Markdown);
        assert!(diff.changed.is_empty());
        assert_eq!(diff.removed_count, 0);

        // A pure move surfaces as exactly one modified unit on the LCS path.
        let ordered = "甲\n\n乙\n\n丙\n\n丁\n";
        let moved = "甲\n\n丙\n\n乙\n\n丁\n";
        let move_diff = diff_snapshot_texts(ordered, moved, DocumentFormat::Markdown);
        assert_eq!(move_diff.changed.len(), 1);
        assert_eq!(move_diff.changed[0].kind, "modified");
        assert_eq!(move_diff.removed_count, 0);
    }

    #[test]
    fn unit_diff_degrades_to_multiset_then_whole_document() {
        // Beyond DIFF_MAX_UNITS on either side: whole-document hint only.
        let many: Vec<u64> = (0..(DIFF_MAX_UNITS as u64 + 1)).collect();
        let outcome = diff_unit_hashes(&many, &[1, 2]);
        assert!(outcome.truncated);
        assert!(outcome.changed.is_empty());

        // Mid sections larger than DIFF_MAX_LCS_CELLS fall back to the
        // multiset match: the swapped pair stops being flagged, the edited
        // head/tail sentinels stay exact.
        let side = 2_100u64;
        let mut old: Vec<u64> = (0..side).collect();
        let mut new = old.clone();
        old[0] = 900_001;
        new[0] = 900_002;
        old[(side - 1) as usize] = 900_003;
        new[(side - 1) as usize] = 900_004;
        new.swap(5, 6);
        assert!(old.len() * new.len() > DIFF_MAX_LCS_CELLS);
        let approx = diff_unit_hashes(&old, &new);
        assert!(!approx.truncated);
        let indices: Vec<usize> = approx.changed.iter().map(|(index, _)| *index).collect();
        assert_eq!(indices, vec![0, (side - 1) as usize]);
        assert_eq!(approx.removed_count, 0);

        // The same shape in a small sequence takes the LCS path and flags
        // the move as a third changed unit.
        let side = 40u64;
        let mut old: Vec<u64> = (0..side).collect();
        let mut new = old.clone();
        old[0] = 900_001;
        new[0] = 900_002;
        old[(side - 1) as usize] = 900_003;
        new[(side - 1) as usize] = 900_004;
        new.swap(5, 6);
        let exact = diff_unit_hashes(&old, &new);
        assert_eq!(exact.changed.len(), 3);
    }

    #[test]
    fn snapshot_capture_diff_and_acknowledge_roundtrip() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let root = "lib";
        let path = "notes/a.md";
        insert_cache_document_with_fingerprint(&current.cache, root, path, "markdown", 100, 1000);
        replace_segments(&current.cache, root, path, &["第一段。\n\n第二段。\n"]);

        assert!(capture_snapshot_record(&mut current.cache, root, path).expect("capture"));
        assert_eq!(snapshot_count(&current.cache, root, path), 1);
        let (snap_size, snap_modified): (i64, i64) = current
            .cache
            .query_row(
                "SELECT source_size, source_modified FROM document_read_snapshots
                 WHERE library_root = ?1 AND relative_path = ?2",
                params![root, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read snapshot fingerprint");
        // The fingerprint comes from the document_cache row in the same
        // transaction, never from a potentially newer scan snapshot.
        assert_eq!((snap_size, snap_modified), (100, 1000));

        // Unchanged file: no diff.
        let same = snapshot_diff_record(
            &current.cache,
            root,
            path,
            DocumentFormat::Markdown,
            100,
            1000,
        )
        .expect("diff unchanged");
        assert_eq!(same, None);

        // External edit + finished re-index: one modified paragraph.
        insert_cache_document_with_fingerprint(&current.cache, root, path, "markdown", 120, 2000);
        replace_segments(&current.cache, root, path, &["第一段改。\n\n第二段。\n"]);
        let diff = snapshot_diff_record(
            &current.cache,
            root,
            path,
            DocumentFormat::Markdown,
            120,
            2000,
        )
        .expect("diff changed")
        .expect("diff present");
        assert_eq!(diff.granularity, "paragraph");
        assert_eq!(diff.changed_segments.len(), 1);
        assert_eq!(diff.changed_segments[0].kind, "modified");
        assert_eq!(diff.changed_segments[0].start_line, Some(1));

        // "知道了" = capture again: the banner stays quiet afterwards.
        assert!(capture_snapshot_record(&mut current.cache, root, path).expect("acknowledge"));
        let after = snapshot_diff_record(
            &current.cache,
            root,
            path,
            DocumentFormat::Markdown,
            120,
            2000,
        )
        .expect("diff acknowledged");
        assert_eq!(after, None);
    }

    #[test]
    fn snapshot_diff_waits_for_reindex_and_respects_library_isolation() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let path = "notes/a.md";
        for root in ["lib-a", "lib-b"] {
            insert_cache_document_with_fingerprint(
                &current.cache,
                root,
                path,
                "markdown",
                100,
                1000,
            );
        }
        replace_segments(&current.cache, "lib-a", path, &["A 库正文。\n"]);
        replace_segments(&current.cache, "lib-b", path, &["B 库正文。\n"]);
        assert!(capture_snapshot_record(&mut current.cache, "lib-a", path).expect("capture a"));
        assert!(capture_snapshot_record(&mut current.cache, "lib-b", path).expect("capture b"));

        // The file changed on disk but the background index has not caught
        // up (document_cache still carries the old fingerprint): stay
        // silent instead of diffing stale segments (IR-D8).
        let pending = snapshot_diff_record(
            &current.cache,
            "lib-a",
            path,
            DocumentFormat::Markdown,
            120,
            2000,
        )
        .expect("diff while pending");
        assert_eq!(pending, None);

        // After re-index only lib-a reports changes; lib-b is untouched.
        insert_cache_document_with_fingerprint(
            &current.cache,
            "lib-a",
            path,
            "markdown",
            120,
            2000,
        );
        replace_segments(&current.cache, "lib-a", path, &["A 库正文改。\n"]);
        let changed = snapshot_diff_record(
            &current.cache,
            "lib-a",
            path,
            DocumentFormat::Markdown,
            120,
            2000,
        )
        .expect("diff a")
        .expect("diff present");
        assert_eq!(changed.changed_segments.len(), 1);
        let other = snapshot_diff_record(
            &current.cache,
            "lib-b",
            path,
            DocumentFormat::Markdown,
            100,
            1000,
        )
        .expect("diff b");
        assert_eq!(other, None);
    }

    #[test]
    fn snapshot_capture_skips_missing_index_and_oversized_documents() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        // No document_cache row yet (still indexing): nothing to snapshot.
        assert!(!capture_snapshot_record(&mut current.cache, "lib", "a.md").expect("no cache row"));
        assert_eq!(snapshot_count(&current.cache, "lib", "a.md"), 0);

        // Content beyond the 10 MiB red line is refused, not truncated.
        insert_cache_document_with_fingerprint(&current.cache, "lib", "big.md", "markdown", 1, 1);
        let oversized = "a".repeat(MAX_MARKDOWN_BYTES as usize + 1);
        replace_segments(&current.cache, "lib", "big.md", &[oversized.as_str()]);
        assert!(!capture_snapshot_record(&mut current.cache, "lib", "big.md").expect("oversized"));
        assert_eq!(snapshot_count(&current.cache, "lib", "big.md"), 0);
    }

    #[test]
    fn pdf_and_epub_snapshots_diff_at_unit_granularity() {
        // PDF: page 2 edited → zero-based page ordinal 1, no line ranges.
        let old_pages = ["第一页", "第二页", "第三页"].join(SNAPSHOT_UNIT_SEPARATOR);
        let new_pages = ["第一页", "第二页改", "第三页"].join(SNAPSHOT_UNIT_SEPARATOR);
        let pdf = diff_snapshot_texts(&old_pages, &new_pages, DocumentFormat::Pdf);
        assert_eq!(pdf.changed.len(), 1);
        assert_eq!(pdf.changed[0].index, 1);
        assert_eq!(pdf.changed[0].kind, "modified");
        assert_eq!(pdf.changed[0].start_line, None);

        // EPUB: a chapter inserted in the middle → added at ordinal 1.
        let old_chapters = ["第一章", "第二章"].join(SNAPSHOT_UNIT_SEPARATOR);
        let new_chapters = ["第一章", "新章节", "第二章"].join(SNAPSHOT_UNIT_SEPARATOR);
        let epub = diff_snapshot_texts(&old_chapters, &new_chapters, DocumentFormat::Epub);
        assert_eq!(epub.changed.len(), 1);
        assert_eq!(epub.changed[0].index, 1);
        assert_eq!(epub.changed[0].kind, "added");
        assert_eq!(epub.removed_count, 0);
    }

    #[test]
    fn snapshot_budget_evicts_pure_lru_including_active_library() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        let kib = 1024usize;
        insert_snapshot(&current.cache, "active", "oldest.md", &"a".repeat(kib), 1);
        insert_snapshot(&current.cache, "other", "middle.md", &"b".repeat(kib), 2);
        insert_snapshot(&current.cache, "active", "newest.md", &"c".repeat(kib), 3);

        enforce_snapshot_budget_with_limits(&current.cache, 2 * kib as u64, kib as u64)
            .expect("enforce snapshot budget");

        // Pure LRU: the active library enjoys no immunity here (IR-D5).
        assert_eq!(snapshot_count(&current.cache, "active", "oldest.md"), 0);
        assert_eq!(snapshot_count(&current.cache, "other", "middle.md"), 0);
        assert_eq!(snapshot_count(&current.cache, "active", "newest.md"), 1);
    }

    #[test]
    fn snapshot_lifecycle_survives_invalidation_but_follows_full_clear() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let root = Path::new("lib");
        let root_key = normalize_root(root);
        for path in ["a.md", "b.md", "c.md"] {
            insert_snapshot(&current.cache, &root_key, path, "正文", 1);
        }

        // Invalidation of a changed-on-disk document must keep the snapshot
        // alive — outliving exactly that change is the feature (IR-D6).
        clear_cached_document(&mut current.cache, root, "a.md").expect("invalidate document");
        assert_eq!(snapshot_count(&current.cache, &root_key, "a.md"), 1);

        // Main-budget LRU eviction keeps it too: snapshots live under
        // their own 256 MiB budget (IR-D5).
        clear_cached_document_by_key(&mut current.cache, &root_key, "b.md")
            .expect("evict one document");
        assert_eq!(snapshot_count(&current.cache, &root_key, "b.md"), 1);

        // The explicit whole-cache clear drops everything.
        clear_cache_storage(&mut current.cache).expect("clear whole cache");
        for path in ["a.md", "b.md", "c.md"] {
            assert_eq!(snapshot_count(&current.cache, &root_key, path), 0);
        }
    }

    #[test]
    fn main_soft_limit_measures_documents_without_snapshot_bytes() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let active_root = Path::new("active-library");
        insert_cache_document(&current.cache, "stale-library", "doc.md", "small", 1);
        // A large snapshot alone must not push conversion-cache documents
        // out of the 1 GiB budget (IR-D5: independent sub-budget).
        insert_snapshot(
            &current.cache,
            "stale-library",
            "doc.md",
            &"s".repeat(1024 * 1024),
            1,
        );
        assert!(cache_active_bytes(&current.cache).expect("cache size") > 512 * 1024);

        enforce_cache_soft_limit_with_limits(
            &mut current.cache,
            active_root,
            512 * 1024,
            460 * 1024,
        )
        .expect("enforce main limit");

        let remaining: i64 = current
            .cache
            .query_row(
                "SELECT count(*) FROM document_cache WHERE library_root = 'stale-library'",
                [],
                |row| row.get(0),
            )
            .expect("count stale documents");
        assert_eq!(remaining, 1);
    }

    #[test]
    fn scan_sweeps_orphan_snapshots_but_keeps_changed_documents() {
        let library = tempdir().expect("temp library");
        fs::write(library.path().join("kept.md"), "# Kept").expect("write kept");
        let root = canonical_library_root(library.path()).expect("canonical root");
        let root_key = normalize_root(&root);
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        // kept.md has no matching document_cache row, so the scan runs the
        // invalidation path on it — the snapshot must survive that.
        insert_snapshot(&current.cache, &root_key, "kept.md", "正文", 1);
        insert_snapshot(&current.cache, &root_key, "ghost.md", "正文", 1);

        scan_documents(&root, &mut current.cache).expect("scan");

        assert_eq!(snapshot_count(&current.cache, &root_key, "kept.md"), 1);
        assert_eq!(snapshot_count(&current.cache, &root_key, "ghost.md"), 0);
    }

    #[test]
    fn probe_reports_directories_but_not_files_or_ghosts() {
        let library = tempdir().expect("temp library");
        let file_path = library.path().join("doc.md");
        fs::write(&file_path, "# Doc").expect("write fixture");

        assert!(probe_path_is_directory(
            library.path().to_string_lossy().as_ref()
        ));
        assert!(!probe_path_is_directory(
            file_path.to_string_lossy().as_ref()
        ));
        assert!(!probe_path_is_directory(
            library
                .path()
                .join("missing-library")
                .to_string_lossy()
                .as_ref()
        ));
    }

    #[test]
    fn rejects_absolute_and_parent_paths() {
        let library = tempdir().expect("temp library");
        fs::write(library.path().join("inside.md"), "# Inside").expect("write fixture");
        let canonical_root = canonical_library_root(library.path()).expect("canonical root");
        assert!(resolve_existing_in_root(&canonical_root, "../outside.md").is_err());
        assert!(resolve_existing_in_root(
            &canonical_root,
            library.path().join("inside.md").to_string_lossy().as_ref()
        )
        .is_err());
        assert!(resolve_existing_in_root(&canonical_root, "inside.md").is_ok());
    }

    #[test]
    fn reveal_resolves_nested_file_and_folder_inside_the_library() {
        let library = tempdir().expect("temp library");
        let nested = library.path().join("notes");
        fs::create_dir(&nested).expect("create nested folder");
        fs::write(nested.join("inside.md"), "# Inside").expect("write fixture");
        let canonical_root = canonical_library_root(library.path()).expect("canonical root");

        let file = resolve_existing_in_root(&canonical_root, "notes/inside.md")
            .expect("nested file should resolve");
        assert_eq!(
            file.file_name().and_then(|name| name.to_str()),
            Some("inside.md")
        );
        let folder = resolve_existing_in_root(&canonical_root, "notes")
            .expect("nested folder should resolve");
        assert_eq!(
            folder.file_name().and_then(|name| name.to_str()),
            Some("notes")
        );
        assert!(resolve_existing_in_root(&canonical_root, "").is_err());
        assert!(resolve_existing_in_root(&canonical_root, "notes/../outside.md").is_err());
    }

    #[test]
    fn outdated_cache_is_rebuilt_with_versioned_incremental_vacuum_schema() {
        let cache_directory = tempdir().expect("temp cache");
        let source_directory = tempdir().expect("temp source");
        let source_path = source_directory.path().join("private-book.pdf");
        fs::write(&source_path, b"private source remains untouched").expect("write source");
        let cache_path = cache_directory.path().join("reade-cache.sqlite3");
        {
            let legacy = Connection::open(&cache_path).expect("open legacy cache");
            legacy
                .execute_batch(
                    "CREATE TABLE legacy_cache(source_path TEXT NOT NULL);
                     INSERT INTO legacy_cache(source_path) VALUES ('private-book.pdf');
                     PRAGMA user_version = 0;",
                )
                .expect("create legacy cache");
        }

        let state = AppState::new(cache_directory.path().to_path_buf()).expect("rebuild cache");
        let current = state.inner.lock().expect("lock cache");
        assert_eq!(
            cache_pragma_i64(&current.cache, "user_version").expect("schema version"),
            CACHE_SCHEMA_VERSION
        );
        assert_eq!(
            cache_pragma_i64(&current.cache, "auto_vacuum").expect("vacuum mode"),
            2
        );
        let legacy_tables: i64 = current
            .cache
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'legacy_cache'",
                [],
                |row| row.get(0),
            )
            .expect("inspect rebuilt schema");
        assert_eq!(legacy_tables, 0);
        assert_eq!(
            fs::read(&source_path).expect("read source"),
            b"private source remains untouched"
        );
    }

    #[test]
    fn soft_limit_evicts_non_active_documents_in_lru_order_to_low_water() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let active_root = Path::new("active-library");
        let active_key = normalize_root(active_root);
        insert_cache_document(&current.cache, &active_key, "current.md", "current", 1);
        insert_cache_document(
            &current.cache,
            "old-library",
            "old.md",
            &"o".repeat(1024 * 1024),
            2,
        );
        insert_cache_document(&current.cache, "recent-library", "recent.md", "recent", 3);
        let soft_limit = 512 * 1024;
        let low_water = soft_limit * 9 / 10;
        assert!(cache_active_bytes(&current.cache).expect("cache size") > soft_limit);

        enforce_cache_soft_limit_with_limits(
            &mut current.cache,
            active_root,
            soft_limit,
            low_water,
        )
        .expect("enforce small cache limit");

        let remaining = |root: &str, path: &str| -> i64 {
            current
                .cache
                .query_row(
                    "SELECT count(*) FROM document_cache
                     WHERE library_root = ?1 AND relative_path = ?2",
                    params![root, path],
                    |row| row.get(0),
                )
                .expect("count cache document")
        };
        assert_eq!(remaining("old-library", "old.md"), 0);
        assert_eq!(remaining("recent-library", "recent.md"), 1);
        assert_eq!(remaining(&active_key, "current.md"), 1);
        assert!(cache_active_bytes(&current.cache).expect("remaining size") <= low_water);
    }

    #[test]
    fn soft_limit_allows_the_active_library_to_exceed_the_limit() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let active_root = Path::new("large-active-library");
        let active_key = normalize_root(active_root);
        insert_cache_document(
            &current.cache,
            &active_key,
            "large.md",
            &"a".repeat(1024 * 1024),
            1,
        );

        enforce_cache_soft_limit_with_limits(&mut current.cache, active_root, 64 * 1024, 57 * 1024)
            .expect("allow oversized active cache");

        let count: i64 = current
            .cache
            .query_row(
                "SELECT count(*) FROM document_cache WHERE library_root = ?1",
                params![active_key],
                |row| row.get(0),
            )
            .expect("count active cache");
        assert_eq!(count, 1);
        assert!(cache_active_bytes(&current.cache).expect("cache size") > 64 * 1024);
    }

    #[test]
    fn completed_old_generation_cannot_update_the_new_library() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        current.generation = 2;
        current.root = Some(PathBuf::from("new-library"));
        current.documents = vec![DocumentInfo {
            relative_path: "same.md".to_owned(),
            title: "New library title".to_owned(),
            size: 3,
            modified: 2,
            format: DocumentFormat::Markdown,
            index_status: IndexStatus::Pending,
            index_error: None,
        }];
        let old_document = DocumentInfo {
            relative_path: "same.md".to_owned(),
            title: "Old library title".to_owned(),
            size: 3,
            modified: 1,
            format: DocumentFormat::Markdown,
            index_status: IndexStatus::Indexing,
            index_error: None,
        };
        let old_result = IndexedDocument {
            title: "Stale converted title".to_owned(),
            status: IndexStatus::Ready,
            error: None,
            segments: Vec::new(),
            links: Vec::new(),
        };

        let stored = store_background_result_if_current(
            &mut current,
            1,
            Path::new("old-library"),
            &old_document,
            &old_result,
        )
        .expect("discard stale result");

        assert!(!stored);
        assert_eq!(current.documents[0].title, "New library title");
        let stale_rows: i64 = current
            .cache
            .query_row(
                "SELECT count(*) FROM document_cache WHERE library_root = 'old-library'",
                [],
                |row| row.get(0),
            )
            .expect("count stale cache rows");
        assert_eq!(stale_rows, 0);
    }

    #[test]
    fn explicit_clear_reclaims_database_pages_and_truncates_wal() {
        let cache_directory = tempdir().expect("temp cache");
        let cache_path = cache_directory.path().join("reade-cache.sqlite3");
        let state = AppState::new(cache_directory.path().to_path_buf()).expect("state");
        {
            let current = state.inner.lock().expect("lock");
            insert_cache_document(
                &current.cache,
                "library",
                "large.md",
                &"x".repeat(2 * 1024 * 1024),
                1,
            );
            current
                .cache
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .expect("materialize cache file");
        }
        let before = fs::metadata(&cache_path).expect("cache before clear").len();

        {
            let mut current = state.inner.lock().expect("lock");
            clear_cache_storage(&mut current.cache).expect("clear cache");
            let remaining: i64 = current
                .cache
                .query_row("SELECT count(*) FROM document_cache", [], |row| row.get(0))
                .expect("count records");
            assert_eq!(remaining, 0);
        }

        let after = fs::metadata(&cache_path).expect("cache after clear").len();
        assert!(after < before, "cache did not shrink: {before} -> {after}");
        let wal_path = cache_sidecar_path(&cache_path, "-wal");
        if wal_path.exists() {
            assert_eq!(fs::metadata(wal_path).expect("WAL metadata").len(), 0);
        }
    }

    #[test]
    fn extracts_titles_and_recognizes_all_reader_formats() {
        assert_eq!(
            extract_title("```md\n# Not title\n```\n# Actual title ##\n"),
            Some("Actual title".to_owned())
        );
        assert_eq!(
            DocumentFormat::from_path(Path::new("book.PDF")),
            Some(DocumentFormat::Pdf)
        );
        assert_eq!(
            DocumentFormat::from_path(Path::new("book.epub")),
            Some(DocumentFormat::Epub)
        );
    }

    #[test]
    fn scan_is_fast_metadata_first_and_cached_search_keeps_locators() {
        let library = tempdir().expect("temp library");
        fs::create_dir_all(library.path().join("guide")).expect("create guide");
        fs::write(
            library.path().join("guide/start.md"),
            "# Getting Started\n\n本地阅读器 supports searchable Markdown.",
        )
        .expect("write markdown");
        fs::write(library.path().join("paper.pdf"), b"%PDF-1.4\n").expect("write pdf");
        fs::write(library.path().join("book.epub"), b"not-a-zip").expect("write epub");
        let root = canonical_library_root(library.path()).expect("canonical root");
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let documents = scan_documents(&root, &mut current.cache).expect("scan");
        assert_eq!(documents.len(), 3);
        assert!(documents
            .iter()
            .any(|document| document.format == DocumentFormat::Pdf));
        assert!(documents
            .iter()
            .any(|document| document.format == DocumentFormat::Epub));

        let markdown = documents
            .iter()
            .find(|document| document.format == DocumentFormat::Markdown)
            .expect("markdown");
        let indexed = index_document_path(&root.join(&markdown.relative_path), markdown)
            .expect("index markdown");
        store_index_result(&mut current.cache, &root, markdown, &indexed).expect("store");
        let results =
            search_index(&current.cache, &normalize_root(&root), "searchable", 10).expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].relative_path, "guide/start.md");
        assert!(results[0].locator.is_none());
    }

    #[test]
    fn like_fallback_treats_wildcards_as_literals() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        current
            .cache
            .execute(
                "INSERT INTO search_segments(
                    library_root, relative_path, title, format, ordinal, content, needs_ocr
                 ) VALUES ('root', 'percent.md', '100%', 'markdown', 0, 'Literal percent', 0)",
                [],
            )
            .expect("insert");
        let results = search_index(&current.cache, "root", "%", 10).expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].relative_path, "percent.md");
    }

    #[test]
    fn document_extents_aggregate_chars_pages_and_ocr_flags_per_library() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        let insert = |root: &str, path: &str, ordinal: u32, content: &str, needs_ocr: i64| {
            current
                .cache
                .execute(
                    "INSERT INTO search_segments(
                         library_root, relative_path, title, format, ordinal, content, needs_ocr
                     ) VALUES (?1, ?2, 't', 'pdf', ?3, ?4, ?5)",
                    params![root, path, ordinal, content, needs_ocr],
                )
                .expect("insert segment");
        };
        // 中文按字符计数(SQLite LENGTH 对 TEXT 数码位):两段共 5 + 4 字符。
        insert("root", "notes/a.md", 0, "中文内容五", 0);
        insert("root", "notes/a.md", 1, "四字正文", 0);
        // 扫描版 PDF:三页里两页 needs_ocr。
        insert("root", "scan.pdf", 0, "", 1);
        insert("root", "scan.pdf", 1, "page text", 0);
        insert("root", "scan.pdf", 2, "", 1);
        // 其他库的段不得串库。
        insert("other", "notes/a.md", 0, "leak", 0);

        let extents = document_extents(&current.cache, "root").expect("extents");
        assert_eq!(
            extents,
            vec![
                DocumentExtent {
                    relative_path: "notes/a.md".to_owned(),
                    char_count: 9,
                    segment_count: 2,
                    needs_ocr_segments: 0,
                },
                DocumentExtent {
                    relative_path: "scan.pdf".to_owned(),
                    char_count: 9,
                    segment_count: 3,
                    needs_ocr_segments: 2,
                },
            ],
        );
        assert!(document_extents(&current.cache, "empty")
            .expect("empty")
            .is_empty());
    }

    // ---- Hover preview (docs/plan-hover-preview.md) ----

    /// Mirrors the numbered contract cases PE01.. in
    /// `src/lib/previewExcerpt.test.ts` (HP-D7): identical inputs must
    /// yield identical excerpts on both ends.
    #[test]
    fn preview_excerpt_contract_cases_match_the_ts_twin() {
        // PE01
        let pe01 = "# Guide Title\n\nSome **bold** text with a [link](./other.md) and `code`.\n\n- item one\n- [x] item two";
        assert_eq!(
            build_preview_excerpt(pe01, None),
            (
                "Guide Title\n\nSome bold text with a link and code.\n\nitem one\nitem two"
                    .to_owned(),
                false
            )
        );
        // PE02
        let pe02 = "# 文档\n\n开头段落。\n\n## 安装步骤\n\n第一步。\n\n## 使用";
        assert_eq!(
            build_preview_excerpt(pe02, Some("安装步骤")),
            ("第一步。\n\n使用".to_owned(), true)
        );
        // PE03
        assert_eq!(
            build_preview_excerpt(
                "## Getting Started\n\nWelcome aboard.",
                Some("getting-started")
            ),
            ("Welcome aboard.".to_owned(), true)
        );
        // PE04
        assert_eq!(
            build_preview_excerpt("# Top\n\nBody text.", Some("missing-section")),
            ("Top\n\nBody text.".to_owned(), false)
        );
        // PE05
        let long = "字".repeat(700);
        let (capped, _) = build_preview_excerpt(&long, None);
        assert_eq!(
            capped,
            format!("{}…", "字".repeat(PREVIEW_EXCERPT_MAX_CHARS))
        );
        assert_eq!(capped.chars().count(), PREVIEW_EXCERPT_MAX_CHARS + 1);
        let exact = "字".repeat(PREVIEW_EXCERPT_MAX_CHARS);
        assert_eq!(build_preview_excerpt(&exact, None).0, exact);
        // PE06
        assert_eq!(build_preview_excerpt("", None), (String::new(), false));
        assert_eq!(
            build_preview_excerpt("  \n\n\t\n", None),
            (String::new(), false)
        );
        // PE07
        let pe07 = "Before fence.\n\n```js\nconst x = 1;\n```\n\nAfter fence.";
        assert_eq!(
            build_preview_excerpt(pe07, None).0,
            "Before fence.\n\nconst x = 1;\n\nAfter fence."
        );
        // PE08
        assert_eq!(
            build_preview_excerpt("\n\n\nFirst para.\n\n\n\nSecond para.\n\n\n", None).0,
            "First para.\n\nSecond para."
        );
        // PE09
        assert_eq!(
            build_preview_excerpt(
                "看 [[notes/目标|别名]] 与 [[另一篇]]，配图 ![替代文本](./img.png)。",
                None
            )
            .0,
            "看 别名 与 另一篇，配图 替代文本。"
        );
        // PE10
        assert_eq!(
            build_preview_excerpt("标题甲\n===\n\n正文。", Some("标题甲")),
            ("标题甲\n\n正文。".to_owned(), false)
        );
        // PE11
        assert_eq!(
            build_preview_excerpt("## 结尾", Some("结尾")),
            (String::new(), true)
        );
    }

    fn preview_document(path: &str, format: DocumentFormat, status: IndexStatus) -> DocumentInfo {
        DocumentInfo {
            relative_path: path.to_owned(),
            title: format!("{path} 标题"),
            size: 1,
            modified: 1,
            format,
            index_status: status,
            index_error: None,
        }
    }

    fn insert_preview_segment(
        connection: &Connection,
        root: &str,
        path: &str,
        format: &str,
        locator: Option<(&str, &str)>,
        ordinal: u32,
        content: &str,
    ) {
        connection
            .execute(
                "INSERT INTO search_segments(
                     library_root, relative_path, title, format, locator_kind, locator_value,
                     ordinal, content, needs_ocr
                 ) VALUES (?1, ?2, 't', ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    root,
                    path,
                    format,
                    locator.map(|pair| pair.0),
                    locator.map(|pair| pair.1),
                    ordinal,
                    content,
                    i64::from(content.trim().is_empty())
                ],
            )
            .expect("insert preview segment");
    }

    #[test]
    fn document_preview_rejects_out_of_scope_paths() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        let documents = vec![preview_document(
            "notes/a.md",
            DocumentFormat::Markdown,
            IndexStatus::Ready,
        )];

        for path in ["../escape.md", "notes/../../escape.md", "/rooted.md", ""] {
            assert!(
                document_preview_for(&current.cache, "root", &documents, path, None).is_err(),
                "path {path:?} must be rejected"
            );
        }
        // In-library shape but absent from the current scan set.
        assert!(
            document_preview_for(&current.cache, "root", &documents, "missing.md", None)
                .unwrap_err()
                .contains("not in the current library")
        );
    }

    #[test]
    fn document_preview_reads_markdown_and_stays_inside_the_library_root() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        let documents = vec![
            preview_document("notes/a.md", DocumentFormat::Markdown, IndexStatus::Ready),
            preview_document(
                "pending.md",
                DocumentFormat::Markdown,
                IndexStatus::Indexing,
            ),
        ];
        insert_preview_segment(
            &current.cache,
            "root",
            "notes/a.md",
            "markdown",
            None,
            0,
            "# 标题\n\n首段内容。\n\n## 细节\n\n细节段。",
        );
        // 另一库同路径的段不得串库。
        insert_preview_segment(
            &current.cache,
            "other",
            "pending.md",
            "markdown",
            None,
            0,
            "泄漏内容",
        );

        let preview = document_preview_for(&current.cache, "root", &documents, "notes/a.md", None)
            .expect("markdown preview");
        assert_eq!(preview.title, "notes/a.md 标题");
        assert_eq!(preview.format, DocumentFormat::Markdown);
        assert_eq!(preview.excerpt, "标题\n\n首段内容。\n\n细节\n\n细节段。");
        assert_eq!(preview.pdf_pages, None);
        assert_eq!(preview.index_status, IndexStatus::Ready);

        let fragment = document_preview_for(
            &current.cache,
            "root",
            &documents,
            "notes/a.md",
            Some("细节"),
        )
        .expect("fragment preview");
        assert_eq!(fragment.excerpt, "细节段。");

        // Segments only exist under the other root: the excerpt must stay
        // empty and the status comes from the scan set.
        let isolated = document_preview_for(&current.cache, "root", &documents, "pending.md", None)
            .expect("isolated preview");
        assert_eq!(isolated.excerpt, "");
        assert_eq!(isolated.index_status, IndexStatus::Indexing);
    }

    #[test]
    fn document_preview_resolves_pdf_pages_and_epub_chapters() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        let documents = vec![
            preview_document("scan.pdf", DocumentFormat::Pdf, IndexStatus::Partial),
            preview_document("book.epub", DocumentFormat::Epub, IndexStatus::Ready),
        ];
        insert_preview_segment(
            &current.cache,
            "root",
            "scan.pdf",
            "pdf",
            Some(("pdfPage", "1")),
            0,
            "",
        );
        insert_preview_segment(
            &current.cache,
            "root",
            "scan.pdf",
            "pdf",
            Some(("pdfPage", "2")),
            1,
            "第二页文本。",
        );
        insert_preview_segment(
            &current.cache,
            "root",
            "scan.pdf",
            "pdf",
            Some(("pdfPage", "3")),
            2,
            "第三页文本。",
        );
        insert_preview_segment(
            &current.cache,
            "root",
            "book.epub",
            "epub",
            Some(("epubChapter", "chapter-1")),
            0,
            "第一章正文。",
        );
        insert_preview_segment(
            &current.cache,
            "root",
            "book.epub",
            "epub",
            Some(("epubChapter", "chapter-2")),
            1,
            "第二章正文。",
        );

        // No fragment: the empty page 1 is skipped for the first textual page.
        let pdf = document_preview_for(&current.cache, "root", &documents, "scan.pdf", None)
            .expect("pdf preview");
        assert_eq!(pdf.excerpt, "第二页文本。");
        assert_eq!(pdf.pdf_pages, Some(3));
        assert_eq!(pdf.index_status, IndexStatus::Partial);

        // Page fragment picks the exact page; unknown pages fall back.
        let page3 = document_preview_for(&current.cache, "root", &documents, "scan.pdf", Some("3"))
            .expect("pdf page preview");
        assert_eq!(page3.excerpt, "第三页文本。");
        let missing =
            document_preview_for(&current.cache, "root", &documents, "scan.pdf", Some("99"))
                .expect("pdf fallback preview");
        assert_eq!(missing.excerpt, "第二页文本。");

        let epub = document_preview_for(&current.cache, "root", &documents, "book.epub", None)
            .expect("epub preview");
        assert_eq!(epub.excerpt, "第一章正文。");
        let chapter = document_preview_for(
            &current.cache,
            "root",
            &documents,
            "book.epub",
            Some("chapter-2"),
        )
        .expect("epub chapter preview");
        assert_eq!(chapter.excerpt, "第二章正文。");
        let unknown_chapter = document_preview_for(
            &current.cache,
            "root",
            &documents,
            "book.epub",
            Some("chapter-9"),
        )
        .expect("epub fallback preview");
        assert_eq!(unknown_chapter.excerpt, "第一章正文。");
    }

    #[test]
    fn pdf_range_reads_are_bounded_and_reject_crossing_eof() {
        let library = tempdir().expect("temp library");
        fs::write(library.path().join("sample.pdf"), b"%PDF-1.7\n0123456789").expect("write pdf");
        fs::write(library.path().join("note.md"), b"not a pdf").expect("write note");
        let root = canonical_library_root(library.path()).expect("canonical root");
        // PDF.js 把每段 range 的终点钳制到 transport length（打开时的文件
        // 大小）；因此跨越 EOF 的请求只可能是文件缩短，按 D06 契约报
        // 稳定错误而不是悄悄截短。
        assert!(read_pdf_range_from_root(&root, "sample.pdf", 9, 50).is_err());
        assert_eq!(
            read_pdf_range_from_root(&root, "sample.pdf", 9, 10).expect("tail range"),
            b"0123456789"
        );
        assert!(read_pdf_range_from_root(&root, "sample.pdf", 0, 0).is_err());
        assert!(read_pdf_range_from_root(&root, "sample.pdf", 0, MAX_RANGE_BYTES + 1).is_err());
        assert!(read_pdf_range_from_root(&root, "sample.pdf", 99, 1).is_err());
        assert!(read_pdf_range_from_root(&root, "note.md", 0, 1).is_err());
    }

    #[test]
    fn changed_files_invalidate_cached_segments() {
        let library = tempdir().expect("temp library");
        let path = library.path().join("note.md");
        fs::write(&path, "# First\nold searchable content").expect("write first");
        let root = canonical_library_root(library.path()).expect("canonical root");
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let first = scan_documents(&root, &mut current.cache).expect("first scan");
        let indexed = index_document_path(&path, &first[0]).expect("index");
        store_index_result(&mut current.cache, &root, &first[0], &indexed).expect("store");
        assert_eq!(
            search_index(&current.cache, &normalize_root(&root), "old searchable", 10)
                .expect("search")
                .len(),
            1
        );

        fs::write(&path, "# Second\nreplacement text with a different length").expect("rewrite");
        let second = scan_documents(&root, &mut current.cache).expect("second scan");
        assert_eq!(second[0].index_status, IndexStatus::Pending);
        assert!(
            search_index(&current.cache, &normalize_root(&root), "old searchable", 10)
                .expect("stale search")
                .is_empty()
        );
    }

    #[test]
    fn oversized_pdf_is_native_view_only() {
        let info = DocumentInfo {
            relative_path: "large.pdf".to_owned(),
            title: "Large".to_owned(),
            size: MAX_CONVERTIBLE_BYTES + 1,
            modified: 0,
            format: DocumentFormat::Pdf,
            index_status: IndexStatus::Pending,
            index_error: None,
        };
        let indexed = index_pdf(Path::new("file-does-not-need-to-exist.pdf"), &info)
            .expect("size is rejected before reading");
        assert_eq!(indexed.status, IndexStatus::Unsupported);
        assert!(indexed.segments.is_empty());
    }

    #[test]
    fn pdf_text_is_indexed_with_one_based_page_locator() {
        let library = tempdir().expect("temp library");
        let path = library.path().join("searchable.pdf");
        write_text_pdf(&path, "Reade PDF searchable page content");
        let metadata = fs::metadata(&path).expect("metadata");
        let info = DocumentInfo {
            relative_path: "searchable.pdf".to_owned(),
            title: "searchable".to_owned(),
            size: metadata.len(),
            modified: modified_millis(&metadata),
            format: DocumentFormat::Pdf,
            index_status: IndexStatus::Pending,
            index_error: None,
        };
        let indexed = index_pdf(&path, &info).expect("index PDF fixture");
        assert_eq!(indexed.segments.len(), 1);
        assert_eq!(indexed.segments[0].locator_value.as_deref(), Some("1"));
        assert!(indexed.segments[0].content.contains("searchable"));
    }

    #[test]
    fn conversion_cache_clear_and_soft_limit_leave_the_legacy_annotation_table_alone() {
        // The legacy cache-resident annotations table is frozen (annotations
        // now live in reade-user.sqlite3) but must survive cache maintenance
        // untouched until its scheduled removal, because it doubles as the
        // rescue-migration source and fallback.
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let root = PathBuf::from("annot-library");
        let root_key = normalize_root(&root);
        current
            .cache
            .execute(
                "INSERT INTO annotations(
                     id, library_root, relative_path, kind, color, note, selected_text, title,
                     locator_json, created_at, updated_at
                 ) VALUES ('ann-legacy', ?1, 'notes/a.md', 'highlight', 'yellow', NULL, 'hello',
                           NULL, '{}', 100, 100)",
                params![root_key],
            )
            .expect("insert legacy annotation row");

        insert_cache_document(&current.cache, &root_key, "notes/a.md", "body", 1);
        insert_cache_document(
            &current.cache,
            "other-library",
            "old.md",
            &"x".repeat(1024 * 1024),
            2,
        );
        clear_cache_storage(&mut current.cache).expect("clear conversion cache");
        enforce_cache_soft_limit_with_limits(&mut current.cache, &root, 64 * 1024, 57 * 1024)
            .expect("enforce soft limit");

        let kept: i64 = current
            .cache
            .query_row("SELECT count(*) FROM annotations", [], |row| row.get(0))
            .expect("count legacy annotations");
        assert_eq!(kept, 1);
    }

    // ---- Document links (docs/plan-backlinks.md B1) ----

    fn markdown_info(relative_path: &str, title: &str) -> DocumentInfo {
        DocumentInfo {
            relative_path: relative_path.to_owned(),
            title: title.to_owned(),
            size: 1,
            modified: 1,
            format: DocumentFormat::Markdown,
            index_status: IndexStatus::Ready,
            index_error: None,
        }
    }

    fn store_links_fixture(
        connection: &mut Connection,
        root: &Path,
        info: &DocumentInfo,
        links: Vec<ExtractedLink>,
    ) {
        let indexed = IndexedDocument {
            title: info.title.clone(),
            status: IndexStatus::Ready,
            error: None,
            segments: Vec::new(),
            links,
        };
        store_index_result(connection, root, info, &indexed).expect("store links fixture");
    }

    fn relative_link(
        target: &str,
        kind: crate::links::LinkTargetKind,
        text: &str,
    ) -> ExtractedLink {
        ExtractedLink::Relative {
            target_path: target.to_owned(),
            target_kind: kind,
            link_text: text.to_owned(),
            fragment: None,
        }
    }

    fn wiki_link(stem: &str, text: &str) -> ExtractedLink {
        ExtractedLink::Wiki {
            stem: stem.to_owned(),
            link_text: text.to_owned(),
            fragment: None,
        }
    }

    fn count_source_links(connection: &Connection, root: &str, source: &str) -> i64 {
        connection
            .query_row(
                "SELECT count(*) FROM document_links
                 WHERE library_root = ?1 AND source_path = ?2",
                params![root, source],
                |row| row.get(0),
            )
            .expect("count link rows")
    }

    #[test]
    fn markdown_indexing_writes_link_rows_and_invalidation_clears_them() {
        let library = tempdir().expect("temp library");
        fs::create_dir_all(library.path().join("notes")).expect("create notes");
        let source = library.path().join("notes/source.md");
        fs::write(
            &source,
            "[a](sibling.md)\n[b](../top.md)\n[c](/abs/root.md)\n![img](assets/pic.png)\n\
             [[Wiki Note]]\n[gone](missing.md)\n[ext](https://example.com/x.md)\n\
             [esc](../../out.md)\n",
        )
        .expect("write source");
        fs::write(library.path().join("notes/sibling.md"), "# Sibling").expect("write sibling");
        fs::write(library.path().join("top.md"), "# Top").expect("write top");
        let root = canonical_library_root(library.path()).expect("canonical root");
        let root_key = normalize_root(&root);
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");

        let documents = scan_documents(&root, &mut current.cache).expect("scan");
        let info = documents
            .iter()
            .find(|document| document.relative_path == "notes/source.md")
            .expect("source scanned")
            .clone();
        let indexed =
            index_document_path(&root.join("notes/source.md"), &info).expect("index source");
        store_index_result(&mut current.cache, &root, &info, &indexed).expect("store");

        // Six library links survive extraction; the external and the
        // escaping targets are dropped before storage.
        let rows: Vec<(String, Option<String>, Option<String>, String)> = {
            let mut statement = current
                .cache
                .prepare(
                    "SELECT link_kind, target_path, wiki_stem, target_kind
                     FROM document_links
                     WHERE library_root = ?1 AND source_path = 'notes/source.md'
                     ORDER BY ordinal ASC",
                )
                .expect("prepare rows");
            let mapped = statement
                .query_map(params![root_key], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .expect("query rows");
            mapped
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("decode rows")
        };
        assert_eq!(
            rows,
            vec![
                (
                    "relative".to_owned(),
                    Some("notes/sibling.md".to_owned()),
                    None,
                    "document".to_owned()
                ),
                (
                    "relative".to_owned(),
                    Some("top.md".to_owned()),
                    None,
                    "document".to_owned()
                ),
                (
                    "relative".to_owned(),
                    Some("abs/root.md".to_owned()),
                    None,
                    "document".to_owned()
                ),
                (
                    "relative".to_owned(),
                    Some("notes/assets/pic.png".to_owned()),
                    None,
                    "asset".to_owned()
                ),
                (
                    "wiki".to_owned(),
                    None,
                    Some("wiki note".to_owned()),
                    "document".to_owned()
                ),
                (
                    "relative".to_owned(),
                    Some("notes/missing.md".to_owned()),
                    None,
                    "document".to_owned()
                ),
            ]
        );

        // Rewriting the file invalidates the cache row; re-indexing
        // replaces the link rows in the same transaction.
        fs::write(&source, "[only](sibling.md)\n").expect("rewrite source");
        let rescanned = scan_documents(&root, &mut current.cache).expect("rescan");
        let info = rescanned
            .iter()
            .find(|document| document.relative_path == "notes/source.md")
            .expect("source rescanned")
            .clone();
        assert_eq!(info.index_status, IndexStatus::Pending);
        assert_eq!(
            count_source_links(&current.cache, &root_key, "notes/source.md"),
            0
        );
        let indexed =
            index_document_path(&root.join("notes/source.md"), &info).expect("reindex source");
        store_index_result(&mut current.cache, &root, &info, &indexed).expect("restore");
        assert_eq!(
            count_source_links(&current.cache, &root_key, "notes/source.md"),
            1
        );

        // A deleted source loses its rows during the next scan cleanup.
        fs::remove_file(&source).expect("delete source");
        scan_documents(&root, &mut current.cache).expect("cleanup scan");
        assert_eq!(
            count_source_links(&current.cache, &root_key, "notes/source.md"),
            0
        );

        // clear_cache_storage drops every link row.
        store_links_fixture(
            &mut current.cache,
            &root,
            &markdown_info("notes/sibling.md", "Sibling"),
            vec![relative_link(
                "top.md",
                crate::links::LinkTargetKind::Document,
                "t",
            )],
        );
        clear_cache_storage(&mut current.cache).expect("clear conversion cache");
        let remaining: i64 = current
            .cache
            .query_row("SELECT count(*) FROM document_links", [], |row| row.get(0))
            .expect("count all links");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn document_links_table_is_added_to_existing_caches_without_a_version_bump() {
        let cache_directory = tempdir().expect("temp cache");
        {
            let state = AppState::new(cache_directory.path().to_path_buf()).expect("create");
            let current = state.inner.lock().expect("lock");
            current
                .cache
                .execute_batch(
                    "DROP INDEX document_links_by_source;
                     DROP INDEX document_links_by_target;
                     DROP INDEX document_links_by_stem;
                     DROP TABLE document_links;",
                )
                .expect("simulate a pre-links cache");
        }
        // Reopening the same versioned cache recreates the table instead of
        // rebuilding the file (the schema version did not change).
        let state = AppState::new(cache_directory.path().to_path_buf()).expect("reopen");
        let current = state.inner.lock().expect("lock");
        assert_eq!(
            cache_pragma_i64(&current.cache, "user_version").expect("version"),
            CACHE_SCHEMA_VERSION
        );
        let tables: i64 = current
            .cache
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'document_links'",
                [],
                |row| row.get(0),
            )
            .expect("inspect schema");
        assert_eq!(tables, 1);
    }

    #[test]
    fn document_links_are_scoped_per_library_root_and_eviction_removes_them() {
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let active_root = PathBuf::from("active-library");
        let stale_root = PathBuf::from("stale-library");
        let info = markdown_info("a.md", "A");
        store_links_fixture(
            &mut current.cache,
            &active_root,
            &info,
            vec![relative_link(
                "b.md",
                crate::links::LinkTargetKind::Document,
                "b",
            )],
        );
        store_links_fixture(
            &mut current.cache,
            &stale_root,
            &info,
            vec![relative_link(
                "b.md",
                crate::links::LinkTargetKind::Document,
                "b",
            )],
        );

        let documents = vec![markdown_info("a.md", "A"), markdown_info("b.md", "B")];
        let links = document_links_for(
            &current.cache,
            &normalize_root(&active_root),
            &documents,
            "b.md",
        )
        .expect("links for active root");
        assert_eq!(links.backlinks.len(), 1);

        // Evicting the stale library's document also drops its link rows.
        clear_cached_document_by_key(&mut current.cache, &normalize_root(&stale_root), "a.md")
            .expect("evict");
        assert_eq!(
            count_source_links(&current.cache, &normalize_root(&stale_root), "a.md"),
            0
        );
        assert_eq!(
            count_source_links(&current.cache, &normalize_root(&active_root), "a.md"),
            1
        );
    }

    #[test]
    fn list_document_links_aggregates_backlinks_wiki_resolution_and_broken_counts() {
        use crate::links::LinkTargetKind;

        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let root = PathBuf::from("library");
        let root_key = normalize_root(&root);

        store_links_fixture(
            &mut current.cache,
            &root,
            &markdown_info("a.md", "文档 A"),
            vec![
                relative_link("notes/target.md", LinkTargetKind::Document, "去目标"),
                relative_link("notes/target.md", LinkTargetKind::Document, "再一次"),
                wiki_link("target", "wiki 指向"),
            ],
        );
        store_links_fixture(
            &mut current.cache,
            &root,
            &markdown_info("b.md", "文档 B"),
            vec![wiki_link("target", "另一个 wiki")],
        );
        store_links_fixture(
            &mut current.cache,
            &root,
            &markdown_info("c.md", "文档 C"),
            vec![
                relative_link("missing.md", LinkTargetKind::Document, "断链"),
                relative_link("img.png", LinkTargetKind::Asset, "图"),
                wiki_link("nowhere", "无目标"),
                wiki_link("dup", "歧义"),
            ],
        );

        let documents = vec![
            markdown_info("notes/target.md", "目标"),
            markdown_info("a.md", "文档 A"),
            markdown_info("b.md", "文档 B"),
            markdown_info("c.md", "文档 C"),
            markdown_info("x/Dup.md", "副本一"),
            markdown_info("y/DUP.md", "副本二"),
        ];

        // Backlinks: direct targets aggregate per source, the unique wiki
        // stem "target" builds edges, case-insensitively.
        let links = document_links_for(&current.cache, &root_key, &documents, "notes/target.md")
            .expect("target links");
        assert_eq!(
            links.backlinks,
            vec![
                BacklinkEntry {
                    source_path: "a.md".to_owned(),
                    source_title: "文档 A".to_owned(),
                    link_text: "去目标".to_owned(),
                    count: 3,
                },
                BacklinkEntry {
                    source_path: "b.md".to_owned(),
                    source_title: "文档 B".to_owned(),
                    link_text: "另一个 wiki".to_owned(),
                    count: 1,
                },
            ]
        );
        assert!(links.outgoing.is_empty());
        assert_eq!(links.broken_count, 0);

        // Outgoing: missing document counts as broken, assets never do,
        // unresolved wiki stems count, ambiguous stems do not build edges.
        let links =
            document_links_for(&current.cache, &root_key, &documents, "c.md").expect("c links");
        assert_eq!(
            links.outgoing,
            vec![
                OutgoingEntry {
                    kind: "document".to_owned(),
                    target_path: Some("missing.md".to_owned()),
                    raw_target: "missing.md".to_owned(),
                    link_text: "断链".to_owned(),
                    present: false,
                    ambiguous_count: 0,
                },
                OutgoingEntry {
                    kind: "asset".to_owned(),
                    target_path: Some("img.png".to_owned()),
                    raw_target: "img.png".to_owned(),
                    link_text: "图".to_owned(),
                    present: false,
                    ambiguous_count: 0,
                },
                OutgoingEntry {
                    kind: "wiki".to_owned(),
                    target_path: None,
                    raw_target: "nowhere".to_owned(),
                    link_text: "无目标".to_owned(),
                    present: false,
                    ambiguous_count: 0,
                },
                OutgoingEntry {
                    kind: "wiki".to_owned(),
                    target_path: None,
                    raw_target: "dup".to_owned(),
                    link_text: "歧义".to_owned(),
                    present: false,
                    ambiguous_count: 2,
                },
            ]
        );
        assert_eq!(links.broken_count, 2);

        // Removing one duplicate from the scan snapshot resolves the
        // ambiguity in the very next query — no re-indexing involved.
        let disambiguated: Vec<DocumentInfo> = documents
            .iter()
            .filter(|document| document.relative_path != "y/DUP.md")
            .cloned()
            .collect();
        let links = document_links_for(&current.cache, &root_key, &disambiguated, "c.md")
            .expect("c links after disambiguation");
        let dup_entry = links
            .outgoing
            .iter()
            .find(|entry| entry.raw_target == "dup")
            .expect("dup entry");
        assert_eq!(dup_entry.target_path.as_deref(), Some("x/Dup.md"));
        assert!(dup_entry.present);
        assert_eq!(dup_entry.ambiguous_count, 0);

        // The wiki backlink direction follows the same unique-stem rule.
        let links = document_links_for(&current.cache, &root_key, &disambiguated, "x/Dup.md")
            .expect("dup backlinks");
        assert_eq!(links.backlinks.len(), 1);
        assert_eq!(links.backlinks[0].source_path, "c.md");

        // Path validation matches every other command.
        assert!(document_links_for(&current.cache, &root_key, &documents, "../out.md").is_err());
        assert!(document_links_for(&current.cache, &root_key, &documents, "C:/abs.md").is_err());
        assert!(document_links_for(&current.cache, &root_key, &documents, " ").is_err());
    }

    /// Pins the serde camelCase wire shape the TS `DocumentLinks` type in
    /// `src/lib/documentLinks.ts` (re-exported by `backend.ts`) relies on.
    #[test]
    fn document_links_serialize_camel_case_for_the_frontend() {
        let links = DocumentLinks {
            backlinks: vec![BacklinkEntry {
                source_path: "a.md".to_owned(),
                source_title: "A".to_owned(),
                link_text: "t".to_owned(),
                count: 2,
            }],
            outgoing: vec![OutgoingEntry {
                kind: "wiki".to_owned(),
                target_path: None,
                raw_target: "stem".to_owned(),
                link_text: "t".to_owned(),
                present: false,
                ambiguous_count: 2,
            }],
            broken_count: 1,
        };
        assert_eq!(
            serde_json::to_value(&links).expect("serialize document links"),
            serde_json::json!({
                "backlinks": [{
                    "sourcePath": "a.md",
                    "sourceTitle": "A",
                    "linkText": "t",
                    "count": 2
                }],
                "outgoing": [{
                    "kind": "wiki",
                    "targetPath": null,
                    "rawTarget": "stem",
                    "linkText": "t",
                    "present": false,
                    "ambiguousCount": 2
                }],
                "brokenCount": 1
            })
        );
    }

    #[test]
    fn list_document_links_stays_fast_on_a_synthetic_link_graph() {
        // Plan B1 budget: 2,000 documents × 10 links, one lookup well under
        // 50ms; the assertion bound is deliberately loose for CI noise.
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let root = PathBuf::from("perf-library");
        let root_key = normalize_root(&root);
        let mut documents = vec![markdown_info("hub.md", "Hub")];
        {
            let transaction = current.cache.transaction().expect("begin");
            {
                let mut insert = transaction
                    .prepare(
                        "INSERT INTO document_links(
                             library_root, source_path, link_kind, target_path, wiki_stem,
                             target_kind, link_text, fragment, ordinal
                         ) VALUES (?1, ?2, 'relative', ?3, NULL, 'document', 't', NULL, ?4)",
                    )
                    .expect("prepare insert");
                for document_index in 0..2_000 {
                    let source = format!("docs/doc-{document_index}.md");
                    for ordinal in 0..10 {
                        let target = if ordinal == 0 {
                            "hub.md".to_owned()
                        } else {
                            format!("docs/doc-{}.md", (document_index + ordinal) % 2_000)
                        };
                        insert
                            .execute(params![root_key, source, target, ordinal as u32])
                            .expect("insert link");
                    }
                }
            }
            transaction.commit().expect("commit");
        }
        for document_index in 0..2_000 {
            documents.push(markdown_info(
                &format!("docs/doc-{document_index}.md"),
                &format!("Doc {document_index}"),
            ));
        }

        let start = Instant::now();
        let links =
            document_links_for(&current.cache, &root_key, &documents, "hub.md").expect("hub links");
        let elapsed = start.elapsed();
        assert_eq!(links.backlinks.len(), LINKS_LIST_LIMIT);
        assert_eq!(links.backlinks[0].count, 1);
        assert!(
            elapsed < Duration::from_millis(250),
            "list_document_links took {elapsed:?}"
        );
    }

    // ---- Related passages (docs/plan-related-passages.md P0/P1) ----
    //
    // The fragment expectations mirror the shared contract case table
    // F01..F13 in src/lib/relatedFragments.test.ts; keep both in sync.

    #[test]
    fn related_fragment_extraction_matches_the_shared_contract_cases() {
        // F01: a 24-char CJK run slices into three 8-char windows.
        let long_run = "控制系统的稳定性分析需要考虑相位裕度与增益裕度";
        assert_eq!(long_run.chars().count(), 23);
        let padded = format!("{long_run}一");
        assert_eq!(
            extract_related_fragments(&padded),
            vec!["控制系统的稳定性", "分析需要考虑相位", "裕度与增益裕度一"]
        );
        // F02: CJK punctuation splits runs.
        assert_eq!(
            extract_related_fragments("时域响应，频域响应；根轨迹"),
            vec!["时域响应", "频域响应", "根轨迹"]
        );
        // F03: mixed CJK and English runs, length-descending.
        assert_eq!(
            extract_related_fragments("傅里叶变换 Fourier transform 基础知识"),
            vec!["transform", "Fourier", "傅里叶变换", "基础知识"]
        );
        // F04: newlines and spaces produce identical fragments.
        assert_eq!(
            extract_related_fragments("foo\nbar baz"),
            extract_related_fragments("foo bar baz")
        );
        // F05/F06: punctuation-only and whitespace-only input is empty.
        assert!(extract_related_fragments("，。！？…—·「」").is_empty());
        assert!(extract_related_fragments(" \t\r\n ").is_empty());
        // F07: fragments below three characters are dropped.
        assert!(extract_related_fragments("ab cd 你好 ok").is_empty());
        // F08: case-insensitive dedupe keeps the first casing.
        assert_eq!(
            extract_related_fragments("Fourier fourier FOURIER"),
            vec!["Fourier"]
        );
        // F09: length-descending order, original position breaks ties.
        assert_eq!(
            extract_related_fragments("alpha beta gamma delta epsilon zeta theta1"),
            vec!["epsilon", "theta1", "alpha", "gamma", "delta", "beta"]
        );
        // F10: input beyond 2,000 characters is ignored.
        let mut oversized = "填".repeat(1_997);
        oversized.push_str("尾巴 marker-fragment");
        let fragments = extract_related_fragments(&oversized);
        assert!(fragments
            .iter()
            .all(|fragment| fragment != "marker-fragment"));
        // F11: FTS syntax stays literal (quotes are delimiters and never
        // survive into fragments); `OR` itself is too short to remain.
        assert_eq!(
            extract_related_fragments("alpha \"beta\" OR NEAR(gamma) *star*"),
            vec!["alpha", "gamma", "beta", "NEAR", "star"]
        );
        // F12: a 12-char run stays whole, a 13-char run slices into 8 + 5.
        assert_eq!(
            extract_related_fragments("这一段恰好十二个字符长度"),
            vec!["这一段恰好十二个字符长度"]
        );
        assert_eq!(
            extract_related_fragments("这一段共有十三个字符长度啊"),
            vec!["这一段共有十三个", "字符长度啊"]
        );
        // F13: a slice remainder below three characters is dropped.
        let seventeen = "一二三四五六七八九十甲乙丙丁戊己庚";
        assert_eq!(seventeen.chars().count(), 17);
        assert_eq!(
            extract_related_fragments(seventeen),
            vec!["一二三四五六七八", "九十甲乙丙丁戊己"]
        );
    }

    #[test]
    fn build_related_match_quotes_fragments_and_escapes_inner_quotes() {
        assert_eq!(build_related_match(&[]), None);
        assert_eq!(
            build_related_match(&["傅里叶变换".to_owned(), "frequency".to_owned()]).as_deref(),
            Some("\"傅里叶变换\" OR \"frequency\"")
        );
        // Defense in depth: fragments can never contain quotes (they are
        // delimiters), but a hand-made one is still escaped by doubling.
        assert_eq!(
            build_related_match(&["a\"b".to_owned()]).as_deref(),
            Some("\"a\"\"b\"")
        );
    }

    // The parameter list mirrors the segment columns on purpose.
    #[allow(clippy::too_many_arguments)]
    fn insert_related_segment(
        connection: &Connection,
        root: &str,
        relative_path: &str,
        title: &str,
        format: &str,
        locator_kind: Option<&str>,
        locator_value: Option<&str>,
        ordinal: u32,
        content: &str,
    ) {
        connection
            .execute(
                "INSERT INTO search_segments(
                     library_root, relative_path, title, format, locator_kind, locator_value,
                     ordinal, content, needs_ocr
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)",
                params![
                    root,
                    relative_path,
                    title,
                    format,
                    locator_kind,
                    locator_value,
                    ordinal,
                    content
                ],
            )
            .expect("insert related segment");
    }

    #[test]
    fn related_passages_hit_all_formats_exclude_self_and_stay_literal() {
        let state = AppState::in_memory().expect("state");
        let current = state.inner.lock().expect("lock");
        let root = "related-library";
        insert_related_segment(
            &current.cache,
            root,
            "notes/alpha.md",
            "Alpha",
            "markdown",
            None,
            None,
            0,
            "傅里叶变换将时域信号映射到频域进行分析，是频谱方法的基础。",
        );
        insert_related_segment(
            &current.cache,
            root,
            "papers/beta.pdf",
            "Beta",
            "pdf",
            Some("pdfPage"),
            Some("3"),
            2,
            "第三页同样讨论傅里叶变换将时域信号映射到频域的推导细节。",
        );
        insert_related_segment(
            &current.cache,
            root,
            "books/gamma.epub",
            "Gamma",
            "epub",
            Some("epubChapter"),
            Some("OEBPS/ch1.xhtml"),
            1,
            "本章仅提到映射到频域这一个说法，与其余片段无关。",
        );
        insert_related_segment(
            &current.cache,
            root,
            "notes/self.md",
            "Self",
            "markdown",
            None,
            None,
            0,
            "傅里叶变换将时域信号映射到频域进行分析。",
        );
        insert_related_segment(
            &current.cache,
            root,
            "notes/other.md",
            "Other",
            "markdown",
            None,
            None,
            0,
            "毫无关系的内容，讲的是园艺技巧与浇水频率。",
        );
        insert_related_segment(
            &current.cache,
            "other-root",
            "iso.md",
            "Iso",
            "markdown",
            None,
            None,
            0,
            "傅里叶变换将时域信号映射到频域进行分析。",
        );

        // The selection contains a newline exactly where the indexed text
        // has none — run splitting keeps the fragments matchable.
        let results = related_passages_index(
            &current.cache,
            root,
            "傅里叶变换将时域信号\n映射到频域",
            Some("notes/self.md"),
            12,
        )
        .expect("related search");
        let paths: Vec<&str> = results
            .iter()
            .map(|result| result.relative_path.as_str())
            .collect();
        assert!(paths.contains(&"notes/alpha.md"));
        assert!(paths.contains(&"papers/beta.pdf"));
        assert!(paths.contains(&"books/gamma.epub"));
        assert!(!paths.contains(&"notes/self.md"), "self is excluded");
        assert!(!paths.contains(&"notes/other.md"));
        assert!(!paths.contains(&"iso.md"), "other roots are isolated");

        // Locators and result ids keep the search_documents shape.
        let beta = results
            .iter()
            .find(|result| result.relative_path == "papers/beta.pdf")
            .expect("pdf hit");
        assert_eq!(beta.locator, Some(SearchLocator::PdfPage { page: 3 }));
        assert_eq!(beta.result_id, "papers/beta.pdf:pdfPage:3");
        let gamma = results
            .iter()
            .find(|result| result.relative_path == "books/gamma.epub")
            .expect("epub hit");
        assert_eq!(
            gamma.locator,
            Some(SearchLocator::EpubChapter {
                chapter_id: "OEBPS/ch1.xhtml".to_owned()
            })
        );
        let alpha = results
            .iter()
            .find(|result| result.relative_path == "notes/alpha.md")
            .expect("markdown hit");
        assert!(alpha.locator.is_none());

        // Multi-fragment hits outrank single-fragment hits (bm25 order).
        let alpha_rank = paths.iter().position(|path| *path == "notes/alpha.md");
        let gamma_rank = paths.iter().position(|path| *path == "books/gamma.epub");
        assert!(alpha_rank < gamma_rank, "ranks: {paths:?}");

        // English selections work the same way.
        insert_related_segment(
            &current.cache,
            root,
            "notes/en.md",
            "English",
            "markdown",
            None,
            None,
            0,
            "The Fourier transform maps time-domain signals into the frequency domain.",
        );
        let english = related_passages_index(
            &current.cache,
            root,
            "Fourier transform maps time-domain signals",
            None,
            12,
        )
        .expect("english search");
        assert!(english
            .iter()
            .any(|result| result.relative_path == "notes/en.md"));

        // FTS operators inside the selection stay literal instead of
        // erroring or matching everything.
        insert_related_segment(
            &current.cache,
            root,
            "notes/near.md",
            "Near",
            "markdown",
            None,
            None,
            0,
            "the NEAR keyword appears here as plain text",
        );
        let literal = related_passages_index(
            &current.cache,
            root,
            "NEAR(alpha) AND *star* \"quoted\"",
            None,
            12,
        )
        .expect("literal search");
        assert!(literal
            .iter()
            .any(|result| result.relative_path == "notes/near.md"));
        assert!(!literal
            .iter()
            .any(|result| result.relative_path == "notes/other.md"));

        // Limits clamp to 1..=50; a zero limit still returns one row.
        let clamped = related_passages_index(
            &current.cache,
            root,
            "傅里叶变换将时域信号映射到频域",
            None,
            0,
        )
        .expect("clamped search");
        assert_eq!(clamped.len(), 1);

        // Selections that normalize to nothing return empty without
        // touching FTS; traversal in exclude_path is rejected.
        assert!(
            related_passages_index(&current.cache, root, "，。！？", None, 12)
                .expect("empty fragments")
                .is_empty()
        );
        assert!(related_passages_index(&current.cache, root, "ab", None, 12)
            .expect("short input")
            .is_empty());
        assert!(
            related_passages_index(&current.cache, root, "傅里叶变换", Some("../x.md"), 12)
                .is_err()
        );
    }

    #[test]
    fn related_passages_meet_the_synthetic_performance_budget() {
        // Plan §3.5: 5,000 segments of ~2 KiB, one query under 500ms.
        let state = AppState::in_memory().expect("state");
        let mut current = state.inner.lock().expect("lock");
        let root = "perf-root";
        let needle = "控制系统稳定性分析方法与频率响应设计准则";
        let filler =
            "这里是一段用于填充的正文，讨论一般性的阅读器实现细节与文档渲染问题。".repeat(20);
        {
            let transaction = current.cache.transaction().expect("begin");
            {
                let mut insert = transaction
                    .prepare(
                        "INSERT INTO search_segments(
                             library_root, relative_path, title, format, locator_kind,
                             locator_value, ordinal, content, needs_ocr
                         ) VALUES (?1, ?2, ?3, 'markdown', NULL, NULL, 0, ?4, 0)",
                    )
                    .expect("prepare insert");
                for index in 0..5_000 {
                    let path = format!("docs/doc-{index}.md");
                    let content = if index % 20 == 0 {
                        format!("{filler}{needle}{filler}")
                    } else {
                        filler.clone()
                    };
                    insert
                        .execute(params![root, path, format!("Doc {index}"), content])
                        .expect("insert segment");
                }
            }
            transaction.commit().expect("commit");
        }

        let start = Instant::now();
        let results = related_passages_index(
            &current.cache,
            root,
            "控制系统稳定性分析方法\n与频率响应设计准则",
            None,
            12,
        )
        .expect("perf search");
        let elapsed = start.elapsed();
        assert_eq!(results.len(), 12);
        assert!(
            elapsed < Duration::from_millis(500),
            "related query took {elapsed:?}"
        );
    }

    // ---- D09: 锁外扫描与专用缓存连接 ----

    /// 扫描经专用连接完成（不持状态锁）：扫描从该连接读缓存（命中已
    /// 索引文档的标题），并经该连接清除已消失文件的陈旧行——两件事都
    /// 对主连接可见（WAL 跨连接读写已提交数据）。
    #[test]
    fn scan_connection_reconciles_cache_rows_visible_to_the_state() {
        let dir = tempdir().expect("temp dir");
        fs::write(dir.path().join("guide.md"), "# Test\n\nScan body").expect("seed md");
        let state = AppState::file_backed(dir.path()).expect("file-backed state");
        let root = canonical_library_root(dir.path()).expect("root");
        let root_key = normalize_root(&root);

        // 预置缓存：guide.md 已索引（标题/size/modified 与真实文件一致，
        // 否则按指纹失效），ghost.md 已消失。
        let metadata = fs::metadata(dir.path().join("guide.md")).expect("metadata");
        let (file_size, file_modified) = (metadata.len(), modified_millis(&metadata));
        {
            let current = state.inner.lock().expect("lock");
            current
                .cache
                .execute(
                    "INSERT INTO document_cache(
                         library_root, relative_path, title, format, source_size,
                         source_modified, converter_revision, status, error, last_accessed
                     ) VALUES (?1, 'guide.md', 'Cached Title', 'markdown', ?2, ?3,
                               ?4, 'ready', NULL, 1)",
                    params![
                        root_key,
                        file_size,
                        file_modified as i64,
                        CONVERTER_REVISION
                    ],
                )
                .expect("seed cache hit");
            current
                .cache
                .execute(
                    "INSERT INTO document_cache(
                         library_root, relative_path, title, format, source_size,
                         source_modified, converter_revision, status, error, last_accessed
                     ) VALUES (?1, 'ghost.md', 'Ghost', 'markdown', 100, 100,
                               ?2, 'ready', NULL, 1)",
                    params![root_key, CONVERTER_REVISION],
                )
                .expect("seed cache ghost");
        }

        let mut scan_cache = state.scan_connection().expect("scan connection");
        let documents = scan_documents(&root, &mut scan_cache).expect("scan");
        drop(scan_cache);
        assert_eq!(documents.len(), 1);
        // 扫描经专用连接读到缓存标题（读路径跨连接生效）。
        assert_eq!(documents[0].title, "Cached Title");

        // 幽灵行的清除经专用连接写入，主连接可见（写路径跨连接生效）。
        let current = state.inner.lock().expect("lock");
        let ghost_rows: i64 = current
            .cache
            .query_row(
                "SELECT COUNT(*) FROM document_cache WHERE relative_path = 'ghost.md'",
                [],
                |row| row.get(0),
            )
            .expect("count ghost");
        assert_eq!(ghost_rows, 0, "stale rows cleared by the scan connection");
    }

    // ---- D07: EPUB 资产多会话与预算 ----

    /// 超过字节预算时淘汰最久未用的会话，且至少保留一个会话（刚打开的
    /// 会话即使超预算也不会被淘汰到空——明确降级而非静默清空）。
    #[test]
    fn epub_asset_budget_evicts_least_recently_used() {
        let state = AppState::in_memory().expect("state");
        {
            let mut current = state.inner.lock().expect("lock");
            for (index, last_used) in [1u64, 3u64, 2u64].into_iter().enumerate() {
                let key = (format!("root-{index}"), format!("book-{index}.epub"));
                current.open_epub_assets.insert(
                    key,
                    OpenEpubAssets {
                        size: 10,
                        modified: 1,
                        assets: vec![("a.png".to_owned(), vec![0u8; 100])],
                        bytes_total: 100,
                        last_used,
                    },
                );
                current.epub_asset_stamp = last_used;
            }
            // 插入一个超预算的会话，强制淘汰路径运行（stamp 取明确更新的
            // 值，避免与既有会话平局导致 LRU 结果不确定）。
            current.epub_asset_stamp = 10;
            let huge_stamp = current.epub_asset_stamp;
            let huge_len = (EPUB_ASSET_BUDGET_BYTES + 1) as usize;
            current.open_epub_assets.insert(
                ("root-huge".to_owned(), "huge.epub".to_owned()),
                OpenEpubAssets {
                    size: 1,
                    modified: 1,
                    assets: vec![("a.bin".to_owned(), vec![0u8; huge_len])],
                    bytes_total: EPUB_ASSET_BUDGET_BYTES + 1,
                    last_used: huge_stamp,
                },
            );
            enforce_epub_asset_budget(&mut current);
            // 最久未用的 root-0（last_used=1）先被淘汰。
            assert!(!current
                .open_epub_assets
                .contains_key(&("root-0".to_owned(), "book-0.epub".to_owned())));
            // 至少保留一个会话：最新的 huge 会话存活。
            assert!(current
                .open_epub_assets
                .contains_key(&("root-huge".to_owned(), "huge.epub".to_owned())));
            // 淘汰持续到只剩一个超预算会话为止（预算内无法再降）。
            assert_eq!(current.open_epub_assets.len(), 1);
        }
    }

    // ---- D06: PDF Range 文件会话语义 ----

    /// A range request that crosses EOF (file shrank since open) must fail
    /// with a stable error instead of returning a truncated chunk; requests
    /// ending exactly at EOF stay valid.
    #[test]
    fn pdf_range_crossing_shrunk_file_is_rejected() {
        let library = tempdir().expect("temp library");
        let body = vec![0x41u8; 200];
        fs::write(library.path().join("sample.pdf"), &body).expect("write pdf");
        let root = canonical_library_root(library.path()).expect("root");

        let ok_full = read_pdf_range_from_root(&root, "sample.pdf", 0, 100).expect("in bounds");
        assert_eq!(ok_full.len(), 100);
        let ok_tail = read_pdf_range_from_root(&root, "sample.pdf", 150, 50).expect("exact EOF");
        assert_eq!(ok_tail.len(), 50);

        let shrunk = read_pdf_range_from_root(&root, "sample.pdf", 0, 300)
            .expect_err("crossing EOF must fail");
        assert!(
            shrunk.contains("changed while it was being read"),
            "unexpected error: {shrunk}"
        );
        let past =
            read_pdf_range_from_root(&root, "sample.pdf", 201, 10).expect_err("past EOF must fail");
        assert!(past.contains("past the end"), "unexpected error: {past}");
    }

    // ---- D02 书库/文档上下文竞态回归 ----

    /// A slow open must never overwrite the root committed by a newer open:
    /// the stale commit fails and the newest ticket wins (plan D02).
    #[test]
    fn opening_a_then_b_cannot_commit_a_last() {
        let state = AppState::in_memory().expect("state");
        let dir_a = tempdir().expect("temp a");
        let dir_b = tempdir().expect("temp b");
        let root_a = canonical_library_root(dir_a.path()).expect("root a");
        let root_b = canonical_library_root(dir_b.path()).expect("root b");

        // Ticket protocol: A took ticket 1, then B took ticket 2.
        OPEN_REQUEST.store(2, Ordering::SeqCst);
        let stale_error =
            commit_open_library(&state, root_a.clone(), Vec::new(), None, 1).unwrap_err();
        assert!(
            stale_error.contains("newer open_library"),
            "unexpected error: {stale_error}"
        );
        {
            let current = state.inner.lock().expect("lock");
            assert!(current.root.is_none(), "stale open must not set a root");
            assert_eq!(current.open_session, 0);
        }

        let (root_key, generation) =
            commit_open_library(&state, root_b.clone(), Vec::new(), None, 2).expect("commit b");
        let current = state.inner.lock().expect("lock");
        assert_eq!(current.root.as_ref(), Some(&root_b));
        assert_eq!(current.root_key, root_key);
        assert_eq!(normalize_root(&root_b), root_key);
        assert_eq!(generation, 1);
        assert_eq!(current.generation, generation);
        // One successful open = one session bump.
        assert_eq!(current.open_session, 1);
    }

    /// An EPUB parse that finishes after the user switched libraries must
    /// not mutate the new library's state, assets, or status events.
    #[test]
    fn late_epub_parse_from_a_cannot_mutate_b() {
        let state = AppState::in_memory().expect("state");
        let dir_b = tempdir().expect("temp b");
        let root_b = canonical_library_root(dir_b.path()).expect("root b");
        {
            let mut current = state.inner.lock().expect("lock");
            current.root = Some(root_b.clone());
            current.root_key = normalize_root(&root_b);
            current.documents.push(DocumentInfo {
                relative_path: "books/sample.epub".to_owned(),
                title: "B book".to_owned(),
                size: 10,
                modified: 20,
                format: DocumentFormat::Epub,
                index_status: IndexStatus::Pending,
                index_error: None,
            });
        }
        let root_a = PathBuf::from("D:\\reade-test-never-opened");
        let indexed_a = IndexedDocument {
            title: "A book".to_owned(),
            status: IndexStatus::Ready,
            error: None,
            segments: Vec::new(),
            links: Vec::new(),
        };
        let committed = commit_epub_open_result(
            &state,
            &root_a,
            "books/sample.epub",
            &indexed_a,
            vec![("pic.png".to_owned(), b"bytes".to_vec())],
        )
        .expect("no error");
        assert!(!committed, "stale parse must be rejected");
        let current = state.inner.lock().expect("lock");
        assert!(
            current.open_epub_assets.is_empty(),
            "B must not inherit A's assets"
        );
        assert_eq!(current.documents[0].title, "B book");
        assert_eq!(current.documents[0].index_status, IndexStatus::Pending);
    }

    /// Same library: the parse result commits, caches the index under the
    /// captured root, and activates the EPUB asset set.
    #[test]
    fn epub_parse_commits_index_and_assets_for_the_open_library() {
        let state = AppState::in_memory().expect("state");
        let dir = tempdir().expect("temp lib");
        let root = canonical_library_root(dir.path()).expect("root");
        {
            let mut current = state.inner.lock().expect("lock");
            current.root = Some(root.clone());
            current.root_key = normalize_root(&root);
            current.documents.push(DocumentInfo {
                relative_path: "books/sample.epub".to_owned(),
                title: "sample".to_owned(),
                size: 42,
                modified: 7,
                format: DocumentFormat::Epub,
                index_status: IndexStatus::Pending,
                index_error: None,
            });
        }
        let indexed = IndexedDocument {
            title: "sample parsed".to_owned(),
            status: IndexStatus::Ready,
            error: None,
            segments: Vec::new(),
            links: Vec::new(),
        };
        let committed = commit_epub_open_result(
            &state,
            &root,
            "books/sample.epub",
            &indexed,
            vec![("pic.png".to_owned(), b"bytes".to_vec())],
        )
        .expect("no error");
        assert!(committed);
        let current = state.inner.lock().expect("lock");
        let open = current
            .open_epub_assets
            .get(&(normalize_root(&root), "books/sample.epub".to_owned()))
            .expect("assets active");
        assert_eq!(open.size, 42);
        assert_eq!(current.documents[0].title, "sample parsed");
        let segments: i64 = current
            .cache
            .query_row(
                "SELECT COUNT(*) FROM search_segments WHERE library_root = ?1",
                params![normalize_root(&root)],
                |row| row.get(0),
            )
            .expect("count segments");
        // IndexedDocument has no segments here, but the cache row must exist
        // for the document itself.
        let cache_rows: i64 = current
            .cache
            .query_row(
                "SELECT COUNT(*) FROM document_cache WHERE library_root = ?1",
                params![normalize_root(&root)],
                |row| row.get(0),
            )
            .expect("count cache rows");
        assert_eq!(segments, 0);
        assert_eq!(cache_rows, 1);
    }

    fn json_fixture(name: &str) -> serde_json::Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/lib/ipc-fixtures")
            .join(name);
        let bytes =
            fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        serde_json::from_slice(&bytes).unwrap_or_else(|error| panic!("parse {name}: {error}"))
    }

    fn assert_fixture_round_trip<T>(name: &str, value: &T)
    where
        T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        let expected = json_fixture(name);
        let encoded = serde_json::to_value(value).expect("serialize");
        assert_eq!(encoded, expected, "{name} rust serialize ≠ fixture");
        let decoded: T = serde_json::from_value(expected).expect("deserialize fixture");
        assert_eq!(decoded, *value, "{name} fixture deserialize ≠ rust value");
    }

    #[test]
    fn ipc_session_dtos_match_shared_fixtures() {
        assert_fixture_round_trip(
            "library-open-result.json",
            &LibraryOpenResult {
                root_key: "C:/合成库/library-a".into(),
                documents: vec![
                    DocumentInfo {
                        relative_path: "笔记/长文.md".into(),
                        title: "稳定性分析 🧪".into(),
                        size: 4096,
                        modified: 1_725_600_000_000,
                        format: DocumentFormat::Markdown,
                        index_status: IndexStatus::Ready,
                        index_error: None,
                    },
                    DocumentInfo {
                        relative_path: "papers/guide.epub".into(),
                        title: "Guide".into(),
                        size: 1_048_576,
                        modified: 1_725_600_000_001,
                        format: DocumentFormat::Epub,
                        index_status: IndexStatus::Failed,
                        index_error: Some("Resource limit exceeded".into()),
                    },
                ],
            },
        );
        let expected_results = json_fixture("search-results.json");
        let results = vec![
            SearchResult {
                result_id: "r-1".into(),
                relative_path: "notes/guide.md".into(),
                title: "安装步骤".into(),
                snippet: "…稳定性…".into(),
                score: 1.5,
                format: DocumentFormat::Markdown,
                locator: None,
            },
            SearchResult {
                result_id: "r-2".into(),
                relative_path: "papers/a.pdf".into(),
                title: "Paper".into(),
                snippet: "abstract".into(),
                score: 0.25,
                format: DocumentFormat::Pdf,
                locator: Some(SearchLocator::PdfPage { page: 12 }),
            },
            SearchResult {
                result_id: "r-3".into(),
                relative_path: "books/long.epub".into(),
                title: "Long Book".into(),
                snippet: "chapter".into(),
                score: 0.5,
                format: DocumentFormat::Epub,
                locator: Some(SearchLocator::EpubChapter {
                    chapter_id: "chap-09".into(),
                }),
            },
        ];
        assert_eq!(
            serde_json::to_value(&results).expect("search serialize"),
            expected_results
        );
        let decoded: Vec<SearchResult> =
            serde_json::from_value(expected_results).expect("search deserialize");
        assert_eq!(decoded, results);
        assert_fixture_round_trip(
            "index-progress.json",
            &IndexProgress {
                library_root: "C:/合成库/library-a".into(),
                total: 16,
                completed: 12,
                ready: 10,
                partial: 1,
                failed: 1,
            },
        );
        assert_fixture_round_trip(
            "document-index-event.json",
            &DocumentIndexEvent {
                library_root: "C:/合成库/library-b".into(),
                relative_path: "notes/长文.md".into(),
                title: "迟到事件".into(),
                status: IndexStatus::Ready,
                error: None,
            },
        );
    }

    // ---- D10 性能基线测量（显式运行，不是 CI 门禁） ----

    /// Opt-in D10 baseline harness (plan §4 D10): generates a synthetic
    /// markdown library, measures cold scan / index build / warm rescans /
    /// search latency, and writes JSON samples to `output/hardening/perf/`.
    /// No absolute-millisecond assertion lives here — thresholds are set
    /// only after repeated same-machine baselines exist.
    ///
    /// Run:
    /// `cargo test --manifest-path src-tauri/Cargo.toml perf_baseline -- --ignored --nocapture`
    /// Env: `READE_PERF_DOCS` (default 5000), `READE_PERF_OUT` (default
    /// `../output/hardening/perf/rust-baseline.json`, relative to `src-tauri`).
    #[test]
    #[ignore = "D10 measurement harness: run explicitly with --ignored"]
    fn perf_baseline_scan_index_search_on_synthetic_library() {
        let docs: usize = std::env::var("READE_PERF_DOCS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(5_000)
            .clamp(30, 50_000);
        let library = tempdir().expect("temp library");
        let cache_dir = tempdir().expect("temp cache");
        let filler =
            "长文合成段落，用于扫描与索引预算测量，包含中文、English、与 inline code。".repeat(12);
        let mut corpus_bytes: u64 = 0;
        for index in 0..docs {
            let folder = library.path().join(format!("batch-{}", index / 500));
            fs::create_dir_all(&folder).expect("create batch dir");
            let body = format!(
                "# 合成文档 {index}\n\n{}\n\nEnglish summary paragraph {index} for corpus statistics.\n",
                (0..24)
                    .map(|p| format!("## 第 {} 节\n\n文档 {index} 的{filler}\n", p + 1))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
            let bytes = body.as_bytes();
            corpus_bytes += bytes.len() as u64;
            fs::write(folder.join(format!("doc-{index:05}.md")), bytes).expect("write doc");
        }
        let root = canonical_library_root(library.path()).expect("canonical root");
        let state = AppState::new(cache_dir.path().to_path_buf()).expect("state");
        let mut current = state.inner.lock().expect("lock");

        let timed = |label: &str, samples_ms: &mut Vec<f64>, run: &mut dyn FnMut()| {
            let start = Instant::now();
            run();
            samples_ms.push(start.elapsed().as_secs_f64() * 1_000.0);
            println!(
                "perf_baseline: {label} = {:.1} ms",
                samples_ms.last().expect("sample")
            );
        };

        let mut cold_scan = Vec::new();
        let documents = {
            let start = Instant::now();
            let documents = scan_documents(&root, &mut current.cache).expect("cold scan");
            let ms = start.elapsed().as_secs_f64() * 1_000.0;
            cold_scan.push(ms);
            println!(
                "perf_baseline: cold_scan({docs} docs, {} KiB) = {ms:.1} ms",
                corpus_bytes / 1024
            );
            documents
        };
        assert_eq!(documents.len(), docs, "synthetic library scan set size");

        let markdown_documents: Vec<DocumentInfo> = documents
            .iter()
            .filter(|document| document.format == DocumentFormat::Markdown)
            .cloned()
            .collect();
        let index_start = Instant::now();
        for document in &markdown_documents {
            let path = root.join(&document.relative_path);
            let indexed = index_document_path(&path, document).expect("index document");
            store_index_result(&mut current.cache, &root, document, &indexed)
                .expect("store index result");
        }
        let index_ms = index_start.elapsed().as_secs_f64() * 1_000.0;
        println!(
            "perf_baseline: index_build({} docs) = {index_ms:.1} ms ({:.3} ms/doc)",
            markdown_documents.len(),
            index_ms / markdown_documents.len() as f64
        );

        let mut warm_scans = Vec::new();
        for _ in 0..5 {
            timed("warm_scan", &mut warm_scans, &mut || {
                let documents = scan_documents(&root, &mut current.cache).expect("warm scan");
                assert_eq!(documents.len(), docs);
            });
        }

        let hot_queries = [
            "长文合成段落",
            "稳定性分析方法与频率响应设计准则",
            "English summary paragraph",
            "阅读器实现细节与文档渲染问题",
            "corpus statistics",
        ];
        let mut search_samples: Vec<(String, Vec<f64>)> = Vec::new();
        let mut any_results = false;
        for query in hot_queries {
            let mut samples = Vec::new();
            for _ in 0..6 {
                let start = Instant::now();
                let results = search_index(&current.cache, &normalize_root(&root), query, 100)
                    .expect("hot search");
                if !results.is_empty() {
                    any_results = true;
                }
                samples.push(start.elapsed().as_secs_f64() * 1_000.0);
            }
            search_samples.push((query.to_owned(), samples));
        }
        // Like-fallback path（<3 字符）单独采样。
        let mut like_samples = Vec::new();
        for _ in 0..6 {
            let start = Instant::now();
            search_index(&current.cache, &normalize_root(&root), "稳定", 100).expect("like search");
            like_samples.push(start.elapsed().as_secs_f64() * 1_000.0);
        }
        assert!(any_results, "hot search must match the synthetic corpus");

        fn percentile(sorted: &mut [f64], p: f64) -> f64 {
            sorted.sort_by(|a, b| a.total_cmp(b));
            if sorted.is_empty() {
                return 0.0;
            }
            let index = (((sorted.len() as f64) * p).ceil() as usize)
                .saturating_sub(1)
                .min(sorted.len() - 1);
            sorted[index]
        }

        let mut report = String::from("{\n");
        report.push_str(&format!(
            "  \"docs\": {docs}, \"corpus_bytes\": {corpus_bytes},\n"
        ));
        report.push_str(&format!(
            "  \"cold_scan_ms\": {:.1}, \"index_build_ms\": {:.1}, \"index_ms_per_doc\": {:.3},\n",
            cold_scan[0],
            index_ms,
            index_ms / markdown_documents.len() as f64
        ));
        report.push_str(&format!(
            "  \"warm_scan_ms\": {{ \"samples\": {:?}, \"median\": {:.1}, \"p95\": {:.1} }},\n",
            warm_scans,
            percentile(&mut warm_scans.clone(), 0.5),
            percentile(&mut warm_scans.clone(), 0.95)
        ));
        report.push_str("  \"search_ms\": [\n");
        for (query, samples) in &search_samples {
            report.push_str(&format!(
                "    {{ \"query\": {query:?}, \"samples\": {:?}, \"median\": {:.1}, \"p95\": {:.1} }},\n",
                samples,
                percentile(&mut samples.clone(), 0.5),
                percentile(&mut samples.clone(), 0.95)
            ));
        }
        report.push_str(&format!(
            "    {{ \"query\": \"稳定(like-fallback)\", \"samples\": {:?}, \"median\": {:.1}, \"p95\": {:.1} }}\n",
            like_samples,
            percentile(&mut like_samples.clone(), 0.5),
            percentile(&mut like_samples.clone(), 0.95)
        ));
        report.push_str("  ]\n}\n");

        let output = std::env::var("READE_PERF_OUT")
            .unwrap_or_else(|_| "../output/hardening/perf/rust-baseline.json".to_owned());
        let output = PathBuf::from(output);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).expect("create perf output dir");
        }
        fs::write(&output, report).expect("write perf baseline report");
        println!("perf_baseline: report written to {}", output.display());
    }
}
