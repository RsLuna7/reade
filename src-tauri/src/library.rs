use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ignore::{DirEntry, WalkBuilder};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

const MAX_DOCUMENT_BYTES: u64 = 10 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 25 * 1024 * 1024;
const DEFAULT_SEARCH_LIMIT: u32 = 30;
const MAX_SEARCH_LIMIT: u32 = 100;
const WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

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
    /// Unix timestamp in milliseconds. Millisecond precision is safe in a JS number.
    pub modified: u64,
    pub is_mdx: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub relative_path: String,
    pub title: String,
    pub snippet: String,
    /// Higher values are more relevant. LIKE fallback results use 0.
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssetData {
    pub relative_path: String,
    pub mime_type: String,
    pub data: String,
}

struct LibraryState {
    root: Option<PathBuf>,
    documents: Vec<DocumentInfo>,
    // The index is intentionally in-memory for the MVP. It is rebuilt when a library is
    // opened/refreshed, so no database files are written into a user's document library.
    index: Connection,
    // Keeping the watcher here owns its worker resources. Replacing this Option drops the old
    // watcher and prevents a thread/resource leak when the user switches libraries.
    watcher: Option<RecommendedWatcher>,
}

pub struct AppState {
    inner: Mutex<LibraryState>,
}

impl AppState {
    pub fn new() -> CommandResult<Self> {
        Ok(Self {
            inner: Mutex::new(LibraryState {
                root: None,
                documents: Vec::new(),
                index: create_index()?,
                watcher: None,
            }),
        })
    }
}

#[tauri::command]
pub async fn open_library(
    root_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Vec<DocumentInfo>> {
    let (root, documents, index) = run_blocking(move || {
        let root = canonical_library_root(Path::new(&root_path))?;
        let (documents, index) = build_snapshot(&root)?;
        Ok((root, documents, index))
    })
    .await?;
    let watcher = create_watcher(&root, app)?;

    let mut current = lock_state(&state)?;
    current.root = Some(root);
    current.documents = documents;
    current.index = index;
    current.watcher = Some(watcher);
    Ok(current.documents.clone())
}

#[tauri::command]
pub async fn refresh_library(state: State<'_, AppState>) -> CommandResult<Vec<DocumentInfo>> {
    let root = {
        let current = lock_state(&state)?;
        current
            .root
            .clone()
            .ok_or_else(|| "No library is open".to_owned())?
    };

    let scan_root = root.clone();
    let (documents, index) = run_blocking(move || build_snapshot(&scan_root)).await?;
    let mut current = lock_state(&state)?;
    if current.root.as_ref() != Some(&root) {
        return Err(
            "The library changed while it was being refreshed; retry the refresh".to_owned(),
        );
    }
    current.documents = documents;
    current.index = index;
    Ok(current.documents.clone())
}

#[tauri::command]
pub async fn read_document(
    relative_path: String,
    state: State<'_, AppState>,
) -> CommandResult<String> {
    let root = current_root(&state)?;
    run_blocking(move || {
        let path = resolve_existing_in_root(&root, &relative_path)?;
        if !is_document_path(&path) {
            return Err("Only .md, .markdown, and .mdx documents can be read".to_owned());
        }
        read_utf8_lossy_with_limit(&path, MAX_DOCUMENT_BYTES, "Markdown document")
    })
    .await
}

#[tauri::command]
pub fn search_documents(
    query: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<SearchResult>> {
    let current = lock_state(&state)?;
    if current.root.is_none() {
        return Err("No library is open".to_owned());
    }
    search_index(
        &current.index,
        &query,
        limit.unwrap_or(DEFAULT_SEARCH_LIMIT),
    )
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

fn create_index() -> CommandResult<Connection> {
    let connection = Connection::open_in_memory()
        .map_err(|error| format!("Cannot create in-memory search index: {error}"))?;
    connection
        .execute_batch(
            "CREATE VIRTUAL TABLE documents USING fts5(
                relative_path UNINDEXED,
                title,
                content,
                tokenize = 'trigram'
            );",
        )
        .map_err(|error| format!("Cannot initialize FTS5 trigram index: {error}"))?;
    Ok(connection)
}

fn build_snapshot(root: &Path) -> CommandResult<(Vec<DocumentInfo>, Connection)> {
    let mut index = create_index()?;
    let transaction = index
        .transaction()
        .map_err(|error| format!("Cannot begin search index transaction: {error}"))?;
    let mut documents = Vec::new();

    let mut builder = WalkBuilder::new(root);
    builder
        .standard_filters(true)
        // A selected library need not itself be a Git repository; still honor any .gitignore it
        // contains because users commonly reuse those patterns for generated documentation.
        .require_git(false)
        .follow_links(false)
        .filter_entry(|entry| !is_excluded_directory(entry));

    for result in builder.build() {
        let entry = match result {
            Ok(entry) => entry,
            // An unreadable subdirectory should not make every readable document unavailable.
            Err(_) => continue,
        };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) || !is_document_path(entry.path())
        {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.len() <= MAX_DOCUMENT_BYTES => metadata,
            Ok(_) | Err(_) => continue,
        };
        let content =
            match read_utf8_lossy_with_limit(entry.path(), MAX_DOCUMENT_BYTES, "Markdown document")
            {
                Ok(content) => content,
                Err(_) => continue,
            };
        let relative_path = normalize_relative_path(
            entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "Scanned document resolved outside the library".to_owned())?,
        );
        let title = extract_title(&content).unwrap_or_else(|| fallback_title(entry.path()));
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let is_mdx = entry
            .path()
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("mdx"));

        transaction
            .execute(
                "INSERT INTO documents(relative_path, title, content) VALUES (?1, ?2, ?3)",
                params![relative_path, title, content],
            )
            .map_err(|error| format!("Cannot add document to search index: {error}"))?;
        documents.push(DocumentInfo {
            relative_path,
            title,
            size: metadata.len(),
            modified,
            is_mdx,
        });
    }

    transaction
        .commit()
        .map_err(|error| format!("Cannot commit search index: {error}"))?;
    documents.sort_by_cached_key(|document| document.relative_path.to_lowercase());
    Ok((documents, index))
}

fn search_index(
    connection: &Connection,
    query: &str,
    limit: u32,
) -> CommandResult<Vec<SearchResult>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    if query.chars().count() < 3 {
        return search_index_like(connection, query, limit);
    }

    // Quote the complete user input as an FTS phrase. This prevents FTS operators supplied by a
    // document/user query from changing the SQL search grammar.
    let fts_query = format!("\"{}\"", query.replace('"', "\"\""));
    let mut statement = connection
        .prepare(
            "SELECT relative_path,
                    title,
                    snippet(documents, 2, '', '', ' … ', 28),
                    -bm25(documents, 0.0, 5.0, 1.0) AS score
             FROM documents
             WHERE documents MATCH ?1
             ORDER BY score DESC, relative_path ASC
             LIMIT ?2",
        )
        .map_err(|error| format!("Cannot prepare full-text search: {error}"))?;
    let rows = statement
        .query_map(params![fts_query, limit], search_result_from_row)
        .map_err(|error| format!("Cannot execute full-text search: {error}"))?;
    collect_search_rows(rows)
}

fn search_index_like(
    connection: &Connection,
    query: &str,
    limit: u32,
) -> CommandResult<Vec<SearchResult>> {
    let pattern = format!("%{}%", escape_like(query));
    let mut statement = connection
        .prepare(
            "SELECT relative_path,
                    title,
                    CASE
                        WHEN instr(lower(content), lower(?1)) > 0 THEN
                            substr(content, max(1, instr(lower(content), lower(?1)) - 40), 160)
                        ELSE title
                    END AS snippet,
                    0.0 AS score
             FROM documents
             WHERE title LIKE ?2 ESCAPE '\\' COLLATE NOCASE
                OR content LIKE ?2 ESCAPE '\\' COLLATE NOCASE
             ORDER BY CASE WHEN title LIKE ?2 ESCAPE '\\' COLLATE NOCASE THEN 0 ELSE 1 END,
                      relative_path ASC
             LIMIT ?3",
        )
        .map_err(|error| format!("Cannot prepare short-query search: {error}"))?;
    let rows = statement
        .query_map(params![query, pattern, limit], search_result_from_row)
        .map_err(|error| format!("Cannot execute short-query search: {error}"))?;
    collect_search_rows(rows)
}

fn search_result_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SearchResult> {
    Ok(SearchResult {
        relative_path: row.get(0)?,
        title: row.get(1)?,
        snippet: row.get(2)?,
        score: row.get(3)?,
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

fn is_document_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md")
                || extension.eq_ignore_ascii_case("markdown")
                || extension.eq_ignore_ascii_case("mdx")
        })
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

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

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
    fn extracts_atx_and_setext_titles_but_ignores_fenced_headings() {
        assert_eq!(
            extract_title("```md\n# Not the title\n```\n# Actual title ##\n"),
            Some("Actual title".to_owned())
        );
        assert_eq!(
            extract_title("A Setext Title\n================\n"),
            Some("A Setext Title".to_owned())
        );
        assert_eq!(extract_title("## Only H2"), None);
    }

    #[test]
    fn scan_respects_ignores_marks_mdx_and_searches_long_and_short_queries() {
        let library = tempdir().expect("temp library");
        fs::create_dir_all(library.path().join("guide")).expect("create guide");
        fs::create_dir_all(library.path().join("node_modules/pkg")).expect("create excluded dir");
        fs::write(
            library.path().join("guide/start.md"),
            "# Getting Started\n\n本地阅读器 supports searchable Markdown.",
        )
        .expect("write markdown");
        fs::write(
            library.path().join("guide/component.mdx"),
            "# MDX Component\n\nexport const Demo = true;",
        )
        .expect("write mdx");
        fs::write(library.path().join("ignored.md"), "# Ignored searchable")
            .expect("write ignored markdown");
        fs::write(library.path().join(".gitignore"), "ignored.md\n").expect("write gitignore");
        fs::write(
            library.path().join("node_modules/pkg/readme.md"),
            "# Dependency searchable",
        )
        .expect("write excluded markdown");

        let root = canonical_library_root(library.path()).expect("canonical root");
        let (documents, index) = build_snapshot(&root).expect("build snapshot");

        assert_eq!(documents.len(), 2);
        assert!(documents
            .iter()
            .any(|document| document.relative_path == "guide/component.mdx" && document.is_mdx));

        let long_results = search_index(&index, "searchable", 10).expect("long search");
        assert_eq!(long_results.len(), 1);
        assert_eq!(long_results[0].relative_path, "guide/start.md");

        let short_results = search_index(&index, "本地", 10).expect("short search");
        assert_eq!(short_results.len(), 1);
        assert_eq!(short_results[0].relative_path, "guide/start.md");
    }

    #[test]
    fn like_fallback_treats_wildcards_as_literals() {
        let connection = create_index().expect("create index");
        connection
            .execute(
                "INSERT INTO documents(relative_path, title, content) VALUES (?1, ?2, ?3)",
                params!["percent.md", "100%", "Literal percent"],
            )
            .expect("insert fixture");
        connection
            .execute(
                "INSERT INTO documents(relative_path, title, content) VALUES (?1, ?2, ?3)",
                params!["other.md", "Other", "Nothing here"],
            )
            .expect("insert fixture");

        let results = search_index(&connection, "%", 10).expect("wildcard search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].relative_path, "percent.md");
    }

    #[test]
    #[ignore = "manual performance acceptance for the 10,000-document MVP target"]
    fn indexes_ten_thousand_documents_within_mvp_budget() {
        let library = tempdir().expect("temp library");
        for directory_index in 0..100 {
            let directory = library.path().join(format!("section-{directory_index:03}"));
            fs::create_dir_all(&directory).expect("create benchmark directory");
            for document_index in 0..100 {
                fs::write(
                    directory.join(format!("document-{document_index:03}.md")),
                    format!(
                        "# 文档 {directory_index}-{document_index}\n\n本地 Markdown 阅读器性能验收。\n\nsearchable benchmark content"
                    ),
                )
                .expect("write benchmark document");
            }
        }

        let root = canonical_library_root(library.path()).expect("canonical root");
        let started = Instant::now();
        let (documents, index) = build_snapshot(&root).expect("build benchmark snapshot");
        let elapsed = started.elapsed();

        assert_eq!(documents.len(), 10_000);
        assert_eq!(
            search_index(&index, "searchable benchmark", 10)
                .expect("search benchmark index")
                .len(),
            10
        );
        assert!(
            elapsed < Duration::from_secs(30),
            "10,000-document indexing took {elapsed:?}"
        );
        eprintln!("indexed 10,000 Markdown documents in {elapsed:?}");
    }
}
