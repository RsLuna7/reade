use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ignore::{DirEntry, WalkBuilder};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};

use crate::documents::{
    allowed_epub_asset, parse_epub, DocumentFormat, EpubDocument, IndexStatus, PdfPageContent,
    PdfReadingMode, MAX_CONVERTIBLE_BYTES,
};

const MAX_MARKDOWN_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 25 * 1024 * 1024;
const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;
const CACHE_SCHEMA_VERSION: i64 = 1;
const CACHE_SOFT_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;
const CACHE_LOW_WATER_BYTES: u64 = CACHE_SOFT_LIMIT_BYTES * 9 / 10;
const DEFAULT_SEARCH_LIMIT: u32 = 30;
const MAX_SEARCH_LIMIT: u32 = 100;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);
const CONVERTER_REVISION: &str = "reade-multiformat-v1:anydoc-0.1.8:pdf-inspector-0.1.8";

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

type CommandResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchLocator {
    PdfPage { page: u32 },
    EpubChapter { chapter_id: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexProgress {
    total: usize,
    completed: usize,
    ready: usize,
    partial: usize,
    failed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentIndexEvent {
    relative_path: String,
    title: String,
    status: IndexStatus,
    error: Option<String>,
}

struct OpenEpubAssets {
    relative_path: String,
    size: u64,
    modified: u64,
    assets: Vec<(String, Vec<u8>)>,
}

struct LibraryState {
    root: Option<PathBuf>,
    documents: Vec<DocumentInfo>,
    cache: Connection,
    watcher: Option<RecommendedWatcher>,
    generation: u64,
    open_epub: Option<OpenEpubAssets>,
}

#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<LibraryState>>,
    index_gate: Arc<Mutex<()>>,
}

impl AppState {
    pub fn new(cache_directory: PathBuf) -> CommandResult<Self> {
        fs::create_dir_all(&cache_directory)
            .map_err(|error| format!("Cannot create application cache directory: {error}"))?;
        let connection = open_cache_connection(&cache_directory.join("reade-cache.sqlite3"))?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> CommandResult<Self> {
        initialize_cache(&connection)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(LibraryState {
                root: None,
                documents: Vec::new(),
                cache: connection,
                watcher: None,
                generation: 0,
                open_epub: None,
            })),
            index_gate: Arc::new(Mutex::new(())),
        })
    }

    #[cfg(test)]
    fn in_memory() -> CommandResult<Self> {
        Self::from_connection(
            Connection::open_in_memory()
                .map_err(|error| format!("Cannot create test cache: {error}"))?,
        )
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
}

#[tauri::command]
pub async fn open_library(
    root_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<DocumentInfo>> {
    let root = run_blocking(move || canonical_library_root(Path::new(&root_path))).await?;
    let documents = {
        let mut current = lock_state(&state)?;
        scan_documents(&root, &mut current.cache)?
    };
    let watcher = create_watcher(&root, app.clone())?;
    let generation = {
        let mut current = lock_state(&state)?;
        current.generation = current.generation.wrapping_add(1);
        current.root = Some(root);
        current.documents = documents;
        current.watcher = Some(watcher);
        current.open_epub = None;
        current.generation
    };
    let snapshot = lock_state(&state)?.documents.clone();
    spawn_background_index(app, generation, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
pub async fn refresh_library(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<DocumentInfo>> {
    let root = current_root(&state)?;
    let scan_root = root.clone();
    let app_state = state.inner().clone();
    let documents = run_blocking(move || {
        let mut current = app_state
            .inner
            .lock()
            .map_err(|_| "Library state lock was poisoned".to_owned())?;
        scan_documents(&scan_root, &mut current.cache)
    })
    .await?;
    let generation = {
        let mut current = lock_state(&state)?;
        if current.root.as_ref() != Some(&root) {
            return Err("The library changed while it was being refreshed; retry".to_owned());
        }
        current.generation = current.generation.wrapping_add(1);
        current.documents = documents;
        current.open_epub = None;
        current.generation
    };
    let snapshot = lock_state(&state)?.documents.clone();
    spawn_background_index(app, generation, snapshot.clone());
    Ok(snapshot)
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
    if format != DocumentFormat::Epub {
        lock_state(&state)?.open_epub = None;
    }
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
            drop(current);
            if let Some(document) = info.filter(|value| {
                matches!(
                    value.index_status,
                    IndexStatus::Pending | IndexStatus::Failed
                )
            }) {
                spawn_background_index(app, generation, vec![document]);
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
            };
            {
                let mut current = lock_state(&state)?;
                let document = current
                    .documents
                    .iter()
                    .find(|document| document.relative_path == relative_path)
                    .cloned()
                    .ok_or_else(|| "Document is not in the current library".to_owned())?;
                store_index_result(&mut current.cache, &root, &document, &indexed)?;
                update_document_status(&mut current, &relative_path, &indexed);
                current.open_epub = Some(OpenEpubAssets {
                    relative_path: relative_path.clone(),
                    size: document.size,
                    modified: document.modified,
                    assets: parsed.asset_bytes,
                });
            }
            emit_document_status(&app, &relative_path, &indexed);
            Ok(DocumentContent::Epub {
                relative_path,
                document: parsed.payload,
            })
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
    let root = current_root(&state)?;
    run_blocking(move || {
        read_pdf_range_from_root(&root, &relative_path, offset, length).map(Response::new)
    })
    .await
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
            let stored_document = current
                .documents
                .iter()
                .find(|candidate| candidate.relative_path == relative_path)
                .cloned()
                .ok_or_else(|| "Document is not in the current library".to_owned())?;
            store_index_result(&mut current.cache, &root, &stored_document, &indexed)?;
            update_document_status(&mut current, &relative_path, &indexed);
        }
        emit_document_status(&app, &relative_path, &indexed);
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
    let root = current_root(&state)?;
    let path = resolve_existing_in_root(&root, &relative_path)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("Cannot inspect EPUB document: {error}"))?;
    let current = lock_state(&state)?;
    let open = current
        .open_epub
        .as_ref()
        .filter(|open| {
            open.relative_path == relative_path
                && open.size == metadata.len()
                && open.modified == modified_millis(&metadata)
        })
        .ok_or_else(|| "EPUB assets are no longer active; reopen the document".to_owned())?;
    let (media_type, bytes) = open
        .assets
        .get(asset_id)
        .ok_or_else(|| "EPUB asset does not exist".to_owned())?;
    if !allowed_epub_asset(media_type) {
        return Err(format!("EPUB asset type is blocked: {media_type}"));
    }
    Ok(Response::new(bytes.clone()))
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
    spawn_background_index(app, generation, vec![document]);
    Ok(())
}

#[tauri::command]
pub fn clear_conversion_cache(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let generation;
    let documents;
    {
        let mut current = lock_state(&state)?;
        clear_cache_storage(&mut current.cache)?;
        for document in &mut current.documents {
            document.index_status = IndexStatus::Pending;
            document.index_error = None;
        }
        current.open_epub = None;
        generation = current.generation;
        documents = current.documents.clone();
    }
    spawn_background_index(app, generation, documents);
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

fn spawn_background_index(app: AppHandle, generation: u64, documents: Vec<DocumentInfo>) {
    tauri::async_runtime::spawn(async move {
        let worker_app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            index_documents_background(worker_app, generation, documents)
        })
        .await;
    });
}

fn index_documents_background(
    app: AppHandle,
    generation: u64,
    documents: Vec<DocumentInfo>,
) -> CommandResult<()> {
    let total = documents.len();
    let mut progress = IndexProgress {
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

        set_document_indexing(&app, &state, &document.relative_path)?;
        let path = match resolve_existing_in_root(&root, &document.relative_path) {
            Ok(path) => path,
            Err(error) => {
                let indexed = IndexedDocument {
                    title: document.title.clone(),
                    status: IndexStatus::Failed,
                    error: Some(error),
                    segments: Vec::new(),
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
    emit_document_status(app, &document.relative_path, indexed);
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

fn emit_document_status(app: &AppHandle, relative_path: &str, indexed: &IndexedDocument) {
    let _ = app.emit(
        "document-index-status",
        DocumentIndexEvent {
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
    })
}

fn index_epub(path: &Path, document: &DocumentInfo) -> CommandResult<IndexedDocument> {
    if document.size > MAX_CONVERTIBLE_BYTES {
        return Ok(IndexedDocument {
            title: document.title.clone(),
            status: IndexStatus::Unsupported,
            error: Some("EPUB 文件超过 128 MiB".to_owned()),
            segments: Vec::new(),
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
             END;",
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
    let mut total = cache_active_bytes(connection)?;
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
        total = cache_active_bytes(connection)?;
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

fn current_root(state: &State<'_, AppState>) -> CommandResult<PathBuf> {
    lock_state(state)?
        .root
        .clone()
        .ok_or_else(|| "No library is open".to_owned())
}

fn canonical_library_root(path: &Path) -> CommandResult<PathBuf> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Cannot open library root: {error}"))?;
    if !canonical.is_dir() {
        return Err("Library root must be a directory".to_owned());
    }
    Ok(canonical)
}

fn resolve_existing_in_root(root: &Path, relative_path: &str) -> CommandResult<PathBuf> {
    let relative = Path::new(relative_path);
    if relative_path.trim().is_empty() || relative.is_absolute() {
        return Err("A non-empty relative path is required".to_owned());
    }
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("Path traversal outside the library is not allowed".to_owned());
    }
    let candidate = root.join(relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Cannot resolve library path: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("Resolved path is outside the library root".to_owned());
    }
    Ok(canonical)
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

fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_root(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn modified_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn now_millis() -> u64 {
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
    fn pdf_range_reads_are_bounded_and_clamped_at_eof() {
        let library = tempdir().expect("temp library");
        fs::write(library.path().join("sample.pdf"), b"%PDF-1.7\n0123456789").expect("write pdf");
        fs::write(library.path().join("note.md"), b"not a pdf").expect("write note");
        let root = canonical_library_root(library.path()).expect("canonical root");
        assert_eq!(
            read_pdf_range_from_root(&root, "sample.pdf", 9, 50).expect("tail range"),
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
}
