//! Durable user-data storage (annotations and document fingerprints).
//!
//! Annotations are irreplaceable user data, so they live in their own
//! `reade-user.sqlite3` database with a real migration chain, instead of the
//! conversion cache whose "schema mismatch → delete the file" policy is only
//! acceptable for regenerable data. The database sits next to the cache file;
//! `UserState` must be constructed *before* the cache `AppState` so a future
//! cache schema bump can never wipe legacy annotations before they have been
//! rescued into this store. The module owns its connection the same way
//! `stats.rs` does, and future user data (e.g. reading history) can join this
//! database by appending migration steps.
//!
//! The `documents` table maps every scanned document to a content fingerprint
//! (see `compute_document_fingerprint`). Rows for documents that disappear
//! from a scan are deliberately retained: a missing annotated path whose
//! fingerprint reappears at a new path is exactly the clue the move-detection
//! rebind chain (`detect_moved_documents` / `rebind_document_annotations`,
//! `docs/research-annotation-data-models.md` §5.5) is built on.
//!
//! Migration rules (Zotero/Calibre hybrid, see
//! `docs/research-annotation-data-models.md` §5.1/§5.9):
//! - `PRAGMA user_version` + sequential integer steps (`migrate_to_v{N}`),
//!   the whole chain in one transaction; any failure rolls everything back
//!   and surfaces an error. The database file is never silently rebuilt.
//! - Databases with data are backed up via `VACUUM INTO` before upgrading.
//! - A `user_version` above what this build supports is refused (ratchet),
//!   so an older Reade cannot corrupt a newer database.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use md5::Md5;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use unicode_normalization::UnicodeNormalization;

use crate::documents::DocumentFormat;
use crate::library::{
    current_root, current_root_and_document_paths, ensure_document_in_open_library,
    normalize_relative_path, normalize_root, now_millis, resolve_existing_in_root,
    validate_relative_library_path, AppState, CommandResult, DocumentInfo, MAX_MARKDOWN_BYTES,
};

const USER_SCHEMA_VERSION: i64 = 5;
const USER_DB_FILE: &str = "reade-user.sqlite3";
const LEGACY_CACHE_DB_FILE: &str = "reade-cache.sqlite3";
/// Tombstoned annotations are physically purged 90 days after deletion.
const TOMBSTONE_RETENTION_MS: u64 = 90 * 24 * 60 * 60 * 1000;

/// Annotations without a review row become due one day after creation
/// (lazy initial state, `initialReviewState` in `src/lib/reviewScheduler.ts`).
const REVIEW_IMPLICIT_DUE_OFFSET_MS: u64 = 24 * 60 * 60 * 1000;
/// Leitner boxes run 0..=5 (`REVIEW_INTERVALS_DAYS` on the frontend).
const REVIEW_MAX_BOX: i64 = 5;
/// `due_at` must land inside `[now − 1h, now + 180d]`: the slack tolerates
/// clock skew, the ceiling is the 60-day top interval with generous margin.
const REVIEW_DUE_PAST_SLACK_MS: u64 = 60 * 60 * 1000;
const REVIEW_DUE_FUTURE_LIMIT_MS: u64 = 180 * 24 * 60 * 60 * 1000;
/// Queue requests over-fetch ×3 so the client can rotate documents before
/// trimming to its batch size (`buildReviewQueue`).
const REVIEW_QUEUE_OVERFETCH: usize = 3;
const MAX_REVIEW_QUEUE_LIMIT: usize = 500;

/// Search queries are truncated to this many chars before normalization.
const MAX_SEARCH_QUERY_CHARS: usize = 256;
const MAX_ANNOTATION_SEARCH_RESULTS: usize = 500;
/// Normalized queries below this length cannot use the trigram FTS index
/// and fall back to a LIKE scan (CJK two-character words are common).
const MIN_FTS_QUERY_CHARS: usize = 3;

const MAX_ANNOTATION_ID_CHARS: usize = 64;
const MAX_ANNOTATION_NOTE_CHARS: usize = 4_000;
const MAX_ANNOTATION_TITLE_CHARS: usize = 200;
const MAX_ANNOTATION_TEXT_CHARS: usize = 2_000;
const MAX_ANNOTATION_RECTS: usize = 64;

/// Collection names are trimmed and capped (`docs/plan-collections.md`
/// §3.1); ids follow the annotation id rules (≤ 64 chars, same alphabet).
/// The TS twin constants live in `src/lib/collections.ts`.
const MAX_COLLECTION_NAME_CHARS: usize = 100;

/// Import caps mirroring `MAX_TRANSFER_*` in `src/lib/annotationTransfer.ts`.
const MAX_IMPORT_ANNOTATIONS: usize = 10_000;
const MAX_IMPORT_FINGERPRINTS: usize = 2_000;

/// Fallback sort key for rows whose locator cannot be parsed; sorts last.
const BROKEN_SORT_INDEX: &str = "Z|99999|00000000";
const SORT_INDEX_CHARS: usize = 16;
const MAX_SORT_PAGE_SLOT: u64 = 99_999;
const MAX_SORT_OFFSET_SLOT: u64 = 99_999_999;
/// `\x1f` unit separator between selected text and note in `searchable_text`.
const SEARCHABLE_TEXT_SEPARATOR: char = '\u{1f}';

/// 1 KiB sample block size for the KOReader-style partial MD5.
const PARTIAL_MD5_BLOCK: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationColor {
    Yellow,
    Green,
    Blue,
    Pink,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationKind {
    Highlight,
    Underline,
    Bookmark,
}

/// `scroll_ratio`/`offset_ratio` are derived display values that may be
/// recomputed after a re-layout; they are not anchor semantics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "format",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BookmarkTarget {
    Markdown {
        heading_id: Option<String>,
        scroll_ratio: f64,
    },
    Pdf {
        page: u32,
        offset_ratio: f64,
    },
    Epub {
        chapter_id: String,
        heading_id: Option<String>,
        scroll_ratio: f64,
    },
}

/// The quote + context remains the authoritative anchor. The optional
/// `start`/`end` offsets are persisted position hints (resolved first, then
/// verified against the quote), and `page_width`/`page_height` snapshot the
/// PDF page size in points at creation time so normalized rects stay
/// convertible to PDF user-space coordinates offline. All new fields are
/// optional additions: locators stored by older builds deserialize untouched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AnnotationLocator {
    Markdown {
        quote: String,
        prefix: String,
        suffix: String,
        heading_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end: Option<u32>,
    },
    Pdf {
        page: u32,
        view: String,
        quote: String,
        prefix: String,
        suffix: String,
        rects: Vec<AnnotationRect>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        page_width: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        page_height: Option<f64>,
    },
    Epub {
        chapter_id: String,
        block_index: u32,
        start_offset: u32,
        end_offset: u32,
        quote: String,
        prefix: String,
        suffix: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end: Option<u32>,
    },
    Bookmark {
        target: BookmarkTarget,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub relative_path: String,
    pub kind: AnnotationKind,
    pub color: Option<AnnotationColor>,
    pub note: Option<String>,
    pub selected_text: Option<String>,
    pub title: Option<String>,
    pub locator: AnnotationLocator,
    /// Precomputed position sort key; clients send it, the server validates
    /// the format and recomputes it from the locator when absent.
    #[serde(default)]
    pub sort_index: String,
    pub created_at: u64,
    pub updated_at: u64,
    /// Tombstone timestamp (ms). `None` = live annotation.
    #[serde(default)]
    pub deleted_at: Option<u64>,
}

#[derive(Clone)]
pub struct UserState {
    connection: Arc<Mutex<Connection>>,
}

impl UserState {
    pub fn new(directory: PathBuf) -> CommandResult<Self> {
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Cannot create application data directory: {error}"))?;
        let connection = open_user_database(
            &directory.join(USER_DB_FILE),
            Some(&directory.join(LEGACY_CACHE_DB_FILE)),
        )?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    #[cfg(test)]
    fn in_memory() -> CommandResult<Self> {
        let connection = Connection::open_in_memory()
            .map_err(|error| format!("Cannot create test user database: {error}"))?;
        Ok(Self {
            connection: Arc::new(Mutex::new(initialize_user_database(
                connection, None, None,
            )?)),
        })
    }

    fn lock(&self) -> CommandResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| "User data state lock was poisoned".to_owned())
    }
}

#[tauri::command]
pub fn list_annotations(
    relative_path: Option<String>,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Vec<Annotation>> {
    let root = current_root(&library)?;
    if let Some(path) = relative_path.as_deref() {
        validate_relative_library_path(path)?;
    }
    let connection = lock_user(&user)?;
    list_annotation_rows(
        &connection,
        &normalize_root(&root),
        relative_path.as_deref(),
    )
}

#[tauri::command]
pub fn upsert_annotation(
    annotation: Annotation,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Annotation> {
    let root = current_root(&library)?;
    let sanitized = sanitize_annotation(annotation)?;
    ensure_document_in_open_library(&library, &sanitized.relative_path)?;
    let connection = lock_user(&user)?;
    upsert_annotation_row(&connection, &normalize_root(&root), &sanitized)?;
    Ok(sanitized)
}

#[tauri::command]
pub fn delete_annotation(
    id: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    validate_annotation_id(&id)?;
    let connection = lock_user(&user)?;
    tombstone_annotation(&connection, &normalize_root(&root), &id, now_millis())
}

#[tauri::command]
pub fn clear_document_annotations(
    relative_path: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    validate_relative_library_path(&relative_path)?;
    let normalized = normalize_relative_path(Path::new(&relative_path));
    let connection = lock_user(&user)?;
    clear_annotation_rows(&connection, &normalize_root(&root), &normalized)
}

/// One `(oldPath → newPath)` rebind proposal. When the same content hash
/// yields several possible pairings (multiple new candidates for one missing
/// path, or several missing paths collapsing onto one candidate), every
/// pairing is returned with `ambiguous = true` and the client must not apply
/// any of them automatically.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MovedDocumentCandidate {
    pub old_path: String,
    pub new_path: String,
    /// Live (non-tombstoned) annotations still attached to `old_path`.
    pub annotation_count: u64,
    pub ambiguous: bool,
}

/// Finds annotated paths that vanished from the current scan but whose
/// content fingerprint reappears at another scanned path (§5.5 step ②).
/// Reads only databases and in-memory scan state; never touches files.
#[tauri::command]
pub fn detect_moved_documents(
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Vec<MovedDocumentCandidate>> {
    let (root, present) = current_root_and_document_paths(&library)?;
    let connection = lock_user(&user)?;
    detect_moved_rows(&connection, &normalize_root(&root), &present)
}

/// Moves every annotation of `old_path` (tombstones included, so deletion
/// history follows the document) to `new_path` in one transaction and drops
/// the stale fingerprint row. Returns the number of annotation rows updated.
#[tauri::command]
pub fn rebind_document_annotations(
    old_path: String,
    new_path: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<u64> {
    let root = current_root(&library)?;
    let (old_normalized, new_normalized) = validate_rebind_paths(&old_path, &new_path)?;
    // The rebind target must exist inside the open library (canonicalized
    // containment check); the old path no longer exists on disk and is only
    // ever used as a database key, like `clear_document_annotations`.
    ensure_document_in_open_library(&library, &new_normalized)?;
    let mut connection = lock_user(&user)?;
    rebind_annotation_rows(
        &mut connection,
        &normalize_root(&root),
        &old_normalized,
        &new_normalized,
    )
}

/// Client-computed Leitner state (`src/lib/reviewScheduler.ts`); the backend
/// validates and persists it — the same derive/validate split as
/// `sort_index`. Field names serialize camelCase to match the TS type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewState {
    /// Named `box_level` because `box` is a Rust keyword; the wire name and
    /// the SQL column are both `box`.
    #[serde(rename = "box")]
    pub box_level: i64,
    pub due_at: u64,
    pub last_reviewed_at: Option<u64>,
    pub total_reviews: u64,
    pub suspended: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQueueItem {
    pub annotation: Annotation,
    pub review: ReviewState,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    pub due_count: u64,
    pub reviewed_today: u64,
}

/// Due review candidates in due-date order, over-fetched ×3 so the client
/// can rotate documents before trimming to its batch size
/// (`docs/plan-annotation-review.md` §3.4).
#[tauri::command]
pub fn list_review_queue(
    now_ms: u64,
    limit: usize,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Vec<ReviewQueueItem>> {
    let root = current_root(&library)?;
    let connection = lock_user(&user)?;
    list_review_queue_rows(&connection, &normalize_root(&root), now_ms, limit)
}

/// Persists a client-derived review state after validating it (annotation
/// exists and is live, box within the ladder, due date inside the skew
/// window). `total_reviews` is counted server-side; suspending does not
/// count as a review.
#[tauri::command]
pub fn record_review_outcome(
    annotation_id: String,
    box_level: i64,
    due_at: u64,
    last_reviewed_at: Option<u64>,
    suspended: bool,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let connection = lock_user(&user)?;
    record_review_outcome_row(
        &connection,
        &normalize_root(&root),
        &annotation_id,
        box_level,
        due_at,
        last_reviewed_at,
        suspended,
        now_millis(),
    )
}

/// Data for the "今日回顾" card: how many candidates are due now and how
/// many outcomes were recorded since `day_start_ms`. The local-timezone day
/// boundary is computed by the client; the backend does no timezone math.
#[tauri::command]
pub fn review_summary(
    day_start_ms: u64,
    now_ms: u64,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<ReviewSummary> {
    let root = current_root(&library)?;
    let connection = lock_user(&user)?;
    review_summary_rows(&connection, &normalize_root(&root), day_start_ms, now_ms)
}

/// Full-text search over live annotations (`docs/plan-annotation-hub.md`
/// §3.1): trigram FTS for queries of ≥3 normalized chars, a LIKE fallback
/// below that, plus a title LIKE supplement for bookmark titles (decision
/// A-D3). Read-only; results are ordered by document path and position.
#[tauri::command]
pub fn search_annotations(
    query: String,
    limit: usize,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Vec<Annotation>> {
    let root = current_root(&library)?;
    let connection = lock_user(&user)?;
    search_annotation_rows(&connection, &normalize_root(&root), &query, limit)
}

/// Every annotation of the current root — tombstones included — in stable
/// `(relative_path, sort_index, id)` order: the data source for the §5.7
/// export envelope and for the import LWW comparison. Read-only.
#[tauri::command]
pub fn list_annotations_for_transfer(
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Vec<Annotation>> {
    let root = current_root(&library)?;
    let connection = lock_user(&user)?;
    transfer_annotation_rows(&connection, &normalize_root(&root))
}

/// One `documents` fingerprint row exposed to the transfer layer. The same
/// shape is accepted back by `import_annotations` for missing-path rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFingerprintEntry {
    pub relative_path: String,
    pub content_hash: String,
}

/// Stored content fingerprints of the current root. Rows for vanished paths
/// are included on purpose: they carry the last known identity of missing
/// annotated documents into the export envelope.
#[tauri::command]
pub fn list_document_fingerprints(
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Vec<DocumentFingerprintEntry>> {
    let root = current_root(&library)?;
    let connection = lock_user(&user)?;
    document_fingerprint_rows(&connection, &normalize_root(&root))
}

/// Applies a client-planned annotation import (`planAnnotationImport` in
/// `src/lib/annotationTransfer.ts`) in a single transaction: every record is
/// sanitized up front and one bad record aborts the whole batch — no partial
/// writes. Unlike `upsert_annotation` this deliberately skips the
/// document-presence check: imported records may reference paths that are
/// not (or no longer) in the library; they surface in the lost-documents
/// rebind list instead. Path strings are still fully validated as
/// library-relative keys. Envelope fingerprints are only inserted for paths
/// absent from the current scan and never overwrite existing rows — they
/// merely seed the §5.5 move-detection chain.
#[tauri::command]
pub fn import_annotations(
    annotations: Vec<Annotation>,
    fingerprints: Vec<DocumentFingerprintEntry>,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<u64> {
    let (root, present) = current_root_and_document_paths(&library)?;
    let mut connection = lock_user(&user)?;
    import_annotation_rows(
        &mut connection,
        &normalize_root(&root),
        annotations,
        &fingerprints,
        &present,
        now_millis(),
    )
}

// ---- Collections (docs/plan-collections.md §3.2) ----
//
// Contract with `src/lib/backend.ts` (snake_case parameter ↔ camelCase
// invoke key): `collection_id` ↔ `collectionId`, `relative_path` ↔
// `relativePath`, `ordered_paths` ↔ `orderedPaths`, `id`/`name` unchanged.
// Every write is scoped to the open `library_root`; item paths are stored
// as plain strings and never used for file access (opening a document
// still goes through `open_document`'s canonicalized boundary).

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub item_count: u64,
    /// Items whose path is in the current scan snapshot — the list health
    /// indicator (`presentCount/itemCount` badge).
    pub present_count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionItem {
    pub relative_path: String,
    pub position: u32,
    pub added_at: u64,
    /// Whether the path is in the current scan snapshot; missing items are
    /// kept (greyed out in the UI) and never auto-deleted (CO-D3).
    pub present: bool,
}

/// Collections of the open library with item/present counts, in stable
/// `(created_at, id)` order (the list itself is never reordered, CO-D4).
#[tauri::command]
pub fn list_collections(
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Vec<CollectionSummary>> {
    let (root, present) = current_root_and_document_paths(&library)?;
    let connection = lock_user(&user)?;
    list_collection_rows(&connection, &normalize_root(&root), &present)
}

#[tauri::command]
pub fn create_collection(
    id: String,
    name: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Collection> {
    let root = current_root(&library)?;
    let connection = lock_user(&user)?;
    create_collection_row(
        &connection,
        &normalize_root(&root),
        &id,
        &name,
        now_millis(),
    )
}

#[tauri::command]
pub fn rename_collection(
    id: String,
    name: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let connection = lock_user(&user)?;
    rename_collection_row(
        &connection,
        &normalize_root(&root),
        &id,
        &name,
        now_millis(),
    )
}

/// Deletes the collection row and its items in one transaction. The
/// documents themselves — and their annotations, reviews and reading
/// positions — are untouched by design (plan §2 goal 5).
#[tauri::command]
pub fn delete_collection(
    id: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let mut connection = lock_user(&user)?;
    delete_collection_row(&mut connection, &normalize_root(&root), &id)
}

/// Items of one collection in manual order. Title and format are resolved
/// by the frontend from its `documents` snapshot, so there is exactly one
/// source for document titles.
#[tauri::command]
pub fn list_collection_items(
    collection_id: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Vec<CollectionItem>> {
    let (root, present) = current_root_and_document_paths(&library)?;
    let connection = lock_user(&user)?;
    list_collection_item_rows(
        &connection,
        &normalize_root(&root),
        &collection_id,
        &present,
    )
}

/// Appends a document to a collection. The path must be part of the
/// current scan snapshot (documents can only be *added* while they exist
/// in the library); re-adding an existing item is idempotent and returns
/// the stored row unchanged.
#[tauri::command]
pub fn add_collection_item(
    collection_id: String,
    relative_path: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<CollectionItem> {
    let (root, present) = current_root_and_document_paths(&library)?;
    let mut connection = lock_user(&user)?;
    add_collection_item_row(
        &mut connection,
        &normalize_root(&root),
        &present,
        &collection_id,
        &relative_path,
        now_millis(),
    )
}

#[tauri::command]
pub fn remove_collection_item(
    collection_id: String,
    relative_path: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let mut connection = lock_user(&user)?;
    remove_collection_item_row(
        &mut connection,
        &normalize_root(&root),
        &collection_id,
        &relative_path,
        now_millis(),
    )
}

/// Rewrites the manual order (CO-D4): `ordered_paths` must be exactly the
/// current item set — anything extra, missing or duplicated aborts before
/// the first write.
#[tauri::command]
pub fn reorder_collection_items(
    collection_id: String,
    ordered_paths: Vec<String>,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let mut connection = lock_user(&user)?;
    reorder_collection_item_rows(
        &mut connection,
        &normalize_root(&root),
        &collection_id,
        &ordered_paths,
        now_millis(),
    )
}

fn lock_user<'a>(state: &'a State<'_, UserState>) -> CommandResult<MutexGuard<'a, Connection>> {
    state.inner().lock()
}

fn open_user_database(path: &Path, legacy_cache: Option<&Path>) -> CommandResult<Connection> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Cannot open user data database: {error}"))?;
    initialize_user_database(connection, Some(path), legacy_cache)
}

fn initialize_user_database(
    mut connection: Connection,
    path: Option<&Path>,
    legacy_cache: Option<&Path>,
) -> CommandResult<Connection> {
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Cannot enable user data WAL mode: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("Cannot tune user data durability: {error}"))?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Cannot read user data schema version: {error}"))?;
    if version > USER_SCHEMA_VERSION {
        // Ratchet: never touch (let alone rebuild) a database written by a
        // newer build. Annotations are irreplaceable.
        return Err(format!(
            "Annotations were written by a newer Reade version \
             (schema {version} > {USER_SCHEMA_VERSION}); update Reade to keep them"
        ));
    }
    if version < USER_SCHEMA_VERSION {
        if version > 0 {
            if let Some(path) = path {
                backup_user_database(&connection, path, version)?;
            }
        }
        let legacy_attached = attach_legacy_cache(&connection, legacy_cache)?;
        let migration = run_migration_chain(&mut connection, version, legacy_attached);
        if legacy_attached {
            // Detach even when the migration failed so the connection is not
            // left holding the cache file open.
            let _ = connection.execute_batch("DETACH DATABASE legacy");
        }
        migration?;
    }
    purge_expired_tombstones(&connection, now_millis())?;
    Ok(connection)
}

fn run_migration_chain(
    connection: &mut Connection,
    from_version: i64,
    legacy_attached: bool,
) -> CommandResult<()> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin user data migration: {error}"))?;
    for step in (from_version + 1)..=USER_SCHEMA_VERSION {
        match step {
            1 => migrate_to_v1(&transaction, legacy_attached)?,
            2 => migrate_to_v2(&transaction)?,
            3 => migrate_to_v3(&transaction)?,
            4 => migrate_to_v4(&transaction)?,
            5 => migrate_to_v5(&transaction)?,
            _ => return Err(format!("Unknown user data migration step {step}")),
        }
        transaction
            .pragma_update(None, "user_version", step)
            .map_err(|error| format!("Cannot record user data schema version {step}: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit user data migration: {error}"))
}

/// v1: the annotations table in its legacy cache-resident shape, plus the
/// one-time rescue of rows from the conversion cache. The legacy table stays
/// in the cache untouched as a fallback for one release cycle; all reads and
/// writes go through this database from now on.
fn migrate_to_v1(transaction: &Connection, legacy_attached: bool) -> CommandResult<()> {
    transaction
        .execute_batch(
            "CREATE TABLE annotations (
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
             CREATE INDEX annotations_by_doc
                 ON annotations(library_root, relative_path, updated_at DESC);",
        )
        .map_err(|error| format!("Cannot create the annotations schema: {error}"))?;
    if !legacy_attached {
        return Ok(());
    }
    let legacy_table: i64 = transaction
        .query_row(
            "SELECT count(*) FROM legacy.sqlite_master
             WHERE type = 'table' AND name = 'annotations'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot inspect the legacy annotation cache: {error}"))?;
    if legacy_table == 0 {
        return Ok(());
    }
    let expected: i64 = transaction
        .query_row("SELECT count(*) FROM legacy.annotations", [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Cannot count legacy annotations: {error}"))?;
    transaction
        .execute(
            "INSERT INTO annotations(
                 id, library_root, relative_path, kind, color, note, selected_text, title,
                 locator_json, created_at, updated_at
             )
             SELECT id, library_root, relative_path, kind, color, note, selected_text, title,
                    locator_json, created_at, updated_at
             FROM legacy.annotations",
            [],
        )
        .map_err(|error| format!("Cannot rescue annotations from the cache: {error}"))?;
    let copied: i64 = transaction
        .query_row("SELECT count(*) FROM annotations", [], |row| row.get(0))
        .map_err(|error| format!("Cannot verify rescued annotations: {error}"))?;
    if copied != expected {
        return Err(format!(
            "Annotation rescue copied {copied} of {expected} rows; aborting the migration"
        ));
    }
    Ok(())
}

/// v2: precomputed sort key, normalized search text + FTS index, and the
/// deletion tombstone. Historical rows are backfilled in place; rows whose
/// locator cannot be parsed keep the fallback sort key and are logged without
/// blocking the migration.
fn migrate_to_v2(transaction: &Connection) -> CommandResult<()> {
    transaction
        .execute_batch(
            "ALTER TABLE annotations ADD COLUMN sort_index TEXT NOT NULL DEFAULT '';
             ALTER TABLE annotations ADD COLUMN searchable_text TEXT NOT NULL DEFAULT '';
             ALTER TABLE annotations ADD COLUMN deleted_at INTEGER;",
        )
        .map_err(|error| format!("Cannot add annotation v2 columns: {error}"))?;
    let rows: Vec<(String, String, Option<String>, Option<String>)> = {
        let mut statement = transaction
            .prepare("SELECT id, locator_json, selected_text, note FROM annotations")
            .map_err(|error| format!("Cannot prepare the annotation backfill: {error}"))?;
        let mapped = statement
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .map_err(|error| format!("Cannot read annotations for backfill: {error}"))?;
        mapped
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode annotations for backfill: {error}"))?
    };
    for (id, locator_json, selected_text, note) in rows {
        let sort_index = match serde_json::from_str::<AnnotationLocator>(&locator_json) {
            Ok(locator) => derive_sort_index(&locator),
            Err(error) => {
                eprintln!(
                    "reade: annotation {id} has an unreadable locator ({error}); \
                     assigning the fallback sort key"
                );
                BROKEN_SORT_INDEX.to_owned()
            }
        };
        let searchable = build_searchable_text(selected_text.as_deref(), note.as_deref());
        transaction
            .execute(
                "UPDATE annotations SET sort_index = ?1, searchable_text = ?2 WHERE id = ?3",
                params![sort_index, searchable, id],
            )
            .map_err(|error| format!("Cannot backfill annotation {id}: {error}"))?;
    }
    // The FTS index is created after the backfill so the single 'rebuild'
    // pass indexes final values. `annotations` keeps its implicit rowid as
    // the external-content key; never VACUUM this database in place (backups
    // use VACUUM INTO), because a plain VACUUM may renumber rowids.
    transaction
        .execute_batch(
            "CREATE VIRTUAL TABLE annotations_fts USING fts5(
                 searchable_text,
                 content = 'annotations',
                 tokenize = 'trigram'
             );
             CREATE TRIGGER annotations_fts_insert AFTER INSERT ON annotations BEGIN
                 INSERT INTO annotations_fts(rowid, searchable_text)
                 VALUES (new.rowid, new.searchable_text);
             END;
             CREATE TRIGGER annotations_fts_delete AFTER DELETE ON annotations BEGIN
                 INSERT INTO annotations_fts(annotations_fts, rowid, searchable_text)
                 VALUES ('delete', old.rowid, old.searchable_text);
             END;
             CREATE TRIGGER annotations_fts_update AFTER UPDATE ON annotations BEGIN
                 INSERT INTO annotations_fts(annotations_fts, rowid, searchable_text)
                 VALUES ('delete', old.rowid, old.searchable_text);
                 INSERT INTO annotations_fts(rowid, searchable_text)
                 VALUES (new.rowid, new.searchable_text);
             END;
             INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild');",
        )
        .map_err(|error| format!("Cannot create the annotation search index: {error}"))?;
    Ok(())
}

/// v3: the document fingerprint table backing the move-detection rebind
/// chain (`docs/research-annotation-data-models.md` §5.5/§5.2). Beyond the
/// §5.2 draft columns, `source_modified` stores the file mtime so refreshes
/// can skip re-hashing unchanged files purely from this table's `(file_size,
/// source_modified)` pair — without it every app launch would re-read the
/// full text of every Markdown document in the library.
fn migrate_to_v3(transaction: &Connection) -> CommandResult<()> {
    transaction
        .execute_batch(
            "CREATE TABLE documents (
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 content_hash TEXT NOT NULL,
                 file_size INTEGER NOT NULL,
                 source_modified INTEGER NOT NULL DEFAULT 0,
                 last_seen_at INTEGER NOT NULL,
                 PRIMARY KEY (library_root, relative_path)
             );
             CREATE INDEX documents_by_hash ON documents(library_root, content_hash);",
        )
        .map_err(|error| format!("Cannot create the document fingerprint schema: {error}"))?;
    Ok(())
}

/// v4: the spaced-repetition review state table
/// (`docs/plan-annotation-review.md` §3.3). One row per *reviewed*
/// annotation, keyed by `annotation_id` without a foreign key: a tombstoned
/// annotation keeps its row until the physical purge, so undoing a deletion
/// restores the review progress. Annotations without a row use the implicit
/// initial state via `COALESCE`, so this migration backfills nothing.
fn migrate_to_v4(transaction: &Connection) -> CommandResult<()> {
    transaction
        .execute_batch(
            "CREATE TABLE annotation_reviews (
                 annotation_id TEXT PRIMARY KEY,
                 library_root TEXT NOT NULL,
                 box INTEGER NOT NULL,
                 due_at INTEGER NOT NULL,
                 last_reviewed_at INTEGER,
                 total_reviews INTEGER NOT NULL DEFAULT 0,
                 suspended INTEGER NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX reviews_due
                 ON annotation_reviews(library_root, suspended, due_at);",
        )
        .map_err(|error| format!("Cannot create the annotation review schema: {error}"))?;
    Ok(())
}

/// v5: named reading collections (`docs/plan-collections.md` §3.1). Two
/// tables, no foreign keys (the `annotation_reviews` precedent): orphan
/// defense lives in the command layer, which deletes a collection's items
/// in the same transaction as the collection row. `collection_items`
/// stores nothing but normalized library-relative path strings — deleting
/// a collection can never touch documents or annotations. The migration
/// backfills nothing.
fn migrate_to_v5(transaction: &Connection) -> CommandResult<()> {
    transaction
        .execute_batch(
            "CREATE TABLE collections (
                 id TEXT PRIMARY KEY,
                 library_root TEXT NOT NULL,
                 name TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX collections_by_root ON collections(library_root, created_at ASC);
             CREATE TABLE collection_items (
                 collection_id TEXT NOT NULL,
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 position INTEGER NOT NULL,
                 added_at INTEGER NOT NULL,
                 PRIMARY KEY (collection_id, relative_path)
             );
             CREATE INDEX collection_items_by_collection
                 ON collection_items(collection_id, position);
             CREATE INDEX collection_items_by_path
                 ON collection_items(library_root, relative_path);",
        )
        .map_err(|error| format!("Cannot create the collections schema: {error}"))?;
    Ok(())
}

fn attach_legacy_cache(connection: &Connection, legacy: Option<&Path>) -> CommandResult<bool> {
    let Some(path) = legacy else {
        return Ok(false);
    };
    // A plain ATTACH would create an empty file, which would later be
    // mistaken for a corrupt cache; only attach what already exists.
    if !path.exists() {
        return Ok(false);
    }
    connection
        .execute(
            "ATTACH DATABASE ?1 AS legacy",
            params![path.to_string_lossy()],
        )
        .map_err(|error| format!("Cannot open the legacy annotation cache: {error}"))?;
    Ok(true)
}

fn backup_user_database(
    connection: &Connection,
    path: &Path,
    version: i64,
) -> CommandResult<PathBuf> {
    let backup_path = path.with_file_name(format!("reade-user.backup-v{version}.sqlite3"));
    if backup_path.exists() {
        // A leftover from an earlier attempt at this same upgrade; the
        // current database supersedes it.
        fs::remove_file(&backup_path)
            .map_err(|error| format!("Cannot replace the stale user data backup: {error}"))?;
    }
    connection
        .execute(
            "VACUUM INTO ?1",
            params![backup_path.to_string_lossy().into_owned()],
        )
        .map_err(|error| format!("Cannot back up user data before migrating: {error}"))?;
    Ok(backup_path)
}

fn purge_expired_tombstones(connection: &Connection, now: u64) -> CommandResult<()> {
    let cutoff = now.saturating_sub(TOMBSTONE_RETENTION_MS);
    connection
        .execute(
            "DELETE FROM annotations WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            params![cutoff as i64],
        )
        .map_err(|error| format!("Cannot clean up expired annotation tombstones: {error}"))?;
    // Review state follows the annotation row: once the tombstone is
    // physically purged (or a document was cleared outright) the orphaned
    // review row goes too. While a tombstone is still alive its row is kept,
    // so undoing a deletion restores the review progress (§3.3).
    connection
        .execute(
            "DELETE FROM annotation_reviews
             WHERE annotation_id NOT IN (SELECT id FROM annotations)",
            [],
        )
        .map_err(|error| format!("Cannot clean up orphaned review state: {error}"))?;
    Ok(())
}

/// KOReader-compatible partial MD5 (`util.partialMd5`, KOReader
/// `frontend/util.lua`): read one 1 KiB block at each offset
/// `1024 << (2*i)` for `i = -1..=10`, with `i = -1` mapped to offset 0
/// (0, 1 KiB, 4 KiB, … 1 GiB), concatenate the samples and hash them.
/// Short files stop at the first partial or empty read, so the whole
/// fingerprint costs at most 12 KiB of I/O regardless of file size.
fn partial_md5_sample_offsets() -> impl Iterator<Item = u64> {
    std::iter::once(0).chain((0..=10u32).map(|i| 1024u64 << (2 * i)))
}

pub(crate) fn partial_md5_fingerprint(path: &Path) -> CommandResult<String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Cannot open document for fingerprinting: {error}"))?;
    let mut hasher = Md5::new();
    let mut buffer = [0u8; PARTIAL_MD5_BLOCK];
    for offset in partial_md5_sample_offsets() {
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("Cannot seek document for fingerprinting: {error}"))?;
        let mut filled = 0usize;
        while filled < PARTIAL_MD5_BLOCK {
            let read = file
                .read(&mut buffer[filled..])
                .map_err(|error| format!("Cannot read document for fingerprinting: {error}"))?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        hasher.update(&buffer[..filled]);
        if filled < PARTIAL_MD5_BLOCK {
            // EOF inside (or right at) this sample block: later offsets are
            // all past the end of the file.
            break;
        }
    }
    Ok(format!("pmd5:{:x}", hasher.finalize()))
}

/// Normalized-text hash for Markdown: SHA-256 over the raw bytes after
/// stripping one leading UTF-8 BOM and converting CRLF to LF (lone `\r`
/// bytes are kept). The definition must stay byte-for-byte identical to
/// `normalizedTextFingerprint` in `scripts/generate-web-library.mjs`, which
/// emits the same fingerprints into the static web manifest.
pub(crate) fn normalized_text_fingerprint(bytes: &[u8]) -> String {
    let content = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let mut normalized = Vec::with_capacity(content.len());
    let mut index = 0;
    while index < content.len() {
        if content[index] == b'\r' && content.get(index + 1) == Some(&b'\n') {
            index += 1;
            continue;
        }
        normalized.push(content[index]);
        index += 1;
    }
    format!("ntxt:{:x}", Sha256::digest(&normalized))
}

/// Content fingerprint per format (§5.5 / Q1): `pmd5:` partial MD5 for the
/// near-immutable binary formats (PDF/EPUB), `ntxt:` normalized-text SHA-256
/// for hand-edited Markdown, where the hash is a best-effort signal rather
/// than a stable identity.
pub(crate) fn compute_document_fingerprint(
    path: &Path,
    format: DocumentFormat,
) -> CommandResult<String> {
    match format {
        DocumentFormat::Markdown | DocumentFormat::Mdx => {
            let metadata = fs::metadata(path)
                .map_err(|error| format!("Cannot inspect document for fingerprinting: {error}"))?;
            if metadata.len() > MAX_MARKDOWN_BYTES {
                // The scan filters oversized Markdown; this only triggers if
                // the file grew between the scan and this read.
                return Err("Markdown document is too large to fingerprint".to_owned());
            }
            let bytes = fs::read(path)
                .map_err(|error| format!("Cannot read document for fingerprinting: {error}"))?;
            Ok(normalized_text_fingerprint(&bytes))
        }
        DocumentFormat::Pdf | DocumentFormat::Epub => partial_md5_fingerprint(path),
    }
}

/// Records fingerprints for every scanned document. Called from the
/// `open_library` / `refresh_library` pipeline after each scan; returns the
/// number of files that were actually (re-)hashed. Unchanged files — same
/// `(file_size, source_modified)` as the stored row — only get a
/// `last_seen_at` touch and cost no file I/O, so refreshing a large library
/// stays cheap. Rows for paths missing from `documents` are retained on
/// purpose (they are the §5.5 rebind clue).
pub(crate) fn sync_document_fingerprints(
    user: &UserState,
    root: &Path,
    documents: &[DocumentInfo],
) -> CommandResult<usize> {
    sync_document_fingerprints_at(user, root, documents, now_millis())
}

fn sync_document_fingerprints_at(
    user: &UserState,
    root: &Path,
    documents: &[DocumentInfo],
    now: u64,
) -> CommandResult<usize> {
    let root_key = normalize_root(root);
    // Phase 1 (short lock): the stored (size, mtime) pairs decide which
    // files need re-hashing.
    let known: HashMap<String, (i64, i64)> = {
        let connection = user.lock()?;
        let mut statement = connection
            .prepare(
                "SELECT relative_path, file_size, source_modified
                 FROM documents WHERE library_root = ?1",
            )
            .map_err(|error| format!("Cannot prepare the fingerprint lookup: {error}"))?;
        let rows = statement
            .query_map(params![root_key], |row| {
                Ok((row.get(0)?, (row.get(1)?, row.get(2)?)))
            })
            .map_err(|error| format!("Cannot read stored fingerprints: {error}"))?;
        rows.collect::<rusqlite::Result<HashMap<_, _>>>()
            .map_err(|error| format!("Cannot decode stored fingerprints: {error}"))?
    };

    // Phase 2 (no lock): hash new/changed files. Failures skip the file —
    // a stale or missing fingerprint only weakens move detection and the
    // next successful refresh repairs it.
    let mut refreshed: Vec<(&str, String, u64, u64)> = Vec::new();
    let mut seen_only: Vec<&str> = Vec::new();
    for document in documents {
        let unchanged =
            known
                .get(&document.relative_path)
                .is_some_and(|&(stored_size, stored_modified)| {
                    stored_size == document.size as i64
                        && stored_modified == document.modified as i64
                });
        if unchanged {
            seen_only.push(&document.relative_path);
            continue;
        }
        // Scan output is trusted, but the canonicalized containment check is
        // kept as defense in depth before opening any file for hashing.
        let path = match resolve_existing_in_root(root, &document.relative_path) {
            Ok(path) => path,
            Err(error) => {
                eprintln!(
                    "reade: skipping fingerprint for {}: {error}",
                    document.relative_path
                );
                continue;
            }
        };
        match compute_document_fingerprint(&path, document.format) {
            Ok(hash) => refreshed.push((
                &document.relative_path,
                hash,
                document.size,
                document.modified,
            )),
            Err(error) => eprintln!(
                "reade: cannot fingerprint {}: {error}",
                document.relative_path
            ),
        }
    }

    // Phase 3 (short lock): one transaction for the whole scan batch, with
    // both statements prepared once so a ten-thousand-document refresh does
    // not re-parse SQL per row.
    let refreshed_count = refreshed.len();
    let mut connection = user.lock()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin the fingerprint update: {error}"))?;
    {
        let mut touch = transaction
            .prepare(
                "UPDATE documents SET last_seen_at = ?3
                 WHERE library_root = ?1 AND relative_path = ?2",
            )
            .map_err(|error| format!("Cannot prepare the fingerprint refresh: {error}"))?;
        for relative_path in seen_only {
            touch
                .execute(params![root_key, relative_path, now as i64])
                .map_err(|error| format!("Cannot refresh document fingerprint: {error}"))?;
        }
        let mut upsert = transaction
            .prepare(
                "INSERT INTO documents(
                     library_root, relative_path, content_hash, file_size,
                     source_modified, last_seen_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(library_root, relative_path) DO UPDATE SET
                     content_hash = excluded.content_hash,
                     file_size = excluded.file_size,
                     source_modified = excluded.source_modified,
                     last_seen_at = excluded.last_seen_at",
            )
            .map_err(|error| format!("Cannot prepare the fingerprint upsert: {error}"))?;
        for (relative_path, hash, size, modified) in refreshed {
            upsert
                .execute(params![
                    root_key,
                    relative_path,
                    hash,
                    size as i64,
                    modified as i64,
                    now as i64
                ])
                .map_err(|error| format!("Cannot store document fingerprint: {error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit document fingerprints: {error}"))?;
    Ok(refreshed_count)
}

fn detect_moved_rows(
    connection: &Connection,
    root: &str,
    present: &HashSet<String>,
) -> CommandResult<Vec<MovedDocumentCandidate>> {
    // Paths that still hold live annotations but vanished from the scan,
    // grouped by their last known fingerprint (BTreeMap for deterministic
    // output order).
    let annotated: Vec<(String, u64)> = {
        let mut statement = connection
            .prepare(
                "SELECT relative_path, count(*) FROM annotations
                 WHERE library_root = ?1 AND deleted_at IS NULL
                 GROUP BY relative_path",
            )
            .map_err(|error| format!("Cannot prepare the move detection: {error}"))?;
        let rows = statement
            .query_map(params![root], |row| {
                Ok((row.get(0)?, row.get::<_, i64>(1)? as u64))
            })
            .map_err(|error| format!("Cannot list annotated documents: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode annotated documents: {error}"))?
    };
    let mut missing_by_hash: BTreeMap<String, Vec<(String, u64)>> = BTreeMap::new();
    for (relative_path, count) in annotated {
        if present.contains(&relative_path) {
            continue;
        }
        let hash: Option<String> = connection
            .query_row(
                "SELECT content_hash FROM documents
                 WHERE library_root = ?1 AND relative_path = ?2",
                params![root, relative_path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Cannot look up a document fingerprint: {error}"))?;
        // No stored fingerprint means no rebind clue; the path stays in the
        // (future §5.6) manual-rebind list instead.
        if let Some(hash) = hash {
            missing_by_hash
                .entry(hash)
                .or_default()
                .push((relative_path, count));
        }
    }

    let mut results = Vec::new();
    for (hash, mut old_entries) in missing_by_hash {
        let candidates: Vec<String> = {
            let mut statement = connection
                .prepare(
                    "SELECT relative_path FROM documents
                     WHERE library_root = ?1 AND content_hash = ?2
                     ORDER BY relative_path ASC",
                )
                .map_err(|error| format!("Cannot prepare the candidate lookup: {error}"))?;
            let rows = statement
                .query_map(params![root, hash], |row| row.get::<_, String>(0))
                .map_err(|error| format!("Cannot list rebind candidates: {error}"))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| format!("Cannot decode rebind candidates: {error}"))?
                .into_iter()
                // Only paths present in the current scan are rebind targets;
                // this also excludes the missing old paths themselves.
                .filter(|path| present.contains(path))
                .collect()
        };
        if candidates.is_empty() {
            continue;
        }
        old_entries.sort();
        let ambiguous = old_entries.len() > 1 || candidates.len() > 1;
        for (old_path, annotation_count) in &old_entries {
            for new_path in &candidates {
                results.push(MovedDocumentCandidate {
                    old_path: old_path.clone(),
                    new_path: new_path.clone(),
                    annotation_count: *annotation_count,
                    ambiguous,
                });
            }
        }
    }
    results.sort_by(|a, b| {
        a.old_path
            .cmp(&b.old_path)
            .then_with(|| a.new_path.cmp(&b.new_path))
    });
    Ok(results)
}

/// Shared string-level validation for both rebind parameters: library-relative,
/// no traversal, non-empty after normalization, and actually two different
/// paths. Filesystem existence is checked separately (only the new path can
/// still exist).
fn validate_rebind_paths(old_path: &str, new_path: &str) -> CommandResult<(String, String)> {
    validate_relative_library_path(old_path)?;
    validate_relative_library_path(new_path)?;
    let old_normalized = normalize_relative_path(Path::new(old_path));
    let new_normalized = normalize_relative_path(Path::new(new_path));
    if old_normalized.is_empty() || new_normalized.is_empty() {
        return Err("A non-empty relative path is required".to_owned());
    }
    if old_normalized == new_normalized {
        return Err("Rebinding requires two different paths".to_owned());
    }
    Ok((old_normalized, new_normalized))
}

fn rebind_annotation_rows(
    connection: &mut Connection,
    root: &str,
    old_path: &str,
    new_path: &str,
) -> CommandResult<u64> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin the annotation rebind: {error}"))?;
    // Tombstones move too: deletion history must follow the document so a
    // future sync/export cannot resurrect annotations under the old path.
    let migrated = transaction
        .execute(
            "UPDATE annotations SET relative_path = ?1
             WHERE library_root = ?2 AND relative_path = ?3",
            params![new_path, root, old_path],
        )
        .map_err(|error| format!("Cannot rebind annotations: {error}"))?;
    // Collection items follow the same rebind confirmation (CO-D3): the
    // membership follows the content to its new path. `UPDATE OR IGNORE`
    // skips items whose collection already contains the new path (primary
    // key conflict); the follow-up DELETE clears those leftovers.
    transaction
        .execute(
            "UPDATE OR IGNORE collection_items SET relative_path = ?1
             WHERE library_root = ?2 AND relative_path = ?3",
            params![new_path, root, old_path],
        )
        .map_err(|error| format!("Cannot rebind collection items: {error}"))?;
    transaction
        .execute(
            "DELETE FROM collection_items WHERE library_root = ?1 AND relative_path = ?2",
            params![root, old_path],
        )
        .map_err(|error| format!("Cannot drop stale collection items: {error}"))?;
    // The old path's fingerprint row is spent: its identity now lives at the
    // new path (whose row the scan maintains). Dropping it keeps future
    // detections from pairing against a path that no longer exists.
    transaction
        .execute(
            "DELETE FROM documents WHERE library_root = ?1 AND relative_path = ?2",
            params![root, old_path],
        )
        .map_err(|error| format!("Cannot drop the stale document fingerprint: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit the annotation rebind: {error}"))?;
    Ok(migrated as u64)
}

fn list_annotation_rows(
    connection: &Connection,
    root: &str,
    relative_path: Option<&str>,
) -> CommandResult<Vec<Annotation>> {
    let mut statement = if relative_path.is_some() {
        connection.prepare(
            "SELECT id, relative_path, kind, color, note, selected_text, title, locator_json,
                    sort_index, created_at, updated_at, deleted_at
             FROM annotations
             WHERE library_root = ?1 AND relative_path = ?2 AND deleted_at IS NULL
             ORDER BY updated_at DESC, id ASC",
        )
    } else {
        connection.prepare(
            "SELECT id, relative_path, kind, color, note, selected_text, title, locator_json,
                    sort_index, created_at, updated_at, deleted_at
             FROM annotations
             WHERE library_root = ?1 AND deleted_at IS NULL
             ORDER BY updated_at DESC, id ASC",
        )
    }
    .map_err(|error| format!("Cannot prepare annotation list: {error}"))?;

    let mapped = if let Some(path) = relative_path {
        statement.query_map(params![root, path], annotation_from_row)
    } else {
        statement.query_map(params![root], annotation_from_row)
    }
    .map_err(|error| format!("Cannot list annotations: {error}"))?;

    let mut annotations = Vec::new();
    for row in mapped {
        annotations.push(row.map_err(|error| format!("Cannot decode annotation: {error}"))?);
    }
    Ok(annotations)
}

/// The 12 annotation columns every row-decoding query must select, in the
/// exact order `annotation_from_row` expects.
const ANNOTATION_COLUMNS: &str = "id, relative_path, kind, color, note, selected_text, title,
     locator_json, sort_index, created_at, updated_at, deleted_at";

fn transfer_annotation_rows(connection: &Connection, root: &str) -> CommandResult<Vec<Annotation>> {
    let sql = format!(
        "SELECT {ANNOTATION_COLUMNS}
         FROM annotations
         WHERE library_root = ?1
         ORDER BY relative_path ASC, sort_index ASC, id ASC"
    );
    query_annotations(connection, &sql, params![root])
}

fn document_fingerprint_rows(
    connection: &Connection,
    root: &str,
) -> CommandResult<Vec<DocumentFingerprintEntry>> {
    let mut statement = connection
        .prepare(
            "SELECT relative_path, content_hash FROM documents
             WHERE library_root = ?1 ORDER BY relative_path ASC",
        )
        .map_err(|error| format!("Cannot prepare the fingerprint listing: {error}"))?;
    let mapped = statement
        .query_map(params![root], |row| {
            Ok(DocumentFingerprintEntry {
                relative_path: row.get(0)?,
                content_hash: row.get(1)?,
            })
        })
        .map_err(|error| format!("Cannot list document fingerprints: {error}"))?;
    let mut entries = Vec::new();
    for row in mapped {
        entries
            .push(row.map_err(|error| format!("Cannot decode a document fingerprint: {error}"))?);
    }
    Ok(entries)
}

/// `pmd5:` partial MD5 or `ntxt:` normalized-text SHA-256, lowercase hex —
/// exactly the two formats `compute_document_fingerprint` produces and the
/// only ones an import may seed into the fingerprint table.
fn is_valid_transfer_content_hash(value: &str) -> bool {
    let lowercase_hex = |text: &str, length: usize| {
        text.len() == length
            && text
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    };
    value
        .strip_prefix("pmd5:")
        .map(|rest| lowercase_hex(rest, 32))
        .or_else(|| {
            value
                .strip_prefix("ntxt:")
                .map(|rest| lowercase_hex(rest, 64))
        })
        .unwrap_or(false)
}

fn import_annotation_rows(
    connection: &mut Connection,
    root: &str,
    annotations: Vec<Annotation>,
    fingerprints: &[DocumentFingerprintEntry],
    present: &HashSet<String>,
    now: u64,
) -> CommandResult<u64> {
    if annotations.len() > MAX_IMPORT_ANNOTATIONS {
        return Err(format!(
            "Import exceeds the {MAX_IMPORT_ANNOTATIONS}-annotation limit"
        ));
    }
    if fingerprints.len() > MAX_IMPORT_FINGERPRINTS {
        return Err(format!(
            "Import exceeds the {MAX_IMPORT_FINGERPRINTS}-document limit"
        ));
    }
    // Everything is validated before the first write so a bad record can
    // never leave a partial import behind.
    let mut sanitized = Vec::with_capacity(annotations.len());
    for annotation in annotations {
        sanitized.push(sanitize_annotation(annotation)?);
    }
    let mut fingerprint_rows = Vec::with_capacity(fingerprints.len());
    for entry in fingerprints {
        validate_relative_library_path(&entry.relative_path)?;
        let normalized = normalize_relative_path(Path::new(&entry.relative_path));
        if normalized.is_empty() {
            return Err("A non-empty relative path is required".to_owned());
        }
        if !is_valid_transfer_content_hash(&entry.content_hash) {
            return Err(format!("Invalid content hash for {normalized}"));
        }
        fingerprint_rows.push((normalized, entry.content_hash.as_str()));
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin the annotation import: {error}"))?;
    for annotation in &sanitized {
        upsert_annotation_row(&transaction, root, annotation)?;
    }
    for (relative_path, content_hash) in &fingerprint_rows {
        // Present paths keep their scan-maintained rows; existing rows for
        // missing paths (a locally known hash) are authoritative too.
        if present.contains(relative_path) {
            continue;
        }
        transaction
            .execute(
                "INSERT INTO documents(
                     library_root, relative_path, content_hash, file_size,
                     source_modified, last_seen_at
                 ) VALUES (?1, ?2, ?3, 0, 0, ?4)
                 ON CONFLICT(library_root, relative_path) DO NOTHING",
                params![root, relative_path, content_hash, now as i64],
            )
            .map_err(|error| format!("Cannot record an imported fingerprint: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit the annotation import: {error}"))?;
    Ok(sanitized.len() as u64)
}

/// Shared WHERE clause for review-queue candidates: live mark annotations
/// with a non-blank excerpt (bookmarks and empty selections never enter the
/// pool, review plan §3.1), not suspended, and due by `?3`. `COALESCE`
/// implements the lazy initial state: no review row means box 0, due at
/// `created_at + ?2` (one day). Parameters: ?1 root, ?2 implicit due
/// offset, ?3 now.
const REVIEW_CANDIDATE_CONDITIONS: &str = "a.library_root = ?1
       AND a.deleted_at IS NULL
       AND a.kind IN ('highlight', 'underline')
       AND a.selected_text IS NOT NULL
       AND trim(a.selected_text, ' \t\r\n') <> ''
       AND COALESCE(r.suspended, 0) = 0
       AND COALESCE(r.due_at, a.created_at + ?2) <= ?3";

fn review_queue_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewQueueItem> {
    let annotation = annotation_from_row(row)?;
    Ok(ReviewQueueItem {
        annotation,
        review: ReviewState {
            box_level: row.get(12)?,
            due_at: row.get::<_, i64>(13)? as u64,
            last_reviewed_at: row.get::<_, Option<i64>>(14)?.map(|value| value as u64),
            total_reviews: row.get::<_, i64>(15)? as u64,
            suspended: row.get::<_, i64>(16)? != 0,
        },
    })
}

fn list_review_queue_rows(
    connection: &Connection,
    root: &str,
    now_ms: u64,
    limit: usize,
) -> CommandResult<Vec<ReviewQueueItem>> {
    let capped = limit.clamp(1, MAX_REVIEW_QUEUE_LIMIT);
    let fetch = (capped * REVIEW_QUEUE_OVERFETCH) as i64;
    let sql = format!(
        "SELECT a.id, a.relative_path, a.kind, a.color, a.note, a.selected_text, a.title,
                a.locator_json, a.sort_index, a.created_at, a.updated_at, a.deleted_at,
                COALESCE(r.box, 0),
                COALESCE(r.due_at, a.created_at + ?2),
                r.last_reviewed_at,
                COALESCE(r.total_reviews, 0),
                COALESCE(r.suspended, 0)
         FROM annotations a
         LEFT JOIN annotation_reviews r
             ON r.annotation_id = a.id AND r.library_root = a.library_root
         WHERE {REVIEW_CANDIDATE_CONDITIONS}
         ORDER BY COALESCE(r.due_at, a.created_at + ?2) ASC, a.id ASC
         LIMIT ?4"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Cannot prepare the review queue: {error}"))?;
    let mapped = statement
        .query_map(
            params![
                root,
                REVIEW_IMPLICIT_DUE_OFFSET_MS as i64,
                now_ms.min(i64::MAX as u64) as i64,
                fetch
            ],
            review_queue_item_from_row,
        )
        .map_err(|error| format!("Cannot list the review queue: {error}"))?;
    let mut items = Vec::new();
    for row in mapped {
        items.push(row.map_err(|error| format!("Cannot decode a review queue item: {error}"))?);
    }
    Ok(items)
}

// The parameter list mirrors the review columns on purpose.
#[allow(clippy::too_many_arguments)]
fn record_review_outcome_row(
    connection: &Connection,
    root: &str,
    annotation_id: &str,
    box_level: i64,
    due_at: u64,
    last_reviewed_at: Option<u64>,
    suspended: bool,
    now: u64,
) -> CommandResult<()> {
    validate_annotation_id(annotation_id)?;
    if !(0..=REVIEW_MAX_BOX).contains(&box_level) {
        return Err(format!("Review box must be between 0 and {REVIEW_MAX_BOX}"));
    }
    let earliest = now.saturating_sub(REVIEW_DUE_PAST_SLACK_MS);
    let latest = now.saturating_add(REVIEW_DUE_FUTURE_LIMIT_MS);
    if due_at < earliest || due_at > latest {
        return Err("Review due date is out of range".to_owned());
    }
    if let Some(reviewed_at) = last_reviewed_at {
        if reviewed_at > now.saturating_add(REVIEW_DUE_PAST_SLACK_MS) {
            return Err("Review timestamp is in the future".to_owned());
        }
    }
    let live: i64 = connection
        .query_row(
            "SELECT count(*) FROM annotations
             WHERE id = ?1 AND library_root = ?2 AND deleted_at IS NULL",
            params![annotation_id, root],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot verify the reviewed annotation: {error}"))?;
    if live == 0 {
        return Err("Annotation was not found".to_owned());
    }
    // Suspending is bookkeeping, not a review: total_reviews only counts
    // remembered/again outcomes (review plan §3.4).
    let increment: i64 = i64::from(!suspended);
    connection
        .execute(
            "INSERT INTO annotation_reviews(
                 annotation_id, library_root, box, due_at, last_reviewed_at,
                 total_reviews, suspended, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(annotation_id) DO UPDATE SET
                 library_root = excluded.library_root,
                 box = excluded.box,
                 due_at = excluded.due_at,
                 last_reviewed_at = excluded.last_reviewed_at,
                 total_reviews = annotation_reviews.total_reviews + ?6,
                 suspended = excluded.suspended,
                 updated_at = excluded.updated_at",
            params![
                annotation_id,
                root,
                box_level,
                due_at as i64,
                last_reviewed_at.map(|value| value as i64),
                increment,
                i64::from(suspended),
                now as i64,
            ],
        )
        .map_err(|error| format!("Cannot save the review outcome: {error}"))?;
    Ok(())
}

fn review_summary_rows(
    connection: &Connection,
    root: &str,
    day_start_ms: u64,
    now_ms: u64,
) -> CommandResult<ReviewSummary> {
    if day_start_ms > now_ms {
        return Err("The review summary range start must not exceed its end".to_owned());
    }
    let sql = format!(
        "SELECT count(*)
         FROM annotations a
         LEFT JOIN annotation_reviews r
             ON r.annotation_id = a.id AND r.library_root = a.library_root
         WHERE {REVIEW_CANDIDATE_CONDITIONS}"
    );
    let now_clamped = now_ms.min(i64::MAX as u64) as i64;
    let due_count: i64 = connection
        .query_row(
            &sql,
            params![root, REVIEW_IMPLICIT_DUE_OFFSET_MS as i64, now_clamped],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot count due reviews: {error}"))?;
    let reviewed_today: i64 = connection
        .query_row(
            "SELECT count(*) FROM annotation_reviews
             WHERE library_root = ?1
               AND last_reviewed_at IS NOT NULL
               AND last_reviewed_at >= ?2 AND last_reviewed_at <= ?3",
            params![root, day_start_ms.min(i64::MAX as u64) as i64, now_clamped],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot count today's reviews: {error}"))?;
    Ok(ReviewSummary {
        due_count: due_count as u64,
        reviewed_today: reviewed_today as u64,
    })
}

/// Truncate → NFKC → lowercase → trim, the same pipeline as
/// `normalizeAnnotationQuery` in `src/lib/annotationSearch.ts`, so both ends
/// agree on which queries are "short" and what they match. Truncation runs
/// on the raw chars (NFKC can expand a char into several).
fn normalize_search_query(raw: &str) -> String {
    raw.chars()
        .take(MAX_SEARCH_QUERY_CHARS)
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .trim()
        .to_owned()
}

/// Wraps a normalized query as one FTS5 phrase. Doubling the inner quotes
/// keeps user text out of the MATCH grammar (`OR`/`NEAR`/`*` stay literal),
/// so the trigram index behaves as a plain substring search.
fn fts_phrase(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

/// `%…%` pattern with `%`/`_`/`\` escaped for `LIKE … ESCAPE '\'`, used by
/// the short-query fallback and the title supplement.
fn like_pattern(query: &str) -> String {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

fn query_annotations(
    connection: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> CommandResult<Vec<Annotation>> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Cannot prepare the annotation search: {error}"))?;
    let mapped = statement
        .query_map(params, annotation_from_row)
        .map_err(|error| format!("Cannot search annotations: {error}"))?;
    let mut annotations = Vec::new();
    for row in mapped {
        annotations.push(row.map_err(|error| format!("Cannot decode annotation: {error}"))?);
    }
    Ok(annotations)
}

fn search_annotation_rows(
    connection: &Connection,
    root: &str,
    query: &str,
    limit: usize,
) -> CommandResult<Vec<Annotation>> {
    let normalized = normalize_search_query(query);
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    let capped = limit.clamp(1, MAX_ANNOTATION_SEARCH_RESULTS);
    let fetch = capped as i64;
    let mut results = if normalized.chars().count() >= MIN_FTS_QUERY_CHARS {
        let sql = format!(
            "SELECT {ANNOTATION_COLUMNS}
             FROM annotations
             WHERE rowid IN (SELECT rowid FROM annotations_fts
                             WHERE annotations_fts MATCH ?1)
               AND library_root = ?2 AND deleted_at IS NULL
             ORDER BY relative_path ASC, sort_index ASC, id ASC
             LIMIT ?3"
        );
        query_annotations(
            connection,
            &sql,
            params![fts_phrase(&normalized), root, fetch],
        )?
    } else {
        let sql = format!(
            "SELECT {ANNOTATION_COLUMNS}
             FROM annotations
             WHERE library_root = ?2 AND deleted_at IS NULL
               AND searchable_text LIKE ?1 ESCAPE '\\'
             ORDER BY relative_path ASC, sort_index ASC, id ASC
             LIMIT ?3"
        );
        query_annotations(
            connection,
            &sql,
            params![like_pattern(&normalized), root, fetch],
        )?
    };
    // Bookmark titles are not part of searchable_text (decision A-D3: no
    // schema change); a LIKE supplement over `title` merges them in. LIKE is
    // only ASCII-case-insensitive, so unlike selected_text/note the title
    // match is byte-wise for non-ASCII case — see the TS contract note.
    if results.len() < capped {
        let sql = format!(
            "SELECT {ANNOTATION_COLUMNS}
             FROM annotations
             WHERE library_root = ?2 AND deleted_at IS NULL
               AND title IS NOT NULL AND title LIKE ?1 ESCAPE '\\'
             ORDER BY relative_path ASC, sort_index ASC, id ASC
             LIMIT ?3"
        );
        let supplement = query_annotations(
            connection,
            &sql,
            params![like_pattern(&normalized), root, fetch],
        )?;
        let seen: HashSet<&str> = results.iter().map(|a| a.id.as_str()).collect();
        let missing: Vec<Annotation> = supplement
            .into_iter()
            .filter(|annotation| !seen.contains(annotation.id.as_str()))
            .collect();
        results.extend(missing);
    }
    results.sort_by(|a, b| {
        a.relative_path
            .cmp(&b.relative_path)
            .then_with(|| a.sort_index.cmp(&b.sort_index))
            .then_with(|| a.id.cmp(&b.id))
    });
    results.truncate(capped);
    Ok(results)
}

fn upsert_annotation_row(
    connection: &Connection,
    root: &str,
    annotation: &Annotation,
) -> CommandResult<()> {
    let locator_json = serde_json::to_string(&annotation.locator)
        .map_err(|error| format!("Cannot encode annotation locator: {error}"))?;
    let kind = annotation_kind_to_db(&annotation.kind);
    let color = annotation.color.as_ref().map(annotation_color_to_db);
    let searchable = build_searchable_text(
        annotation.selected_text.as_deref(),
        annotation.note.as_deref(),
    );
    connection
        .execute(
            "INSERT INTO annotations(
                 id, library_root, relative_path, kind, color, note, selected_text, title,
                 locator_json, sort_index, searchable_text, created_at, updated_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
                 library_root = excluded.library_root,
                 relative_path = excluded.relative_path,
                 kind = excluded.kind,
                 color = excluded.color,
                 note = excluded.note,
                 selected_text = excluded.selected_text,
                 title = excluded.title,
                 locator_json = excluded.locator_json,
                 sort_index = excluded.sort_index,
                 searchable_text = excluded.searchable_text,
                 created_at = excluded.created_at,
                 updated_at = excluded.updated_at,
                 deleted_at = excluded.deleted_at
             WHERE annotations.library_root = excluded.library_root",
            params![
                annotation.id,
                root,
                annotation.relative_path,
                kind,
                color,
                annotation.note,
                annotation.selected_text,
                annotation.title,
                locator_json,
                annotation.sort_index,
                searchable,
                annotation.created_at as i64,
                annotation.updated_at as i64,
                annotation.deleted_at.map(|value| value as i64),
            ],
        )
        .map_err(|error| format!("Cannot save annotation: {error}"))?;
    let owned: i64 = connection
        .query_row(
            "SELECT count(*) FROM annotations WHERE id = ?1 AND library_root = ?2",
            params![annotation.id, root],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot verify annotation ownership: {error}"))?;
    if owned == 0 {
        return Err("Annotation id belongs to another library".to_owned());
    }
    Ok(())
}

/// Deleting writes a tombstone so deletions survive restarts and can later be
/// synchronized or undone; the row is purged 90 days later. Explicitly
/// clearing a document (`clear_annotation_rows`) purges immediately.
fn tombstone_annotation(
    connection: &Connection,
    root: &str,
    id: &str,
    now: u64,
) -> CommandResult<()> {
    let updated = connection
        .execute(
            "UPDATE annotations SET deleted_at = ?1, updated_at = ?2
             WHERE id = ?3 AND library_root = ?4 AND deleted_at IS NULL",
            params![now as i64, now as i64, id, root],
        )
        .map_err(|error| format!("Cannot delete annotation: {error}"))?;
    if updated == 0 {
        return Err("Annotation was not found".to_owned());
    }
    Ok(())
}

fn clear_annotation_rows(
    connection: &Connection,
    root: &str,
    relative_path: &str,
) -> CommandResult<()> {
    connection
        .execute(
            "DELETE FROM annotations WHERE library_root = ?1 AND relative_path = ?2",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot clear document annotations: {error}"))?;
    Ok(())
}

fn annotation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Annotation> {
    let kind_raw: String = row.get(2)?;
    let color_raw: Option<String> = row.get(3)?;
    let locator_json: String = row.get(7)?;
    let locator = serde_json::from_str(&locator_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Annotation {
        id: row.get(0)?,
        relative_path: row.get(1)?,
        kind: annotation_kind_from_db(&kind_raw).map_err(|message| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                message.into(),
            )
        })?,
        color: color_raw
            .map(|value| annotation_color_from_db(&value))
            .transpose()
            .map_err(|message| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    message.into(),
                )
            })?,
        note: row.get(4)?,
        selected_text: row.get(5)?,
        title: row.get(6)?,
        locator,
        sort_index: row.get(8)?,
        created_at: row.get::<_, i64>(9)? as u64,
        updated_at: row.get::<_, i64>(10)? as u64,
        deleted_at: row.get::<_, Option<i64>>(11)?.map(|value| value as u64),
    })
}

fn annotation_kind_to_db(kind: &AnnotationKind) -> &'static str {
    match kind {
        AnnotationKind::Highlight => "highlight",
        AnnotationKind::Underline => "underline",
        AnnotationKind::Bookmark => "bookmark",
    }
}

fn annotation_kind_from_db(value: &str) -> Result<AnnotationKind, String> {
    match value {
        "highlight" => Ok(AnnotationKind::Highlight),
        "underline" => Ok(AnnotationKind::Underline),
        "bookmark" => Ok(AnnotationKind::Bookmark),
        _ => Err(format!("Unknown annotation kind: {value}")),
    }
}

fn annotation_color_to_db(color: &AnnotationColor) -> &'static str {
    match color {
        AnnotationColor::Yellow => "yellow",
        AnnotationColor::Green => "green",
        AnnotationColor::Blue => "blue",
        AnnotationColor::Pink => "pink",
    }
}

fn annotation_color_from_db(value: &str) -> Result<AnnotationColor, String> {
    match value {
        "yellow" => Ok(AnnotationColor::Yellow),
        "green" => Ok(AnnotationColor::Green),
        "blue" => Ok(AnnotationColor::Blue),
        "pink" => Ok(AnnotationColor::Pink),
        _ => Err(format!("Unknown annotation color: {value}")),
    }
}

/// `searchable_text = selected_text + '\x1f' + note`, NFKC-normalized, so
/// full-width/compatibility variants match their canonical forms in search.
fn build_searchable_text(selected_text: Option<&str>, note: Option<&str>) -> String {
    let mut raw = String::new();
    raw.push_str(selected_text.unwrap_or(""));
    raw.push(SEARCHABLE_TEXT_SEPARATOR);
    raw.push_str(note.unwrap_or(""));
    raw.nfkc().collect()
}

fn sort_slots(prefix: char, high: u64, low: u64) -> String {
    format!(
        "{prefix}|{:05}|{:08}",
        high.min(MAX_SORT_PAGE_SLOT),
        low.min(MAX_SORT_OFFSET_SLOT)
    )
}

fn ratio_slot(ratio: f64) -> u64 {
    if !ratio.is_finite() || ratio <= 0.0 {
        return 0;
    }
    (ratio * 100_000_000.0).round() as u64
}

/// Derives the position sort key from a locator. The encoding mirrors
/// `deriveAnnotationSortIndex` in `src/lib/annotations.ts` and must stay in
/// sync with it:
/// - markdown: `M|00000|<start>` (start hint, 0 when absent)
/// - pdf: `P|<page>|<offset>` (offset = first rect y × 10000; ratio × 10^8
///   for bookmarks)
/// - epub: `E|<chapter slot>|<offset>` (chapter slot is 0 without a chapter
///   order context; offset = chapter-level start hint, else
///   blockIndex × 10^4 + min(startOffset, 9999))
pub(crate) fn derive_sort_index(locator: &AnnotationLocator) -> String {
    match locator {
        AnnotationLocator::Markdown { start, .. } => {
            sort_slots('M', 0, start.map(u64::from).unwrap_or(0))
        }
        AnnotationLocator::Pdf { page, rects, .. } => {
            let offset = rects
                .first()
                .map(|rect| {
                    if rect.y.is_finite() && rect.y > 0.0 {
                        (rect.y * 10_000.0).round() as u64
                    } else {
                        0
                    }
                })
                .unwrap_or(0);
            sort_slots('P', u64::from(*page), offset)
        }
        AnnotationLocator::Epub {
            start,
            block_index,
            start_offset,
            ..
        } => {
            let offset = start.map(u64::from).unwrap_or_else(|| {
                u64::from(*block_index) * 10_000 + u64::from(*start_offset).min(9_999)
            });
            sort_slots('E', 0, offset)
        }
        AnnotationLocator::Bookmark { target } => match target {
            BookmarkTarget::Markdown { scroll_ratio, .. } => {
                sort_slots('M', 0, ratio_slot(*scroll_ratio))
            }
            BookmarkTarget::Pdf { page, offset_ratio } => {
                sort_slots('P', u64::from(*page), ratio_slot(*offset_ratio))
            }
            BookmarkTarget::Epub { scroll_ratio, .. } => {
                sort_slots('E', 0, ratio_slot(*scroll_ratio))
            }
        },
    }
}

fn is_valid_sort_index(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != SORT_INDEX_CHARS {
        return false;
    }
    matches!(bytes[0], b'E' | b'M' | b'P' | b'Z')
        && bytes[1] == b'|'
        && bytes[2..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'|'
        && bytes[8..].iter().all(u8::is_ascii_digit)
}

fn sanitize_annotation(mut annotation: Annotation) -> CommandResult<Annotation> {
    validate_annotation_id(&annotation.id)?;
    validate_relative_library_path(&annotation.relative_path)?;
    annotation.relative_path = normalize_relative_path(Path::new(&annotation.relative_path));
    annotation.note = sanitize_optional_text(annotation.note, MAX_ANNOTATION_NOTE_CHARS, "note")?;
    annotation.title =
        sanitize_optional_text(annotation.title, MAX_ANNOTATION_TITLE_CHARS, "title")?;
    annotation.selected_text = sanitize_optional_text(
        annotation.selected_text,
        MAX_ANNOTATION_TEXT_CHARS,
        "selected text",
    )?;
    match annotation.kind {
        AnnotationKind::Highlight | AnnotationKind::Underline => {
            if annotation.color.is_none() {
                return Err("Mark annotations require a color".to_owned());
            }
            match &annotation.locator {
                AnnotationLocator::Markdown { .. }
                | AnnotationLocator::Pdf { .. }
                | AnnotationLocator::Epub { .. } => {}
                AnnotationLocator::Bookmark { .. } => {
                    return Err("Mark annotations cannot use a bookmark locator".to_owned());
                }
            }
        }
        AnnotationKind::Bookmark => {
            if !matches!(annotation.locator, AnnotationLocator::Bookmark { .. }) {
                return Err("Bookmark annotations require a bookmark locator".to_owned());
            }
        }
    }
    sanitize_locator_limits(&annotation.locator)?;
    // The client normally precomputes the sort key; recompute it as the
    // server-side fallback when absent, reject it when malformed.
    if annotation.sort_index.is_empty() {
        annotation.sort_index = derive_sort_index(&annotation.locator);
    } else if !is_valid_sort_index(&annotation.sort_index) {
        return Err("Annotation sort index is invalid".to_owned());
    }
    if annotation.created_at == 0 || annotation.updated_at == 0 {
        return Err("Annotation timestamps are required".to_owned());
    }
    if annotation.deleted_at == Some(0) {
        return Err("Annotation deletion timestamp is invalid".to_owned());
    }
    if annotation.updated_at < annotation.created_at {
        annotation.updated_at = annotation.created_at;
    }
    Ok(annotation)
}

fn sanitize_locator_limits(locator: &AnnotationLocator) -> CommandResult<()> {
    let (quote, prefix, suffix) = match locator {
        AnnotationLocator::Markdown {
            quote,
            prefix,
            suffix,
            start,
            end,
            ..
        }
        | AnnotationLocator::Epub {
            quote,
            prefix,
            suffix,
            start,
            end,
            ..
        } => {
            if let (Some(start), Some(end)) = (start, end) {
                if end < start {
                    return Err("Annotation position hint is inverted".to_owned());
                }
            }
            (quote, prefix, suffix)
        }
        AnnotationLocator::Pdf {
            quote,
            prefix,
            suffix,
            ..
        } => (quote, prefix, suffix),
        AnnotationLocator::Bookmark { .. } => return Ok(()),
    };
    if quote.chars().count() > MAX_ANNOTATION_TEXT_CHARS
        || prefix.chars().count() > MAX_ANNOTATION_TEXT_CHARS
        || suffix.chars().count() > MAX_ANNOTATION_TEXT_CHARS
    {
        return Err(format!(
            "Annotation quote context exceeds {MAX_ANNOTATION_TEXT_CHARS} characters"
        ));
    }
    if let AnnotationLocator::Pdf {
        view,
        rects,
        page_width,
        page_height,
        ..
    } = locator
    {
        if view != "original" && view != "reading" {
            return Err("PDF annotation view must be original or reading".to_owned());
        }
        if rects.len() > MAX_ANNOTATION_RECTS {
            return Err("PDF annotation has too many rectangles".to_owned());
        }
        for dimension in [page_width, page_height].into_iter().flatten() {
            if !dimension.is_finite() || *dimension <= 0.0 {
                return Err("PDF annotation page size is invalid".to_owned());
            }
        }
    }
    Ok(())
}

fn sanitize_optional_text(
    value: Option<String>,
    max_chars: usize,
    label: &str,
) -> CommandResult<Option<String>> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > max_chars {
        return Err(format!("Annotation {label} exceeds {max_chars} characters"));
    }
    Ok(Some(trimmed.to_owned()))
}

/// Shared id rules for client-generated identifiers (annotations and
/// collections use the same alphabet and length cap).
fn validate_id_value(id: &str, label: &str) -> CommandResult<()> {
    if id.is_empty() || id.chars().count() > MAX_ANNOTATION_ID_CHARS {
        return Err(format!("{label} id is invalid"));
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(format!("{label} id contains unsupported characters"));
    }
    Ok(())
}

fn validate_annotation_id(id: &str) -> CommandResult<()> {
    validate_id_value(id, "Annotation")
}

// ---- Collection row implementations ----

fn validate_collection_id(id: &str) -> CommandResult<()> {
    validate_id_value(id, "Collection")
}

/// Trimmed, non-empty, capped name — the same sanitation the web store
/// applies through `sanitizeCollectionName` in `src/lib/collections.ts`.
fn validate_collection_name(name: &str) -> CommandResult<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Collection name must not be empty".to_owned());
    }
    if trimmed.chars().count() > MAX_COLLECTION_NAME_CHARS {
        return Err(format!(
            "Collection name exceeds {MAX_COLLECTION_NAME_CHARS} characters"
        ));
    }
    Ok(trimmed.to_owned())
}

/// Ownership gate shared by every per-collection operation: the id must
/// exist inside the open library root (the cross-library capture rules of
/// the annotation store).
fn ensure_collection_in_root(connection: &Connection, root: &str, id: &str) -> CommandResult<()> {
    validate_collection_id(id)?;
    let owned: i64 = connection
        .query_row(
            "SELECT count(*) FROM collections WHERE id = ?1 AND library_root = ?2",
            params![id, root],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot verify collection ownership: {error}"))?;
    if owned == 0 {
        return Err("Collection was not found".to_owned());
    }
    Ok(())
}

fn touch_collection(connection: &Connection, root: &str, id: &str, now: u64) -> CommandResult<()> {
    connection
        .execute(
            "UPDATE collections SET updated_at = ?1 WHERE id = ?2 AND library_root = ?3",
            params![now as i64, id, root],
        )
        .map_err(|error| format!("Cannot touch collection: {error}"))?;
    Ok(())
}

fn list_collection_rows(
    connection: &Connection,
    root: &str,
    present: &HashSet<String>,
) -> CommandResult<Vec<CollectionSummary>> {
    let mut collections: Vec<CollectionSummary> = {
        let mut statement = connection
            .prepare(
                "SELECT id, name, created_at, updated_at FROM collections
                 WHERE library_root = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|error| format!("Cannot prepare the collection list: {error}"))?;
        let rows = statement
            .query_map(params![root], |row| {
                Ok(CollectionSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get::<_, i64>(2)? as u64,
                    updated_at: row.get::<_, i64>(3)? as u64,
                    item_count: 0,
                    present_count: 0,
                })
            })
            .map_err(|error| format!("Cannot list collections: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode collections: {error}"))?
    };

    let mut counts: HashMap<String, (u64, u64)> = HashMap::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT collection_id, relative_path FROM collection_items
                 WHERE library_root = ?1",
            )
            .map_err(|error| format!("Cannot prepare the collection counts: {error}"))?;
        let rows = statement
            .query_map(params![root], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("Cannot count collection items: {error}"))?;
        for row in rows {
            let (collection_id, relative_path) =
                row.map_err(|error| format!("Cannot decode collection counts: {error}"))?;
            let entry = counts.entry(collection_id).or_insert((0, 0));
            entry.0 += 1;
            if present.contains(&relative_path) {
                entry.1 += 1;
            }
        }
    }
    for collection in &mut collections {
        if let Some(&(item_count, present_count)) = counts.get(&collection.id) {
            collection.item_count = item_count;
            collection.present_count = present_count;
        }
    }
    Ok(collections)
}

fn create_collection_row(
    connection: &Connection,
    root: &str,
    id: &str,
    name: &str,
    now: u64,
) -> CommandResult<Collection> {
    validate_collection_id(id)?;
    let name = validate_collection_name(name)?;
    // The id is a global primary key (mirroring the IndexedDB keyPath), so
    // an id held by any library refuses the insert up front.
    let existing: i64 = connection
        .query_row(
            "SELECT count(*) FROM collections WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot verify the collection id: {error}"))?;
    if existing > 0 {
        return Err("Collection id already exists".to_owned());
    }
    connection
        .execute(
            "INSERT INTO collections(id, library_root, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, root, name, now as i64, now as i64],
        )
        .map_err(|error| format!("Cannot create the collection: {error}"))?;
    Ok(Collection {
        id: id.to_owned(),
        name,
        created_at: now,
        updated_at: now,
    })
}

fn rename_collection_row(
    connection: &Connection,
    root: &str,
    id: &str,
    name: &str,
    now: u64,
) -> CommandResult<()> {
    validate_collection_id(id)?;
    let name = validate_collection_name(name)?;
    let updated = connection
        .execute(
            "UPDATE collections SET name = ?1, updated_at = ?2
             WHERE id = ?3 AND library_root = ?4",
            params![name, now as i64, id, root],
        )
        .map_err(|error| format!("Cannot rename the collection: {error}"))?;
    if updated == 0 {
        return Err("Collection was not found".to_owned());
    }
    Ok(())
}

fn delete_collection_row(connection: &mut Connection, root: &str, id: &str) -> CommandResult<()> {
    ensure_collection_in_root(connection, root, id)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin the collection deletion: {error}"))?;
    transaction
        .execute(
            "DELETE FROM collection_items WHERE collection_id = ?1 AND library_root = ?2",
            params![id, root],
        )
        .map_err(|error| format!("Cannot delete the collection items: {error}"))?;
    transaction
        .execute(
            "DELETE FROM collections WHERE id = ?1 AND library_root = ?2",
            params![id, root],
        )
        .map_err(|error| format!("Cannot delete the collection: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit the collection deletion: {error}"))
}

fn list_collection_item_rows(
    connection: &Connection,
    root: &str,
    collection_id: &str,
    present: &HashSet<String>,
) -> CommandResult<Vec<CollectionItem>> {
    ensure_collection_in_root(connection, root, collection_id)?;
    let mut statement = connection
        .prepare(
            "SELECT relative_path, position, added_at FROM collection_items
             WHERE collection_id = ?1 AND library_root = ?2
             ORDER BY position ASC, relative_path ASC",
        )
        .map_err(|error| format!("Cannot prepare the collection items: {error}"))?;
    let rows = statement
        .query_map(params![collection_id, root], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u32>(1)?,
                row.get::<_, i64>(2)? as u64,
            ))
        })
        .map_err(|error| format!("Cannot list collection items: {error}"))?;
    let mut items = Vec::new();
    for row in rows {
        let (relative_path, position, added_at) =
            row.map_err(|error| format!("Cannot decode a collection item: {error}"))?;
        let is_present = present.contains(&relative_path);
        items.push(CollectionItem {
            relative_path,
            position,
            added_at,
            present: is_present,
        });
    }
    Ok(items)
}

fn add_collection_item_row(
    connection: &mut Connection,
    root: &str,
    present: &HashSet<String>,
    collection_id: &str,
    relative_path: &str,
    now: u64,
) -> CommandResult<CollectionItem> {
    ensure_collection_in_root(connection, root, collection_id)?;
    validate_relative_library_path(relative_path)?;
    let normalized = normalize_relative_path(Path::new(relative_path));
    if normalized.is_empty() {
        return Err("A non-empty relative path is required".to_owned());
    }
    // Adding requires the document in the current scan snapshot; missing
    // items can only *become* missing later (rename/delete on disk) and
    // are then greyed out instead of purged.
    if !present.contains(&normalized) {
        return Err("Document is not in the current library".to_owned());
    }
    let existing: Option<(u32, i64)> = connection
        .query_row(
            "SELECT position, added_at FROM collection_items
             WHERE collection_id = ?1 AND relative_path = ?2 AND library_root = ?3",
            params![collection_id, normalized, root],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("Cannot inspect the collection item: {error}"))?;
    if let Some((position, added_at)) = existing {
        // Idempotent re-add: the stored row (and the collection's
        // updated_at) stay untouched.
        return Ok(CollectionItem {
            relative_path: normalized,
            position,
            added_at: added_at as u64,
            present: true,
        });
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin the collection insert: {error}"))?;
    let position: u32 = transaction
        .query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM collection_items
             WHERE collection_id = ?1 AND library_root = ?2",
            params![collection_id, root],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot compute the item position: {error}"))?;
    transaction
        .execute(
            "INSERT INTO collection_items(
                 collection_id, library_root, relative_path, position, added_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![collection_id, root, normalized, position, now as i64],
        )
        .map_err(|error| format!("Cannot add the collection item: {error}"))?;
    touch_collection(&transaction, root, collection_id, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit the collection insert: {error}"))?;
    Ok(CollectionItem {
        relative_path: normalized,
        position,
        added_at: now,
        present: true,
    })
}

fn remove_collection_item_row(
    connection: &mut Connection,
    root: &str,
    collection_id: &str,
    relative_path: &str,
    now: u64,
) -> CommandResult<()> {
    ensure_collection_in_root(connection, root, collection_id)?;
    validate_relative_library_path(relative_path)?;
    let normalized = normalize_relative_path(Path::new(relative_path));
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin the collection removal: {error}"))?;
    let removed = transaction
        .execute(
            "DELETE FROM collection_items
             WHERE collection_id = ?1 AND relative_path = ?2 AND library_root = ?3",
            params![collection_id, normalized, root],
        )
        .map_err(|error| format!("Cannot remove the collection item: {error}"))?;
    if removed == 0 {
        return Err("Collection item was not found".to_owned());
    }
    touch_collection(&transaction, root, collection_id, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit the collection removal: {error}"))
}

fn reorder_collection_item_rows(
    connection: &mut Connection,
    root: &str,
    collection_id: &str,
    ordered_paths: &[String],
    now: u64,
) -> CommandResult<()> {
    ensure_collection_in_root(connection, root, collection_id)?;
    let existing: Vec<String> = {
        let mut statement = connection
            .prepare(
                "SELECT relative_path FROM collection_items
                 WHERE collection_id = ?1 AND library_root = ?2",
            )
            .map_err(|error| format!("Cannot prepare the reorder check: {error}"))?;
        let rows = statement
            .query_map(params![collection_id, root], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Cannot read the collection order: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode the collection order: {error}"))?
    };
    let ordered_set: HashSet<&str> = ordered_paths.iter().map(String::as_str).collect();
    let existing_set: HashSet<&str> = existing.iter().map(String::as_str).collect();
    if ordered_paths.len() != existing.len()
        || ordered_set.len() != ordered_paths.len()
        || ordered_set != existing_set
    {
        return Err("Reordered paths do not match the collection items".to_owned());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin the collection reorder: {error}"))?;
    {
        let mut update = transaction
            .prepare(
                "UPDATE collection_items SET position = ?1
                 WHERE collection_id = ?2 AND relative_path = ?3 AND library_root = ?4",
            )
            .map_err(|error| format!("Cannot prepare the reorder update: {error}"))?;
        for (position, relative_path) in ordered_paths.iter().enumerate() {
            update
                .execute(params![position as u32, collection_id, relative_path, root])
                .map_err(|error| format!("Cannot reorder a collection item: {error}"))?;
        }
    }
    touch_collection(&transaction, root, collection_id, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit the collection reorder: {error}"))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    const ROOT: &str = "C:/library";

    const LEGACY_ANNOTATIONS_DDL: &str = "CREATE TABLE IF NOT EXISTS annotations (
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
     );";

    fn locked(state: &UserState) -> MutexGuard<'_, Connection> {
        state.connection.lock().expect("lock user connection")
    }

    fn user_version(connection: &Connection) -> i64 {
        connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user_version")
    }

    fn count_rows(connection: &Connection, sql: &str) -> i64 {
        connection
            .query_row(sql, [], |row| row.get(0))
            .expect("count rows")
    }

    // The parameter list mirrors the legacy annotation columns on purpose.
    #[allow(clippy::too_many_arguments)]
    fn insert_legacy_row(
        connection: &Connection,
        root: &str,
        id: &str,
        relative_path: &str,
        locator_json: &str,
        kind: &str,
        selected_text: Option<&str>,
        note: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO annotations(
                     id, library_root, relative_path, kind, color, note, selected_text, title,
                     locator_json, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'yellow', ?5, ?6, 'Title', ?7, 100, 100)",
                params![
                    id,
                    root,
                    relative_path,
                    kind,
                    note,
                    selected_text,
                    locator_json
                ],
            )
            .expect("insert legacy annotation");
    }

    fn build_legacy_cache(directory: &Path) -> PathBuf {
        let path = directory.join(LEGACY_CACHE_DB_FILE);
        let connection = Connection::open(&path).expect("open legacy cache");
        connection
            .execute_batch(LEGACY_ANNOTATIONS_DDL)
            .expect("create legacy schema");
        insert_legacy_row(
            &connection,
            ROOT,
            "ann-markdown",
            "notes/a.md",
            r#"{"kind":"markdown","quote":"hello world","prefix":"say ","suffix":" today","headingId":"intro"}"#,
            "highlight",
            Some("ｈｅｌｌｏ world"),
            Some("remember"),
        );
        insert_legacy_row(
            &connection,
            ROOT,
            "ann-pdf",
            "paper.pdf",
            r#"{"kind":"pdf","page":3,"view":"original","quote":"q","prefix":"","suffix":"","rects":[{"x":0.1,"y":0.25,"w":0.5,"h":0.02}]}"#,
            "highlight",
            Some("q"),
            None,
        );
        insert_legacy_row(
            &connection,
            ROOT,
            "ann-epub",
            "book.epub",
            r#"{"kind":"epub","chapterId":"OEBPS/ch1.xhtml","blockIndex":2,"startOffset":15,"endOffset":25,"quote":"q","prefix":"","suffix":""}"#,
            "underline",
            Some("q"),
            None,
        );
        insert_legacy_row(
            &connection,
            ROOT,
            "ann-bookmark",
            "notes/a.md",
            r#"{"kind":"bookmark","target":{"format":"markdown","headingId":null,"scrollRatio":0.5}}"#,
            "bookmark",
            None,
            None,
        );
        insert_legacy_row(
            &connection,
            "corrupt-lib",
            "ann-corrupt",
            "broken.md",
            "not json at all",
            "highlight",
            Some("x"),
            None,
        );
        path
    }

    fn sample_annotation(id: &str, relative_path: &str) -> Annotation {
        Annotation {
            id: id.to_owned(),
            relative_path: relative_path.to_owned(),
            kind: AnnotationKind::Highlight,
            color: Some(AnnotationColor::Yellow),
            note: Some("remember this".to_owned()),
            selected_text: Some("hello world".to_owned()),
            title: Some("hello world".to_owned()),
            locator: AnnotationLocator::Markdown {
                quote: "hello world".to_owned(),
                prefix: "say ".to_owned(),
                suffix: " today".to_owned(),
                heading_id: Some("intro".to_owned()),
                start: Some(1024),
                end: Some(1035),
            },
            sort_index: String::new(),
            created_at: 100,
            updated_at: 100,
            deleted_at: None,
        }
    }

    fn sanitized_sample(id: &str, relative_path: &str) -> Annotation {
        sanitize_annotation(sample_annotation(id, relative_path)).expect("sanitize sample")
    }

    #[test]
    fn fresh_database_reaches_current_version_and_reopen_is_idempotent() {
        let directory = tempdir().expect("temp dir");
        {
            let state = UserState::new(directory.path().to_path_buf()).expect("create");
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            assert_eq!(
                count_rows(
                    &connection,
                    "SELECT count(*) FROM sqlite_master
                     WHERE name IN ('annotations', 'annotations_fts', 'documents',
                                    'annotation_reviews', 'collections', 'collection_items')",
                ),
                6
            );
            let annotation = sanitized_sample("ann-1", "notes/a.md");
            upsert_annotation_row(&connection, ROOT, &annotation).expect("insert");
        }
        // A fresh-install migration must not create a stray cache file.
        assert!(!directory.path().join(LEGACY_CACHE_DB_FILE).exists());
        for _ in 0..2 {
            let state = UserState::new(directory.path().to_path_buf()).expect("reopen");
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotations"),
                1
            );
        }
    }

    #[test]
    fn rescues_legacy_annotations_with_verified_counts_and_backfill() {
        let directory = tempdir().expect("temp dir");
        let cache_path = build_legacy_cache(directory.path());

        let state = UserState::new(directory.path().to_path_buf()).expect("migrate");
        {
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotations"),
                5
            );

            let listed = list_annotation_rows(&connection, ROOT, None).expect("list");
            assert_eq!(listed.len(), 4);
            let markdown = listed
                .iter()
                .find(|annotation| annotation.id == "ann-markdown")
                .expect("markdown row");
            assert_eq!(markdown.relative_path, "notes/a.md");
            assert_eq!(markdown.kind, AnnotationKind::Highlight);
            assert_eq!(markdown.color, Some(AnnotationColor::Yellow));
            assert_eq!(markdown.note.as_deref(), Some("remember"));
            assert_eq!(markdown.selected_text.as_deref(), Some("ｈｅｌｌｏ world"));
            assert_eq!(markdown.title.as_deref(), Some("Title"));
            assert_eq!(markdown.created_at, 100);
            assert_eq!(markdown.updated_at, 100);
            assert_eq!(markdown.deleted_at, None);
            assert!(matches!(
                &markdown.locator,
                AnnotationLocator::Markdown { quote, start: None, end: None, .. }
                    if quote == "hello world"
            ));

            let sort_index = |id: &str| -> String {
                connection
                    .query_row(
                        "SELECT sort_index FROM annotations WHERE id = ?1",
                        params![id],
                        |row| row.get(0),
                    )
                    .expect("read sort_index")
            };
            assert_eq!(sort_index("ann-markdown"), "M|00000|00000000");
            assert_eq!(sort_index("ann-pdf"), "P|00003|00002500");
            assert_eq!(sort_index("ann-epub"), "E|00000|00020015");
            assert_eq!(sort_index("ann-bookmark"), "M|00000|50000000");
            assert_eq!(sort_index("ann-corrupt"), BROKEN_SORT_INDEX);

            let searchable: String = connection
                .query_row(
                    "SELECT searchable_text FROM annotations WHERE id = 'ann-markdown'",
                    [],
                    |row| row.get(0),
                )
                .expect("read searchable_text");
            // NFKC folds the fullwidth letters; separator splits text and note.
            assert_eq!(searchable, "hello world\u{1f}remember");
        }

        // The legacy cache table is kept as a fallback and never re-imported.
        let cache = Connection::open(&cache_path).expect("reopen cache");
        assert_eq!(count_rows(&cache, "SELECT count(*) FROM annotations"), 5);
        insert_legacy_row(
            &cache,
            ROOT,
            "ann-late",
            "late.md",
            r#"{"kind":"markdown","quote":"late","prefix":"","suffix":"","headingId":null}"#,
            "highlight",
            Some("late"),
            None,
        );
        drop(cache);
        drop(state);

        let state = UserState::new(directory.path().to_path_buf()).expect("reopen");
        let connection = locked(&state);
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            5
        );
    }

    #[test]
    fn refuses_databases_from_newer_reade_without_wiping() {
        let directory = tempdir().expect("temp dir");
        {
            let state = UserState::new(directory.path().to_path_buf()).expect("create");
            let connection = locked(&state);
            upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-1", "notes/a.md"))
                .expect("insert");
            connection
                .pragma_update(None, "user_version", 99)
                .expect("simulate newer schema");
        }
        let error = match UserState::new(directory.path().to_path_buf()) {
            Ok(_) => panic!("newer schema must be refused"),
            Err(error) => error,
        };
        assert!(error.contains("newer"), "unexpected error: {error}");
        let connection = Connection::open(directory.path().join(USER_DB_FILE)).expect("reopen raw");
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            1
        );
        assert_eq!(user_version(&connection), 99);
    }

    #[test]
    fn backs_up_existing_data_before_migrating() {
        let directory = tempdir().expect("temp dir");
        let db_path = directory.path().join(USER_DB_FILE);
        {
            let connection = Connection::open(&db_path).expect("hand-build v1");
            connection
                .execute_batch(LEGACY_ANNOTATIONS_DDL)
                .expect("v1 schema");
            insert_legacy_row(
                &connection,
                ROOT,
                "ann-v1",
                "notes/a.md",
                r#"{"kind":"markdown","quote":"hello","prefix":"","suffix":"","headingId":null}"#,
                "highlight",
                Some("hello"),
                None,
            );
            connection
                .pragma_update(None, "user_version", 1)
                .expect("mark v1");
        }

        let state = UserState::new(directory.path().to_path_buf()).expect("upgrade");
        let connection = locked(&state);
        assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
        let sort_index: String = connection
            .query_row(
                "SELECT sort_index FROM annotations WHERE id = 'ann-v1'",
                [],
                |row| row.get(0),
            )
            .expect("backfilled sort_index");
        assert_eq!(sort_index, "M|00000|00000000");

        let backup_path = directory.path().join("reade-user.backup-v1.sqlite3");
        assert!(backup_path.exists(), "backup file must be created");
        let backup = Connection::open(&backup_path).expect("open backup");
        assert_eq!(user_version(&backup), 1);
        assert_eq!(count_rows(&backup, "SELECT count(*) FROM annotations"), 1);
        // The backup snapshots the pre-migration schema.
        assert_eq!(
            count_rows(
                &backup,
                "SELECT count(*) FROM pragma_table_info('annotations')
                 WHERE name = 'sort_index'",
            ),
            0
        );
    }

    #[test]
    fn delete_writes_a_tombstone_and_list_filters_it() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let annotation = sanitized_sample("ann-1", "notes/a.md");
        upsert_annotation_row(&connection, ROOT, &annotation).expect("insert");

        tombstone_annotation(&connection, ROOT, "ann-1", 5_000).expect("tombstone");
        assert!(list_annotation_rows(&connection, ROOT, None)
            .expect("list")
            .is_empty());
        let (deleted_at, updated_at): (Option<i64>, i64) = connection
            .query_row(
                "SELECT deleted_at, updated_at FROM annotations WHERE id = 'ann-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("tombstone row kept");
        assert_eq!(deleted_at, Some(5_000));
        assert_eq!(updated_at, 5_000);

        let error = tombstone_annotation(&connection, ROOT, "ann-1", 6_000)
            .expect_err("tombstoned row behaves as missing");
        assert!(error.contains("not found"), "unexpected error: {error}");
        assert!(tombstone_annotation(&connection, ROOT, "ann-unknown", 6_000).is_err());

        // Undo restores by upserting the original annotation (deleted_at None).
        upsert_annotation_row(&connection, ROOT, &annotation).expect("resurrect");
        assert_eq!(
            list_annotation_rows(&connection, ROOT, None)
                .expect("list restored")
                .len(),
            1
        );
    }

    #[test]
    fn clear_document_purges_rows_physically() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-a1", "a.md"))
            .expect("insert a1");
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-a2", "a.md"))
            .expect("insert a2");
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-b", "b.md"))
            .expect("insert b");
        tombstone_annotation(&connection, ROOT, "ann-a1", 5_000).expect("tombstone a1");

        clear_annotation_rows(&connection, ROOT, "a.md").expect("clear a.md");
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM annotations WHERE relative_path = 'a.md'",
            ),
            0
        );
        assert_eq!(
            list_annotation_rows(&connection, ROOT, Some("b.md"))
                .expect("list b")
                .len(),
            1
        );
    }

    #[test]
    fn purges_only_expired_tombstones_on_open() {
        let directory = tempdir().expect("temp dir");
        let now = now_millis();
        {
            let state = UserState::new(directory.path().to_path_buf()).expect("create");
            let connection = locked(&state);
            upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-old", "a.md"))
                .expect("insert old");
            upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-fresh", "a.md"))
                .expect("insert fresh");
            tombstone_annotation(
                &connection,
                ROOT,
                "ann-old",
                now - TOMBSTONE_RETENTION_MS - 60_000,
            )
            .expect("old tombstone");
            tombstone_annotation(&connection, ROOT, "ann-fresh", now - 60_000)
                .expect("fresh tombstone");
        }
        let state = UserState::new(directory.path().to_path_buf()).expect("reopen");
        let connection = locked(&state);
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM annotations WHERE id = 'ann-old'",
            ),
            0
        );
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM annotations WHERE id = 'ann-fresh'",
            ),
            1
        );
    }

    #[test]
    fn sanitize_validates_sort_index_and_new_locator_fields() {
        // Empty sort index is recomputed server-side from the locator.
        let derived = sanitized_sample("ann-1", "notes/a.md");
        assert_eq!(derived.sort_index, "M|00000|00001024");

        // A well-formed client value is kept verbatim.
        let mut provided = sample_annotation("ann-2", "notes/a.md");
        provided.sort_index = "M|00000|00000007".to_owned();
        assert_eq!(
            sanitize_annotation(provided)
                .expect("keep valid")
                .sort_index,
            "M|00000|00000007"
        );

        for malformed in ["garbage", "M|0|0", "Q|00000|00000000", "M|00000|0000000a"] {
            let mut annotation = sample_annotation("ann-3", "notes/a.md");
            annotation.sort_index = malformed.to_owned();
            assert!(
                sanitize_annotation(annotation).is_err(),
                "sort index {malformed:?} must be rejected"
            );
        }

        let mut inverted_hint = sample_annotation("ann-4", "notes/a.md");
        inverted_hint.locator = AnnotationLocator::Markdown {
            quote: "q".to_owned(),
            prefix: String::new(),
            suffix: String::new(),
            heading_id: None,
            start: Some(10),
            end: Some(5),
        };
        assert!(sanitize_annotation(inverted_hint).is_err());

        let mut bad_page_size = sample_annotation("ann-5", "paper.pdf");
        bad_page_size.locator = AnnotationLocator::Pdf {
            page: 1,
            view: "original".to_owned(),
            quote: "q".to_owned(),
            prefix: String::new(),
            suffix: String::new(),
            rects: Vec::new(),
            page_width: Some(0.0),
            page_height: Some(842.0),
        };
        assert!(sanitize_annotation(bad_page_size).is_err());

        let mut good_page_size = sample_annotation("ann-6", "paper.pdf");
        good_page_size.locator = AnnotationLocator::Pdf {
            page: 2,
            view: "original".to_owned(),
            quote: "q".to_owned(),
            prefix: String::new(),
            suffix: String::new(),
            rects: vec![AnnotationRect {
                x: 0.1,
                y: 0.5,
                w: 0.2,
                h: 0.02,
            }],
            page_width: Some(595.0),
            page_height: Some(842.0),
        };
        let sanitized = sanitize_annotation(good_page_size).expect("valid pdf locator");
        assert_eq!(sanitized.sort_index, "P|00002|00005000");

        // Legacy rules still hold.
        assert!(sanitize_annotation(sample_annotation("ann-7", "../outside.md")).is_err());
        let mut colorless = sample_annotation("ann-8", "notes/a.md");
        colorless.color = None;
        assert!(sanitize_annotation(colorless).is_err());
        let mut bad_id = sample_annotation("bad id!", "notes/a.md");
        bad_id.id = "bad id!".to_owned();
        assert!(sanitize_annotation(bad_id).is_err());
    }

    #[test]
    fn annotation_id_cannot_be_captured_by_another_library() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let annotation = sanitized_sample("ann-shared", "notes/a.md");
        upsert_annotation_row(&connection, "C:/one", &annotation).expect("insert");
        let error = upsert_annotation_row(&connection, "C:/two", &annotation)
            .expect_err("cross-library upsert must fail");
        assert!(
            error.contains("another library"),
            "unexpected error: {error}"
        );
        assert_eq!(
            list_annotation_rows(&connection, "C:/one", None)
                .expect("list")
                .len(),
            1
        );
    }

    #[test]
    fn fts_index_follows_annotation_writes() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let mut annotation = sample_annotation("ann-1", "notes/a.md");
        annotation.selected_text = Some("ｔｒｉｇｒａｍ searchable body".to_owned());
        annotation.note = Some("first note".to_owned());
        let annotation = sanitize_annotation(annotation).expect("sanitize");
        upsert_annotation_row(&connection, ROOT, &annotation).expect("insert");

        let fts_hits = |query: &str| -> i64 {
            connection
                .query_row(
                    "SELECT count(*) FROM annotations_fts WHERE annotations_fts MATCH ?1",
                    params![query],
                    |row| row.get(0),
                )
                .expect("query fts")
        };
        // NFKC folds the fullwidth letters into the searchable ASCII form.
        assert_eq!(fts_hits("trigram"), 1);
        assert_eq!(fts_hits("first"), 1);

        let mut updated = annotation.clone();
        updated.note = Some("second note".to_owned());
        upsert_annotation_row(&connection, ROOT, &updated).expect("update");
        assert_eq!(fts_hits("first"), 0);
        assert_eq!(fts_hits("second"), 1);

        clear_annotation_rows(&connection, ROOT, "notes/a.md").expect("clear");
        assert_eq!(fts_hits("trigram"), 0);
    }

    #[test]
    fn derive_sort_index_encodings_sort_by_position() {
        let markdown = |start: Option<u32>| AnnotationLocator::Markdown {
            quote: "q".to_owned(),
            prefix: String::new(),
            suffix: String::new(),
            heading_id: None,
            start,
            end: start.map(|value| value + 1),
        };
        assert_eq!(derive_sort_index(&markdown(None)), "M|00000|00000000");
        assert_eq!(derive_sort_index(&markdown(Some(42))), "M|00000|00000042");
        assert!(derive_sort_index(&markdown(Some(42))) < derive_sort_index(&markdown(Some(430))));

        let pdf = |page: u32, y: f64| AnnotationLocator::Pdf {
            page,
            view: "original".to_owned(),
            quote: "q".to_owned(),
            prefix: String::new(),
            suffix: String::new(),
            rects: vec![AnnotationRect {
                x: 0.0,
                y,
                w: 0.1,
                h: 0.1,
            }],
            page_width: None,
            page_height: None,
        };
        assert_eq!(derive_sort_index(&pdf(3, 0.25)), "P|00003|00002500");
        // Page dominates the y offset; both slots clamp instead of overflowing.
        assert!(derive_sort_index(&pdf(2, 0.99)) < derive_sort_index(&pdf(10, 0.01)));
        assert_eq!(derive_sort_index(&pdf(200_000, 2.0)), "P|99999|00020000");
        assert_eq!(derive_sort_index(&pdf(1, 99_999.0)), "P|00001|99999999");

        let epub = |start: Option<u32>, block: u32, offset: u32| AnnotationLocator::Epub {
            chapter_id: "OEBPS/ch1.xhtml".to_owned(),
            block_index: block,
            start_offset: offset,
            end_offset: offset + 1,
            quote: "q".to_owned(),
            prefix: String::new(),
            suffix: String::new(),
            start,
            end: start.map(|value| value + 1),
        };
        assert_eq!(derive_sort_index(&epub(Some(7), 2, 15)), "E|00000|00000007");
        assert_eq!(derive_sort_index(&epub(None, 2, 15)), "E|00000|00020015");
        assert!(derive_sort_index(&epub(None, 2, 15)) < derive_sort_index(&epub(None, 3, 0)));

        let bookmark = AnnotationLocator::Bookmark {
            target: BookmarkTarget::Pdf {
                page: 7,
                offset_ratio: 0.25,
            },
        };
        assert_eq!(derive_sort_index(&bookmark), "P|00007|25000000");

        for value in [
            derive_sort_index(&markdown(Some(1))),
            derive_sort_index(&pdf(1, 0.1)),
            derive_sort_index(&epub(None, 0, 0)),
            BROKEN_SORT_INDEX.to_owned(),
        ] {
            assert!(is_valid_sort_index(&value), "{value} must validate");
        }
        assert!(!is_valid_sort_index("M|0|0"));
        assert!(!is_valid_sort_index("A|00000|00000000"));
        assert!(!is_valid_sort_index("M|00000|0000000ab"));
    }

    // ---- Document fingerprints and the move-detection rebind chain ----

    use crate::documents::IndexStatus;

    /// The v2 schema exactly as `migrate_to_v1` + `migrate_to_v2` produce it,
    /// for testing the v2 → v3 step in isolation.
    const V2_SCHEMA_DDL: &str = "CREATE TABLE annotations (
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
         updated_at INTEGER NOT NULL,
         sort_index TEXT NOT NULL DEFAULT '',
         searchable_text TEXT NOT NULL DEFAULT '',
         deleted_at INTEGER
     );
     CREATE INDEX annotations_by_doc
         ON annotations(library_root, relative_path, updated_at DESC);
     CREATE VIRTUAL TABLE annotations_fts USING fts5(
         searchable_text,
         content = 'annotations',
         tokenize = 'trigram'
     );
     CREATE TRIGGER annotations_fts_insert AFTER INSERT ON annotations BEGIN
         INSERT INTO annotations_fts(rowid, searchable_text)
         VALUES (new.rowid, new.searchable_text);
     END;
     CREATE TRIGGER annotations_fts_delete AFTER DELETE ON annotations BEGIN
         INSERT INTO annotations_fts(annotations_fts, rowid, searchable_text)
         VALUES ('delete', old.rowid, old.searchable_text);
     END;
     CREATE TRIGGER annotations_fts_update AFTER UPDATE ON annotations BEGIN
         INSERT INTO annotations_fts(annotations_fts, rowid, searchable_text)
         VALUES ('delete', old.rowid, old.searchable_text);
         INSERT INTO annotations_fts(rowid, searchable_text)
         VALUES (new.rowid, new.searchable_text);
     END;";

    fn document_info(
        relative_path: &str,
        size: u64,
        modified: u64,
        format: DocumentFormat,
    ) -> DocumentInfo {
        DocumentInfo {
            relative_path: relative_path.to_owned(),
            title: relative_path.to_owned(),
            size,
            modified,
            format,
            index_status: IndexStatus::Pending,
            index_error: None,
        }
    }

    fn insert_document_row(connection: &Connection, root: &str, relative_path: &str, hash: &str) {
        connection
            .execute(
                "INSERT INTO documents(
                     library_root, relative_path, content_hash, file_size,
                     source_modified, last_seen_at
                 ) VALUES (?1, ?2, ?3, 10, 10, 10)",
                params![root, relative_path, hash],
            )
            .expect("insert document fingerprint fixture");
    }

    fn fingerprint_row(connection: &Connection, root: &str, path: &str) -> (String, i64, i64, i64) {
        connection
            .query_row(
                "SELECT content_hash, file_size, source_modified, last_seen_at
                 FROM documents WHERE library_root = ?1 AND relative_path = ?2",
                params![root, path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read fingerprint row")
    }

    fn partial_md5_of(parts: &[&[u8]]) -> String {
        let mut hasher = Md5::new();
        for part in parts {
            hasher.update(part);
        }
        format!("pmd5:{:x}", hasher.finalize())
    }

    #[test]
    fn partial_md5_samples_koreader_offsets_and_stops_at_eof() {
        let directory = tempdir().expect("temp dir");
        let file = |name: &str, bytes: &[u8]| -> PathBuf {
            let path = directory.path().join(name);
            fs::write(&path, bytes).expect("write fixture");
            path
        };

        // Empty file: no sample consumed, MD5 of the empty string.
        assert_eq!(
            partial_md5_fingerprint(&file("empty.pdf", b"")).expect("empty"),
            "pmd5:d41d8cd98f00b204e9800998ecf8427e"
        );

        // Shorter than one block: the partial first block is the whole input.
        let tiny = b"tiny pdf bytes";
        assert_eq!(
            partial_md5_fingerprint(&file("tiny.pdf", tiny)).expect("tiny"),
            partial_md5_of(&[tiny])
        );

        // Exactly one block: the follow-up sample at offset 1024 reads zero
        // bytes and terminates cleanly.
        let block: Vec<u8> = (0..1024u32).map(|i| (i % 251) as u8).collect();
        assert_eq!(
            partial_md5_fingerprint(&file("block.pdf", &block)).expect("block"),
            partial_md5_of(&[&block])
        );

        // EOF in the middle of the third sample (offset 4096): the sample is
        // truncated at EOF and later offsets are skipped.
        let crossing: Vec<u8> = (0..5000u32).map(|i| (i % 249) as u8).collect();
        assert_eq!(
            partial_md5_fingerprint(&file("crossing.pdf", &crossing)).expect("crossing"),
            partial_md5_of(&[
                &crossing[0..1024],
                &crossing[1024..2048],
                &crossing[4096..5000]
            ])
        );

        // Large file: only the exponential offsets participate. Mutating an
        // unsampled byte keeps the fingerprint, mutating a sampled byte
        // changes it.
        let mut large: Vec<u8> = (0..100_000u32).map(|i| (i % 253) as u8).collect();
        let expected = partial_md5_of(&[
            &large[0..1024],
            &large[1024..2048],
            &large[4096..5120],
            &large[16_384..17_408],
            &large[65_536..66_560],
        ]);
        assert_eq!(
            partial_md5_fingerprint(&file("large.pdf", &large)).expect("large"),
            expected
        );
        large[30_000] ^= 0xff;
        assert_eq!(
            partial_md5_fingerprint(&file("large-unsampled.pdf", &large)).expect("unsampled"),
            expected
        );
        large[65_600] ^= 0xff;
        assert_ne!(
            partial_md5_fingerprint(&file("large-sampled.pdf", &large)).expect("sampled"),
            expected
        );
    }

    #[test]
    fn normalized_text_fingerprint_strips_bom_and_normalizes_crlf() {
        let plain = normalized_text_fingerprint(b"line1\nline2");
        assert_eq!(normalized_text_fingerprint(b"line1\r\nline2"), plain);
        assert_eq!(
            normalized_text_fingerprint(b"\xEF\xBB\xBFline1\r\nline2"),
            plain
        );
        // A lone carriage return is content, not a line ending to normalize.
        assert_ne!(normalized_text_fingerprint(b"line1\rline2"), plain);
        // Pinned value shared with the web generator test
        // (scripts/generate-web-library.test.mjs) so both implementations
        // stay byte-for-byte interchangeable.
        assert_eq!(
            normalized_text_fingerprint(b"hello"),
            "ntxt:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn sync_upserts_fingerprints_and_only_rehashes_changed_files() {
        let library = tempdir().expect("temp library");
        fs::create_dir_all(library.path().join("notes")).expect("create notes");
        fs::write(
            library.path().join("notes/a.md"),
            b"\xEF\xBB\xBF# Title\r\nbody",
        )
        .expect("write markdown");
        fs::write(library.path().join("paper.pdf"), b"%PDF-1.4 fake body").expect("write pdf");
        let root = library.path().canonicalize().expect("canonical root");
        let root_key = normalize_root(&root);
        let documents = vec![
            document_info("notes/a.md", 18, 111, DocumentFormat::Markdown),
            document_info("paper.pdf", 18, 222, DocumentFormat::Pdf),
        ];

        let state = UserState::in_memory().expect("state");
        assert_eq!(
            sync_document_fingerprints_at(&state, &root, &documents, 1_000).expect("first sync"),
            2
        );
        {
            let connection = locked(&state);
            let (markdown_hash, size, modified, seen) =
                fingerprint_row(&connection, &root_key, "notes/a.md");
            // BOM/CRLF normalization applies before hashing.
            assert_eq!(markdown_hash, normalized_text_fingerprint(b"# Title\nbody"));
            assert_eq!((size, modified, seen), (18, 111, 1_000));
            let (pdf_hash, ..) = fingerprint_row(&connection, &root_key, "paper.pdf");
            assert_eq!(pdf_hash, partial_md5_of(&[b"%PDF-1.4 fake body"]));
        }

        // Unchanged (size, mtime): no re-hash, only a last_seen_at touch.
        assert_eq!(
            sync_document_fingerprints_at(&state, &root, &documents, 2_000).expect("second sync"),
            0
        );
        {
            let connection = locked(&state);
            let (hash, _, _, seen) = fingerprint_row(&connection, &root_key, "notes/a.md");
            assert_eq!(hash, normalized_text_fingerprint(b"# Title\nbody"));
            assert_eq!(seen, 2_000);
        }

        // A changed file (new mtime/size) is re-hashed; a document missing
        // from the scan keeps its row untouched as the rebind clue.
        fs::write(library.path().join("notes/a.md"), b"# Title\nchanged")
            .expect("rewrite markdown");
        let changed = vec![document_info(
            "notes/a.md",
            15,
            333,
            DocumentFormat::Markdown,
        )];
        assert_eq!(
            sync_document_fingerprints_at(&state, &root, &changed, 3_000).expect("third sync"),
            1
        );
        let connection = locked(&state);
        let (hash, size, modified, seen) = fingerprint_row(&connection, &root_key, "notes/a.md");
        assert_eq!(hash, normalized_text_fingerprint(b"# Title\nchanged"));
        assert_eq!((size, modified, seen), (15, 333, 3_000));
        let (pdf_hash, _, _, pdf_seen) = fingerprint_row(&connection, &root_key, "paper.pdf");
        assert_eq!(pdf_hash, partial_md5_of(&[b"%PDF-1.4 fake body"]));
        assert_eq!(pdf_seen, 2_000, "vanished rows must be retained untouched");
    }

    #[test]
    fn detect_moved_rows_covers_none_one_to_one_and_ambiguous() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);

        // Live annotations on old.md (plus one tombstone that must not count)
        // and a tombstone-only path that must not trigger detection at all.
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-1", "old.md"))
            .expect("insert ann-1");
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-2", "old.md"))
            .expect("insert ann-2");
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-3", "old.md"))
            .expect("insert ann-3");
        tombstone_annotation(&connection, ROOT, "ann-3", 5_000).expect("tombstone ann-3");
        upsert_annotation_row(
            &connection,
            ROOT,
            &sanitized_sample("ann-gone", "erased.md"),
        )
        .expect("insert ann-gone");
        tombstone_annotation(&connection, ROOT, "ann-gone", 5_000).expect("tombstone ann-gone");

        // While old.md is still present there is nothing to report.
        insert_document_row(&connection, ROOT, "old.md", "pmd5:aaaa");
        let present: HashSet<String> = ["old.md".to_owned()].into();
        assert!(detect_moved_rows(&connection, ROOT, &present)
            .expect("no move")
            .is_empty());

        // One-to-one: the fingerprint of the vanished old.md reappears at
        // exactly one scanned path.
        insert_document_row(&connection, ROOT, "moved/new.md", "pmd5:aaaa");
        let present: HashSet<String> = ["moved/new.md".to_owned()].into();
        assert_eq!(
            detect_moved_rows(&connection, ROOT, &present).expect("one to one"),
            vec![MovedDocumentCandidate {
                old_path: "old.md".to_owned(),
                new_path: "moved/new.md".to_owned(),
                annotation_count: 2,
                ambiguous: false,
            }]
        );

        // A missing path without any stored fingerprint yields no pairing.
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-4", "unhashed.md"))
            .expect("insert ann-4");
        assert_eq!(
            detect_moved_rows(&connection, ROOT, &present)
                .expect("unhashed")
                .len(),
            1
        );

        // Several candidates with the same hash: all pairings come back
        // flagged ambiguous.
        insert_document_row(&connection, ROOT, "copy/twin.md", "pmd5:aaaa");
        let present: HashSet<String> =
            ["moved/new.md".to_owned(), "copy/twin.md".to_owned()].into();
        let ambiguous = detect_moved_rows(&connection, ROOT, &present).expect("ambiguous");
        assert_eq!(ambiguous.len(), 2);
        assert!(ambiguous.iter().all(|candidate| candidate.ambiguous));
        assert_eq!(
            ambiguous
                .iter()
                .map(|candidate| candidate.new_path.as_str())
                .collect::<Vec<_>>(),
            vec!["copy/twin.md", "moved/new.md"]
        );

        // Several missing annotated paths collapsing onto one candidate are
        // ambiguous too: auto-merging two documents' annotations would be
        // surprising.
        upsert_annotation_row(
            &connection,
            ROOT,
            &sanitized_sample("ann-5", "other-old.md"),
        )
        .expect("insert ann-5");
        insert_document_row(&connection, ROOT, "other-old.md", "pmd5:aaaa");
        let present: HashSet<String> = ["moved/new.md".to_owned()].into();
        let collapsed = detect_moved_rows(&connection, ROOT, &present).expect("collapsed");
        assert_eq!(collapsed.len(), 2);
        assert!(collapsed.iter().all(|candidate| candidate.ambiguous));
    }

    #[test]
    fn rebind_moves_tombstones_updates_documents_and_reports_row_count() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);

        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-1", "old.md"))
            .expect("insert ann-1");
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-2", "old.md"))
            .expect("insert ann-2");
        tombstone_annotation(&connection, ROOT, "ann-2", 5_000).expect("tombstone ann-2");
        upsert_annotation_row(
            &connection,
            ROOT,
            &sanitized_sample("ann-other", "other.md"),
        )
        .expect("insert other");
        insert_document_row(&connection, ROOT, "old.md", "pmd5:aaaa");
        insert_document_row(&connection, ROOT, "moved/new.md", "pmd5:aaaa");

        let migrated = rebind_annotation_rows(&mut connection, ROOT, "old.md", "moved/new.md")
            .expect("rebind");
        assert_eq!(migrated, 2, "live row and tombstone must both move");

        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM annotations WHERE relative_path = 'old.md'",
            ),
            0
        );
        let (deleted_at,): (Option<i64>,) = connection
            .query_row(
                "SELECT deleted_at FROM annotations
                 WHERE id = 'ann-2' AND relative_path = 'moved/new.md'",
                [],
                |row| Ok((row.get(0)?,)),
            )
            .expect("tombstone moved to the new path");
        assert_eq!(deleted_at, Some(5_000));
        let listed = list_annotation_rows(&connection, ROOT, Some("moved/new.md")).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "ann-1");
        assert_eq!(
            list_annotation_rows(&connection, ROOT, Some("other.md"))
                .expect("list other")
                .len(),
            1,
            "unrelated documents stay untouched"
        );

        // The stale fingerprint row is dropped, the new path's row stays.
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM documents WHERE relative_path = 'old.md'",
            ),
            0
        );
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM documents WHERE relative_path = 'moved/new.md'",
            ),
            1
        );

        // The FTS index survives the relative_path update (the update
        // trigger rewrites the same rowid).
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM annotations_fts WHERE annotations_fts MATCH 'hello'",
            ),
            3
        );

        // Rebinding a path with no annotations reports zero migrated rows.
        assert_eq!(
            rebind_annotation_rows(&mut connection, ROOT, "old.md", "moved/new.md")
                .expect("empty rebind"),
            0
        );
    }

    #[test]
    fn rebind_path_validation_rejects_traversal_absolute_empty_and_identical() {
        assert!(validate_rebind_paths("../outside.md", "inside.md").is_err());
        assert!(validate_rebind_paths("inside.md", "../outside.md").is_err());
        assert!(validate_rebind_paths("C:/absolute.md", "inside.md").is_err());
        assert!(validate_rebind_paths("inside.md", "/rooted.md").is_err());
        assert!(validate_rebind_paths(".", "inside.md").is_err());
        assert!(validate_rebind_paths("same.md", "same.md").is_err());
        assert!(validate_rebind_paths("a/./same.md", "a/same.md").is_err());
        assert_eq!(
            validate_rebind_paths("old dir/a.md", "new/b.md").expect("valid pair"),
            ("old dir/a.md".to_owned(), "new/b.md".to_owned())
        );
    }

    #[test]
    fn migrates_v2_databases_to_v3_with_backup_and_idempotent_reopen() {
        let directory = tempdir().expect("temp dir");
        let db_path = directory.path().join(USER_DB_FILE);
        {
            let connection = Connection::open(&db_path).expect("hand-build v2");
            connection.execute_batch(V2_SCHEMA_DDL).expect("v2 schema");
            connection
                .execute(
                    "INSERT INTO annotations(
                         id, library_root, relative_path, kind, color, note, selected_text,
                         title, locator_json, created_at, updated_at, sort_index,
                         searchable_text, deleted_at
                     ) VALUES ('ann-v2', ?1, 'notes/a.md', 'highlight', 'yellow', NULL, 'hello',
                               NULL, ?2, 100, 100, 'M|00000|00000000', 'hello\u{1f}', NULL)",
                    params![
                        ROOT,
                        r#"{"kind":"markdown","quote":"hello","prefix":"","suffix":"","headingId":null}"#
                    ],
                )
                .expect("insert v2 row");
            connection
                .pragma_update(None, "user_version", 2)
                .expect("mark v2");
        }

        for _ in 0..2 {
            let state = UserState::new(directory.path().to_path_buf()).expect("upgrade/reopen");
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            assert_eq!(
                count_rows(
                    &connection,
                    "SELECT count(*) FROM sqlite_master
                     WHERE type = 'table' AND name = 'documents'",
                ),
                1
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotations"),
                1,
                "existing annotations survive the v3 step"
            );
            assert_eq!(count_rows(&connection, "SELECT count(*) FROM documents"), 0);
        }

        // The pre-upgrade backup snapshots the v2 state.
        let backup_path = directory.path().join("reade-user.backup-v2.sqlite3");
        assert!(backup_path.exists(), "v2 backup must be created");
        let backup = Connection::open(&backup_path).expect("open backup");
        assert_eq!(user_version(&backup), 2);
        assert_eq!(
            count_rows(
                &backup,
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'documents'",
            ),
            0
        );
        assert_eq!(count_rows(&backup, "SELECT count(*) FROM annotations"), 1);
    }

    // ---- Spaced-repetition review state (plan-annotation-review R0) ----

    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    /// The documents table exactly as `migrate_to_v3` produces it, so a v3
    /// database can be hand-built (together with `V2_SCHEMA_DDL`) to test the
    /// v3 → v4 step in isolation.
    const V3_DOCUMENTS_DDL: &str = "CREATE TABLE documents (
         library_root TEXT NOT NULL,
         relative_path TEXT NOT NULL,
         content_hash TEXT NOT NULL,
         file_size INTEGER NOT NULL,
         source_modified INTEGER NOT NULL DEFAULT 0,
         last_seen_at INTEGER NOT NULL,
         PRIMARY KEY (library_root, relative_path)
     );
     CREATE INDEX documents_by_hash ON documents(library_root, content_hash);";

    fn review_sample(id: &str, relative_path: &str, created_at: u64) -> Annotation {
        let mut annotation = sample_annotation(id, relative_path);
        annotation.created_at = created_at;
        annotation.updated_at = created_at;
        sanitize_annotation(annotation).expect("sanitize review sample")
    }

    fn bookmark_sample(id: &str, relative_path: &str, title: &str, created_at: u64) -> Annotation {
        let mut annotation = sample_annotation(id, relative_path);
        annotation.kind = AnnotationKind::Bookmark;
        annotation.color = None;
        annotation.note = None;
        annotation.selected_text = None;
        annotation.title = Some(title.to_owned());
        annotation.locator = AnnotationLocator::Bookmark {
            target: BookmarkTarget::Markdown {
                heading_id: None,
                scroll_ratio: 0.25,
            },
        };
        annotation.created_at = created_at;
        annotation.updated_at = created_at;
        sanitize_annotation(annotation).expect("sanitize bookmark sample")
    }

    fn insert_review_row(
        connection: &Connection,
        root: &str,
        annotation_id: &str,
        box_level: i64,
        due_at: u64,
        last_reviewed_at: Option<u64>,
        suspended: bool,
    ) {
        connection
            .execute(
                "INSERT INTO annotation_reviews(
                     annotation_id, library_root, box, due_at, last_reviewed_at,
                     total_reviews, suspended, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 1)",
                params![
                    annotation_id,
                    root,
                    box_level,
                    due_at as i64,
                    last_reviewed_at.map(|value| value as i64),
                    i64::from(suspended)
                ],
            )
            .expect("insert review fixture");
    }

    fn review_row(connection: &Connection, id: &str) -> (i64, i64, Option<i64>, i64, i64) {
        connection
            .query_row(
                "SELECT box, due_at, last_reviewed_at, total_reviews, suspended
                 FROM annotation_reviews WHERE annotation_id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .expect("read review row")
    }

    #[test]
    fn migrates_v3_databases_to_v4_with_backup_and_idempotent_reopen() {
        let directory = tempdir().expect("temp dir");
        let db_path = directory.path().join(USER_DB_FILE);
        {
            let connection = Connection::open(&db_path).expect("hand-build v3");
            connection.execute_batch(V2_SCHEMA_DDL).expect("v2 schema");
            connection
                .execute_batch(V3_DOCUMENTS_DDL)
                .expect("v3 documents schema");
            connection
                .execute(
                    "INSERT INTO annotations(
                         id, library_root, relative_path, kind, color, note, selected_text,
                         title, locator_json, created_at, updated_at, sort_index,
                         searchable_text, deleted_at
                     ) VALUES ('ann-v3', ?1, 'notes/a.md', 'highlight', 'yellow', NULL, 'hello',
                               NULL, ?2, 100, 100, 'M|00000|00000000', 'hello\u{1f}', NULL)",
                    params![
                        ROOT,
                        r#"{"kind":"markdown","quote":"hello","prefix":"","suffix":"","headingId":null}"#
                    ],
                )
                .expect("insert v3 row");
            connection
                .pragma_update(None, "user_version", 3)
                .expect("mark v3");
        }

        // Upgrading and reopening are both idempotent: the review table and
        // its due index exist exactly once, existing annotations survive.
        // (The chain continues to the current version, v5 as of the
        // collections migration.)
        for _ in 0..2 {
            let state = UserState::new(directory.path().to_path_buf()).expect("upgrade/reopen");
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            assert_eq!(
                count_rows(
                    &connection,
                    "SELECT count(*) FROM sqlite_master
                     WHERE type = 'table' AND name = 'annotation_reviews'",
                ),
                1
            );
            assert_eq!(
                count_rows(
                    &connection,
                    "SELECT count(*) FROM sqlite_master
                     WHERE type = 'index' AND name = 'reviews_due'",
                ),
                1
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotations"),
                1,
                "existing annotations survive the v4 step"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotation_reviews"),
                0,
                "the migration backfills nothing (lazy initial state)"
            );
        }

        // The pre-upgrade backup snapshots the v3 state.
        let backup_path = directory.path().join("reade-user.backup-v3.sqlite3");
        assert!(backup_path.exists(), "v3 backup must be created");
        let backup = Connection::open(&backup_path).expect("open backup");
        assert_eq!(user_version(&backup), 3);
        assert_eq!(
            count_rows(
                &backup,
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'annotation_reviews'",
            ),
            0
        );
        assert_eq!(count_rows(&backup, "SELECT count(*) FROM annotations"), 1);
    }

    // ---- Collections (docs/plan-collections.md C0) ----

    /// Hand-builds a v4 database (v2 annotation schema + the real v3/v4
    /// migration steps) so the v4 → v5 step can be tested in isolation.
    fn build_v4_database(directory: &Path) -> PathBuf {
        let db_path = directory.join(USER_DB_FILE);
        let connection = Connection::open(&db_path).expect("hand-build v4");
        connection.execute_batch(V2_SCHEMA_DDL).expect("v2 schema");
        migrate_to_v3(&connection).expect("v3 step");
        migrate_to_v4(&connection).expect("v4 step");
        connection
            .execute(
                "INSERT INTO annotations(
                     id, library_root, relative_path, kind, color, note, selected_text,
                     title, locator_json, created_at, updated_at, sort_index,
                     searchable_text, deleted_at
                 ) VALUES ('ann-v4', ?1, 'notes/a.md', 'highlight', 'yellow', NULL, 'hello',
                           NULL, ?2, 100, 100, 'M|00000|00000000', 'hello\u{1f}', NULL)",
                params![
                    ROOT,
                    r#"{"kind":"markdown","quote":"hello","prefix":"","suffix":"","headingId":null}"#
                ],
            )
            .expect("insert v4 annotation");
        insert_document_row(&connection, ROOT, "notes/a.md", "pmd5:aaaa");
        insert_review_row(&connection, ROOT, "ann-v4", 2, 1_000, Some(500), false);
        connection
            .pragma_update(None, "user_version", 4)
            .expect("mark v4");
        db_path
    }

    #[test]
    fn migrates_v4_databases_to_v5_with_backup_and_idempotent_reopen() {
        let directory = tempdir().expect("temp dir");
        build_v4_database(directory.path());

        // Upgrading and reopening are both idempotent: the collection
        // tables exist exactly once and every earlier table keeps its data.
        for _ in 0..2 {
            let state = UserState::new(directory.path().to_path_buf()).expect("upgrade/reopen");
            let connection = locked(&state);
            assert_eq!(user_version(&connection), 5);
            assert_eq!(
                count_rows(
                    &connection,
                    "SELECT count(*) FROM sqlite_master
                     WHERE type = 'table' AND name IN ('collections', 'collection_items')",
                ),
                2
            );
            assert_eq!(
                count_rows(
                    &connection,
                    "SELECT count(*) FROM sqlite_master
                     WHERE type = 'index'
                       AND name IN ('collections_by_root', 'collection_items_by_collection',
                                    'collection_items_by_path')",
                ),
                3
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotations"),
                1
            );
            assert_eq!(count_rows(&connection, "SELECT count(*) FROM documents"), 1);
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotation_reviews"),
                1
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM collections"),
                0,
                "the migration backfills nothing"
            );
        }

        // The pre-upgrade backup snapshots the v4 state.
        let backup_path = directory.path().join("reade-user.backup-v4.sqlite3");
        assert!(backup_path.exists(), "v4 backup must be created");
        let backup = Connection::open(&backup_path).expect("open backup");
        assert_eq!(user_version(&backup), 4);
        assert_eq!(
            count_rows(
                &backup,
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'collections'",
            ),
            0
        );
        assert_eq!(count_rows(&backup, "SELECT count(*) FROM annotations"), 1);
    }

    fn present_set(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|path| (*path).to_owned()).collect()
    }

    #[test]
    fn collection_crud_validates_ids_names_presence_and_ownership() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        let present = present_set(&["a.md", "b.md", "sub/c.pdf"]);

        // Id rules match the annotation id alphabet and length cap.
        assert!(create_collection_row(&connection, ROOT, &"x".repeat(65), "名单", 1_000).is_err());
        assert!(create_collection_row(&connection, ROOT, "bad id!", "名单", 1_000).is_err());
        assert!(create_collection_row(&connection, ROOT, "", "名单", 1_000).is_err());
        // Name rules: trimmed, non-empty, ≤ 100 chars.
        assert!(create_collection_row(&connection, ROOT, "col-a", "", 1_000).is_err());
        assert!(create_collection_row(&connection, ROOT, "col-a", "   ", 1_000).is_err());
        assert!(
            create_collection_row(&connection, ROOT, "col-a", &"名".repeat(101), 1_000).is_err()
        );

        let created = create_collection_row(&connection, ROOT, "col-a", "  考研数学  ", 1_000)
            .expect("create");
        assert_eq!(
            created,
            Collection {
                id: "col-a".to_owned(),
                name: "考研数学".to_owned(),
                created_at: 1_000,
                updated_at: 1_000,
            }
        );
        // A hundred-char name is exactly at the cap.
        create_collection_row(&connection, ROOT, "col-cap", &"名".repeat(100), 1_100)
            .expect("name at cap");
        // The id is globally unique, even across libraries (IndexedDB
        // keyPath parity).
        assert!(create_collection_row(&connection, ROOT, "col-a", "重复", 1_200).is_err());
        assert!(create_collection_row(&connection, "C:/other", "col-a", "重复", 1_200).is_err());

        // Ownership: operations against another root see "not found".
        assert!(rename_collection_row(&connection, "C:/other", "col-a", "新名", 2_000).is_err());
        assert!(delete_collection_row(&mut connection, "C:/other", "col-a").is_err());
        assert!(list_collection_item_rows(&connection, "C:/other", "col-a", &present).is_err());
        rename_collection_row(&connection, ROOT, "col-a", " 数学一 ", 2_000).expect("rename");
        let renamed: String = connection
            .query_row(
                "SELECT name FROM collections WHERE id = 'col-a'",
                [],
                |row| row.get(0),
            )
            .expect("read renamed");
        assert_eq!(renamed, "数学一");

        // Adding validates the path shape and the scan-snapshot presence.
        assert!(add_collection_item_row(
            &mut connection,
            ROOT,
            &present,
            "col-a",
            "../outside.md",
            3_000
        )
        .is_err());
        assert!(add_collection_item_row(
            &mut connection,
            ROOT,
            &present,
            "col-a",
            "missing.md",
            3_000
        )
        .is_err());
        assert!(add_collection_item_row(
            &mut connection,
            ROOT,
            &present,
            "col-missing",
            "a.md",
            3_000
        )
        .is_err());

        // Positions append 0, 1, 2 …
        let first =
            add_collection_item_row(&mut connection, ROOT, &present, "col-a", "a.md", 3_000)
                .expect("add a");
        assert_eq!(
            (first.position, first.added_at, first.present),
            (0, 3_000, true)
        );
        let second =
            add_collection_item_row(&mut connection, ROOT, &present, "col-a", "b.md", 3_500)
                .expect("add b");
        assert_eq!(second.position, 1);
        let third =
            add_collection_item_row(&mut connection, ROOT, &present, "col-a", "sub/c.pdf", 4_000)
                .expect("add c");
        assert_eq!(third.position, 2);

        // Re-adding is idempotent: same row back, no timestamp movement.
        let repeat =
            add_collection_item_row(&mut connection, ROOT, &present, "col-a", "a.md", 9_000)
                .expect("re-add a");
        assert_eq!((repeat.position, repeat.added_at), (0, 3_000));
        let updated_at: i64 = connection
            .query_row(
                "SELECT updated_at FROM collections WHERE id = 'col-a'",
                [],
                |row| row.get(0),
            )
            .expect("read updated_at");
        assert_eq!(
            updated_at, 4_000,
            "idempotent re-add must not touch updated_at"
        );

        // Reorder must receive exactly the current set.
        let reorder = |connection: &mut Connection, paths: &[&str]| {
            reorder_collection_item_rows(
                connection,
                ROOT,
                "col-a",
                &paths
                    .iter()
                    .map(|path| (*path).to_owned())
                    .collect::<Vec<_>>(),
                5_000,
            )
        };
        assert!(reorder(&mut connection, &["a.md", "b.md"]).is_err());
        assert!(reorder(&mut connection, &["a.md", "b.md", "sub/c.pdf", "d.md"]).is_err());
        assert!(reorder(&mut connection, &["a.md", "a.md", "b.md"]).is_err());
        assert!(reorder(&mut connection, &["a.md", "b.md", "d.md"]).is_err());
        reorder(&mut connection, &["sub/c.pdf", "a.md", "b.md"]).expect("reorder");
        let ordered = list_collection_item_rows(&connection, ROOT, "col-a", &present)
            .expect("list after reorder");
        assert_eq!(
            ordered
                .iter()
                .map(|item| (item.relative_path.as_str(), item.position))
                .collect::<Vec<_>>(),
            vec![("sub/c.pdf", 0), ("a.md", 1), ("b.md", 2)]
        );

        // Removal: unknown items error, removal keeps the others.
        assert!(
            remove_collection_item_row(&mut connection, ROOT, "col-a", "missing.md", 6_000)
                .is_err()
        );
        remove_collection_item_row(&mut connection, ROOT, "col-a", "b.md", 6_000).expect("remove");
        assert_eq!(
            list_collection_item_rows(&connection, ROOT, "col-a", &present)
                .expect("list after removal")
                .len(),
            2
        );

        // Summaries: itemCount vs presentCount with one missing path, and
        // per-root isolation.
        let shrunk = present_set(&["a.md"]);
        create_collection_row(&connection, "C:/other", "col-iso", "别的库", 7_000)
            .expect("create isolated");
        let listed = list_collection_rows(&connection, ROOT, &shrunk).expect("list summaries");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "col-a");
        assert_eq!((listed[0].item_count, listed[0].present_count), (2, 1));
        assert_eq!(listed[1].id, "col-cap");
        assert_eq!((listed[1].item_count, listed[1].present_count), (0, 0));
    }

    #[test]
    fn delete_collection_removes_items_but_never_documents_or_annotations() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        let present = present_set(&["a.md", "b.md"]);
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-1", "a.md"))
            .expect("insert annotation");
        insert_document_row(&connection, ROOT, "a.md", "pmd5:aaaa");
        create_collection_row(&connection, ROOT, "col-del", "要删除", 1_000).expect("create");
        add_collection_item_row(&mut connection, ROOT, &present, "col-del", "a.md", 2_000)
            .expect("add a");
        add_collection_item_row(&mut connection, ROOT, &present, "col-del", "b.md", 2_100)
            .expect("add b");

        delete_collection_row(&mut connection, ROOT, "col-del").expect("delete");

        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM collections"),
            0
        );
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM collection_items"),
            0
        );
        // The direct assertion behind "deleting a list never deletes the
        // documents": annotation and fingerprint rows are untouched.
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            1
        );
        assert_eq!(count_rows(&connection, "SELECT count(*) FROM documents"), 1);
        assert!(delete_collection_row(&mut connection, ROOT, "col-del").is_err());
    }

    #[test]
    fn rebind_migrates_collection_items_and_clears_duplicate_leftovers() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        let present = present_set(&["old.md", "other.md", "moved/new.md"]);
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-1", "old.md"))
            .expect("insert annotation");
        insert_document_row(&connection, ROOT, "old.md", "pmd5:aaaa");
        insert_document_row(&connection, ROOT, "moved/new.md", "pmd5:aaaa");

        create_collection_row(&connection, ROOT, "col-a", "清单甲", 1_000).expect("create a");
        add_collection_item_row(&mut connection, ROOT, &present, "col-a", "old.md", 2_000)
            .expect("a: old");
        add_collection_item_row(&mut connection, ROOT, &present, "col-a", "other.md", 2_100)
            .expect("a: other");
        create_collection_row(&connection, ROOT, "col-b", "清单乙", 1_100).expect("create b");
        add_collection_item_row(
            &mut connection,
            ROOT,
            &present,
            "col-b",
            "moved/new.md",
            2_200,
        )
        .expect("b: new");
        add_collection_item_row(&mut connection, ROOT, &present, "col-b", "old.md", 2_300)
            .expect("b: old");
        // A second library's rows must stay untouched.
        create_collection_row(&connection, "C:/other", "col-iso", "隔离", 1_200)
            .expect("create isolated");
        add_collection_item_row(
            &mut connection,
            "C:/other",
            &present,
            "col-iso",
            "old.md",
            2_400,
        )
        .expect("isolated: old");

        let migrated = rebind_annotation_rows(&mut connection, ROOT, "old.md", "moved/new.md")
            .expect("rebind");
        assert_eq!(migrated, 1);

        // col-a's membership followed the content, keeping its position.
        let items =
            list_collection_item_rows(&connection, ROOT, "col-a", &present).expect("list col-a");
        assert_eq!(
            items
                .iter()
                .map(|item| (item.relative_path.as_str(), item.position))
                .collect::<Vec<_>>(),
            vec![("moved/new.md", 0), ("other.md", 1)]
        );
        // col-b already contained the target: the old row is gone, the
        // existing row stays, nothing is duplicated.
        let items =
            list_collection_item_rows(&connection, ROOT, "col-b", &present).expect("list col-b");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].relative_path, "moved/new.md");
        assert_eq!(items[0].added_at, 2_200);
        // The isolated library still points at its own old.md.
        let isolated = list_collection_item_rows(&connection, "C:/other", "col-iso", &present)
            .expect("list isolated");
        assert_eq!(isolated[0].relative_path, "old.md");
    }

    /// Pins the serde camelCase wire shape the TS `Collection` /
    /// `CollectionSummary` / `CollectionItem` types in `src/lib/backend.ts`
    /// rely on.
    #[test]
    fn collection_payloads_serialize_camel_case_for_the_frontend() {
        let summary = CollectionSummary {
            id: "col".to_owned(),
            name: "考研数学".to_owned(),
            created_at: 1,
            updated_at: 2,
            item_count: 3,
            present_count: 4,
        };
        assert_eq!(
            serde_json::to_value(&summary).expect("serialize summary"),
            serde_json::json!({
                "id": "col",
                "name": "考研数学",
                "createdAt": 1,
                "updatedAt": 2,
                "itemCount": 3,
                "presentCount": 4
            })
        );
        let item = CollectionItem {
            relative_path: "a.md".to_owned(),
            position: 0,
            added_at: 5,
            present: true,
        };
        assert_eq!(
            serde_json::to_value(&item).expect("serialize item"),
            serde_json::json!({
                "relativePath": "a.md",
                "position": 0,
                "addedAt": 5,
                "present": true
            })
        );
    }

    /// Two-end contract fixture CC01..CC13: the same operation sequence is
    /// replayed in `src/lib/webCollections.test.ts` and both sides must
    /// produce these exact snapshots. Keep the numbers in sync.
    #[test]
    fn collections_contract_fixture_matches_the_web_snapshots() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        let present_all = present_set(&[
            "math/真题.pdf",
            "notes/错题.md",
            "notes/公式.md",
            "papers/robot.epub",
        ]);
        // The final snapshot simulates 公式.md having vanished from disk.
        let present_final = present_set(&["math/真题.pdf", "notes/错题.md", "papers/robot.epub"]);

        // CC01/CC02: two collections, the first name arrives untrimmed.
        create_collection_row(&connection, ROOT, "col-a", " 考研数学 ", 1_000).expect("CC01");
        create_collection_row(&connection, ROOT, "col-b", "组会论文", 2_000).expect("CC02");
        // CC03..CC07: five items across the two collections.
        add_collection_item_row(
            &mut connection,
            ROOT,
            &present_all,
            "col-a",
            "math/真题.pdf",
            3_000,
        )
        .expect("CC03");
        add_collection_item_row(
            &mut connection,
            ROOT,
            &present_all,
            "col-a",
            "notes/错题.md",
            4_000,
        )
        .expect("CC04");
        add_collection_item_row(
            &mut connection,
            ROOT,
            &present_all,
            "col-a",
            "notes/公式.md",
            5_000,
        )
        .expect("CC05");
        add_collection_item_row(
            &mut connection,
            ROOT,
            &present_all,
            "col-b",
            "papers/robot.epub",
            6_000,
        )
        .expect("CC06");
        add_collection_item_row(
            &mut connection,
            ROOT,
            &present_all,
            "col-b",
            "notes/错题.md",
            7_000,
        )
        .expect("CC07");
        // CC08: idempotent re-add leaves every timestamp alone.
        let repeat = add_collection_item_row(
            &mut connection,
            ROOT,
            &present_all,
            "col-a",
            "notes/错题.md",
            8_000,
        )
        .expect("CC08");
        assert_eq!((repeat.position, repeat.added_at), (1, 4_000));
        // CC09: manual reorder of col-a.
        reorder_collection_item_rows(
            &mut connection,
            ROOT,
            "col-a",
            &[
                "notes/公式.md".to_owned(),
                "math/真题.pdf".to_owned(),
                "notes/错题.md".to_owned(),
            ],
            9_000,
        )
        .expect("CC09");
        // CC10/CC11: shrink then delete the second collection.
        remove_collection_item_row(&mut connection, ROOT, "col-b", "papers/robot.epub", 10_000)
            .expect("CC10");
        delete_collection_row(&mut connection, ROOT, "col-b").expect("CC11");

        // CC12: the summary snapshot.
        let collections =
            list_collection_rows(&connection, ROOT, &present_final).expect("CC12 list");
        assert_eq!(
            collections,
            vec![CollectionSummary {
                id: "col-a".to_owned(),
                name: "考研数学".to_owned(),
                created_at: 1_000,
                updated_at: 9_000,
                item_count: 3,
                present_count: 2,
            }]
        );
        // CC13: the item snapshot.
        let items = list_collection_item_rows(&connection, ROOT, "col-a", &present_final)
            .expect("CC13 items");
        assert_eq!(
            items,
            vec![
                CollectionItem {
                    relative_path: "notes/公式.md".to_owned(),
                    position: 0,
                    added_at: 5_000,
                    present: false,
                },
                CollectionItem {
                    relative_path: "math/真题.pdf".to_owned(),
                    position: 1,
                    added_at: 3_000,
                    present: true,
                },
                CollectionItem {
                    relative_path: "notes/错题.md".to_owned(),
                    position: 2,
                    added_at: 4_000,
                    present: true,
                },
            ]
        );
        assert!(list_collection_item_rows(&connection, ROOT, "col-b", &present_final).is_err());
    }

    #[test]
    fn review_queue_coalesces_the_implicit_state_and_filters_the_pool() {
        // Mirrors the queue contract fixture Q1..Q6 in
        // src/lib/webAnnotations.test.ts ("review queue" section).
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let created = 1_700_000_000_000u64;

        // Q1: no review row → implicit box 0, due at created_at + 1 day.
        upsert_annotation_row(
            &connection,
            ROOT,
            &review_sample("ann-implicit", "a.md", created),
        )
        .expect("insert implicit");
        // Q2: explicit rows order by due_at ascending.
        upsert_annotation_row(
            &connection,
            ROOT,
            &review_sample("ann-early", "b.md", created),
        )
        .expect("insert early");
        insert_review_row(
            &connection,
            ROOT,
            "ann-early",
            1,
            created + 1_000,
            Some(created),
            false,
        );
        upsert_annotation_row(
            &connection,
            ROOT,
            &review_sample("ann-late", "b.md", created),
        )
        .expect("insert late");
        insert_review_row(
            &connection,
            ROOT,
            "ann-late",
            2,
            created + 2 * DAY_MS,
            Some(created),
            false,
        );
        // Q3: suspended rows never enter the queue.
        upsert_annotation_row(
            &connection,
            ROOT,
            &review_sample("ann-susp", "c.md", created),
        )
        .expect("insert suspended");
        insert_review_row(&connection, ROOT, "ann-susp", 0, created, None, true);
        // Q4: tombstones are excluded.
        upsert_annotation_row(
            &connection,
            ROOT,
            &review_sample("ann-dead", "c.md", created),
        )
        .expect("insert dead");
        tombstone_annotation(&connection, ROOT, "ann-dead", created + 10).expect("tombstone");
        // Q5: bookmarks are not review material.
        upsert_annotation_row(
            &connection,
            ROOT,
            &bookmark_sample("ann-bookmark", "c.md", "第三章 力学导论", created),
        )
        .expect("insert bookmark");
        // Q6: a blank excerpt (legacy rescued row shape) is excluded.
        connection
            .execute(
                "INSERT INTO annotations(
                     id, library_root, relative_path, kind, color, note, selected_text, title,
                     locator_json, sort_index, searchable_text, created_at, updated_at, deleted_at
                 ) VALUES ('ann-blank', ?1, 'c.md', 'highlight', 'yellow', NULL, '   ', NULL,
                           ?2, 'M|00000|00000000', '   \u{1f}', ?3, ?3, NULL)",
                params![
                    ROOT,
                    r#"{"kind":"markdown","quote":"q","prefix":"","suffix":"","headingId":null}"#,
                    created as i64
                ],
            )
            .expect("insert blank-excerpt row");

        let now = created + DAY_MS;
        let ids = |items: &[ReviewQueueItem]| -> Vec<String> {
            items
                .iter()
                .map(|item| item.annotation.id.clone())
                .collect()
        };

        let queue = list_review_queue_rows(&connection, ROOT, now, 10).expect("queue");
        assert_eq!(ids(&queue), vec!["ann-early", "ann-implicit"]);
        let implicit = &queue[1].review;
        assert_eq!(implicit.box_level, 0);
        assert_eq!(implicit.due_at, created + DAY_MS);
        assert_eq!(implicit.last_reviewed_at, None);
        assert_eq!(implicit.total_reviews, 0);
        assert!(!implicit.suspended);
        let early = &queue[0].review;
        assert_eq!(early.box_level, 1);
        assert_eq!(early.due_at, created + 1_000);
        assert_eq!(early.last_reviewed_at, Some(created));
        assert!(!early.suspended);

        // Q1 boundary: one millisecond before created_at + 1d the implicit
        // row is not yet due.
        let before = list_review_queue_rows(&connection, ROOT, now - 1, 10).expect("before due");
        assert_eq!(ids(&before), vec!["ann-early"]);

        // Library scope: another root sees nothing.
        assert!(list_review_queue_rows(&connection, "C:/other", now, 10)
            .expect("other root")
            .is_empty());
    }

    #[test]
    fn review_queue_overfetches_three_times_the_limit() {
        // Queue contract fixture Q7 (src/lib/webAnnotations.test.ts).
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let created = 1_700_000_000_000u64;
        for index in 0..7 {
            upsert_annotation_row(
                &connection,
                ROOT,
                &review_sample(&format!("ann-{index}"), &format!("doc-{index}.md"), created),
            )
            .expect("insert candidate");
        }
        let now = created + 2 * DAY_MS;
        assert_eq!(
            list_review_queue_rows(&connection, ROOT, now, 2)
                .expect("overfetch")
                .len(),
            6
        );
        // A zero limit is clamped to 1 (×3 rows) instead of erroring.
        assert_eq!(
            list_review_queue_rows(&connection, ROOT, now, 0)
                .expect("clamped")
                .len(),
            3
        );
    }

    #[test]
    fn record_review_outcome_validates_and_counts_server_side() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let created = 1_700_000_000_000u64;
        let now = created + DAY_MS;
        upsert_annotation_row(
            &connection,
            ROOT,
            &review_sample("ann-live", "a.md", created),
        )
        .expect("insert live");
        upsert_annotation_row(
            &connection,
            ROOT,
            &review_sample("ann-gone", "a.md", created),
        )
        .expect("insert gone");
        tombstone_annotation(&connection, ROOT, "ann-gone", created + 10).expect("tombstone");

        // Rejection matrix: unknown id, tombstoned id, malformed id, foreign
        // library, box outside 0..=5, due date outside [now − 1h, now + 180d],
        // future lastReviewedAt.
        let attempt = |id: &str, root: &str, box_level: i64, due: u64, last: Option<u64>| {
            record_review_outcome_row(&connection, root, id, box_level, due, last, false, now)
        };
        assert!(attempt("ann-unknown", ROOT, 0, now + DAY_MS, Some(now)).is_err());
        assert!(attempt("ann-gone", ROOT, 0, now + DAY_MS, Some(now)).is_err());
        assert!(attempt("bad id!", ROOT, 0, now + DAY_MS, Some(now)).is_err());
        assert!(attempt("ann-live", "C:/other", 0, now + DAY_MS, Some(now)).is_err());
        for bad_box in [-1, REVIEW_MAX_BOX + 1] {
            assert!(attempt("ann-live", ROOT, bad_box, now + DAY_MS, Some(now)).is_err());
        }
        assert!(attempt(
            "ann-live",
            ROOT,
            0,
            now - REVIEW_DUE_PAST_SLACK_MS - 1,
            Some(now)
        )
        .is_err());
        assert!(attempt(
            "ann-live",
            ROOT,
            0,
            now + REVIEW_DUE_FUTURE_LIMIT_MS + 1,
            Some(now)
        )
        .is_err());
        assert!(attempt(
            "ann-live",
            ROOT,
            0,
            now + DAY_MS,
            Some(now + 2 * REVIEW_DUE_PAST_SLACK_MS)
        )
        .is_err());
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotation_reviews"),
            0,
            "rejected outcomes must not write rows"
        );

        // remembered → box 1; the server counts the review itself.
        record_review_outcome_row(
            &connection,
            ROOT,
            "ann-live",
            1,
            now + 3 * DAY_MS,
            Some(now),
            false,
            now,
        )
        .expect("remembered");
        assert_eq!(
            review_row(&connection, "ann-live"),
            (1, (now + 3 * DAY_MS) as i64, Some(now as i64), 1, 0)
        );

        // again → box 0, counted again.
        record_review_outcome_row(
            &connection,
            ROOT,
            "ann-live",
            0,
            now + DAY_MS,
            Some(now),
            false,
            now,
        )
        .expect("again");
        assert_eq!(
            review_row(&connection, "ann-live"),
            (0, (now + DAY_MS) as i64, Some(now as i64), 2, 0)
        );

        // suspend flips the flag without counting a review.
        record_review_outcome_row(
            &connection,
            ROOT,
            "ann-live",
            0,
            now + DAY_MS,
            Some(now),
            true,
            now,
        )
        .expect("suspend");
        assert_eq!(
            review_row(&connection, "ann-live"),
            (0, (now + DAY_MS) as i64, Some(now as i64), 2, 1)
        );

        // The window boundaries themselves are accepted.
        record_review_outcome_row(
            &connection,
            ROOT,
            "ann-live",
            0,
            now - REVIEW_DUE_PAST_SLACK_MS,
            Some(now),
            false,
            now,
        )
        .expect("earliest boundary");
        record_review_outcome_row(
            &connection,
            ROOT,
            "ann-live",
            REVIEW_MAX_BOX,
            now + REVIEW_DUE_FUTURE_LIMIT_MS,
            Some(now),
            false,
            now,
        )
        .expect("latest boundary");
        assert_eq!(review_row(&connection, "ann-live").3, 4);
    }

    #[test]
    fn review_summary_counts_due_candidates_and_reviews_in_the_window() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let created = 1_700_000_000_000u64;
        let now = created + 10 * DAY_MS;
        let day_start = now - 3_600_000;

        // Due via the implicit state.
        upsert_annotation_row(&connection, ROOT, &review_sample("ann-a", "a.md", created))
            .expect("insert a");
        // Due via an explicit row, reviewed inside today's window.
        upsert_annotation_row(&connection, ROOT, &review_sample("ann-b", "b.md", created))
            .expect("insert b");
        insert_review_row(
            &connection,
            ROOT,
            "ann-b",
            1,
            now - 1_000,
            Some(day_start + 500),
            false,
        );
        // Not due; last review happened before the day started.
        upsert_annotation_row(&connection, ROOT, &review_sample("ann-c", "c.md", created))
            .expect("insert c");
        insert_review_row(
            &connection,
            ROOT,
            "ann-c",
            2,
            now + DAY_MS,
            Some(day_start - 5_000),
            false,
        );

        assert_eq!(
            review_summary_rows(&connection, ROOT, day_start, now).expect("summary"),
            ReviewSummary {
                due_count: 2,
                reviewed_today: 1
            }
        );
        assert_eq!(
            review_summary_rows(&connection, "C:/other", day_start, now).expect("other root"),
            ReviewSummary {
                due_count: 0,
                reviewed_today: 0
            }
        );
        assert!(review_summary_rows(&connection, ROOT, now + 1, now).is_err());
    }

    #[test]
    fn purge_drops_orphaned_review_rows_with_the_tombstone() {
        let directory = tempdir().expect("temp dir");
        let now = now_millis();
        {
            let state = UserState::new(directory.path().to_path_buf()).expect("create");
            let connection = locked(&state);
            for id in ["ann-old", "ann-fresh", "ann-live"] {
                upsert_annotation_row(&connection, ROOT, &sanitized_sample(id, "a.md"))
                    .expect("insert");
                insert_review_row(&connection, ROOT, id, 1, now, Some(now), false);
            }
            // Simulates a physically cleared document: the review row lost
            // its annotation entirely.
            insert_review_row(&connection, ROOT, "ann-ghost", 1, now, Some(now), false);
            tombstone_annotation(
                &connection,
                ROOT,
                "ann-old",
                now - TOMBSTONE_RETENTION_MS - 60_000,
            )
            .expect("expired tombstone");
            tombstone_annotation(&connection, ROOT, "ann-fresh", now - 60_000)
                .expect("fresh tombstone");
        }

        let state = UserState::new(directory.path().to_path_buf()).expect("reopen");
        let connection = locked(&state);
        // The expired tombstone and its review state are gone; the fresh
        // tombstone keeps its row so undoing the deletion restores progress;
        // rows without any annotation are dropped.
        let mut remaining: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT annotation_id FROM annotation_reviews")
                .expect("prepare remaining");
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query remaining");
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .expect("decode remaining")
        };
        remaining.sort();
        assert_eq!(remaining, vec!["ann-fresh", "ann-live"]);
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM annotations WHERE id = 'ann-old'",
            ),
            0
        );
    }

    // ---- Annotation search (plan-annotation-hub A1) ----
    //
    // The hit expectations mirror the shared contract case table C1..C19 in
    // src/lib/annotationSearch.test.ts; keep both sides in sync.

    fn insert_mark(
        connection: &Connection,
        root: &str,
        id: &str,
        relative_path: &str,
        selected_text: &str,
        note: Option<&str>,
    ) {
        let mut annotation = sample_annotation(id, relative_path);
        annotation.selected_text = Some(selected_text.to_owned());
        annotation.note = note.map(str::to_owned);
        annotation.title = None;
        let annotation = sanitize_annotation(annotation).expect("sanitize search fixture");
        upsert_annotation_row(connection, root, &annotation).expect("insert search fixture");
    }

    #[test]
    fn search_annotations_matches_the_shared_contract_cases() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        insert_mark(
            &connection,
            ROOT,
            "ann-cn",
            "notes/physics.md",
            "量子纠缠是一种物理现象",
            None,
        );
        insert_mark(
            &connection,
            ROOT,
            "ann-en",
            "notes/hello.md",
            "Hello World reading notes",
            None,
        );
        insert_mark(
            &connection,
            ROOT,
            "ann-full",
            "notes/full.md",
            "ｈｅｌｌｏ　ｗｏｒｌｄ",
            None,
        );
        insert_mark(
            &connection,
            ROOT,
            "ann-note",
            "notes/note.md",
            "占位",
            Some("回头再读这一段"),
        );
        upsert_annotation_row(
            &connection,
            ROOT,
            &bookmark_sample("ann-bm", "chapters/three.md", "第三章 力学导论", 100),
        )
        .expect("insert bookmark");
        insert_mark(
            &connection,
            ROOT,
            "ann-dead",
            "notes/physics.md",
            "量子纠缠已删除样本",
            None,
        );
        tombstone_annotation(&connection, ROOT, "ann-dead", 5_000).expect("tombstone");
        insert_mark(
            &connection,
            "C:/other",
            "ann-iso",
            "notes/iso.md",
            "量子纠缠隔离样本",
            None,
        );

        let hits = |query: &str| -> Vec<String> {
            search_annotation_rows(&connection, ROOT, query, 50)
                .expect("search")
                .into_iter()
                .map(|annotation| annotation.id)
                .collect()
        };

        // C1 (two-char Chinese, LIKE fallback) / C2 (three-char, FTS) / C3.
        assert_eq!(hits("量子"), vec!["ann-cn"]);
        assert_eq!(hits("量子纠"), vec!["ann-cn"]);
        assert_eq!(hits("引力"), Vec::<String>::new());
        // C4 / C5: English case-insensitive on both paths (results in
        // relative_path order: notes/full.md < notes/hello.md).
        assert_eq!(hits("HELLO"), vec!["ann-full", "ann-en"]);
        assert_eq!(hits("HE"), vec!["ann-full", "ann-en"]);
        // C6: fullwidth query folds onto halfwidth text; C7: halfwidth query
        // hits fullwidth text (searchable_text was NFKC-folded at write).
        assert_eq!(hits("ｈｅｌｌｏ"), vec!["ann-full", "ann-en"]);
        assert_eq!(hits("hello"), vec!["ann-full", "ann-en"]);
        // C8: note hit.
        assert_eq!(hits("回头再读"), vec!["ann-note"]);
        // C9: bookmark title via the LIKE supplement, on the FTS path (3+
        // chars) and on the LIKE path (2 chars).
        assert_eq!(hits("第三章"), vec!["ann-bm"]);
        assert_eq!(hits("导论"), vec!["ann-bm"]);
        // C10: tombstones never match.
        assert_eq!(hits("已删除"), Vec::<String>::new());
        // Library scope: the other library's rows are invisible here and
        // visible there.
        assert_eq!(hits("隔离样本"), Vec::<String>::new());
        let other: Vec<String> = search_annotation_rows(&connection, "C:/other", "隔离样本", 50)
            .expect("other root")
            .into_iter()
            .map(|annotation| annotation.id)
            .collect();
        assert_eq!(other, vec!["ann-iso"]);
    }

    #[test]
    fn search_annotations_treats_metacharacters_literally() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let fixtures: &[(&str, &str, &str)] = &[
            ("ann-pct", "misc/a.md", "价格上涨5%了"),
            ("ann-num", "misc/b.md", "价格上涨56元"),
            ("ann-und1", "misc/c.md", "函数 a_b 命名"),
            ("ann-und2", "misc/d.md", "函数 axb 命名"),
            ("ann-quote", "misc/e.md", "他说\"你好\"然后离开"),
            ("ann-plain", "misc/f.md", "他说你好"),
            ("ann-or", "misc/g.md", "pick foo or bar today"),
            ("ann-foo", "misc/h.md", "foo alone"),
            ("ann-near", "misc/l.md", "wrote near(2) syntax here"),
            ("ann-star", "misc/i.md", "通配符abc*def测试"),
            ("ann-star2", "misc/j.md", "通配符abcZdef测试"),
            ("ann-bslash", "misc/k.md", "路径 a\\bin 下"),
        ];
        for (id, path, text) in fixtures {
            insert_mark(&connection, ROOT, id, path, text, None);
        }
        let hits = |query: &str| -> Vec<String> {
            search_annotation_rows(&connection, ROOT, query, 50)
                .expect("search")
                .into_iter()
                .map(|annotation| annotation.id)
                .collect()
        };

        // C11: `%` literal on the LIKE path.
        assert_eq!(hits("5%"), vec!["ann-pct"]);
        // C12: `_` literal (FTS path plus escaped title supplement).
        assert_eq!(hits("a_b"), vec!["ann-und1"]);
        // C13: quotes are doubled into the FTS phrase, not phrase syntax.
        assert_eq!(hits("\"你好\""), vec!["ann-quote"]);
        // C14: FTS operators stay literal (OR and NEAR alike).
        assert_eq!(hits("foo OR bar"), vec!["ann-or"]);
        assert_eq!(hits("NEAR(2)"), vec!["ann-near"]);
        // C15: `*` is no prefix wildcard.
        assert_eq!(hits("abc*"), vec!["ann-star"]);
        // C16: `\` literal on the LIKE path.
        assert_eq!(hits("a\\"), vec!["ann-bslash"]);
    }

    #[test]
    fn search_annotations_applies_limits_and_query_truncation() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        insert_mark(&connection, ROOT, "ann-c", "c.md", "共享词组样本", None);
        insert_mark(&connection, ROOT, "ann-a", "a.md", "共享词组样本", None);
        insert_mark(&connection, ROOT, "ann-b", "b.md", "共享词组样本", None);
        let hits = |query: &str, limit: usize| -> Vec<String> {
            search_annotation_rows(&connection, ROOT, query, limit)
                .expect("search")
                .into_iter()
                .map(|annotation| annotation.id)
                .collect()
        };

        // Results order by relative_path (A-D2); C18: the limit trims them.
        assert_eq!(hits("共享词组", 50), vec!["ann-a", "ann-b", "ann-c"]);
        assert_eq!(hits("共享词组", 2), vec!["ann-a", "ann-b"]);
        // A zero limit clamps to one result instead of erroring.
        assert_eq!(hits("共享词组", 0), vec!["ann-a"]);

        // C19: chars beyond 256 are dropped before matching (the 257-char
        // query matches only because its tail is truncated away).
        let long_text = "y".repeat(300);
        insert_mark(&connection, ROOT, "ann-long", "long.md", &long_text, None);
        let truncated = format!("{}z", "y".repeat(256));
        assert_eq!(hits(&truncated, 50), vec!["ann-long"]);
        let kept_whole = format!("{}z", "y".repeat(255));
        assert_eq!(hits(&kept_whole, 50), Vec::<String>::new());

        // C17: blank queries return nothing (and never reach FTS).
        assert_eq!(hits("", 50), Vec::<String>::new());
        assert_eq!(hits("   ", 50), Vec::<String>::new());
    }

    #[test]
    fn transfer_listing_includes_tombstones_in_stable_order() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-b", "b.md"))
            .expect("insert b");
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-a", "a.md"))
            .expect("insert a");
        tombstone_annotation(&connection, ROOT, "ann-b", 5_000).expect("tombstone b");
        upsert_annotation_row(
            &connection,
            "D:/other-library",
            &sanitized_sample("ann-foreign", "a.md"),
        )
        .expect("insert foreign");

        let rows = transfer_annotation_rows(&connection, ROOT).expect("list");
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["ann-a", "ann-b"]
        );
        assert_eq!(rows[1].deleted_at, Some(5_000));
        // The live listing keeps filtering the tombstone out.
        let live = list_annotation_rows(&connection, ROOT, None).expect("live list");
        assert_eq!(live.len(), 1);
    }

    #[test]
    fn fingerprint_listing_is_root_scoped_and_keeps_vanished_paths() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        insert_document_row(&connection, ROOT, "present.md", "pmd5:aaaa");
        insert_document_row(&connection, ROOT, "vanished.md", "pmd5:bbbb");
        insert_document_row(&connection, "D:/other-library", "foreign.md", "pmd5:cccc");
        let rows = document_fingerprint_rows(&connection, ROOT).expect("list");
        assert_eq!(
            rows,
            vec![
                DocumentFingerprintEntry {
                    relative_path: "present.md".to_owned(),
                    content_hash: "pmd5:aaaa".to_owned(),
                },
                DocumentFingerprintEntry {
                    relative_path: "vanished.md".to_owned(),
                    content_hash: "pmd5:bbbb".to_owned(),
                },
            ]
        );
    }

    fn fingerprint_entry(path: &str, hash: &str) -> DocumentFingerprintEntry {
        DocumentFingerprintEntry {
            relative_path: path.to_owned(),
            content_hash: hash.to_owned(),
        }
    }

    const VALID_NTXT: &str =
        "ntxt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn import_writes_records_and_seeds_missing_path_fingerprints_only() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        // A pre-existing row for a missing path must never be overwritten.
        insert_document_row(&connection, ROOT, "already-known.md", "pmd5:aaaa");
        let present: HashSet<String> = ["present.md".to_owned()].into_iter().collect();

        let mut tombstone = sample_annotation("imp-dead", "moved/away.md");
        tombstone.deleted_at = Some(900);
        tombstone.updated_at = 900;
        let written = import_annotation_rows(
            &mut connection,
            ROOT,
            vec![
                sample_annotation("imp-live", "present.md"),
                tombstone,
                sample_annotation("imp-lost", "already-known.md"),
            ],
            &[
                fingerprint_entry("present.md", VALID_NTXT),
                fingerprint_entry("moved/away.md", VALID_NTXT),
                fingerprint_entry("already-known.md", VALID_NTXT),
            ],
            &present,
            7_000,
        )
        .expect("import");
        assert_eq!(written, 3);
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            3
        );
        let dead: Option<i64> = connection
            .query_row(
                "SELECT deleted_at FROM annotations WHERE id = 'imp-dead'",
                [],
                |row| row.get(0),
            )
            .expect("read tombstone");
        assert_eq!(dead, Some(900));

        // present.md: no fingerprint row was created (scan owns it).
        let present_rows: i64 = connection
            .query_row(
                "SELECT count(*) FROM documents WHERE relative_path = 'present.md'",
                [],
                |row| row.get(0),
            )
            .expect("count present");
        assert_eq!(present_rows, 0);
        // moved/away.md: seeded from the envelope with zero size/mtime.
        assert_eq!(
            fingerprint_row(&connection, ROOT, "moved/away.md"),
            (VALID_NTXT.to_owned(), 0, 0, 7_000)
        );
        // already-known.md: the local row wins over the envelope value.
        assert_eq!(
            fingerprint_row(&connection, ROOT, "already-known.md"),
            ("pmd5:aaaa".to_owned(), 10, 10, 10)
        );
    }

    #[test]
    fn import_is_transactional_and_validates_before_writing() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        let present = HashSet::new();

        // Second record carries an invalid id: nothing may be written.
        let error = import_annotation_rows(
            &mut connection,
            ROOT,
            vec![
                sample_annotation("imp-ok", "a.md"),
                sample_annotation("bad id!", "a.md"),
            ],
            &[],
            &present,
            7_000,
        )
        .expect_err("must reject");
        assert!(error.contains("id"), "unexpected error: {error}");
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            0
        );

        // Invalid fingerprint rows abort the batch the same way.
        for entry in [
            fingerprint_entry("../escape.md", VALID_NTXT),
            fingerprint_entry("a.md", "md5:not-a-real-format"),
            fingerprint_entry("a.md", "pmd5:SHOUTING"),
        ] {
            let error = import_annotation_rows(
                &mut connection,
                ROOT,
                vec![sample_annotation("imp-ok", "a.md")],
                &[entry],
                &present,
                7_000,
            )
            .expect_err("must reject fingerprint");
            assert!(!error.is_empty());
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotations"),
                0
            );
        }

        // A zero deletion timestamp is rejected by the shared sanitizer.
        let mut zero_tombstone = sample_annotation("imp-zero", "a.md");
        zero_tombstone.deleted_at = Some(0);
        assert!(import_annotation_rows(
            &mut connection,
            ROOT,
            vec![zero_tombstone],
            &[],
            &present,
            7_000,
        )
        .is_err());
    }

    #[test]
    fn import_enforces_batch_caps() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        let present = HashSet::new();
        let oversized: Vec<Annotation> = (0..=MAX_IMPORT_ANNOTATIONS)
            .map(|index| sample_annotation(&format!("imp-{index}"), "a.md"))
            .collect();
        let error = import_annotation_rows(&mut connection, ROOT, oversized, &[], &present, 7_000)
            .expect_err("must reject oversized batch");
        assert!(error.contains("limit"), "unexpected error: {error}");
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            0
        );

        let oversized_fingerprints: Vec<DocumentFingerprintEntry> = (0..=MAX_IMPORT_FINGERPRINTS)
            .map(|index| fingerprint_entry(&format!("doc-{index}.md"), VALID_NTXT))
            .collect();
        assert!(import_annotation_rows(
            &mut connection,
            ROOT,
            Vec::new(),
            &oversized_fingerprints,
            &present,
            7_000,
        )
        .is_err());
    }

    #[test]
    fn transfer_content_hash_validation_matches_generated_formats() {
        assert!(is_valid_transfer_content_hash(
            "pmd5:0123456789abcdef0123456789abcdef"
        ));
        assert!(is_valid_transfer_content_hash(VALID_NTXT));
        for hash in [
            "",
            "pmd5:short",
            "pmd5:0123456789ABCDEF0123456789ABCDEF",
            "ntxt:0123",
            "sha1:0123456789abcdef0123456789abcdef",
            "pmd5:0123456789abcdef0123456789abcdeg",
        ] {
            assert!(!is_valid_transfer_content_hash(hash), "{hash} accepted");
        }
    }

    #[test]
    fn import_updates_existing_rows_by_id() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("imp-lww", "a.md"))
            .expect("seed");

        let mut newer = sample_annotation("imp-lww", "a.md");
        newer.note = Some("imported newer note".to_owned());
        newer.updated_at = 9_000;
        import_annotation_rows(
            &mut connection,
            ROOT,
            vec![newer],
            &[],
            &HashSet::new(),
            9_500,
        )
        .expect("import update");
        let (note, updated_at): (Option<String>, i64) = connection
            .query_row(
                "SELECT note, updated_at FROM annotations WHERE id = 'imp-lww'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read updated row");
        assert_eq!(note.as_deref(), Some("imported newer note"));
        assert_eq!(updated_at, 9_000);
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            1
        );
    }
}
