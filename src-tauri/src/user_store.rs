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

const USER_SCHEMA_VERSION: i64 = 7;
pub(crate) const USER_DB_FILE: &str = "reade-user.sqlite3";
pub(crate) const LEGACY_CACHE_DB_FILE: &str = "reade-cache.sqlite3";
/// Tombstoned annotations are physically purged 90 days after deletion.
const TOMBSTONE_RETENTION_MS: u64 = 90 * 24 * 60 * 60 * 1000;

/// First due offset when the user explicitly enrolls an excerpt
/// (`initialReviewState` in `src/lib/reviewScheduler.ts`). Ordinary marks
/// do not receive an implicit due date.
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
/// New excerpt quotes keep a short prefix/suffix; migrated rows may be longer.
const MAX_QUOTE_CONTEXT_CHARS: usize = 32;
const MAX_CHAPTER_ID_CHARS: usize = 1_024;

/// Collection names are trimmed and capped (`docs/plan-collections.md`
/// §3.1); ids follow the annotation id rules (≤ 64 chars, same alphabet).
/// The TS twin constants live in `src/lib/collections.ts`.
const MAX_COLLECTION_NAME_CHARS: usize = 100;

/// Import caps mirroring `MAX_TRANSFER_*` in `src/lib/annotationTransfer.ts`.
const MAX_IMPORT_ANNOTATIONS: usize = 10_000;
const MAX_IMPORT_FINGERPRINTS: usize = 2_000;
/// A clear undo snapshot is kept in renderer memory and crosses IPC twice.
/// Cap all v6 rows together so a forged restore payload cannot grow without
/// bound while still matching the existing transfer ceiling.
const MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS: usize = 10_000;

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

// ---- Reading-first annotation model (schema v6) -------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExcerptTone {
    Sand,
    Sage,
    Slate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExcerptStyle {
    Highlight,
    Underline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationEntryKind {
    Excerpt,
    Place,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextQuoteSelector {
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SourceRevisionBasis {
    Capture,
    MigrationSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRevision {
    pub content_hash: String,
    pub observed_at: u64,
    pub basis: SourceRevisionBasis,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "format",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SourceAnchor {
    Markdown {
        quote: TextQuoteSelector,
        heading_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end: Option<u32>,
    },
    PdfText {
        page: u32,
        view: String,
        quote: TextQuoteSelector,
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
        quote: TextQuoteSelector,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        end: Option<u32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExcerptAppearance {
    pub style: ExcerptStyle,
    pub tone: ExcerptTone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Excerpt {
    pub id: String,
    pub relative_path: String,
    pub source_text: String,
    pub anchor: SourceAnchor,
    pub source_revision: Option<SourceRevision>,
    pub appearance: ExcerptAppearance,
    pub sort_index: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub deleted_at: Option<u64>,
    pub legacy_kind: Option<ExcerptStyle>,
    pub legacy_color: Option<AnnotationColor>,
    pub legacy_title: Option<String>,
    pub legacy_selected_text: Option<String>,
}

pub type ReadingPlaceTarget = BookmarkTarget;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPlace {
    pub id: String,
    pub relative_path: String,
    pub title: Option<String>,
    pub target: ReadingPlaceTarget,
    pub source_revision: Option<SourceRevision>,
    pub sort_index: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub deleted_at: Option<u64>,
    pub legacy_color: Option<AnnotationColor>,
    pub legacy_selected_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reflection {
    pub entry_id: String,
    pub entry_kind: AnnotationEntryKind,
    pub body: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub deleted_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEnrollment {
    pub excerpt_id: String,
    pub enrolled_at: u64,
    #[serde(rename = "box")]
    pub box_level: i64,
    pub due_at: u64,
    pub last_reviewed_at: Option<u64>,
    pub total_reviews: u64,
    pub suspended: bool,
    pub updated_at: u64,
    pub deleted_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentAnnotationBundle {
    pub excerpts: Vec<Excerpt>,
    pub places: Vec<ReadingPlace>,
    pub reflections: Vec<Reflection>,
    pub review_enrollments: Vec<ReviewEnrollment>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExcerptCaptureResult {
    pub excerpt: Excerpt,
    pub reflection: Option<Reflection>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExcerptDraft {
    pub id: String,
    pub relative_path: String,
    pub source_text: String,
    pub anchor: SourceAnchor,
    pub appearance: ExcerptAppearance,
    pub sort_index: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPlaceDraft {
    pub id: String,
    pub relative_path: String,
    pub title: Option<String>,
    pub target: ReadingPlaceTarget,
    pub sort_index: String,
}

#[derive(Clone)]
pub struct UserState {
    connection: Arc<Mutex<Connection>>,
    /// Set when the durable database could not be opened. Commands that
    /// need a healthy store refuse with this reason; backup may still
    /// snapshot `durable_path` if the file is still on disk.
    unavailable: Option<String>,
    durable_path: Option<PathBuf>,
}

impl std::fmt::Debug for UserState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("UserState")
    }
}

impl UserState {
    /// `durable_directory` holds the primary user database (D04: under
    /// `app_data_dir`, never cleared as derived cache). `legacy_cache_directory`
    /// supplies, in order: the old cache-resident user database to migrate
    /// from (`storage_migration.rs`) and the conversion-cache database the
    /// v1 rescue reads from. The rescue must run before any cache rebuild —
    /// that is why the durable database opens first in `lib.rs`.
    pub fn new(durable_directory: PathBuf, legacy_cache_directory: PathBuf) -> CommandResult<Self> {
        let durable = crate::storage_migration::prepare_durable_user_database(
            &durable_directory,
            &legacy_cache_directory,
        )?;
        let connection = open_user_database(
            &durable,
            Some(&legacy_cache_directory.join(LEGACY_CACHE_DB_FILE)),
        )?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            unavailable: None,
            durable_path: Some(durable),
        })
    }

    pub(crate) fn in_memory() -> CommandResult<Self> {
        let connection = Connection::open_in_memory()
            .map_err(|error| format!("Cannot create test user database: {error}"))?;
        Ok(Self {
            connection: Arc::new(Mutex::new(initialize_user_database(
                connection, None, None,
            )?)),
            unavailable: None,
            durable_path: None,
        })
    }

    pub(crate) fn unavailable(reason: String, durable_path: PathBuf) -> CommandResult<Self> {
        Ok(Self {
            unavailable: Some(reason),
            durable_path: Some(durable_path),
            ..Self::in_memory()?
        })
    }

    fn lock(&self) -> CommandResult<MutexGuard<'_, Connection>> {
        if let Some(reason) = &self.unavailable {
            return Err(format!("User database is unavailable: {reason}"));
        }
        self.connection
            .lock()
            .map_err(|_| "User data state lock was poisoned".to_owned())
    }

    pub(crate) fn snapshot_to(&self, dest: &Path) -> CommandResult<()> {
        if self.unavailable.is_some() {
            let Some(path) = &self.durable_path else {
                return Err(
                    "User database is unavailable and no on-disk file exists to back up".into(),
                );
            };
            if !path.exists() {
                return Err(
                    "User database is unavailable and no on-disk file exists to back up".into(),
                );
            }
            let connection = Connection::open(path)
                .map_err(|error| format!("Cannot open user database for backup: {error}"))?;
            return crate::sqlite_io::vacuum_into(&connection, dest);
        }
        let connection = self.lock()?;
        crate::sqlite_io::vacuum_into(&connection, dest)
    }

    pub(crate) fn integrity_ok(&self) -> CommandResult<bool> {
        if self.unavailable.is_some() {
            return Ok(false);
        }
        let connection = self.lock()?;
        crate::sqlite_io::integrity_ok(&connection)
    }

    pub(crate) fn schema_version(&self) -> CommandResult<i64> {
        let connection = self.lock()?;
        crate::sqlite_io::user_version(&connection)
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
    let root_key = normalize_root(&root);
    let mut connection = lock_user(&user)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin annotation upsert: {error}"))?;
    ensure_v6_root_writable(&transaction, &root_key)?;
    mirror_legacy_annotation_into_v6_core(&transaction, &root_key, &sanitized)?;
    refresh_v6_migration_ledger(&transaction, &root_key, sanitized.updated_at)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit annotation upsert: {error}"))?;
    Ok(sanitized)
}

#[tauri::command]
pub fn delete_annotation(
    id: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let root_key = normalize_root(&root);
    validate_annotation_id(&id)?;
    let now = now_millis();
    let mut connection = lock_user(&user)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin annotation deletion: {error}"))?;
    ensure_v6_root_writable(&transaction, &root_key)?;
    let entry_kind = if read_excerpt_row(&transaction, &root_key, &id)?.is_some() {
        AnnotationEntryKind::Excerpt
    } else if read_reading_place_row(&transaction, &root_key, &id)?.is_some() {
        AnnotationEntryKind::Place
    } else {
        return Err("Annotation was not found".to_owned());
    };
    set_annotation_entry_deleted_row(&transaction, &root_key, &id, &entry_kind, true, now)?;
    refresh_v6_migration_ledger(&transaction, &root_key, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit annotation deletion: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn clear_document_annotations(
    relative_path: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<DocumentAnnotationBundle> {
    let root = current_root(&library)?;
    validate_relative_library_path(&relative_path)?;
    let normalized = normalize_relative_path(Path::new(&relative_path));
    let mut connection = lock_user(&user)?;
    clear_annotation_rows(&mut connection, &normalize_root(&root), &normalized)
}

#[tauri::command]
pub fn restore_document_annotations(
    relative_path: String,
    snapshot: DocumentAnnotationBundle,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<DocumentAnnotationBundle> {
    let root = current_root(&library)?;
    validate_relative_library_path(&relative_path)?;
    let normalized = normalize_relative_path(Path::new(&relative_path));
    ensure_document_in_open_library(&library, &normalized)?;
    let snapshot = validate_document_annotation_bundle(&normalized, snapshot)?;
    let mut connection = lock_user(&user)?;
    restore_document_annotation_rows(
        &mut connection,
        &normalize_root(&root),
        &normalized,
        snapshot,
    )
}

#[tauri::command]
pub fn list_document_annotations(
    relative_path: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<DocumentAnnotationBundle> {
    let root = current_root(&library)?;
    validate_relative_library_path(&relative_path)?;
    let normalized = normalize_relative_path(Path::new(&relative_path));
    let connection = lock_user(&user)?;
    list_document_annotation_rows(&connection, &normalize_root(&root), &normalized)
}

#[tauri::command]
pub fn create_excerpt(
    draft: ExcerptDraft,
    reflection_body: Option<String>,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<ExcerptCaptureResult> {
    let root = current_root(&library)?;
    let root_key = normalize_root(&root);
    let draft = sanitize_excerpt_draft(draft)?;
    ensure_document_in_open_library(&library, &draft.relative_path)?;
    let mut connection = lock_user(&user)?;
    create_excerpt_rows(
        &mut connection,
        &root_key,
        draft,
        reflection_body,
        now_millis(),
    )
}

#[tauri::command]
pub fn update_excerpt_appearance(
    id: String,
    appearance: ExcerptAppearance,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Excerpt> {
    let root = current_root(&library)?;
    let root_key = normalize_root(&root);
    validate_annotation_id(&id)?;
    let mut connection = lock_user(&user)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin excerpt appearance update: {error}"))?;
    ensure_v6_root_writable(&transaction, &root_key)?;
    let mut excerpt = read_excerpt_row(&transaction, &root_key, &id)?
        .ok_or_else(|| "Excerpt was not found".to_owned())?;
    if excerpt.deleted_at.is_some() {
        return Err("Excerpt was not found".to_owned());
    }
    let tone_changed = excerpt.appearance.tone != appearance.tone;
    excerpt.appearance = appearance;
    excerpt.updated_at = now_millis();
    if tone_changed {
        excerpt.legacy_color = Some(tone_to_legacy_color(&excerpt.appearance.tone));
    }
    excerpt.legacy_kind = Some(excerpt.appearance.style.clone());
    let reflection = read_reflection_row(&transaction, &root_key, &id)?;
    upsert_excerpt_row(
        &transaction,
        &root_key,
        &excerpt,
        live_reflection_body(reflection.as_ref()),
    )?;
    refresh_v6_migration_ledger(&transaction, &root_key, excerpt.updated_at)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit excerpt appearance update: {error}"))?;
    Ok(excerpt)
}

#[tauri::command]
pub fn create_reading_place(
    draft: ReadingPlaceDraft,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<ReadingPlace> {
    let root = current_root(&library)?;
    let root_key = normalize_root(&root);
    let draft = sanitize_reading_place_draft(draft)?;
    ensure_document_in_open_library(&library, &draft.relative_path)?;
    let now = now_millis();
    let mut connection = lock_user(&user)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin reading-place creation: {error}"))?;
    ensure_v6_root_writable(&transaction, &root_key)?;
    let source_revision =
        source_revision_for_path(&transaction, &root_key, &draft.relative_path, now)?;
    let place = ReadingPlace {
        id: draft.id,
        relative_path: draft.relative_path,
        title: draft.title,
        target: draft.target,
        source_revision,
        sort_index: draft.sort_index,
        created_at: now,
        updated_at: now,
        deleted_at: None,
        legacy_color: None,
        legacy_selected_text: None,
    };
    upsert_reading_place_row(&transaction, &root_key, &place)?;
    refresh_v6_migration_ledger(&transaction, &root_key, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit reading-place creation: {error}"))?;
    Ok(place)
}

#[tauri::command]
pub fn upsert_reflection(
    entry_id: String,
    entry_kind: AnnotationEntryKind,
    body: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Reflection> {
    let root = current_root(&library)?;
    let root_key = normalize_root(&root);
    validate_annotation_id(&entry_id)?;
    let body = sanitize_required_text(body, MAX_ANNOTATION_NOTE_CHARS, "reflection")?;
    let now = now_millis();
    let mut connection = lock_user(&user)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin reflection update: {error}"))?;
    ensure_v6_root_writable(&transaction, &root_key)?;
    ensure_v6_entry_in_root(&transaction, &root_key, &entry_id, &entry_kind)?;
    let created_at = read_reflection_row(&transaction, &root_key, &entry_id)?
        .map(|reflection| reflection.created_at)
        .unwrap_or(now);
    let reflection = Reflection {
        entry_id: entry_id.clone(),
        entry_kind: entry_kind.clone(),
        body,
        created_at,
        updated_at: now,
        deleted_at: None,
    };
    upsert_reflection_row(&transaction, &root_key, &reflection)?;
    sync_reflection_to_entry(&transaction, &root_key, &reflection)?;
    refresh_v6_migration_ledger(&transaction, &root_key, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit reflection update: {error}"))?;
    Ok(reflection)
}

#[tauri::command]
pub fn delete_reflection(
    entry_id: String,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let root_key = normalize_root(&root);
    validate_annotation_id(&entry_id)?;
    let now = now_millis();
    let mut connection = lock_user(&user)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin reflection deletion: {error}"))?;
    ensure_v6_root_writable(&transaction, &root_key)?;
    let mut reflection = read_reflection_row(&transaction, &root_key, &entry_id)?
        .ok_or_else(|| "Reflection was not found".to_owned())?;
    if reflection.deleted_at.is_some() {
        return Err("Reflection was not found".to_owned());
    }
    reflection.deleted_at = Some(now);
    reflection.updated_at = now;
    upsert_reflection_row(&transaction, &root_key, &reflection)?;
    sync_reflection_to_entry(&transaction, &root_key, &reflection)?;
    refresh_v6_migration_ledger(&transaction, &root_key, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit reflection deletion: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_annotation_entry(
    id: String,
    entry_kind: AnnotationEntryKind,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    set_annotation_entry_deleted(id, entry_kind, true, library, user)
}

#[tauri::command]
pub fn restore_annotation_entry(
    id: String,
    entry_kind: AnnotationEntryKind,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    set_annotation_entry_deleted(id, entry_kind, false, library, user)
}

fn set_annotation_entry_deleted(
    id: String,
    entry_kind: AnnotationEntryKind,
    deleted: bool,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let root_key = normalize_root(&root);
    validate_annotation_id(&id)?;
    let now = now_millis();
    let mut connection = lock_user(&user)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin annotation entry update: {error}"))?;
    ensure_v6_root_writable(&transaction, &root_key)?;
    set_annotation_entry_deleted_row(&transaction, &root_key, &id, &entry_kind, deleted, now)?;
    refresh_v6_migration_ledger(&transaction, &root_key, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit annotation entry update: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn set_review_enrollment(
    excerpt_id: String,
    enabled: bool,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Option<ReviewEnrollment>> {
    let root = current_root(&library)?;
    let root_key = normalize_root(&root);
    validate_annotation_id(&excerpt_id)?;
    let now = now_millis();
    let mut connection = lock_user(&user)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin review enrollment update: {error}"))?;
    ensure_v6_root_writable(&transaction, &root_key)?;
    let _excerpt = read_excerpt_row(&transaction, &root_key, &excerpt_id)?
        .filter(|entry| entry.deleted_at.is_none())
        .ok_or_else(|| "Excerpt was not found".to_owned())?;
    let result = if enabled {
        let mut enrollment = read_review_enrollment_row(&transaction, &root_key, &excerpt_id)?
            .unwrap_or(ReviewEnrollment {
                excerpt_id: excerpt_id.clone(),
                enrolled_at: now,
                box_level: 0,
                due_at: now.saturating_add(REVIEW_IMPLICIT_DUE_OFFSET_MS),
                last_reviewed_at: None,
                total_reviews: 0,
                suspended: false,
                updated_at: now,
                deleted_at: None,
            });
        enrollment.suspended = false;
        enrollment.deleted_at = None;
        enrollment.updated_at = now;
        upsert_review_enrollment_row(&transaction, &root_key, &enrollment)?;
        Some(enrollment)
    } else {
        if let Some(mut enrollment) =
            read_review_enrollment_row(&transaction, &root_key, &excerpt_id)?
        {
            enrollment.deleted_at = Some(now);
            enrollment.suspended = true;
            enrollment.updated_at = now;
            upsert_review_enrollment_row(&transaction, &root_key, &enrollment)?;
        }
        None
    };
    refresh_v6_migration_ledger(&transaction, &root_key, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit review enrollment update: {error}"))?;
    Ok(result)
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSearchHit {
    pub annotation: Annotation,
    pub has_reflection: bool,
    pub enrolled: bool,
}

/// Data for enrolled-queue counts. The home view no longer shows a due card;
/// the command palette and 全库摘录 remain the only interval-review entries.
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

/// Persists a client-derived review state after validating it (excerpt
/// exists and is enrolled, box within the ladder, due date inside the skew
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
    record_excerpt_review_outcome(
        annotation_id,
        box_level,
        due_at,
        last_reviewed_at,
        suspended,
        library,
        user,
    )
}

/// v6-native outcome write: requires a live enrollment.
#[tauri::command]
pub fn record_excerpt_review_outcome(
    annotation_id: String,
    box_level: i64,
    due_at: u64,
    last_reviewed_at: Option<u64>,
    suspended: bool,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let root_key = normalize_root(&root);
    validate_annotation_id(&annotation_id)?;
    let now = now_millis();
    let mut connection = lock_user(&user)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin excerpt review outcome: {error}"))?;
    ensure_v6_root_writable(&transaction, &root_key)?;
    if read_review_enrollment_row(&transaction, &root_key, &annotation_id)?
        .filter(|entry| entry.deleted_at.is_none())
        .is_none()
    {
        return Err("Excerpt is not enrolled in spaced review".to_owned());
    }
    validate_review_outcome_fields(box_level, due_at, last_reviewed_at, now)?;
    sync_review_outcome_to_enrollment(
        &transaction,
        &root_key,
        &annotation_id,
        box_level,
        due_at,
        last_reviewed_at,
        suspended,
        now,
    )?;
    refresh_v6_migration_ledger(&transaction, &root_key, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit excerpt review outcome: {error}"))?;
    Ok(())
}

/// Data for enrolled-queue counts. The local-timezone day boundary is
/// computed by the client; the backend does no timezone math.
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

/// Same search as `search_annotations`, with reflection and enrollment flags
/// for the 全库摘录 hub. Read-only; tombstones excluded.
#[tauri::command]
pub fn search_annotation_entries(
    query: String,
    limit: usize,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
) -> CommandResult<Vec<AnnotationSearchHit>> {
    let root = current_root(&library)?;
    let connection = lock_user(&user)?;
    let root_key = normalize_root(&root);
    let annotations = search_annotation_rows(&connection, &root_key, &query, limit)?;
    annotation_search_hits(&connection, &root_key, annotations)
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

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationImportExtras {
    #[serde(default)]
    pub reflections: Vec<Reflection>,
    #[serde(default)]
    pub review_enrollments: Vec<ReviewEnrollment>,
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
///
/// Optional `extras` (ArchiveV2 reflections / enrollments) are applied in the
/// same transaction when the root's v6 ledger is ready. Stale `dueAt` values
/// are clamped into the live review window so Leitner progress survives.
#[tauri::command]
pub fn import_annotations(
    annotations: Vec<Annotation>,
    fingerprints: Vec<DocumentFingerprintEntry>,
    extras: Option<AnnotationImportExtras>,
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
        extras.unwrap_or_default(),
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

pub(crate) fn open_user_database(
    path: &Path,
    legacy_cache: Option<&Path>,
) -> CommandResult<Connection> {
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
            6 => migrate_to_v6(&transaction)?,
            7 => migrate_to_v7(&transaction)?,
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

/// v6: reading-first entries. The v5 tables remain intact for one
/// compatibility release and every migrated row is reverse-projected before
/// commit. A mismatch aborts the whole migration.
fn migrate_to_v6(transaction: &Connection) -> CommandResult<()> {
    transaction
        .execute_batch(
            "CREATE TABLE excerpts (
                 id TEXT PRIMARY KEY,
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 source_text TEXT NOT NULL,
                 anchor_json TEXT NOT NULL,
                 source_revision_json TEXT,
                 style TEXT NOT NULL,
                 tone TEXT NOT NULL,
                 legacy_kind TEXT,
                 legacy_color TEXT,
                 legacy_title TEXT,
                 legacy_selected_text TEXT,
                 sort_index TEXT NOT NULL,
                 searchable_text TEXT NOT NULL DEFAULT '',
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 deleted_at INTEGER
             );
             CREATE INDEX excerpts_by_doc
                 ON excerpts(library_root, relative_path, sort_index, id);
             CREATE VIRTUAL TABLE excerpts_fts USING fts5(
                 searchable_text,
                 content = 'excerpts',
                 tokenize = 'trigram'
             );
             CREATE TRIGGER excerpts_fts_insert AFTER INSERT ON excerpts BEGIN
                 INSERT INTO excerpts_fts(rowid, searchable_text)
                 VALUES (new.rowid, new.searchable_text);
             END;
             CREATE TRIGGER excerpts_fts_delete AFTER DELETE ON excerpts BEGIN
                 INSERT INTO excerpts_fts(excerpts_fts, rowid, searchable_text)
                 VALUES ('delete', old.rowid, old.searchable_text);
             END;
             CREATE TRIGGER excerpts_fts_update AFTER UPDATE ON excerpts BEGIN
                 INSERT INTO excerpts_fts(excerpts_fts, rowid, searchable_text)
                 VALUES ('delete', old.rowid, old.searchable_text);
                 INSERT INTO excerpts_fts(rowid, searchable_text)
                 VALUES (new.rowid, new.searchable_text);
             END;
             CREATE TABLE reading_places (
                 id TEXT PRIMARY KEY,
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 title TEXT,
                 target_json TEXT NOT NULL,
                 source_revision_json TEXT,
                 legacy_color TEXT,
                 legacy_selected_text TEXT,
                 sort_index TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 deleted_at INTEGER
             );
             CREATE INDEX reading_places_by_doc
                 ON reading_places(library_root, relative_path, sort_index, id);
             CREATE TABLE reflections (
                 entry_id TEXT PRIMARY KEY,
                 entry_kind TEXT NOT NULL,
                 library_root TEXT NOT NULL,
                 body TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 deleted_at INTEGER
             );
             CREATE TABLE review_enrollments (
                 excerpt_id TEXT PRIMARY KEY,
                 library_root TEXT NOT NULL,
                 enrolled_at INTEGER NOT NULL,
                 box INTEGER NOT NULL,
                 due_at INTEGER NOT NULL,
                 last_reviewed_at INTEGER,
                 total_reviews INTEGER NOT NULL DEFAULT 0,
                 suspended INTEGER NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL,
                 deleted_at INTEGER
             );
             CREATE INDEX review_enrollments_due
                 ON review_enrollments(library_root, suspended, due_at);
             CREATE TABLE annotation_v6_migration (
                 library_root TEXT PRIMARY KEY,
                 legacy_total INTEGER NOT NULL,
                 excerpt_total INTEGER NOT NULL,
                 place_total INTEGER NOT NULL,
                 reflection_total INTEGER NOT NULL,
                 enrollment_total INTEGER NOT NULL,
                 source_checksum TEXT NOT NULL,
                 target_checksum TEXT NOT NULL,
                 migrated_at INTEGER NOT NULL
             );",
        )
        .map_err(|error| format!("Cannot create annotation v6 schema: {error}"))?;

    let roots: Vec<String> = {
        let mut statement = transaction
            .prepare("SELECT DISTINCT library_root FROM annotations ORDER BY library_root")
            .map_err(|error| format!("Cannot prepare annotation v6 roots: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get(0))
            .map_err(|error| format!("Cannot read annotation v6 roots: {error}"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("Cannot decode annotation v6 roots: {error}"))?
    };
    let migrated_at = now_millis();
    for (index, root) in roots.into_iter().enumerate() {
        let savepoint = format!("annotation_v6_root_{index}");
        transaction
            .execute_batch(&format!("SAVEPOINT {savepoint}"))
            .map_err(|error| format!("Cannot start annotation v6 root savepoint: {error}"))?;
        match migrate_root_to_v6(transaction, &root, migrated_at) {
            Ok(()) => transaction
                .execute_batch(&format!("RELEASE {savepoint}"))
                .map_err(|error| format!("Cannot release annotation v6 root savepoint: {error}"))?,
            Err(error) => {
                transaction
                    .execute_batch(&format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}"))
                    .map_err(|rollback| {
                        format!("Cannot roll back annotation v6 root {root}: {rollback}")
                    })?;
                eprintln!(
                    "reade: keeping annotation root {root} on the legacy reader; v6 migration failed: {error}"
                );
            }
        }
    }
    Ok(())
}

/// v7: user-approved wipe to v6-only. Clears legacy + v6 annotation content,
/// keeps fingerprints/collections shells, and seeds a ready empty ledger for
/// every known root so writers never fall back to dual-write.
fn migrate_to_v7(transaction: &Connection) -> CommandResult<()> {
    let mut roots: HashSet<String> = HashSet::new();
    for sql in [
        "SELECT DISTINCT library_root FROM annotations",
        "SELECT DISTINCT library_root FROM excerpts",
        "SELECT DISTINCT library_root FROM reading_places",
        "SELECT DISTINCT library_root FROM annotation_v6_migration",
        "SELECT DISTINCT library_root FROM documents",
    ] {
        let mut statement = transaction
            .prepare(sql)
            .map_err(|error| format!("Cannot prepare annotation v7 roots: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Cannot read annotation v7 roots: {error}"))?;
        for row in rows {
            roots
                .insert(row.map_err(|error| format!("Cannot decode annotation v7 root: {error}"))?);
        }
    }

    transaction
        .execute_batch(
            "DELETE FROM annotations;
             DELETE FROM annotation_reviews;
             DELETE FROM excerpts;
             DELETE FROM reading_places;
             DELETE FROM reflections;
             DELETE FROM review_enrollments;
             DELETE FROM collection_items;
             DELETE FROM annotation_v6_migration;
             INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild');
             INSERT INTO excerpts_fts(excerpts_fts) VALUES('rebuild');",
        )
        .map_err(|error| format!("Cannot wipe annotation tables for v7: {error}"))?;

    let migrated_at = now_millis();
    let empty_checksum = migration_checksum("", &[])?;
    for root in roots {
        transaction
            .execute(
                "INSERT INTO annotation_v6_migration(
                     library_root, legacy_total, excerpt_total, place_total,
                     reflection_total, enrollment_total, source_checksum,
                     target_checksum, migrated_at
                 ) VALUES (?1, 0, 0, 0, 0, 0, ?2, ?2, ?3)",
                params![root, empty_checksum, migrated_at as i64],
            )
            .map_err(|error| format!("Cannot seed annotation v7 ledger: {error}"))?;
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct LegacyReviewMigrationRow {
    annotation_id: String,
    box_level: i64,
    due_at: u64,
    last_reviewed_at: Option<u64>,
    total_reviews: u64,
    suspended: bool,
    updated_at: u64,
}

fn legacy_review_rows_for_root(
    connection: &Connection,
    root: &str,
) -> CommandResult<Vec<LegacyReviewMigrationRow>> {
    let mut statement = connection
        .prepare(
            "SELECT annotation_id, box, due_at, last_reviewed_at,
                    total_reviews, suspended, updated_at
             FROM annotation_reviews WHERE library_root = ?1
             ORDER BY annotation_id",
        )
        .map_err(|error| format!("Cannot prepare legacy review migration: {error}"))?;
    let rows = statement
        .query_map(params![root], |row| {
            Ok(LegacyReviewMigrationRow {
                annotation_id: row.get(0)?,
                box_level: row.get(1)?,
                due_at: row.get::<_, i64>(2)? as u64,
                last_reviewed_at: row.get::<_, Option<i64>>(3)?.map(|value| value as u64),
                total_reviews: row.get::<_, i64>(4)? as u64,
                suspended: row.get::<_, i64>(5)? != 0,
                updated_at: row.get::<_, i64>(6)? as u64,
            })
        })
        .map_err(|error| format!("Cannot read legacy review migration: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("Cannot decode legacy review migration: {error}"))
}

fn document_hashes_for_root(
    connection: &Connection,
    root: &str,
) -> CommandResult<HashMap<String, String>> {
    let mut statement = connection
        .prepare(
            "SELECT relative_path, content_hash FROM documents
             WHERE library_root = ?1",
        )
        .map_err(|error| format!("Cannot prepare annotation v6 fingerprints: {error}"))?;
    let rows = statement
        .query_map(params![root], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| format!("Cannot read annotation v6 fingerprints: {error}"))?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|error| format!("Cannot decode annotation v6 fingerprints: {error}"))
}

fn migration_revision(
    hashes: &HashMap<String, String>,
    relative_path: &str,
    observed_at: u64,
) -> Option<SourceRevision> {
    hashes
        .get(relative_path)
        .map(|content_hash| SourceRevision {
            content_hash: content_hash.clone(),
            observed_at,
            basis: SourceRevisionBasis::MigrationSnapshot,
        })
}

fn legacy_color_to_tone(color: Option<&AnnotationColor>) -> ExcerptTone {
    match color {
        Some(AnnotationColor::Green) => ExcerptTone::Sage,
        Some(AnnotationColor::Blue) => ExcerptTone::Slate,
        _ => ExcerptTone::Sand,
    }
}

fn tone_to_legacy_color(tone: &ExcerptTone) -> AnnotationColor {
    match tone {
        ExcerptTone::Sand => AnnotationColor::Yellow,
        ExcerptTone::Sage => AnnotationColor::Green,
        ExcerptTone::Slate => AnnotationColor::Blue,
    }
}

fn annotation_locator_to_source_anchor(locator: &AnnotationLocator) -> CommandResult<SourceAnchor> {
    match locator {
        AnnotationLocator::Markdown {
            quote,
            prefix,
            suffix,
            heading_id,
            start,
            end,
        } => Ok(SourceAnchor::Markdown {
            quote: TextQuoteSelector {
                exact: quote.clone(),
                prefix: prefix.clone(),
                suffix: suffix.clone(),
            },
            heading_id: heading_id.clone(),
            start: *start,
            end: *end,
        }),
        AnnotationLocator::Pdf {
            page,
            view,
            quote,
            prefix,
            suffix,
            rects,
            page_width,
            page_height,
        } => Ok(SourceAnchor::PdfText {
            page: *page,
            view: view.clone(),
            quote: TextQuoteSelector {
                exact: quote.clone(),
                prefix: prefix.clone(),
                suffix: suffix.clone(),
            },
            rects: rects.clone(),
            page_width: *page_width,
            page_height: *page_height,
        }),
        AnnotationLocator::Epub {
            chapter_id,
            block_index,
            start_offset,
            end_offset,
            quote,
            prefix,
            suffix,
            start,
            end,
        } => Ok(SourceAnchor::Epub {
            chapter_id: chapter_id.clone(),
            block_index: *block_index,
            start_offset: *start_offset,
            end_offset: *end_offset,
            quote: TextQuoteSelector {
                exact: quote.clone(),
                prefix: prefix.clone(),
                suffix: suffix.clone(),
            },
            start: *start,
            end: *end,
        }),
        AnnotationLocator::Bookmark { .. } => {
            Err("A mark annotation cannot migrate from a bookmark locator".to_owned())
        }
    }
}

fn source_anchor_to_annotation_locator(anchor: &SourceAnchor) -> AnnotationLocator {
    match anchor {
        SourceAnchor::Markdown {
            quote,
            heading_id,
            start,
            end,
        } => AnnotationLocator::Markdown {
            quote: quote.exact.clone(),
            prefix: quote.prefix.clone(),
            suffix: quote.suffix.clone(),
            heading_id: heading_id.clone(),
            start: *start,
            end: *end,
        },
        SourceAnchor::PdfText {
            page,
            view,
            quote,
            rects,
            page_width,
            page_height,
        } => AnnotationLocator::Pdf {
            page: *page,
            view: view.clone(),
            quote: quote.exact.clone(),
            prefix: quote.prefix.clone(),
            suffix: quote.suffix.clone(),
            rects: rects.clone(),
            page_width: *page_width,
            page_height: *page_height,
        },
        SourceAnchor::Epub {
            chapter_id,
            block_index,
            start_offset,
            end_offset,
            quote,
            start,
            end,
        } => AnnotationLocator::Epub {
            chapter_id: chapter_id.clone(),
            block_index: *block_index,
            start_offset: *start_offset,
            end_offset: *end_offset,
            quote: quote.exact.clone(),
            prefix: quote.prefix.clone(),
            suffix: quote.suffix.clone(),
            start: *start,
            end: *end,
        },
    }
}

fn migration_checksum(root: &str, annotations: &[Annotation]) -> CommandResult<String> {
    let mut hasher = Sha256::new();
    hasher.update(root.as_bytes());
    hasher.update([0]);
    for annotation in annotations {
        let encoded = serde_json::to_vec(annotation)
            .map_err(|error| format!("Cannot encode annotation migration checksum: {error}"))?;
        hasher.update((encoded.len() as u64).to_le_bytes());
        hasher.update(encoded);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn migrate_root_to_v6(connection: &Connection, root: &str, migrated_at: u64) -> CommandResult<()> {
    let source = transfer_annotation_rows(connection, root)?;
    let source_checksum = migration_checksum(root, &source)?;
    let hashes = document_hashes_for_root(connection, root)?;
    let legacy_reviews = legacy_review_rows_for_root(connection, root)?;
    let review_by_id: HashMap<&str, &LegacyReviewMigrationRow> = legacy_reviews
        .iter()
        .map(|review| (review.annotation_id.as_str(), review))
        .collect();
    let mut projected = Vec::with_capacity(source.len());
    let mut excerpt_ids = HashSet::new();
    let mut excerpt_total = 0usize;
    let mut place_total = 0usize;
    let mut reflection_total = 0usize;

    for annotation in &source {
        let source_revision = migration_revision(&hashes, &annotation.relative_path, migrated_at);
        match annotation.kind {
            AnnotationKind::Highlight | AnnotationKind::Underline => {
                let anchor = annotation_locator_to_source_anchor(&annotation.locator)?;
                let style = match annotation.kind {
                    AnnotationKind::Highlight => ExcerptStyle::Highlight,
                    AnnotationKind::Underline => ExcerptStyle::Underline,
                    AnnotationKind::Bookmark => unreachable!(),
                };
                let source_text = annotation
                    .selected_text
                    .clone()
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| match &anchor {
                        SourceAnchor::Markdown { quote, .. }
                        | SourceAnchor::PdfText { quote, .. }
                        | SourceAnchor::Epub { quote, .. } => quote.exact.clone(),
                    });
                let excerpt = Excerpt {
                    id: annotation.id.clone(),
                    relative_path: annotation.relative_path.clone(),
                    source_text,
                    anchor,
                    source_revision,
                    appearance: ExcerptAppearance {
                        style: style.clone(),
                        tone: legacy_color_to_tone(annotation.color.as_ref()),
                    },
                    sort_index: annotation.sort_index.clone(),
                    created_at: annotation.created_at,
                    updated_at: annotation.updated_at,
                    deleted_at: annotation.deleted_at,
                    legacy_kind: Some(style),
                    legacy_color: annotation.color.clone(),
                    legacy_title: annotation.title.clone(),
                    legacy_selected_text: annotation.selected_text.clone(),
                };
                insert_migrated_excerpt(connection, root, &excerpt, annotation.note.as_deref())?;
                if let Some(note) = annotation.note.as_deref() {
                    insert_migrated_reflection(
                        connection,
                        root,
                        &annotation.id,
                        AnnotationEntryKind::Excerpt,
                        note,
                        annotation,
                    )?;
                    reflection_total += 1;
                }
                excerpt_ids.insert(annotation.id.as_str());
                excerpt_total += 1;
                projected.push(excerpt_to_legacy_annotation(
                    &excerpt,
                    annotation.note.clone(),
                ));
            }
            AnnotationKind::Bookmark => {
                let AnnotationLocator::Bookmark { target } = &annotation.locator else {
                    return Err(
                        "A bookmark annotation cannot migrate from a text locator".to_owned()
                    );
                };
                let place = ReadingPlace {
                    id: annotation.id.clone(),
                    relative_path: annotation.relative_path.clone(),
                    title: annotation.title.clone(),
                    target: target.clone(),
                    source_revision,
                    sort_index: annotation.sort_index.clone(),
                    created_at: annotation.created_at,
                    updated_at: annotation.updated_at,
                    deleted_at: annotation.deleted_at,
                    legacy_color: annotation.color.clone(),
                    legacy_selected_text: annotation.selected_text.clone(),
                };
                insert_migrated_place(connection, root, &place)?;
                if let Some(note) = annotation.note.as_deref() {
                    insert_migrated_reflection(
                        connection,
                        root,
                        &annotation.id,
                        AnnotationEntryKind::Place,
                        note,
                        annotation,
                    )?;
                    reflection_total += 1;
                }
                place_total += 1;
                projected.push(reading_place_to_legacy_annotation(
                    &place,
                    annotation.note.clone(),
                ));
            }
        }
    }

    for review in &legacy_reviews {
        if !excerpt_ids.contains(review.annotation_id.as_str()) {
            return Err(format!(
                "Legacy review {} does not belong to a migrated excerpt",
                review.annotation_id
            ));
        }
        connection
            .execute(
                "INSERT INTO review_enrollments(
                     excerpt_id, library_root, enrolled_at, box, due_at,
                     last_reviewed_at, total_reviews, suspended, updated_at, deleted_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
                params![
                    review.annotation_id,
                    root,
                    review.last_reviewed_at.unwrap_or(review.updated_at) as i64,
                    review.box_level,
                    review.due_at as i64,
                    review.last_reviewed_at.map(|value| value as i64),
                    review.total_reviews as i64,
                    i64::from(review.suspended),
                    review.updated_at as i64,
                ],
            )
            .map_err(|error| format!("Cannot migrate review {}: {error}", review.annotation_id))?;
    }

    // Old builds implicitly enroll every mark without a row. Materialize a
    // suspended compatibility row so rolling back does not reintroduce that
    // behaviour; these rows are deliberately not v6 enrollments.
    for annotation in &source {
        if !excerpt_ids.contains(annotation.id.as_str())
            || review_by_id.contains_key(annotation.id.as_str())
        {
            continue;
        }
        connection
            .execute(
                "INSERT INTO annotation_reviews(
                     annotation_id, library_root, box, due_at, last_reviewed_at,
                     total_reviews, suspended, updated_at
                 ) VALUES (?1, ?2, 0, ?3, NULL, 0, 1, ?4)",
                params![
                    annotation.id,
                    root,
                    annotation
                        .created_at
                        .saturating_add(REVIEW_IMPLICIT_DUE_OFFSET_MS) as i64,
                    migrated_at as i64,
                ],
            )
            .map_err(|error| {
                format!(
                    "Cannot materialize legacy review suspension for {}: {error}",
                    annotation.id
                )
            })?;
    }

    if source != projected {
        let mismatch = source
            .iter()
            .zip(projected.iter())
            .position(|(left, right)| left != right)
            .unwrap_or(0);
        return Err(format!(
            "Annotation v6 reverse projection differs at row {mismatch} for {root}"
        ));
    }
    let target_checksum = migration_checksum(root, &projected)?;
    if source_checksum != target_checksum {
        return Err(format!("Annotation v6 checksum mismatch for {root}"));
    }
    if source.len() != excerpt_total + place_total {
        return Err(format!("Annotation v6 count mismatch for {root}"));
    }
    connection
        .execute(
            "INSERT INTO annotation_v6_migration(
                 library_root, legacy_total, excerpt_total, place_total,
                 reflection_total, enrollment_total, source_checksum,
                 target_checksum, migrated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                root,
                source.len() as i64,
                excerpt_total as i64,
                place_total as i64,
                reflection_total as i64,
                legacy_reviews.len() as i64,
                source_checksum,
                target_checksum,
                migrated_at as i64,
            ],
        )
        .map_err(|error| format!("Cannot record annotation v6 migration: {error}"))?;
    Ok(())
}

fn insert_migrated_excerpt(
    connection: &Connection,
    root: &str,
    excerpt: &Excerpt,
    note: Option<&str>,
) -> CommandResult<()> {
    let anchor_json = serde_json::to_string(&excerpt.anchor)
        .map_err(|error| format!("Cannot encode migrated excerpt anchor: {error}"))?;
    let source_revision_json = excerpt
        .source_revision
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("Cannot encode migrated excerpt revision: {error}"))?;
    let style = match excerpt.appearance.style {
        ExcerptStyle::Highlight => "highlight",
        ExcerptStyle::Underline => "underline",
    };
    let tone = match excerpt.appearance.tone {
        ExcerptTone::Sand => "sand",
        ExcerptTone::Sage => "sage",
        ExcerptTone::Slate => "slate",
    };
    let legacy_kind = excerpt.legacy_kind.as_ref().map(|kind| match kind {
        ExcerptStyle::Highlight => "highlight",
        ExcerptStyle::Underline => "underline",
    });
    let legacy_color = excerpt.legacy_color.as_ref().map(annotation_color_to_db);
    let searchable = build_searchable_text(Some(&excerpt.source_text), note);
    connection
        .execute(
            "INSERT INTO excerpts(
                 id, library_root, relative_path, source_text, anchor_json,
                 source_revision_json, style, tone, legacy_kind, legacy_color,
                 legacy_title, legacy_selected_text, sort_index, searchable_text,
                 created_at, updated_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17)",
            params![
                excerpt.id,
                root,
                excerpt.relative_path,
                excerpt.source_text,
                anchor_json,
                source_revision_json,
                style,
                tone,
                legacy_kind,
                legacy_color,
                excerpt.legacy_title,
                excerpt.legacy_selected_text,
                excerpt.sort_index,
                searchable,
                excerpt.created_at as i64,
                excerpt.updated_at as i64,
                excerpt.deleted_at.map(|value| value as i64),
            ],
        )
        .map_err(|error| format!("Cannot insert migrated excerpt {}: {error}", excerpt.id))?;
    Ok(())
}

fn insert_migrated_place(
    connection: &Connection,
    root: &str,
    place: &ReadingPlace,
) -> CommandResult<()> {
    let target_json = serde_json::to_string(&place.target)
        .map_err(|error| format!("Cannot encode migrated reading place: {error}"))?;
    let source_revision_json = place
        .source_revision
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("Cannot encode migrated place revision: {error}"))?;
    connection
        .execute(
            "INSERT INTO reading_places(
                 id, library_root, relative_path, title, target_json,
                 source_revision_json, legacy_color, legacy_selected_text,
                 sort_index, created_at, updated_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                place.id,
                root,
                place.relative_path,
                place.title,
                target_json,
                source_revision_json,
                place.legacy_color.as_ref().map(annotation_color_to_db),
                place.legacy_selected_text,
                place.sort_index,
                place.created_at as i64,
                place.updated_at as i64,
                place.deleted_at.map(|value| value as i64),
            ],
        )
        .map_err(|error| format!("Cannot insert migrated reading place {}: {error}", place.id))?;
    Ok(())
}

fn insert_migrated_reflection(
    connection: &Connection,
    root: &str,
    entry_id: &str,
    entry_kind: AnnotationEntryKind,
    body: &str,
    annotation: &Annotation,
) -> CommandResult<()> {
    let kind = match entry_kind {
        AnnotationEntryKind::Excerpt => "excerpt",
        AnnotationEntryKind::Place => "place",
    };
    connection
        .execute(
            "INSERT INTO reflections(
                 entry_id, entry_kind, library_root, body,
                 created_at, updated_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                entry_id,
                kind,
                root,
                body,
                annotation.created_at as i64,
                annotation.updated_at as i64,
                annotation.deleted_at.map(|value| value as i64),
            ],
        )
        .map_err(|error| format!("Cannot insert migrated reflection {entry_id}: {error}"))?;
    Ok(())
}

fn excerpt_to_legacy_annotation(excerpt: &Excerpt, note: Option<String>) -> Annotation {
    Annotation {
        id: excerpt.id.clone(),
        relative_path: excerpt.relative_path.clone(),
        kind: match excerpt.appearance.style {
            ExcerptStyle::Highlight => AnnotationKind::Highlight,
            ExcerptStyle::Underline => AnnotationKind::Underline,
        },
        color: excerpt
            .legacy_color
            .clone()
            .or(Some(tone_to_legacy_color(&excerpt.appearance.tone))),
        note,
        selected_text: excerpt.legacy_selected_text.clone(),
        title: excerpt.legacy_title.clone(),
        locator: source_anchor_to_annotation_locator(&excerpt.anchor),
        sort_index: excerpt.sort_index.clone(),
        created_at: excerpt.created_at,
        updated_at: excerpt.updated_at,
        deleted_at: excerpt.deleted_at,
    }
}

fn reading_place_to_legacy_annotation(place: &ReadingPlace, note: Option<String>) -> Annotation {
    Annotation {
        id: place.id.clone(),
        relative_path: place.relative_path.clone(),
        kind: AnnotationKind::Bookmark,
        color: place.legacy_color.clone(),
        note,
        selected_text: place.legacy_selected_text.clone(),
        title: place.title.clone(),
        locator: AnnotationLocator::Bookmark {
            target: place.target.clone(),
        },
        sort_index: place.sort_index.clone(),
        created_at: place.created_at,
        updated_at: place.updated_at,
        deleted_at: place.deleted_at,
    }
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
    connection
        .execute(
            "DELETE FROM excerpts WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            params![cutoff as i64],
        )
        .map_err(|error| format!("Cannot clean up expired excerpts: {error}"))?;
    connection
        .execute(
            "DELETE FROM reading_places WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            params![cutoff as i64],
        )
        .map_err(|error| format!("Cannot clean up expired reading places: {error}"))?;
    connection
        .execute(
            "DELETE FROM reflections
             WHERE (deleted_at IS NOT NULL AND deleted_at < ?1)
                OR (entry_kind = 'excerpt' AND entry_id NOT IN (SELECT id FROM excerpts))
                OR (entry_kind = 'place' AND entry_id NOT IN (SELECT id FROM reading_places))",
            params![cutoff as i64],
        )
        .map_err(|error| format!("Cannot clean up expired reflections: {error}"))?;
    connection
        .execute(
            "DELETE FROM review_enrollments
             WHERE (deleted_at IS NOT NULL AND deleted_at < ?1)
                OR excerpt_id NOT IN (SELECT id FROM excerpts)",
            params![cutoff as i64],
        )
        .map_err(|error| format!("Cannot clean up expired review enrollments: {error}"))?;
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
                "SELECT relative_path, count(*) FROM (
                     SELECT relative_path FROM excerpts
                     WHERE library_root = ?1 AND deleted_at IS NULL
                     UNION ALL
                     SELECT relative_path FROM reading_places
                     WHERE library_root = ?1 AND deleted_at IS NULL
                 )
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
            "UPDATE excerpts SET relative_path = ?1
             WHERE library_root = ?2 AND relative_path = ?3",
            params![new_path, root, old_path],
        )
        .map_err(|error| format!("Cannot rebind excerpts: {error}"))?
        + transaction
            .execute(
                "UPDATE reading_places SET relative_path = ?1
                 WHERE library_root = ?2 AND relative_path = ?3",
                params![new_path, root, old_path],
            )
            .map_err(|error| format!("Cannot rebind reading places: {error}"))?;
    // Keep empty legacy shells consistent if any stray rows remain.
    transaction
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
    refresh_v6_migration_ledger(&transaction, root, now_millis())?;
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
    let mut annotations = reverse_project_v6_annotations(connection, root)?;
    annotations.retain(|annotation| annotation.deleted_at.is_none());
    if let Some(path) = relative_path {
        annotations.retain(|annotation| annotation.relative_path == path);
    }
    annotations.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(annotations)
}

fn transfer_annotation_rows(connection: &Connection, root: &str) -> CommandResult<Vec<Annotation>> {
    reverse_project_v6_annotations(connection, root)
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

fn clamp_import_due_at(due_at: u64, now: u64) -> u64 {
    let min = now.saturating_sub(REVIEW_DUE_PAST_SLACK_MS);
    let max = now.saturating_add(REVIEW_DUE_FUTURE_LIMIT_MS);
    due_at.clamp(min, max)
}

fn import_annotation_rows(
    connection: &mut Connection,
    root: &str,
    annotations: Vec<Annotation>,
    fingerprints: &[DocumentFingerprintEntry],
    extras: AnnotationImportExtras,
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
    let mut reflections = Vec::with_capacity(extras.reflections.len());
    for reflection in extras.reflections {
        validate_annotation_id(&reflection.entry_id)?;
        let body = reflection.body.trim();
        if reflection.deleted_at.is_none() && body.is_empty() {
            return Err("Reflection body cannot be empty".to_owned());
        }
        if body.chars().count() > MAX_ANNOTATION_NOTE_CHARS {
            return Err(format!(
                "Reflection body exceeds the {MAX_ANNOTATION_NOTE_CHARS}-character limit"
            ));
        }
        reflections.push(Reflection {
            body: body.to_owned(),
            ..reflection
        });
    }
    let mut enrollments = Vec::with_capacity(extras.review_enrollments.len());
    for enrollment in extras.review_enrollments {
        validate_annotation_id(&enrollment.excerpt_id)?;
        if !(0..=REVIEW_MAX_BOX).contains(&enrollment.box_level) {
            return Err(format!("Review box must be between 0 and {REVIEW_MAX_BOX}"));
        }
        enrollments.push(ReviewEnrollment {
            due_at: clamp_import_due_at(enrollment.due_at, now),
            ..enrollment
        });
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin the annotation import: {error}"))?;
    for annotation in &sanitized {
        mirror_legacy_annotation_into_v6_core(&transaction, root, annotation)?;
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
    ensure_v6_root_writable(&transaction, root)?;
    for reflection in &reflections {
        if reflection.deleted_at.is_some() {
            continue;
        }
        upsert_reflection_row(&transaction, root, reflection)?;
        sync_reflection_to_entry(&transaction, root, reflection)?;
    }
    for enrollment in &enrollments {
        upsert_review_enrollment_row(&transaction, root, enrollment)?;
    }
    refresh_v6_migration_ledger(&transaction, root, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit the annotation import: {error}"))?;
    Ok(sanitized.len() as u64)
}

/// Shared WHERE clause for enrollment-only review-queue candidates: live
/// excerpts with an unsuspended enrollment and `due_at` by `?2`.
/// Parameters: ?1 root, ?2 now.
const REVIEW_CANDIDATE_CONDITIONS: &str = "e.library_root = ?1
       AND e.deleted_at IS NULL
       AND trim(e.source_text, ' \t\r\n') <> ''
       AND r.deleted_at IS NULL
       AND r.suspended = 0
       AND r.due_at <= ?2";

fn list_review_queue_rows(
    connection: &Connection,
    root: &str,
    now_ms: u64,
    limit: usize,
) -> CommandResult<Vec<ReviewQueueItem>> {
    let capped = limit.clamp(1, MAX_REVIEW_QUEUE_LIMIT);
    let fetch = (capped * REVIEW_QUEUE_OVERFETCH) as i64;
    let sql = format!(
        "SELECT e.id, e.relative_path, e.source_text, e.anchor_json, e.source_revision_json,
                e.style, e.tone, e.legacy_kind, e.legacy_color, e.legacy_title,
                e.legacy_selected_text, e.sort_index, e.created_at, e.updated_at, e.deleted_at,
                r.box, r.due_at, r.last_reviewed_at, r.total_reviews, r.suspended
         FROM excerpts e
         INNER JOIN review_enrollments r
             ON r.excerpt_id = e.id AND r.library_root = e.library_root
         WHERE {REVIEW_CANDIDATE_CONDITIONS}
         ORDER BY r.due_at ASC, e.id ASC
         LIMIT ?3"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("Cannot prepare the review queue: {error}"))?;
    let reflections = reflection_map(connection, root)?;
    let mapped = statement
        .query_map(
            params![root, now_ms.min(i64::MAX as u64) as i64, fetch],
            |row| {
                let excerpt = excerpt_from_row(row)?;
                let review = ReviewState {
                    box_level: row.get(15)?,
                    due_at: row.get::<_, i64>(16)? as u64,
                    last_reviewed_at: row.get::<_, Option<i64>>(17)?.map(|value| value as u64),
                    total_reviews: row.get::<_, i64>(18)? as u64,
                    suspended: row.get::<_, i64>(19)? != 0,
                };
                Ok((excerpt, review))
            },
        )
        .map_err(|error| format!("Cannot list the review queue: {error}"))?;
    let mut items = Vec::new();
    for row in mapped {
        let (excerpt, review) =
            row.map_err(|error| format!("Cannot decode a review queue item: {error}"))?;
        let note = projected_reflection_note(excerpt.deleted_at, reflections.get(&excerpt.id));
        items.push(ReviewQueueItem {
            annotation: excerpt_to_legacy_annotation(&excerpt, note),
            review,
        });
    }
    Ok(items)
}

// The parameter list mirrors the review columns on purpose.
#[allow(clippy::too_many_arguments)]
fn validate_review_outcome_fields(
    box_level: i64,
    due_at: u64,
    last_reviewed_at: Option<u64>,
    now: u64,
) -> CommandResult<()> {
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
    Ok(())
}

// Dual-write live enrollments only; missing rows stay unenrolled.
#[allow(clippy::too_many_arguments)]
fn sync_review_outcome_to_enrollment(
    connection: &Connection,
    root: &str,
    annotation_id: &str,
    box_level: i64,
    due_at: u64,
    last_reviewed_at: Option<u64>,
    suspended: bool,
    now: u64,
) -> CommandResult<()> {
    let Some(mut enrollment) = read_review_enrollment_row(connection, root, annotation_id)? else {
        return Ok(());
    };
    if enrollment.deleted_at.is_some() {
        return Ok(());
    }
    enrollment.box_level = box_level;
    enrollment.due_at = due_at;
    enrollment.last_reviewed_at = last_reviewed_at;
    enrollment.suspended = suspended;
    enrollment.updated_at = now;
    if !suspended {
        enrollment.total_reviews = enrollment.total_reviews.saturating_add(1);
    }
    upsert_review_enrollment_row(connection, root, &enrollment)
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
         FROM excerpts e
         INNER JOIN review_enrollments r
             ON r.excerpt_id = e.id AND r.library_root = e.library_root
         WHERE {REVIEW_CANDIDATE_CONDITIONS}"
    );
    let now_clamped = now_ms.min(i64::MAX as u64) as i64;
    let due_count: i64 = connection
        .query_row(&sql, params![root, now_clamped], |row| row.get(0))
        .map_err(|error| format!("Cannot count due reviews: {error}"))?;
    let reviewed_today: i64 = connection
        .query_row(
            "SELECT count(*) FROM review_enrollments
             WHERE library_root = ?1
               AND deleted_at IS NULL
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

fn collect_search_ids(
    connection: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
) -> CommandResult<Vec<String>> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Cannot prepare the annotation search: {error}"))?;
    let mapped = statement
        .query_map(params, |row| row.get(0))
        .map_err(|error| format!("Cannot search annotations: {error}"))?;
    let mut ids = Vec::new();
    for row in mapped {
        ids.push(row.map_err(|error| format!("Cannot decode annotation id: {error}"))?);
    }
    Ok(ids)
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
    let pattern = like_pattern(&normalized);
    let mut hit_ids = HashSet::new();

    // Excerpt body + reflection note: trigram FTS for longer queries, LIKE for
    // short CJK tokens that the index cannot usefully match.
    let excerpt_ids = if normalized.chars().count() >= MIN_FTS_QUERY_CHARS {
        let phrase = fts_phrase(&normalized);
        collect_search_ids(
            connection,
            "SELECT e.id
             FROM excerpts e
             JOIN excerpts_fts ON excerpts_fts.rowid = e.rowid
             WHERE e.library_root = ?1
               AND e.deleted_at IS NULL
               AND excerpts_fts MATCH ?2",
            &[&root as &dyn rusqlite::ToSql, &phrase],
        )?
    } else {
        collect_search_ids(
            connection,
            "SELECT id FROM excerpts
             WHERE library_root = ?1
               AND deleted_at IS NULL
               AND searchable_text LIKE ?2 ESCAPE '\\'",
            &[&root as &dyn rusqlite::ToSql, &pattern],
        )?
    };
    hit_ids.extend(excerpt_ids);

    // Title supplement for excerpts (legacy_title is not in searchable_text).
    hit_ids.extend(collect_search_ids(
        connection,
        "SELECT id FROM excerpts
         WHERE library_root = ?1
           AND deleted_at IS NULL
           AND lower(ifnull(legacy_title, '')) LIKE ?2 ESCAPE '\\'",
        &[&root as &dyn rusqlite::ToSql, &pattern],
    )?);

    // Reading places: title + optional reflection body (no place FTS table).
    hit_ids.extend(collect_search_ids(
        connection,
        "SELECT p.id
         FROM reading_places p
         LEFT JOIN reflections r
           ON r.library_root = p.library_root
          AND r.entry_id = p.id
          AND r.deleted_at IS NULL
         WHERE p.library_root = ?1
           AND p.deleted_at IS NULL
           AND (
             lower(ifnull(p.title, '')) LIKE ?2 ESCAPE '\\'
             OR lower(ifnull(r.body, '')) LIKE ?2 ESCAPE '\\'
           )",
        &[&root as &dyn rusqlite::ToSql, &pattern],
    )?);

    let reflections = reflection_map(connection, root)?;
    let mut results = Vec::with_capacity(hit_ids.len());
    for id in hit_ids {
        if let Some(excerpt) = read_excerpt_row(connection, root, &id)? {
            if excerpt.deleted_at.is_some() {
                continue;
            }
            let note = projected_reflection_note(None, reflections.get(&id));
            results.push(excerpt_to_legacy_annotation(&excerpt, note));
            continue;
        }
        if let Some(place) = read_reading_place_row(connection, root, &id)? {
            if place.deleted_at.is_some() {
                continue;
            }
            let note = projected_reflection_note(None, reflections.get(&id));
            results.push(reading_place_to_legacy_annotation(&place, note));
        }
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

fn annotation_search_hits(
    connection: &Connection,
    root: &str,
    annotations: Vec<Annotation>,
) -> CommandResult<Vec<AnnotationSearchHit>> {
    let enrolled_ids: HashSet<String> = connection
        .prepare(
            "SELECT excerpt_id FROM review_enrollments
             WHERE library_root = ?1 AND suspended = 0 AND deleted_at IS NULL",
        )
        .map_err(|error| format!("Cannot prepare enrollment lookup: {error}"))?
        .query_map(params![root], |row| row.get(0))
        .map_err(|error| format!("Cannot list enrolled reviews: {error}"))?
        .collect::<rusqlite::Result<HashSet<String>>>()
        .map_err(|error| format!("Cannot decode enrolled reviews: {error}"))?;
    Ok(annotations
        .into_iter()
        .map(|annotation| {
            let has_reflection = annotation
                .note
                .as_ref()
                .is_some_and(|note| !note.trim().is_empty());
            let enrolled = enrolled_ids.contains(&annotation.id);
            AnnotationSearchHit {
                annotation,
                has_reflection,
                enrolled,
            }
        })
        .collect())
}

fn char_count(value: &str) -> usize {
    value.chars().count()
}

fn sql_error(context: &str, error: rusqlite::Error) -> String {
    format!("{context}: {error}")
}

fn excerpt_style_to_db(style: &ExcerptStyle) -> &'static str {
    match style {
        ExcerptStyle::Highlight => "highlight",
        ExcerptStyle::Underline => "underline",
    }
}

fn excerpt_style_from_db(value: &str) -> CommandResult<ExcerptStyle> {
    match value {
        "highlight" => Ok(ExcerptStyle::Highlight),
        "underline" => Ok(ExcerptStyle::Underline),
        _ => Err(format!("Unknown excerpt style: {value}")),
    }
}

fn excerpt_tone_to_db(tone: &ExcerptTone) -> &'static str {
    match tone {
        ExcerptTone::Sand => "sand",
        ExcerptTone::Sage => "sage",
        ExcerptTone::Slate => "slate",
    }
}

fn excerpt_tone_from_db(value: &str) -> CommandResult<ExcerptTone> {
    match value {
        "sand" => Ok(ExcerptTone::Sand),
        "sage" => Ok(ExcerptTone::Sage),
        "slate" => Ok(ExcerptTone::Slate),
        _ => Err(format!("Unknown excerpt tone: {value}")),
    }
}

fn entry_kind_to_db(kind: &AnnotationEntryKind) -> &'static str {
    match kind {
        AnnotationEntryKind::Excerpt => "excerpt",
        AnnotationEntryKind::Place => "place",
    }
}

fn entry_kind_from_db(value: &str) -> CommandResult<AnnotationEntryKind> {
    match value {
        "excerpt" => Ok(AnnotationEntryKind::Excerpt),
        "place" => Ok(AnnotationEntryKind::Place),
        _ => Err(format!("Unknown annotation entry kind: {value}")),
    }
}

fn require_bounded_text(
    value: &str,
    label: &str,
    max_chars: usize,
    allow_blank: bool,
) -> CommandResult<()> {
    if !allow_blank && value.trim().is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if char_count(value) > max_chars {
        return Err(format!("{label} exceeds {max_chars} characters"));
    }
    Ok(())
}

fn require_ratio(value: f64, label: &str) -> CommandResult<()> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn sanitize_required_text(value: String, max_chars: usize, label: &str) -> CommandResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if char_count(trimmed) > max_chars {
        return Err(format!("{label} exceeds {max_chars} characters"));
    }
    Ok(trimmed.to_owned())
}

fn sanitize_quote(quote: &TextQuoteSelector) -> CommandResult<()> {
    require_bounded_text(&quote.exact, "quote", MAX_ANNOTATION_TEXT_CHARS, false)?;
    require_bounded_text(&quote.prefix, "quote prefix", MAX_QUOTE_CONTEXT_CHARS, true)?;
    require_bounded_text(&quote.suffix, "quote suffix", MAX_QUOTE_CONTEXT_CHARS, true)?;
    Ok(())
}

fn sanitize_source_anchor(anchor: &SourceAnchor) -> CommandResult<()> {
    match anchor {
        SourceAnchor::Markdown {
            quote, start, end, ..
        } => {
            sanitize_quote(quote)?;
            if let (Some(start), Some(end)) = (start, end) {
                if end < start {
                    return Err("Markdown annotation position is inverted".to_owned());
                }
            }
        }
        SourceAnchor::PdfText {
            page,
            view,
            quote,
            rects,
            page_width,
            page_height,
        } => {
            sanitize_quote(quote)?;
            if *page == 0 {
                return Err("PDF annotation page is invalid".to_owned());
            }
            if view != "original" && view != "reading" {
                return Err("PDF annotation view must be original or reading".to_owned());
            }
            if rects.len() > MAX_ANNOTATION_RECTS {
                return Err("PDF annotation has too many rectangles".to_owned());
            }
            for rect in rects {
                if ![rect.x, rect.y, rect.w, rect.h]
                    .into_iter()
                    .all(f64::is_finite)
                    || rect.w <= 0.0
                    || rect.h <= 0.0
                {
                    return Err("PDF annotation rectangle is invalid".to_owned());
                }
            }
            for dimension in [*page_width, *page_height].into_iter().flatten() {
                if !dimension.is_finite() || dimension <= 0.0 {
                    return Err("PDF annotation page size is invalid".to_owned());
                }
            }
        }
        SourceAnchor::Epub {
            chapter_id,
            start_offset,
            end_offset,
            quote,
            start,
            end,
            ..
        } => {
            require_bounded_text(chapter_id, "EPUB chapter", MAX_CHAPTER_ID_CHARS, false)?;
            sanitize_quote(quote)?;
            if end_offset < start_offset {
                return Err("EPUB annotation position is inverted".to_owned());
            }
            if let (Some(start), Some(end)) = (start, end) {
                if end < start {
                    return Err("EPUB annotation position is inverted".to_owned());
                }
            }
        }
    }
    Ok(())
}

fn sanitize_excerpt_draft(mut draft: ExcerptDraft) -> CommandResult<ExcerptDraft> {
    validate_annotation_id(&draft.id)?;
    validate_relative_library_path(&draft.relative_path)?;
    draft.relative_path = normalize_relative_path(Path::new(&draft.relative_path));
    require_bounded_text(
        &draft.source_text,
        "excerpt text",
        MAX_ANNOTATION_TEXT_CHARS,
        false,
    )?;
    sanitize_source_anchor(&draft.anchor)?;
    if !is_valid_sort_index(&draft.sort_index) {
        return Err("Annotation sort index is invalid".to_owned());
    }
    Ok(draft)
}

fn sanitize_reading_place_draft(mut draft: ReadingPlaceDraft) -> CommandResult<ReadingPlaceDraft> {
    validate_annotation_id(&draft.id)?;
    validate_relative_library_path(&draft.relative_path)?;
    draft.relative_path = normalize_relative_path(Path::new(&draft.relative_path));
    if let Some(title) = &draft.title {
        require_bounded_text(title, "bookmark title", MAX_ANNOTATION_TITLE_CHARS, false)?;
    }
    if !is_valid_sort_index(&draft.sort_index) {
        return Err("Annotation sort index is invalid".to_owned());
    }
    match &draft.target {
        BookmarkTarget::Markdown { scroll_ratio, .. } => {
            require_ratio(*scroll_ratio, "Markdown reading position")?;
        }
        BookmarkTarget::Pdf { page, offset_ratio } => {
            if *page == 0 {
                return Err("PDF bookmark page is invalid".to_owned());
            }
            require_ratio(*offset_ratio, "PDF reading position")?;
        }
        BookmarkTarget::Epub {
            chapter_id,
            scroll_ratio,
            ..
        } => {
            require_bounded_text(chapter_id, "EPUB chapter", MAX_CHAPTER_ID_CHARS, false)?;
            require_ratio(*scroll_ratio, "EPUB reading position")?;
        }
    }
    Ok(draft)
}

fn live_reflection_body(reflection: Option<&Reflection>) -> Option<&str> {
    reflection
        .filter(|item| item.deleted_at.is_none())
        .map(|item| item.body.as_str())
}

fn projected_reflection_note(
    entry_deleted_at: Option<u64>,
    reflection: Option<&Reflection>,
) -> Option<String> {
    let reflection = reflection?;
    if reflection.deleted_at.is_none()
        || (entry_deleted_at.is_some() && reflection.deleted_at == entry_deleted_at)
    {
        Some(reflection.body.clone())
    } else {
        None
    }
}

fn excerpt_from_legacy_annotation(
    annotation: &Annotation,
    source_revision: Option<SourceRevision>,
    existing: Option<&Excerpt>,
) -> CommandResult<Excerpt> {
    let anchor = annotation_locator_to_source_anchor(&annotation.locator)?;
    let style = match annotation.kind {
        AnnotationKind::Highlight => ExcerptStyle::Highlight,
        AnnotationKind::Underline => ExcerptStyle::Underline,
        AnnotationKind::Bookmark => {
            return Err("A bookmark annotation cannot project to an excerpt".to_owned());
        }
    };
    let source_text = match annotation
        .selected_text
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_owned(),
        None => match &anchor {
            SourceAnchor::Markdown { quote, .. }
            | SourceAnchor::PdfText { quote, .. }
            | SourceAnchor::Epub { quote, .. } => quote.exact.clone(),
        },
    };
    let (tone, legacy_color, created_at) = if let Some(existing) = existing {
        let incoming_tone = legacy_color_to_tone(annotation.color.as_ref());
        if incoming_tone != existing.appearance.tone {
            (incoming_tone, annotation.color.clone(), existing.created_at)
        } else {
            (
                existing.appearance.tone.clone(),
                existing.legacy_color.clone(),
                existing.created_at,
            )
        }
    } else {
        (
            legacy_color_to_tone(annotation.color.as_ref()),
            annotation.color.clone(),
            annotation.created_at,
        )
    };
    Ok(Excerpt {
        id: annotation.id.clone(),
        relative_path: annotation.relative_path.clone(),
        source_text,
        anchor,
        source_revision,
        appearance: ExcerptAppearance {
            style: style.clone(),
            tone,
        },
        sort_index: annotation.sort_index.clone(),
        created_at,
        updated_at: annotation.updated_at,
        deleted_at: annotation.deleted_at,
        legacy_kind: Some(style),
        legacy_color,
        legacy_title: annotation.title.clone(),
        legacy_selected_text: annotation.selected_text.clone(),
    })
}

fn place_from_legacy_annotation(
    annotation: &Annotation,
    source_revision: Option<SourceRevision>,
    existing: Option<&ReadingPlace>,
) -> CommandResult<ReadingPlace> {
    let AnnotationLocator::Bookmark { target } = &annotation.locator else {
        return Err("A bookmark annotation cannot migrate from a text locator".to_owned());
    };
    Ok(ReadingPlace {
        id: annotation.id.clone(),
        relative_path: annotation.relative_path.clone(),
        title: annotation.title.clone(),
        target: target.clone(),
        source_revision,
        sort_index: annotation.sort_index.clone(),
        created_at: existing
            .map(|place| place.created_at)
            .unwrap_or(annotation.created_at),
        updated_at: annotation.updated_at,
        deleted_at: annotation.deleted_at,
        legacy_color: existing
            .and_then(|place| place.legacy_color.clone())
            .or_else(|| annotation.color.clone()),
        legacy_selected_text: existing
            .and_then(|place| place.legacy_selected_text.clone())
            .or_else(|| annotation.selected_text.clone()),
    })
}

#[cfg(test)]
fn mirror_legacy_annotation_into_v6(
    connection: &Connection,
    root: &str,
    annotation: &Annotation,
) -> CommandResult<()> {
    mirror_legacy_annotation_into_v6_core(connection, root, annotation)?;
    if v6_ledger_ready(connection, root)? {
        refresh_v6_migration_ledger(connection, root, annotation.updated_at)?;
    }
    Ok(())
}

fn mirror_legacy_annotation_into_v6_core(
    connection: &Connection,
    root: &str,
    annotation: &Annotation,
) -> CommandResult<()> {
    let source_revision = source_revision_for_path(
        connection,
        root,
        &annotation.relative_path,
        annotation.updated_at,
    )?;
    match annotation.kind {
        AnnotationKind::Highlight | AnnotationKind::Underline => {
            let existing = read_excerpt_row(connection, root, &annotation.id)?;
            let excerpt =
                excerpt_from_legacy_annotation(annotation, source_revision, existing.as_ref())?;
            let reflection = read_reflection_row(connection, root, &annotation.id)?;
            let note = annotation
                .note
                .as_deref()
                .or_else(|| live_reflection_body(reflection.as_ref()));
            connection
                .execute(
                    "DELETE FROM reading_places WHERE library_root = ?1 AND id = ?2",
                    params![root, annotation.id],
                )
                .map_err(|error| sql_error("Cannot clear mirrored reading place", error))?;
            upsert_excerpt_row(connection, root, &excerpt, note)?;
            if let Some(body) = annotation
                .note
                .as_ref()
                .filter(|value| !value.trim().is_empty())
            {
                upsert_reflection_row(
                    connection,
                    root,
                    &Reflection {
                        entry_id: annotation.id.clone(),
                        entry_kind: AnnotationEntryKind::Excerpt,
                        body: body.clone(),
                        created_at: reflection
                            .as_ref()
                            .map(|item| item.created_at)
                            .unwrap_or(annotation.created_at),
                        updated_at: annotation.updated_at,
                        deleted_at: annotation.deleted_at,
                    },
                )?;
            }
        }
        AnnotationKind::Bookmark => {
            let existing = read_reading_place_row(connection, root, &annotation.id)?;
            let place =
                place_from_legacy_annotation(annotation, source_revision, existing.as_ref())?;
            let reflection = read_reflection_row(connection, root, &annotation.id)?;
            connection
                .execute(
                    "DELETE FROM excerpts WHERE library_root = ?1 AND id = ?2",
                    params![root, annotation.id],
                )
                .map_err(|error| sql_error("Cannot clear mirrored excerpt", error))?;
            upsert_reading_place_row(connection, root, &place)?;
            if let Some(body) = annotation
                .note
                .as_ref()
                .filter(|value| !value.trim().is_empty())
            {
                upsert_reflection_row(
                    connection,
                    root,
                    &Reflection {
                        entry_id: annotation.id.clone(),
                        entry_kind: AnnotationEntryKind::Place,
                        body: body.clone(),
                        created_at: reflection
                            .as_ref()
                            .map(|item| item.created_at)
                            .unwrap_or(annotation.created_at),
                        updated_at: annotation.updated_at,
                        deleted_at: annotation.deleted_at,
                    },
                )?;
            }
        }
    }
    Ok(())
}

fn source_revision_for_path(
    connection: &Connection,
    root: &str,
    relative_path: &str,
    now: u64,
) -> CommandResult<Option<SourceRevision>> {
    let hash: Option<String> = connection
        .query_row(
            "SELECT content_hash FROM documents
             WHERE library_root = ?1 AND relative_path = ?2",
            params![root, relative_path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| sql_error("Cannot read document fingerprint", error))?;
    Ok(hash.map(|content_hash| SourceRevision {
        content_hash,
        observed_at: now,
        basis: SourceRevisionBasis::Capture,
    }))
}

fn count_root_rows(connection: &Connection, sql: &str, root: &str) -> CommandResult<i64> {
    connection
        .query_row(sql, params![root], |row| row.get(0))
        .map_err(|error| sql_error("Cannot count annotation rows", error))
}

fn v6_ledger_ready(connection: &Connection, root: &str) -> CommandResult<bool> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT source_checksum, target_checksum
             FROM annotation_v6_migration WHERE library_root = ?1",
            params![root],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| sql_error("Cannot read annotation v6 ledger", error))?;
    Ok(matches!(row, Some((source, target)) if source == target))
}

fn ensure_v6_root_writable(connection: &Connection, root: &str) -> CommandResult<()> {
    if v6_ledger_ready(connection, root)? {
        return Ok(());
    }
    // Fresh roots after v7 have no ledger row yet; seed an empty ready ledger.
    refresh_v6_migration_ledger(connection, root, now_millis())
}

fn excerpt_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Excerpt> {
    let anchor_json: String = row.get(3)?;
    let anchor = serde_json::from_str(&anchor_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let source_revision_json: Option<String> = row.get(4)?;
    let source_revision = source_revision_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    let style_raw: String = row.get(5)?;
    let tone_raw: String = row.get(6)?;
    let legacy_kind_raw: Option<String> = row.get(7)?;
    let legacy_color_raw: Option<String> = row.get(8)?;
    Ok(Excerpt {
        id: row.get(0)?,
        relative_path: row.get(1)?,
        source_text: row.get(2)?,
        anchor,
        source_revision,
        appearance: ExcerptAppearance {
            style: excerpt_style_from_db(&style_raw).map_err(|message| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    message.into(),
                )
            })?,
            tone: excerpt_tone_from_db(&tone_raw).map_err(|message| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Text,
                    message.into(),
                )
            })?,
        },
        sort_index: row.get(11)?,
        created_at: row.get::<_, i64>(12)? as u64,
        updated_at: row.get::<_, i64>(13)? as u64,
        deleted_at: row.get::<_, Option<i64>>(14)?.map(|value| value as u64),
        legacy_kind: legacy_kind_raw
            .as_deref()
            .map(excerpt_style_from_db)
            .transpose()
            .map_err(|message| {
                rusqlite::Error::FromSqlConversionFailure(
                    7,
                    rusqlite::types::Type::Text,
                    message.into(),
                )
            })?,
        legacy_color: legacy_color_raw
            .as_deref()
            .map(annotation_color_from_db)
            .transpose()
            .map_err(|message| {
                rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Text,
                    message.into(),
                )
            })?,
        legacy_title: row.get(9)?,
        legacy_selected_text: row.get(10)?,
    })
}

fn reading_place_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingPlace> {
    let target_json: String = row.get(3)?;
    let target = serde_json::from_str(&target_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let source_revision_json: Option<String> = row.get(4)?;
    let source_revision = source_revision_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    let legacy_color_raw: Option<String> = row.get(5)?;
    Ok(ReadingPlace {
        id: row.get(0)?,
        relative_path: row.get(1)?,
        title: row.get(2)?,
        target,
        source_revision,
        sort_index: row.get(7)?,
        created_at: row.get::<_, i64>(8)? as u64,
        updated_at: row.get::<_, i64>(9)? as u64,
        deleted_at: row.get::<_, Option<i64>>(10)?.map(|value| value as u64),
        legacy_color: legacy_color_raw
            .as_deref()
            .map(annotation_color_from_db)
            .transpose()
            .map_err(|message| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    message.into(),
                )
            })?,
        legacy_selected_text: row.get(6)?,
    })
}

fn reflection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Reflection> {
    let kind_raw: String = row.get(1)?;
    Ok(Reflection {
        entry_id: row.get(0)?,
        entry_kind: entry_kind_from_db(&kind_raw).map_err(|message| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                message.into(),
            )
        })?,
        body: row.get(2)?,
        created_at: row.get::<_, i64>(3)? as u64,
        updated_at: row.get::<_, i64>(4)? as u64,
        deleted_at: row.get::<_, Option<i64>>(5)?.map(|value| value as u64),
    })
}

fn review_enrollment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewEnrollment> {
    Ok(ReviewEnrollment {
        excerpt_id: row.get(0)?,
        enrolled_at: row.get::<_, i64>(1)? as u64,
        box_level: row.get(2)?,
        due_at: row.get::<_, i64>(3)? as u64,
        last_reviewed_at: row.get::<_, Option<i64>>(4)?.map(|value| value as u64),
        total_reviews: row.get::<_, i64>(5)? as u64,
        suspended: row.get::<_, i64>(6)? != 0,
        updated_at: row.get::<_, i64>(7)? as u64,
        deleted_at: row.get::<_, Option<i64>>(8)?.map(|value| value as u64),
    })
}

const EXCERPT_COLUMNS: &str = "id, relative_path, source_text, anchor_json, source_revision_json,
     style, tone, legacy_kind, legacy_color, legacy_title, legacy_selected_text,
     sort_index, created_at, updated_at, deleted_at";
const PLACE_COLUMNS: &str = "id, relative_path, title, target_json, source_revision_json,
     legacy_color, legacy_selected_text, sort_index, created_at, updated_at, deleted_at";
const REFLECTION_COLUMNS: &str = "entry_id, entry_kind, body, created_at, updated_at, deleted_at";
const ENROLLMENT_COLUMNS: &str = "excerpt_id, enrolled_at, box, due_at, last_reviewed_at,
     total_reviews, suspended, updated_at, deleted_at";

fn read_excerpt_row(
    connection: &Connection,
    root: &str,
    id: &str,
) -> CommandResult<Option<Excerpt>> {
    connection
        .query_row(
            &format!(
                "SELECT {EXCERPT_COLUMNS} FROM excerpts
                 WHERE library_root = ?1 AND id = ?2"
            ),
            params![root, id],
            excerpt_from_row,
        )
        .optional()
        .map_err(|error| sql_error("Cannot read excerpt", error))
}

fn read_reading_place_row(
    connection: &Connection,
    root: &str,
    id: &str,
) -> CommandResult<Option<ReadingPlace>> {
    connection
        .query_row(
            &format!(
                "SELECT {PLACE_COLUMNS} FROM reading_places
                 WHERE library_root = ?1 AND id = ?2"
            ),
            params![root, id],
            reading_place_from_row,
        )
        .optional()
        .map_err(|error| sql_error("Cannot read reading place", error))
}

fn read_reflection_row(
    connection: &Connection,
    root: &str,
    entry_id: &str,
) -> CommandResult<Option<Reflection>> {
    connection
        .query_row(
            &format!(
                "SELECT {REFLECTION_COLUMNS} FROM reflections
                 WHERE library_root = ?1 AND entry_id = ?2"
            ),
            params![root, entry_id],
            reflection_from_row,
        )
        .optional()
        .map_err(|error| sql_error("Cannot read reflection", error))
}

fn read_review_enrollment_row(
    connection: &Connection,
    root: &str,
    excerpt_id: &str,
) -> CommandResult<Option<ReviewEnrollment>> {
    connection
        .query_row(
            &format!(
                "SELECT {ENROLLMENT_COLUMNS} FROM review_enrollments
                 WHERE library_root = ?1 AND excerpt_id = ?2"
            ),
            params![root, excerpt_id],
            review_enrollment_from_row,
        )
        .optional()
        .map_err(|error| sql_error("Cannot read review enrollment", error))
}

fn query_mapped<T>(
    connection: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
    mapper: fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    context: &str,
) -> CommandResult<Vec<T>> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| sql_error(context, error))?;
    let mapped = statement
        .query_map(params, mapper)
        .map_err(|error| sql_error(context, error))?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row.map_err(|error| sql_error(context, error))?);
    }
    Ok(rows)
}

fn load_excerpts(
    connection: &Connection,
    root: &str,
    relative_path: Option<&str>,
    include_deleted: bool,
) -> CommandResult<Vec<Excerpt>> {
    let deleted_clause = if include_deleted {
        ""
    } else {
        "AND deleted_at IS NULL"
    };
    if let Some(path) = relative_path {
        query_mapped(
            connection,
            &format!(
                "SELECT {EXCERPT_COLUMNS} FROM excerpts
                 WHERE library_root = ?1 AND relative_path = ?2 {deleted_clause}
                 ORDER BY sort_index ASC, id ASC"
            ),
            params![root, path],
            excerpt_from_row,
            "Cannot list excerpts",
        )
    } else {
        query_mapped(
            connection,
            &format!(
                "SELECT {EXCERPT_COLUMNS} FROM excerpts
                 WHERE library_root = ?1 {deleted_clause}
                 ORDER BY relative_path ASC, sort_index ASC, id ASC"
            ),
            params![root],
            excerpt_from_row,
            "Cannot list excerpts",
        )
    }
}

fn load_reading_places(
    connection: &Connection,
    root: &str,
    relative_path: Option<&str>,
    include_deleted: bool,
) -> CommandResult<Vec<ReadingPlace>> {
    let deleted_clause = if include_deleted {
        ""
    } else {
        "AND deleted_at IS NULL"
    };
    if let Some(path) = relative_path {
        query_mapped(
            connection,
            &format!(
                "SELECT {PLACE_COLUMNS} FROM reading_places
                 WHERE library_root = ?1 AND relative_path = ?2 {deleted_clause}
                 ORDER BY sort_index ASC, id ASC"
            ),
            params![root, path],
            reading_place_from_row,
            "Cannot list reading places",
        )
    } else {
        query_mapped(
            connection,
            &format!(
                "SELECT {PLACE_COLUMNS} FROM reading_places
                 WHERE library_root = ?1 {deleted_clause}
                 ORDER BY relative_path ASC, sort_index ASC, id ASC"
            ),
            params![root],
            reading_place_from_row,
            "Cannot list reading places",
        )
    }
}

fn load_reflections(
    connection: &Connection,
    root: &str,
    include_deleted: bool,
) -> CommandResult<Vec<Reflection>> {
    let deleted_clause = if include_deleted {
        ""
    } else {
        "AND deleted_at IS NULL"
    };
    query_mapped(
        connection,
        &format!(
            "SELECT {REFLECTION_COLUMNS} FROM reflections
             WHERE library_root = ?1 {deleted_clause}
             ORDER BY entry_id ASC"
        ),
        params![root],
        reflection_from_row,
        "Cannot list reflections",
    )
}

fn reflection_map(
    connection: &Connection,
    root: &str,
) -> CommandResult<HashMap<String, Reflection>> {
    Ok(load_reflections(connection, root, true)?
        .into_iter()
        .map(|reflection| (reflection.entry_id.clone(), reflection))
        .collect())
}

fn list_document_annotation_rows(
    connection: &Connection,
    root: &str,
    relative_path: &str,
) -> CommandResult<DocumentAnnotationBundle> {
    if !v6_ledger_ready(connection, root)? {
        let legacy = count_root_rows(
            connection,
            "SELECT count(*) FROM annotations WHERE library_root = ?1",
            root,
        )?;
        if legacy > 0 {
            return Err("this library is still on the legacy annotation reader".to_owned());
        }
    }
    let excerpts = load_excerpts(connection, root, Some(relative_path), false)?;
    let places = load_reading_places(connection, root, Some(relative_path), false)?;
    let live_ids: HashSet<String> = excerpts
        .iter()
        .map(|item| item.id.clone())
        .chain(places.iter().map(|item| item.id.clone()))
        .collect();
    let excerpt_ids: HashSet<String> = excerpts.iter().map(|item| item.id.clone()).collect();
    let reflections = load_reflections(connection, root, false)?
        .into_iter()
        .filter(|item| live_ids.contains(&item.entry_id))
        .collect();
    let review_enrollments = query_mapped(
        connection,
        &format!(
            "SELECT {ENROLLMENT_COLUMNS} FROM review_enrollments
             WHERE library_root = ?1 AND deleted_at IS NULL
             ORDER BY excerpt_id ASC"
        ),
        params![root],
        review_enrollment_from_row,
        "Cannot list review enrollments",
    )?
    .into_iter()
    .filter(|item| excerpt_ids.contains(&item.excerpt_id))
    .collect();
    Ok(DocumentAnnotationBundle {
        excerpts,
        places,
        reflections,
        review_enrollments,
    })
}

fn verify_row_owned(
    connection: &Connection,
    sql: &str,
    id: &str,
    root: &str,
    label: &str,
) -> CommandResult<()> {
    let owned: i64 = connection
        .query_row(sql, params![id, root], |row| row.get(0))
        .map_err(|error| sql_error(&format!("Cannot verify {label} ownership"), error))?;
    if owned == 0 {
        return Err(format!("{label} id belongs to another library"));
    }
    Ok(())
}

fn upsert_excerpt_row(
    connection: &Connection,
    root: &str,
    excerpt: &Excerpt,
    note: Option<&str>,
) -> CommandResult<()> {
    let anchor_json = serde_json::to_string(&excerpt.anchor)
        .map_err(|error| format!("Cannot encode excerpt anchor: {error}"))?;
    let source_revision_json = excerpt
        .source_revision
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("Cannot encode excerpt revision: {error}"))?;
    let searchable = build_searchable_text(Some(&excerpt.source_text), note);
    connection
        .execute(
            "INSERT INTO excerpts(
                 id, library_root, relative_path, source_text, anchor_json,
                 source_revision_json, style, tone, legacy_kind, legacy_color,
                 legacy_title, legacy_selected_text, sort_index, searchable_text,
                 created_at, updated_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17)
             ON CONFLICT(id) DO UPDATE SET
                 library_root = excluded.library_root,
                 relative_path = excluded.relative_path,
                 source_text = excluded.source_text,
                 anchor_json = excluded.anchor_json,
                 source_revision_json = excluded.source_revision_json,
                 style = excluded.style,
                 tone = excluded.tone,
                 legacy_kind = excluded.legacy_kind,
                 legacy_color = excluded.legacy_color,
                 legacy_title = excluded.legacy_title,
                 legacy_selected_text = excluded.legacy_selected_text,
                 sort_index = excluded.sort_index,
                 searchable_text = excluded.searchable_text,
                 created_at = excluded.created_at,
                 updated_at = excluded.updated_at,
                 deleted_at = excluded.deleted_at
             WHERE excerpts.library_root = excluded.library_root",
            params![
                excerpt.id,
                root,
                excerpt.relative_path,
                excerpt.source_text,
                anchor_json,
                source_revision_json,
                excerpt_style_to_db(&excerpt.appearance.style),
                excerpt_tone_to_db(&excerpt.appearance.tone),
                excerpt.legacy_kind.as_ref().map(excerpt_style_to_db),
                excerpt.legacy_color.as_ref().map(annotation_color_to_db),
                excerpt.legacy_title,
                excerpt.legacy_selected_text,
                excerpt.sort_index,
                searchable,
                excerpt.created_at as i64,
                excerpt.updated_at as i64,
                excerpt.deleted_at.map(|value| value as i64),
            ],
        )
        .map_err(|error| sql_error("Cannot save excerpt", error))?;
    verify_row_owned(
        connection,
        "SELECT count(*) FROM excerpts WHERE id = ?1 AND library_root = ?2",
        &excerpt.id,
        root,
        "Excerpt",
    )
}

fn upsert_reading_place_row(
    connection: &Connection,
    root: &str,
    place: &ReadingPlace,
) -> CommandResult<()> {
    let target_json = serde_json::to_string(&place.target)
        .map_err(|error| format!("Cannot encode reading place target: {error}"))?;
    let source_revision_json = place
        .source_revision
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("Cannot encode reading place revision: {error}"))?;
    connection
        .execute(
            "INSERT INTO reading_places(
                 id, library_root, relative_path, title, target_json,
                 source_revision_json, legacy_color, legacy_selected_text,
                 sort_index, created_at, updated_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                 library_root = excluded.library_root,
                 relative_path = excluded.relative_path,
                 title = excluded.title,
                 target_json = excluded.target_json,
                 source_revision_json = excluded.source_revision_json,
                 legacy_color = excluded.legacy_color,
                 legacy_selected_text = excluded.legacy_selected_text,
                 sort_index = excluded.sort_index,
                 created_at = excluded.created_at,
                 updated_at = excluded.updated_at,
                 deleted_at = excluded.deleted_at
             WHERE reading_places.library_root = excluded.library_root",
            params![
                place.id,
                root,
                place.relative_path,
                place.title,
                target_json,
                source_revision_json,
                place.legacy_color.as_ref().map(annotation_color_to_db),
                place.legacy_selected_text,
                place.sort_index,
                place.created_at as i64,
                place.updated_at as i64,
                place.deleted_at.map(|value| value as i64),
            ],
        )
        .map_err(|error| sql_error("Cannot save reading place", error))?;
    verify_row_owned(
        connection,
        "SELECT count(*) FROM reading_places WHERE id = ?1 AND library_root = ?2",
        &place.id,
        root,
        "Reading place",
    )
}

fn upsert_reflection_row(
    connection: &Connection,
    root: &str,
    reflection: &Reflection,
) -> CommandResult<()> {
    connection
        .execute(
            "INSERT INTO reflections(
                 entry_id, entry_kind, library_root, body,
                 created_at, updated_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(entry_id) DO UPDATE SET
                 entry_kind = excluded.entry_kind,
                 library_root = excluded.library_root,
                 body = excluded.body,
                 created_at = excluded.created_at,
                 updated_at = excluded.updated_at,
                 deleted_at = excluded.deleted_at
             WHERE reflections.library_root = excluded.library_root",
            params![
                reflection.entry_id,
                entry_kind_to_db(&reflection.entry_kind),
                root,
                reflection.body,
                reflection.created_at as i64,
                reflection.updated_at as i64,
                reflection.deleted_at.map(|value| value as i64),
            ],
        )
        .map_err(|error| sql_error("Cannot save reflection", error))?;
    verify_row_owned(
        connection,
        "SELECT count(*) FROM reflections WHERE entry_id = ?1 AND library_root = ?2",
        &reflection.entry_id,
        root,
        "Reflection",
    )
}

fn upsert_review_enrollment_row(
    connection: &Connection,
    root: &str,
    enrollment: &ReviewEnrollment,
) -> CommandResult<()> {
    connection
        .execute(
            "INSERT INTO review_enrollments(
                 excerpt_id, library_root, enrolled_at, box, due_at,
                 last_reviewed_at, total_reviews, suspended, updated_at, deleted_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(excerpt_id) DO UPDATE SET
                 library_root = excluded.library_root,
                 enrolled_at = excluded.enrolled_at,
                 box = excluded.box,
                 due_at = excluded.due_at,
                 last_reviewed_at = excluded.last_reviewed_at,
                 total_reviews = excluded.total_reviews,
                 suspended = excluded.suspended,
                 updated_at = excluded.updated_at,
                 deleted_at = excluded.deleted_at
             WHERE review_enrollments.library_root = excluded.library_root",
            params![
                enrollment.excerpt_id,
                root,
                enrollment.enrolled_at as i64,
                enrollment.box_level,
                enrollment.due_at as i64,
                enrollment.last_reviewed_at.map(|value| value as i64),
                enrollment.total_reviews as i64,
                i64::from(enrollment.suspended),
                enrollment.updated_at as i64,
                enrollment.deleted_at.map(|value| value as i64),
            ],
        )
        .map_err(|error| sql_error("Cannot save review enrollment", error))?;
    verify_row_owned(
        connection,
        "SELECT count(*) FROM review_enrollments WHERE excerpt_id = ?1 AND library_root = ?2",
        &enrollment.excerpt_id,
        root,
        "Review enrollment",
    )
}

fn ensure_v6_entry_in_root(
    connection: &Connection,
    root: &str,
    entry_id: &str,
    entry_kind: &AnnotationEntryKind,
) -> CommandResult<()> {
    match entry_kind {
        AnnotationEntryKind::Excerpt => {
            read_excerpt_row(connection, root, entry_id)?
                .filter(|item| item.deleted_at.is_none())
                .ok_or_else(|| "Excerpt was not found".to_owned())?;
        }
        AnnotationEntryKind::Place => {
            read_reading_place_row(connection, root, entry_id)?
                .filter(|item| item.deleted_at.is_none())
                .ok_or_else(|| "Reading place was not found".to_owned())?;
        }
    }
    Ok(())
}

fn sync_reflection_to_entry(
    connection: &Connection,
    root: &str,
    reflection: &Reflection,
) -> CommandResult<()> {
    match reflection.entry_kind {
        AnnotationEntryKind::Excerpt => {
            let excerpt = read_excerpt_row(connection, root, &reflection.entry_id)?
                .ok_or_else(|| "Excerpt was not found".to_owned())?;
            upsert_excerpt_row(
                connection,
                root,
                &excerpt,
                live_reflection_body(Some(reflection)),
            )
        }
        AnnotationEntryKind::Place => Ok(()),
    }
}

fn set_annotation_entry_deleted_row(
    connection: &Connection,
    root: &str,
    id: &str,
    entry_kind: &AnnotationEntryKind,
    deleted: bool,
    now: u64,
) -> CommandResult<()> {
    match entry_kind {
        AnnotationEntryKind::Excerpt => {
            let mut excerpt = read_excerpt_row(connection, root, id)?
                .ok_or_else(|| "Excerpt was not found".to_owned())?;
            if deleted {
                if excerpt.deleted_at.is_some() {
                    return Err("Excerpt was not found".to_owned());
                }
                excerpt.deleted_at = Some(now);
            } else {
                let previous = excerpt
                    .deleted_at
                    .ok_or_else(|| "Excerpt was not found".to_owned())?;
                excerpt.deleted_at = None;
                if let Some(mut reflection) = read_reflection_row(connection, root, id)? {
                    if reflection.deleted_at == Some(previous) {
                        reflection.deleted_at = None;
                        reflection.updated_at = now;
                        upsert_reflection_row(connection, root, &reflection)?;
                    }
                }
            }
            excerpt.updated_at = now;
            if deleted {
                if let Some(mut reflection) = read_reflection_row(connection, root, id)?
                    .filter(|item| item.deleted_at.is_none())
                {
                    reflection.deleted_at = Some(now);
                    reflection.updated_at = now;
                    upsert_reflection_row(connection, root, &reflection)?;
                }
            }
            let reflection = read_reflection_row(connection, root, id)?;
            upsert_excerpt_row(
                connection,
                root,
                &excerpt,
                live_reflection_body(reflection.as_ref()),
            )?;
            Ok(())
        }
        AnnotationEntryKind::Place => {
            let mut place = read_reading_place_row(connection, root, id)?
                .ok_or_else(|| "Reading place was not found".to_owned())?;
            if deleted {
                if place.deleted_at.is_some() {
                    return Err("Reading place was not found".to_owned());
                }
                place.deleted_at = Some(now);
            } else {
                let previous = place
                    .deleted_at
                    .ok_or_else(|| "Reading place was not found".to_owned())?;
                place.deleted_at = None;
                if let Some(mut reflection) = read_reflection_row(connection, root, id)? {
                    if reflection.deleted_at == Some(previous) {
                        reflection.deleted_at = None;
                        reflection.updated_at = now;
                        upsert_reflection_row(connection, root, &reflection)?;
                    }
                }
            }
            place.updated_at = now;
            if deleted {
                if let Some(mut reflection) = read_reflection_row(connection, root, id)?
                    .filter(|item| item.deleted_at.is_none())
                {
                    reflection.deleted_at = Some(now);
                    reflection.updated_at = now;
                    upsert_reflection_row(connection, root, &reflection)?;
                }
            }
            upsert_reading_place_row(connection, root, &place)?;
            Ok(())
        }
    }
}

#[allow(dead_code)] // Kept for pre-v7 fixtures / rollback experiments; writers are v6-only.
fn ensure_legacy_review_suspended(
    connection: &Connection,
    root: &str,
    annotation_id: &str,
    now: u64,
) -> CommandResult<()> {
    let due_at = now.saturating_add(REVIEW_IMPLICIT_DUE_OFFSET_MS);
    connection
        .execute(
            "INSERT INTO annotation_reviews(
                 annotation_id, library_root, box, due_at, last_reviewed_at,
                 total_reviews, suspended, updated_at
             ) VALUES (?1, ?2, 0, ?3, NULL, 0, 1, ?4)
             ON CONFLICT(annotation_id) DO UPDATE SET
                 suspended = 1,
                 updated_at = excluded.updated_at",
            params![annotation_id, root, due_at as i64, now as i64],
        )
        .map_err(|error| sql_error("Cannot suspend legacy review", error))?;
    Ok(())
}

#[allow(dead_code)] // Kept for pre-v7 fixtures / rollback experiments; writers are v6-only.
fn sync_enrollment_to_legacy_review(
    connection: &Connection,
    root: &str,
    enrollment: &ReviewEnrollment,
) -> CommandResult<()> {
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
                 total_reviews = excluded.total_reviews,
                 suspended = excluded.suspended,
                 updated_at = excluded.updated_at",
            params![
                enrollment.excerpt_id,
                root,
                enrollment.box_level,
                enrollment.due_at as i64,
                enrollment.last_reviewed_at.map(|value| value as i64),
                enrollment.total_reviews as i64,
                i64::from(enrollment.suspended),
                enrollment.updated_at as i64,
            ],
        )
        .map_err(|error| sql_error("Cannot sync legacy review", error))?;
    Ok(())
}

fn reverse_project_v6_annotations(
    connection: &Connection,
    root: &str,
) -> CommandResult<Vec<Annotation>> {
    let reflections = reflection_map(connection, root)?;
    let mut projected = Vec::new();
    for excerpt in load_excerpts(connection, root, None, true)? {
        let note = projected_reflection_note(excerpt.deleted_at, reflections.get(&excerpt.id));
        projected.push(excerpt_to_legacy_annotation(&excerpt, note));
    }
    for place in load_reading_places(connection, root, None, true)? {
        let note = projected_reflection_note(place.deleted_at, reflections.get(&place.id));
        projected.push(reading_place_to_legacy_annotation(&place, note));
    }
    projected.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then_with(|| left.sort_index.cmp(&right.sort_index))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(projected)
}

fn refresh_v6_migration_ledger(connection: &Connection, root: &str, now: u64) -> CommandResult<()> {
    // v7+: legacy tables stay empty shells. Ledger tracks v6 only (no dual-write parity).
    let projected = reverse_project_v6_annotations(connection, root)?;
    let target_checksum = migration_checksum(root, &projected)?;
    let excerpt_total = count_root_rows(
        connection,
        "SELECT count(*) FROM excerpts WHERE library_root = ?1",
        root,
    )?;
    let place_total = count_root_rows(
        connection,
        "SELECT count(*) FROM reading_places WHERE library_root = ?1",
        root,
    )?;
    let reflection_total = count_root_rows(
        connection,
        "SELECT count(*) FROM reflections WHERE library_root = ?1",
        root,
    )?;
    let enrollment_total = count_root_rows(
        connection,
        "SELECT count(*) FROM review_enrollments
         WHERE library_root = ?1 AND deleted_at IS NULL",
        root,
    )?;
    connection
        .execute(
            "INSERT INTO annotation_v6_migration(
                 library_root, legacy_total, excerpt_total, place_total,
                 reflection_total, enrollment_total, source_checksum,
                 target_checksum, migrated_at
             ) VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?6, ?7)
             ON CONFLICT(library_root) DO UPDATE SET
                 legacy_total = 0,
                 excerpt_total = excluded.excerpt_total,
                 place_total = excluded.place_total,
                 reflection_total = excluded.reflection_total,
                 enrollment_total = excluded.enrollment_total,
                 source_checksum = excluded.source_checksum,
                 target_checksum = excluded.target_checksum,
                 migrated_at = excluded.migrated_at",
            params![
                root,
                excerpt_total,
                place_total,
                reflection_total,
                enrollment_total,
                target_checksum,
                now as i64,
            ],
        )
        .map_err(|error| sql_error("Cannot refresh annotation v6 ledger", error))?;
    Ok(())
}

#[allow(dead_code)] // Test / pre-v7 fixture helper; production writers use v6-only paths.
fn upsert_annotation_row_legacy(
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

/// Test / pre-v7 fixture helper. Production writers use v6-only create/update
/// commands; this path still mirrors a legacy Annotation into the v6 core for
/// search and migration regression fixtures.
#[cfg(test)]
fn upsert_annotation_row(
    connection: &Connection,
    root: &str,
    annotation: &Annotation,
) -> CommandResult<()> {
    ensure_v6_root_writable(connection, root)?;
    mirror_legacy_annotation_into_v6_core(connection, root, annotation)?;
    refresh_v6_migration_ledger(connection, root, annotation.updated_at)
}

#[cfg(test)]
fn tombstone_annotation(
    connection: &Connection,
    root: &str,
    id: &str,
    now: u64,
) -> CommandResult<()> {
    let entry_kind = if read_excerpt_row(connection, root, id)?.is_some() {
        AnnotationEntryKind::Excerpt
    } else if read_reading_place_row(connection, root, id)?.is_some() {
        AnnotationEntryKind::Place
    } else {
        return Err("Annotation was not found".to_owned());
    };
    set_annotation_entry_deleted_row(connection, root, id, &entry_kind, true, now)?;
    refresh_v6_migration_ledger(connection, root, now)
}

fn create_excerpt_rows(
    connection: &mut Connection,
    root: &str,
    draft: ExcerptDraft,
    reflection_body: Option<String>,
    now: u64,
) -> CommandResult<ExcerptCaptureResult> {
    let draft = sanitize_excerpt_draft(draft)?;
    let reflection_body = reflection_body
        .map(|body| sanitize_required_text(body, MAX_ANNOTATION_NOTE_CHARS, "reflection"))
        .transpose()?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin excerpt creation: {error}"))?;
    ensure_v6_root_writable(&transaction, root)?;
    let source_revision = source_revision_for_path(&transaction, root, &draft.relative_path, now)?;
    let source_text = draft.source_text;
    let appearance = draft.appearance;
    let excerpt = Excerpt {
        id: draft.id,
        relative_path: draft.relative_path,
        source_text: source_text.clone(),
        anchor: draft.anchor,
        source_revision,
        appearance: appearance.clone(),
        sort_index: draft.sort_index,
        created_at: now,
        updated_at: now,
        deleted_at: None,
        legacy_kind: Some(appearance.style.clone()),
        legacy_color: Some(tone_to_legacy_color(&appearance.tone)),
        legacy_title: None,
        legacy_selected_text: Some(source_text),
    };
    let reflection = reflection_body.map(|body| Reflection {
        entry_id: excerpt.id.clone(),
        entry_kind: AnnotationEntryKind::Excerpt,
        body,
        created_at: now,
        updated_at: now,
        deleted_at: None,
    });
    upsert_excerpt_row(
        &transaction,
        root,
        &excerpt,
        reflection.as_ref().map(|item| item.body.as_str()),
    )?;
    if let Some(reflection) = &reflection {
        upsert_reflection_row(&transaction, root, reflection)?;
    }
    refresh_v6_migration_ledger(&transaction, root, now)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit excerpt creation: {error}"))?;
    Ok(ExcerptCaptureResult {
        excerpt,
        reflection,
    })
}

fn validate_restore_timestamp_order(created_at: u64, updated_at: u64) -> CommandResult<()> {
    if created_at > updated_at {
        return Err("Annotation timestamps are out of order".to_owned());
    }
    Ok(())
}

fn validate_restore_source_revision(revision: Option<&SourceRevision>) -> CommandResult<()> {
    if let Some(revision) = revision {
        require_bounded_text(
            &revision.content_hash,
            "annotation source revision hash",
            256,
            false,
        )?;
    }
    Ok(())
}

fn document_annotation_bundle_row_count(snapshot: &DocumentAnnotationBundle) -> usize {
    snapshot
        .excerpts
        .len()
        .saturating_add(snapshot.places.len())
        .saturating_add(snapshot.reflections.len())
        .saturating_add(snapshot.review_enrollments.len())
}

fn validate_document_annotation_bundle(
    relative_path: &str,
    snapshot: DocumentAnnotationBundle,
) -> CommandResult<DocumentAnnotationBundle> {
    let total_rows = document_annotation_bundle_row_count(&snapshot);
    if total_rows > MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS {
        return Err(format!(
            "Document annotation bundle exceeds the {MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS}-row limit"
        ));
    }

    let mut parent_kinds = HashMap::new();
    for excerpt in &snapshot.excerpts {
        if excerpt.deleted_at.is_some() {
            return Err("Restore payload cannot contain annotation tombstones".to_owned());
        }
        if excerpt.relative_path != relative_path {
            return Err("Restore payload contains an annotation from another document".to_owned());
        }
        let sanitized = sanitize_excerpt_draft(ExcerptDraft {
            id: excerpt.id.clone(),
            relative_path: excerpt.relative_path.clone(),
            source_text: excerpt.source_text.clone(),
            anchor: excerpt.anchor.clone(),
            appearance: excerpt.appearance.clone(),
            sort_index: excerpt.sort_index.clone(),
        })?;
        if sanitized.relative_path != relative_path {
            return Err("Restore payload contains a non-canonical document path".to_owned());
        }
        validate_restore_timestamp_order(excerpt.created_at, excerpt.updated_at)?;
        validate_restore_source_revision(excerpt.source_revision.as_ref())?;
        if let Some(title) = &excerpt.legacy_title {
            require_bounded_text(
                title,
                "legacy excerpt title",
                MAX_ANNOTATION_TITLE_CHARS,
                true,
            )?;
        }
        if let Some(text) = &excerpt.legacy_selected_text {
            require_bounded_text(text, "legacy excerpt text", MAX_ANNOTATION_TEXT_CHARS, true)?;
        }
        if parent_kinds
            .insert(excerpt.id.clone(), AnnotationEntryKind::Excerpt)
            .is_some()
        {
            return Err("Restore payload contains duplicate annotation ids".to_owned());
        }
    }
    for place in &snapshot.places {
        if place.deleted_at.is_some() {
            return Err("Restore payload cannot contain annotation tombstones".to_owned());
        }
        if place.relative_path != relative_path {
            return Err("Restore payload contains an annotation from another document".to_owned());
        }
        let sanitized = sanitize_reading_place_draft(ReadingPlaceDraft {
            id: place.id.clone(),
            relative_path: place.relative_path.clone(),
            title: place.title.clone(),
            target: place.target.clone(),
            sort_index: place.sort_index.clone(),
        })?;
        if sanitized.relative_path != relative_path {
            return Err("Restore payload contains a non-canonical document path".to_owned());
        }
        validate_restore_timestamp_order(place.created_at, place.updated_at)?;
        validate_restore_source_revision(place.source_revision.as_ref())?;
        if let Some(text) = &place.legacy_selected_text {
            require_bounded_text(
                text,
                "legacy reading-place text",
                MAX_ANNOTATION_TEXT_CHARS,
                true,
            )?;
        }
        if parent_kinds
            .insert(place.id.clone(), AnnotationEntryKind::Place)
            .is_some()
        {
            return Err("Restore payload contains duplicate annotation ids".to_owned());
        }
    }

    let mut reflection_ids = HashSet::new();
    for reflection in &snapshot.reflections {
        if reflection.deleted_at.is_some() {
            return Err("Restore payload cannot contain reflection tombstones".to_owned());
        }
        validate_annotation_id(&reflection.entry_id)?;
        let parent_kind = parent_kinds
            .get(&reflection.entry_id)
            .ok_or_else(|| "Restore payload contains an orphan reflection".to_owned())?;
        if parent_kind != &reflection.entry_kind {
            return Err("Restore payload contains a mismatched reflection".to_owned());
        }
        let normalized = sanitize_required_text(
            reflection.body.clone(),
            MAX_ANNOTATION_NOTE_CHARS,
            "reflection",
        )?;
        if normalized != reflection.body {
            return Err("Restore payload contains a non-canonical reflection".to_owned());
        }
        validate_restore_timestamp_order(reflection.created_at, reflection.updated_at)?;
        if !reflection_ids.insert(reflection.entry_id.clone()) {
            return Err("Restore payload contains duplicate reflections".to_owned());
        }
    }

    let mut enrollment_ids = HashSet::new();
    for enrollment in &snapshot.review_enrollments {
        if enrollment.deleted_at.is_some() {
            return Err("Restore payload cannot contain enrollment tombstones".to_owned());
        }
        validate_annotation_id(&enrollment.excerpt_id)?;
        if parent_kinds.get(&enrollment.excerpt_id) != Some(&AnnotationEntryKind::Excerpt) {
            return Err("Restore payload contains an orphan review enrollment".to_owned());
        }
        if !(0..=REVIEW_MAX_BOX).contains(&enrollment.box_level) {
            return Err(format!("Review box must be between 0 and {REVIEW_MAX_BOX}"));
        }
        if !enrollment_ids.insert(enrollment.excerpt_id.clone()) {
            return Err("Restore payload contains duplicate review enrollments".to_owned());
        }
    }
    Ok(snapshot)
}

fn restore_id_exists(connection: &Connection, id: &str) -> CommandResult<bool> {
    connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM excerpts WHERE id = ?1
                 UNION ALL SELECT 1 FROM reading_places WHERE id = ?1
                 UNION ALL SELECT 1 FROM reflections WHERE entry_id = ?1
                 UNION ALL SELECT 1 FROM review_enrollments WHERE excerpt_id = ?1
             )",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot check annotation restore conflicts: {error}"))
}

fn restore_document_annotation_rows(
    connection: &mut Connection,
    root: &str,
    relative_path: &str,
    snapshot: DocumentAnnotationBundle,
) -> CommandResult<DocumentAnnotationBundle> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin annotation restore: {error}"))?;
    ensure_v6_root_writable(&transaction, root)?;
    let current = list_document_annotation_rows(&transaction, root, relative_path)?;
    if !current.excerpts.is_empty() || !current.places.is_empty() {
        return Err("Document annotations changed after they were cleared".to_owned());
    }
    for id in snapshot
        .excerpts
        .iter()
        .map(|item| item.id.as_str())
        .chain(snapshot.places.iter().map(|item| item.id.as_str()))
    {
        if restore_id_exists(&transaction, id)? {
            return Err("Annotation restore conflicts with an existing id".to_owned());
        }
    }

    let reflections: HashMap<&str, &Reflection> = snapshot
        .reflections
        .iter()
        .map(|item| (item.entry_id.as_str(), item))
        .collect();
    for excerpt in &snapshot.excerpts {
        upsert_excerpt_row(
            &transaction,
            root,
            excerpt,
            reflections
                .get(excerpt.id.as_str())
                .map(|item| item.body.as_str()),
        )?;
    }
    for place in &snapshot.places {
        upsert_reading_place_row(&transaction, root, place)?;
    }
    for reflection in &snapshot.reflections {
        upsert_reflection_row(&transaction, root, reflection)?;
    }
    for enrollment in &snapshot.review_enrollments {
        upsert_review_enrollment_row(&transaction, root, enrollment)?;
    }
    let refreshed_at = snapshot
        .excerpts
        .iter()
        .map(|item| item.updated_at)
        .chain(snapshot.places.iter().map(|item| item.updated_at))
        .chain(snapshot.reflections.iter().map(|item| item.updated_at))
        .chain(
            snapshot
                .review_enrollments
                .iter()
                .map(|item| item.updated_at),
        )
        .max()
        .unwrap_or_else(now_millis);
    refresh_v6_migration_ledger(&transaction, root, refreshed_at)?;
    let restored = list_document_annotation_rows(&transaction, root, relative_path)?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit annotation restore: {error}"))?;
    Ok(restored)
}

fn clear_annotation_rows(
    connection: &mut Connection,
    root: &str,
    relative_path: &str,
) -> CommandResult<DocumentAnnotationBundle> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot begin document annotation clear: {error}"))?;
    let snapshot = list_document_annotation_rows(&transaction, root, relative_path)?;
    if document_annotation_bundle_row_count(&snapshot) > MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS {
        return Err(format!(
            "Document annotation bundle exceeds the {MAX_DOCUMENT_ANNOTATION_BUNDLE_ROWS}-row limit"
        ));
    }
    transaction
        .execute(
            "DELETE FROM annotations WHERE library_root = ?1 AND relative_path = ?2",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot clear document annotations: {error}"))?;
    transaction
        .execute(
            "DELETE FROM review_enrollments WHERE library_root = ?1 AND excerpt_id IN (
                 SELECT id FROM excerpts WHERE library_root = ?1 AND relative_path = ?2
             )",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot clear document enrollments: {error}"))?;
    transaction
        .execute(
            "DELETE FROM reflections WHERE library_root = ?1 AND entry_id IN (
                 SELECT id FROM excerpts WHERE library_root = ?1 AND relative_path = ?2
                 UNION
                 SELECT id FROM reading_places WHERE library_root = ?1 AND relative_path = ?2
             )",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot clear document reflections: {error}"))?;
    transaction
        .execute(
            "DELETE FROM excerpts WHERE library_root = ?1 AND relative_path = ?2",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot clear document excerpts: {error}"))?;
    transaction
        .execute(
            "DELETE FROM reading_places WHERE library_root = ?1 AND relative_path = ?2",
            params![root, relative_path],
        )
        .map_err(|error| format!("Cannot clear document reading places: {error}"))?;
    refresh_v6_migration_ledger(&transaction, root, now_millis())?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit document annotation clear: {error}"))?;
    Ok(snapshot)
}

fn annotation_kind_to_db(kind: &AnnotationKind) -> &'static str {
    match kind {
        AnnotationKind::Highlight => "highlight",
        AnnotationKind::Underline => "underline",
        AnnotationKind::Bookmark => "bookmark",
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
            let state = UserState::new(
                directory.path().to_path_buf(),
                directory.path().to_path_buf(),
            )
            .expect("create");
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            assert_eq!(
                count_rows(
                    &connection,
                    "SELECT count(*) FROM sqlite_master
                     WHERE name IN ('annotations', 'annotations_fts', 'documents',
                                    'annotation_reviews', 'collections', 'collection_items',
                                    'excerpts', 'excerpts_fts', 'reading_places',
                                    'reflections', 'review_enrollments',
                                    'annotation_v6_migration')",
                ),
                12
            );
            let annotation = sanitized_sample("ann-1", "notes/a.md");
            upsert_annotation_row(&connection, ROOT, &annotation).expect("insert");
        }
        // A fresh-install migration must not create a stray cache file.
        assert!(!directory.path().join(LEGACY_CACHE_DB_FILE).exists());
        for _ in 0..2 {
            let state = UserState::new(
                directory.path().to_path_buf(),
                directory.path().to_path_buf(),
            )
            .expect("reopen");
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM excerpts")
                    + count_rows(&connection, "SELECT count(*) FROM reading_places"),
                1
            );
        }
    }

    #[test]
    fn rescues_legacy_annotations_with_verified_counts_and_backfill() {
        let directory = tempdir().expect("temp dir");
        let cache_path = build_legacy_cache(directory.path());

        let state = UserState::new(
            directory.path().to_path_buf(),
            directory.path().to_path_buf(),
        )
        .expect("migrate");
        {
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            // v1 rescues into annotations, v6 mirrors, v7 wipes to empty v6-only.
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotations"),
                0,
                "v7 wipe clears rescued legacy rows"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM excerpts"),
                0,
                "v7 wipe clears v6 excerpts"
            );
            assert!(list_annotation_rows(&connection, ROOT, None)
                .expect("list")
                .is_empty());
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

        let state = UserState::new(
            directory.path().to_path_buf(),
            directory.path().to_path_buf(),
        )
        .expect("reopen");
        let connection = locked(&state);
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            0
        );
    }

    #[test]
    fn refuses_databases_from_newer_reade_without_wiping() {
        let directory = tempdir().expect("temp dir");
        {
            let state = UserState::new(
                directory.path().to_path_buf(),
                directory.path().to_path_buf(),
            )
            .expect("create");
            let connection = locked(&state);
            upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-1", "notes/a.md"))
                .expect("insert");
            connection
                .pragma_update(None, "user_version", 99)
                .expect("simulate newer schema");
        }
        let error = match UserState::new(
            directory.path().to_path_buf(),
            directory.path().to_path_buf(),
        ) {
            Ok(_) => panic!("newer schema must be refused"),
            Err(error) => error,
        };
        assert!(error.contains("newer"), "unexpected error: {error}");
        let connection = Connection::open(directory.path().join(USER_DB_FILE)).expect("reopen raw");
        assert_eq!(count_rows(&connection, "SELECT count(*) FROM excerpts"), 1);
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

        let state = UserState::new(
            directory.path().to_path_buf(),
            directory.path().to_path_buf(),
        )
        .expect("upgrade");
        let connection = locked(&state);
        assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            0,
            "v7 wipe clears upgraded rows"
        );

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
                "SELECT deleted_at, updated_at FROM excerpts WHERE id = 'ann-1'",
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
        let mut connection = locked(&state);
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-a1", "a.md"))
            .expect("insert a1");
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-a2", "a.md"))
            .expect("insert a2");
        upsert_annotation_row(&connection, ROOT, &sanitized_sample("ann-b", "b.md"))
            .expect("insert b");
        tombstone_annotation(&connection, ROOT, "ann-a1", 5_000).expect("tombstone a1");

        clear_annotation_rows(&mut connection, ROOT, "a.md").expect("clear a.md");
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM excerpts WHERE relative_path = 'a.md'",
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
            let state = UserState::new(
                directory.path().to_path_buf(),
                directory.path().to_path_buf(),
            )
            .expect("create");
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
        let state = UserState::new(
            directory.path().to_path_buf(),
            directory.path().to_path_buf(),
        )
        .expect("reopen");
        let connection = locked(&state);
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM excerpts WHERE id = 'ann-old'",
            ),
            0
        );
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM excerpts WHERE id = 'ann-fresh'",
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
        let mut connection = locked(&state);
        let mut annotation = sample_annotation("ann-1", "notes/a.md");
        annotation.selected_text = Some("ｔｒｉｇｒａｍ searchable body".to_owned());
        annotation.note = Some("first note".to_owned());
        let annotation = sanitize_annotation(annotation).expect("sanitize");
        upsert_annotation_row(&connection, ROOT, &annotation).expect("insert");

        let fts_hits = |query: &str| -> i64 {
            connection
                .query_row(
                    "SELECT count(*) FROM excerpts_fts WHERE excerpts_fts MATCH ?1",
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

        clear_annotation_rows(&mut connection, ROOT, "notes/a.md").expect("clear");
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM excerpts_fts WHERE excerpts_fts MATCH 'trigram'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query cleared fts"),
            0
        );
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
                "SELECT count(*) FROM excerpts WHERE relative_path = 'old.md'",
            ),
            0
        );
        let (deleted_at,): (Option<i64>,) = connection
            .query_row(
                "SELECT deleted_at FROM excerpts
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
                "SELECT count(*) FROM excerpts_fts WHERE excerpts_fts MATCH 'hello'",
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
            let state = UserState::new(
                directory.path().to_path_buf(),
                directory.path().to_path_buf(),
            )
            .expect("upgrade/reopen");
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
                0,
                "v7 wipe clears annotations after upgrade"
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
                "INSERT INTO review_enrollments(
                     excerpt_id, library_root, enrolled_at, box, due_at, last_reviewed_at,
                     total_reviews, suspended, updated_at, deleted_at
                 ) VALUES (?1, ?2, 1, ?3, ?4, ?5, 0, ?6, 1, NULL)
                 ON CONFLICT(excerpt_id) DO UPDATE SET
                     library_root = excluded.library_root,
                     box = excluded.box,
                     due_at = excluded.due_at,
                     last_reviewed_at = excluded.last_reviewed_at,
                     total_reviews = excluded.total_reviews,
                     suspended = excluded.suspended,
                     updated_at = excluded.updated_at,
                     deleted_at = NULL",
                params![
                    annotation_id,
                    root,
                    box_level,
                    due_at as i64,
                    last_reviewed_at.map(|value| value as i64),
                    i64::from(suspended)
                ],
            )
            .expect("insert review enrollment fixture");
    }

    fn review_row(connection: &Connection, id: &str) -> (i64, i64, Option<i64>, i64, i64) {
        connection
            .query_row(
                "SELECT box, due_at, last_reviewed_at, total_reviews, suspended
                 FROM review_enrollments WHERE excerpt_id = ?1",
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
            .expect("read review enrollment")
    }

    #[allow(clippy::too_many_arguments)]
    fn record_review_outcome_for_test(
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
        validate_review_outcome_fields(box_level, due_at, last_reviewed_at, now)?;
        if read_excerpt_row(connection, root, annotation_id)?
            .filter(|entry| entry.deleted_at.is_none())
            .is_none()
        {
            return Err("Annotation was not found".to_owned());
        }
        if read_review_enrollment_row(connection, root, annotation_id)?
            .filter(|entry| entry.deleted_at.is_none())
            .is_none()
        {
            return Err("Excerpt is not enrolled in spaced review".to_owned());
        }
        sync_review_outcome_to_enrollment(
            connection,
            root,
            annotation_id,
            box_level,
            due_at,
            last_reviewed_at,
            suspended,
            now,
        )
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
        // The chain continues through v6, which materializes a suspended
        // compatibility review row but does not create an enrollment.
        for _ in 0..2 {
            let state = UserState::new(
                directory.path().to_path_buf(),
                directory.path().to_path_buf(),
            )
            .expect("upgrade/reopen");
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
                0,
                "v7 wipe clears annotations after upgrade"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotation_reviews"),
                0,
                "v7 wipe clears legacy reviews"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM review_enrollments"),
                0,
                "a missing v5 review row is not explicit enrollment"
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
        connection
            .execute(
                "INSERT INTO annotation_reviews(
                     annotation_id, library_root, box, due_at, last_reviewed_at,
                     total_reviews, suspended, updated_at
                 ) VALUES ('ann-v4', ?1, 2, 1000, 500, 1, 0, 1)",
                params![ROOT],
            )
            .expect("insert v4 review");
        connection
            .pragma_update(None, "user_version", 4)
            .expect("mark v4");
        db_path
    }

    #[test]
    fn migrates_v4_databases_through_v6_with_backup_and_idempotent_reopen() {
        let directory = tempdir().expect("temp dir");
        build_v4_database(directory.path());

        // Upgrading and reopening are both idempotent: the collection
        // tables exist exactly once and every earlier table keeps its data.
        for _ in 0..2 {
            let state = UserState::new(
                directory.path().to_path_buf(),
                directory.path().to_path_buf(),
            )
            .expect("upgrade/reopen");
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
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
                0,
                "v7 wipe"
            );
            assert_eq!(count_rows(&connection, "SELECT count(*) FROM documents"), 1);
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotation_reviews"),
                0,
                "v7 wipe"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM review_enrollments"),
                0,
                "v7 wipe"
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

    /// Mirrors `src/lib/annotationMigrationFixture.ts` MIG-A at the storage
    /// boundary: four colors collapse to three tones while every legacy
    /// compatibility field remains queryable.
    #[test]
    fn migrates_v5_annotations_to_v6_with_backup_ledger_and_review_opt_in() {
        let directory = tempdir().expect("temp dir");
        let db_path = build_v4_database(directory.path());
        {
            let connection = Connection::open(&db_path).expect("open v4");
            migrate_to_v5(&connection).expect("v5 schema");

            let mut pink = sample_annotation("mig-md-pink", "notes/pink.md");
            pink.kind = AnnotationKind::Underline;
            pink.color = Some(AnnotationColor::Pink);
            pink.note = Some("pink reflection".to_owned());
            pink.selected_text = Some("old pink".to_owned());
            pink.title = Some("preserved title".to_owned());
            let pink = sanitize_annotation(pink).expect("pink annotation");
            upsert_annotation_row_legacy(&connection, ROOT, &pink).expect("insert pink");

            let bookmark = sanitize_annotation(Annotation {
                id: "mig-bookmark-weird".to_owned(),
                relative_path: "notes/pink.md".to_owned(),
                kind: AnnotationKind::Bookmark,
                color: Some(AnnotationColor::Pink),
                note: Some("place reflection".to_owned()),
                selected_text: Some("legacy bookmark selection".to_owned()),
                title: Some("bookmark".to_owned()),
                locator: AnnotationLocator::Bookmark {
                    target: BookmarkTarget::Markdown {
                        heading_id: Some("legacy".to_owned()),
                        scroll_ratio: 0.4,
                    },
                },
                sort_index: String::new(),
                created_at: 200,
                updated_at: 250,
                deleted_at: None,
            })
            .expect("legacy-shaped bookmark");
            upsert_annotation_row_legacy(&connection, ROOT, &bookmark).expect("insert bookmark");

            let mut deleted_pdf = sample_annotation("mig-pdf-deleted", "paper.pdf");
            deleted_pdf.locator = AnnotationLocator::Pdf {
                page: 3,
                view: "original".to_owned(),
                quote: "pdf quote".to_owned(),
                prefix: String::new(),
                suffix: String::new(),
                rects: vec![AnnotationRect {
                    x: 0.1,
                    y: 0.2,
                    w: 0.4,
                    h: 0.03,
                }],
                page_width: Some(595.0),
                page_height: Some(842.0),
            };
            deleted_pdf.selected_text = Some("pdf quote".to_owned());
            deleted_pdf.note = Some("deleted reflection".to_owned());
            let deleted_at = now_millis();
            deleted_pdf.updated_at = deleted_at;
            deleted_pdf.deleted_at = Some(deleted_at);
            let deleted_pdf = sanitize_annotation(deleted_pdf).expect("deleted pdf");
            upsert_annotation_row_legacy(&connection, ROOT, &deleted_pdf)
                .expect("insert deleted pdf");

            insert_document_row(&connection, ROOT, "notes/pink.md", "ntxt:aaaa");
            insert_document_row(&connection, ROOT, "paper.pdf", "pmd5:bbbb");
            connection
                .pragma_update(None, "user_version", 5)
                .expect("mark v5");
        }

        for _ in 0..2 {
            let state = UserState::new(
                directory.path().to_path_buf(),
                directory.path().to_path_buf(),
            )
            .expect("upgrade/reopen");
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotations"),
                0,
                "v7 wipe"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM excerpts"),
                0,
                "v7 wipe"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM reading_places"),
                0,
                "v7 wipe"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM reflections"),
                0,
                "v7 wipe"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM review_enrollments"),
                0,
                "v7 wipe"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotation_reviews"),
                0,
                "v7 wipe"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotation_v6_migration"),
                1
            );
        }

        let backup_path = directory.path().join("reade-user.backup-v5.sqlite3");
        assert!(backup_path.exists(), "v5 backup must be created");
        let backup = Connection::open(backup_path).expect("open v5 backup");
        assert_eq!(user_version(&backup), 5);
        assert_eq!(
            count_rows(
                &backup,
                "SELECT count(*) FROM sqlite_master WHERE name = 'excerpts'"
            ),
            0
        );
        assert_eq!(count_rows(&backup, "SELECT count(*) FROM annotations"), 4);
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
        assert_eq!(count_rows(&connection, "SELECT count(*) FROM excerpts"), 1);
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
    fn review_queue_keeps_unenrolled_marks_out_of_the_pool() {
        // Mirrors the queue contract fixture Q1..Q6 in
        // src/lib/webAnnotations.test.ts ("review queue" section).
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let created = 1_700_000_000_000u64;

        // Q1: no review row → not enrolled.
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
        assert_eq!(ids(&queue), vec!["ann-early"]);
        let early = &queue[0].review;
        assert_eq!(early.box_level, 1);
        assert_eq!(early.due_at, created + 1_000);
        assert_eq!(early.last_reviewed_at, Some(created));
        assert!(!early.suspended);

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
            insert_review_row(
                &connection,
                ROOT,
                &format!("ann-{index}"),
                0,
                created,
                None,
                false,
            );
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
            record_review_outcome_for_test(&connection, root, id, box_level, due, last, false, now)
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
            count_rows(&connection, "SELECT count(*) FROM review_enrollments"),
            0,
            "rejected outcomes must not write rows"
        );

        insert_review_row(&connection, ROOT, "ann-live", 0, now + DAY_MS, None, false);

        // remembered → box 1; the server counts the review itself.
        record_review_outcome_for_test(
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
        record_review_outcome_for_test(
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
        record_review_outcome_for_test(
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
        record_review_outcome_for_test(
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
        record_review_outcome_for_test(
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
                due_count: 1,
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
            let state = UserState::new(
                directory.path().to_path_buf(),
                directory.path().to_path_buf(),
            )
            .expect("create");
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

        let state = UserState::new(
            directory.path().to_path_buf(),
            directory.path().to_path_buf(),
        )
        .expect("reopen");
        let connection = locked(&state);
        // The expired tombstone and its review state are gone; the fresh
        // tombstone keeps its row so undoing the deletion restores progress;
        // rows without any annotation are dropped.
        let remaining: Vec<String> = {
            let mut statement = connection
                .prepare(
                    "SELECT excerpt_id FROM review_enrollments
                     WHERE deleted_at IS NULL ORDER BY excerpt_id",
                )
                .expect("prepare remaining");
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query remaining");
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .expect("decode remaining")
        };
        assert_eq!(remaining, vec!["ann-fresh", "ann-live"]);
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM excerpts WHERE id = 'ann-old'",
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
    fn search_annotation_entries_flags_reflections_and_enrollments() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        insert_mark(
            &connection,
            ROOT,
            "ann-note",
            "notes/a.md",
            "共享词组样本",
            Some("有感悟"),
        );
        insert_mark(
            &connection,
            ROOT,
            "ann-plain",
            "notes/b.md",
            "共享词组样本",
            None,
        );
        insert_review_row(
            &connection,
            ROOT,
            "ann-plain",
            0,
            1_700_000_000_000,
            None,
            false,
        );
        let hits = annotation_search_hits(
            &connection,
            ROOT,
            search_annotation_rows(&connection, ROOT, "共享词组", 50).expect("search"),
        )
        .expect("hits");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].annotation.id, "ann-note");
        assert!(hits[0].has_reflection);
        assert!(!hits[0].enrolled);
        assert_eq!(hits[1].annotation.id, "ann-plain");
        assert!(!hits[1].has_reflection);
        assert!(hits[1].enrolled);
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
            AnnotationImportExtras::default(),
            &present,
            7_000,
        )
        .expect("import");
        assert_eq!(written, 3);
        assert_eq!(
            transfer_annotation_rows(&connection, ROOT)
                .expect("transfer")
                .len(),
            3
        );
        let dead: Option<i64> = connection
            .query_row(
                "SELECT deleted_at FROM excerpts WHERE id = 'imp-dead'",
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
            AnnotationImportExtras::default(),
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
                AnnotationImportExtras::default(),
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
            AnnotationImportExtras::default(),
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
        let error = import_annotation_rows(
            &mut connection,
            ROOT,
            oversized,
            &[],
            AnnotationImportExtras::default(),
            &present,
            7_000,
        )
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
            AnnotationImportExtras::default(),
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
            AnnotationImportExtras::default(),
            &HashSet::new(),
            9_500,
        )
        .expect("import update");
        let listed = list_annotation_rows(&connection, ROOT, None).expect("list after update");
        let updated = listed
            .iter()
            .find(|item| item.id == "imp-lww")
            .expect("row");
        assert_eq!(updated.note.as_deref(), Some("imported newer note"));
        assert_eq!(updated.updated_at, 9_000);
        assert_eq!(listed.len(), 1);
    }

    fn markdown_locator() -> AnnotationLocator {
        AnnotationLocator::Markdown {
            quote: "hello world".to_owned(),
            prefix: "say ".to_owned(),
            suffix: " today".to_owned(),
            heading_id: Some("intro".to_owned()),
            start: Some(1024),
            end: Some(1035),
        }
    }

    fn sample_excerpt_draft(id: &str, relative_path: &str) -> ExcerptDraft {
        ExcerptDraft {
            id: id.to_owned(),
            relative_path: relative_path.to_owned(),
            source_text: "hello world".to_owned(),
            anchor: SourceAnchor::Markdown {
                quote: TextQuoteSelector {
                    exact: "hello world".to_owned(),
                    prefix: "say ".to_owned(),
                    suffix: " today".to_owned(),
                },
                heading_id: Some("intro".to_owned()),
                start: Some(1024),
                end: Some(1035),
            },
            appearance: ExcerptAppearance {
                style: ExcerptStyle::Highlight,
                tone: ExcerptTone::Sand,
            },
            sort_index: derive_sort_index(&markdown_locator()),
        }
    }

    fn persist_excerpt(connection: &Connection, draft: ExcerptDraft, now: u64) -> Excerpt {
        let draft = sanitize_excerpt_draft(draft).expect("sanitize excerpt draft");
        let source_text = draft.source_text.clone();
        let appearance = draft.appearance.clone();
        let relative_path = draft.relative_path;
        let source_revision = source_revision_for_path(connection, ROOT, &relative_path, now)
            .expect("source revision");
        let excerpt = Excerpt {
            id: draft.id,
            relative_path,
            source_text: source_text.clone(),
            anchor: draft.anchor,
            source_revision,
            appearance: appearance.clone(),
            sort_index: draft.sort_index,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            legacy_kind: Some(appearance.style),
            legacy_color: Some(tone_to_legacy_color(&appearance.tone)),
            legacy_title: None,
            legacy_selected_text: Some(source_text),
        };
        upsert_excerpt_row(connection, ROOT, &excerpt, None).expect("upsert excerpt");
        refresh_v6_migration_ledger(connection, ROOT, now).expect("refresh ledger");
        excerpt
    }

    fn persist_reading_place(
        connection: &Connection,
        draft: ReadingPlaceDraft,
        now: u64,
    ) -> ReadingPlace {
        let draft = sanitize_reading_place_draft(draft).expect("sanitize place draft");
        let relative_path = draft.relative_path.clone();
        let place = ReadingPlace {
            id: draft.id,
            relative_path: relative_path.clone(),
            title: draft.title,
            target: draft.target,
            source_revision: source_revision_for_path(connection, ROOT, &relative_path, now)
                .expect("source revision"),
            sort_index: draft.sort_index,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            legacy_color: None,
            legacy_selected_text: None,
        };
        upsert_reading_place_row(connection, ROOT, &place).expect("upsert place");
        refresh_v6_migration_ledger(connection, ROOT, now).expect("refresh ledger");
        place
    }

    #[test]
    fn v6_sanitize_rejects_oversized_source_and_quote_without_truncating() {
        let mut draft = sample_excerpt_draft("draft-1", "notes/a.md");
        draft.source_text = "字".repeat(MAX_ANNOTATION_TEXT_CHARS + 1);
        assert!(sanitize_excerpt_draft(draft.clone())
            .unwrap_err()
            .contains("exceeds"));
        if let SourceAnchor::Markdown { quote, .. } = &mut draft.anchor {
            quote.exact = "字".repeat(MAX_ANNOTATION_TEXT_CHARS + 1);
        }
        draft.source_text = "ok".to_owned();
        assert!(sanitize_excerpt_draft(draft)
            .unwrap_err()
            .contains("exceeds"));
    }

    #[test]
    fn v6_sanitize_rejects_unsafe_ids_paths_tones_and_sort_keys() {
        let draft = sample_excerpt_draft("draft-1", "notes/a.md");
        let mut bad = draft.clone();
        bad.relative_path = "../escape.md".to_owned();
        assert!(sanitize_excerpt_draft(bad).is_err());
        let mut bad = draft.clone();
        bad.id = "bad id".to_owned();
        assert!(sanitize_excerpt_draft(bad).is_err());
        let mut bad = draft.clone();
        bad.sort_index = "M|0|0".to_owned();
        assert!(sanitize_excerpt_draft(bad).unwrap_err().contains("sort"));
        assert!(
            sanitize_required_text(" ".to_owned(), MAX_ANNOTATION_NOTE_CHARS, "reflection")
                .is_err()
        );
        assert!(sanitize_required_text(
            "想".repeat(MAX_ANNOTATION_NOTE_CHARS + 1),
            MAX_ANNOTATION_NOTE_CHARS,
            "reflection"
        )
        .is_err());
        assert_eq!(
            sanitize_required_text(
                "  我的感悟  ".to_owned(),
                MAX_ANNOTATION_NOTE_CHARS,
                "reflection"
            )
            .expect("trim"),
            "我的感悟"
        );
    }

    #[test]
    fn v6_sanitize_validates_pdf_geometry_and_epub_offsets() {
        let mut draft = sample_excerpt_draft("draft-pdf", "paper.pdf");
        draft.anchor = SourceAnchor::PdfText {
            page: 3,
            view: "original".to_owned(),
            quote: TextQuoteSelector {
                exact: "text".to_owned(),
                prefix: String::new(),
                suffix: String::new(),
            },
            rects: vec![AnnotationRect {
                x: 0.1,
                y: 0.2,
                w: 0.4,
                h: 0.03,
            }],
            page_width: Some(595.0),
            page_height: Some(842.0),
        };
        draft.sort_index = derive_sort_index(&AnnotationLocator::Pdf {
            page: 3,
            view: "original".to_owned(),
            quote: "text".to_owned(),
            prefix: String::new(),
            suffix: String::new(),
            rects: vec![AnnotationRect {
                x: 0.1,
                y: 0.2,
                w: 0.4,
                h: 0.03,
            }],
            page_width: Some(595.0),
            page_height: Some(842.0),
        });
        sanitize_excerpt_draft(draft.clone()).expect("valid pdf");
        if let SourceAnchor::PdfText { rects, .. } = &mut draft.anchor {
            rects[0].w = 0.0;
        }
        assert!(sanitize_excerpt_draft(draft)
            .unwrap_err()
            .contains("rectangle"));

        let mut epub = sample_excerpt_draft("draft-epub", "book.epub");
        epub.anchor = SourceAnchor::Epub {
            chapter_id: "c1".to_owned(),
            block_index: 1,
            start_offset: 8,
            end_offset: 2,
            quote: TextQuoteSelector {
                exact: "text".to_owned(),
                prefix: String::new(),
                suffix: String::new(),
            },
            start: None,
            end: None,
        };
        assert!(sanitize_excerpt_draft(epub)
            .unwrap_err()
            .contains("inverted"));
    }

    #[test]
    fn v6_sanitize_validates_reading_place_paths_ratios_and_pages() {
        let draft = ReadingPlaceDraft {
            id: "place-1".to_owned(),
            relative_path: "notes/a.md".to_owned(),
            title: Some("位置".to_owned()),
            target: BookmarkTarget::Markdown {
                heading_id: Some("a".to_owned()),
                scroll_ratio: 0.5,
            },
            sort_index: "M|00000|50000000".to_owned(),
        };
        sanitize_reading_place_draft(draft.clone()).expect("valid place");
        let mut bad = draft.clone();
        if let BookmarkTarget::Markdown { scroll_ratio, .. } = &mut bad.target {
            *scroll_ratio = 1.1;
        }
        assert!(sanitize_reading_place_draft(bad)
            .unwrap_err()
            .contains("position"));
        let mut bad = draft;
        bad.target = BookmarkTarget::Pdf {
            page: 0,
            offset_ratio: 0.2,
        };
        assert!(sanitize_reading_place_draft(bad)
            .unwrap_err()
            .contains("page"));
    }

    #[test]
    fn v6_excerpt_dual_writes_legacy_row_and_refreshes_ledger() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        insert_document_row(&connection, ROOT, "notes/a.md", "ntxt:aaaa");
        let excerpt = persist_excerpt(
            &connection,
            sample_excerpt_draft("ex-1", "notes/a.md"),
            1_000,
        );
        let bundle = list_document_annotation_rows(&connection, ROOT, "notes/a.md").expect("list");
        assert_eq!(bundle.excerpts.len(), 1);
        assert_eq!(bundle.excerpts[0].id, "ex-1");
        assert_eq!(bundle.excerpts[0].appearance.tone, ExcerptTone::Sand);
        assert_eq!(
            bundle.excerpts[0]
                .source_revision
                .as_ref()
                .map(|item| item.basis.clone()),
            Some(SourceRevisionBasis::Capture)
        );
        let listed =
            list_annotation_rows(&connection, ROOT, Some("notes/a.md")).expect("legacy list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, AnnotationKind::Highlight);
        assert_eq!(listed[0].color, Some(AnnotationColor::Yellow));
        assert_eq!(listed[0].selected_text.as_deref(), Some("hello world"));
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            0,
            "create_excerpt must not dual-write legacy annotations"
        );
        assert!(read_review_enrollment_row(&connection, ROOT, &excerpt.id)
            .expect("enrollment")
            .is_none());
        let (source, target): (String, String) = connection
            .query_row(
                "SELECT source_checksum, target_checksum FROM annotation_v6_migration
                 WHERE library_root = ?1",
                params![ROOT],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("ledger");
        assert_eq!(source, target);
    }

    #[test]
    fn excerpt_capture_writes_reflection_atomically_and_keeps_legacy_shell_empty() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        insert_document_row(&connection, ROOT, "notes/atomic.md", "ntxt:aaaa");

        let result = create_excerpt_rows(
            &mut connection,
            ROOT,
            sample_excerpt_draft("ex-atomic", "notes/atomic.md"),
            Some("  同一事务  ".to_owned()),
            1_000,
        )
        .expect("capture");
        assert_eq!(
            result.reflection.as_ref().map(|item| item.body.as_str()),
            Some("同一事务")
        );
        assert_eq!(
            result.reflection.as_ref().map(|item| item.created_at),
            Some(result.excerpt.created_at)
        );
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            0
        );

        connection
            .execute_batch(
                "CREATE TRIGGER fail_atomic_reflection BEFORE INSERT ON reflections BEGIN
                     SELECT RAISE(ABORT, 'blocked reflection');
                 END;",
            )
            .expect("failure trigger");
        let error = create_excerpt_rows(
            &mut connection,
            ROOT,
            sample_excerpt_draft("ex-rollback", "notes/atomic.md"),
            Some("must roll back".to_owned()),
            2_000,
        )
        .expect_err("reflection failure must abort capture");
        assert!(error.contains("reflection"), "unexpected error: {error}");
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM excerpts WHERE id = 'ex-rollback'"
            ),
            0
        );
        assert_eq!(
            count_rows(
                &connection,
                "SELECT count(*) FROM excerpts_fts WHERE searchable_text LIKE '%must roll back%'"
            ),
            0
        );
    }

    #[test]
    fn clear_restore_round_trips_all_v6_rows_and_review_state() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        insert_document_row(&connection, ROOT, "notes/roundtrip.md", "ntxt:aaaa");
        let capture = create_excerpt_rows(
            &mut connection,
            ROOT,
            sample_excerpt_draft("ex-roundtrip", "notes/roundtrip.md"),
            Some("excerpt reflection".to_owned()),
            1_000,
        )
        .expect("capture");
        let place = persist_reading_place(
            &connection,
            ReadingPlaceDraft {
                id: "place-roundtrip".to_owned(),
                relative_path: "notes/roundtrip.md".to_owned(),
                title: Some("resume here".to_owned()),
                target: BookmarkTarget::Markdown {
                    heading_id: Some("review".to_owned()),
                    scroll_ratio: 0.4,
                },
                sort_index: "M|00000|40000000".to_owned(),
            },
            1_100,
        );
        let place_reflection = Reflection {
            entry_id: place.id.clone(),
            entry_kind: AnnotationEntryKind::Place,
            body: "place reflection".to_owned(),
            created_at: 1_200,
            updated_at: 1_200,
            deleted_at: None,
        };
        upsert_reflection_row(&connection, ROOT, &place_reflection).expect("place reflection");
        let enrollment = ReviewEnrollment {
            excerpt_id: capture.excerpt.id.clone(),
            enrolled_at: 1_300,
            box_level: 4,
            due_at: 123,
            last_reviewed_at: Some(99),
            total_reviews: 7,
            suspended: true,
            updated_at: 456,
            deleted_at: None,
        };
        upsert_review_enrollment_row(&connection, ROOT, &enrollment).expect("enrollment");
        refresh_v6_migration_ledger(&connection, ROOT, 1_300).expect("ledger");

        let before =
            list_document_annotation_rows(&connection, ROOT, "notes/roundtrip.md").expect("before");
        let snapshot =
            clear_annotation_rows(&mut connection, ROOT, "notes/roundtrip.md").expect("clear");
        assert_eq!(snapshot, before);
        assert!(
            list_document_annotation_rows(&connection, ROOT, "notes/roundtrip.md")
                .expect("cleared")
                .excerpts
                .is_empty()
        );

        let mut invalid = snapshot.clone();
        invalid.reflections[0].entry_kind = AnnotationEntryKind::Place;
        let invalid = validate_document_annotation_bundle("notes/roundtrip.md", invalid)
            .expect_err("mismatched reflection");
        assert!(invalid.contains("mismatched"));
        assert!(
            list_document_annotation_rows(&connection, ROOT, "notes/roundtrip.md")
                .expect("still empty")
                .excerpts
                .is_empty()
        );

        let validated = validate_document_annotation_bundle("notes/roundtrip.md", snapshot)
            .expect("valid snapshot");
        let restored = restore_document_annotation_rows(
            &mut connection,
            ROOT,
            "notes/roundtrip.md",
            validated,
        )
        .expect("restore");
        assert_eq!(restored, before);
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            0
        );
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotation_reviews"),
            0
        );
    }

    #[test]
    fn clear_is_atomic_when_a_later_delete_fails() {
        let state = UserState::in_memory().expect("state");
        let mut connection = locked(&state);
        insert_document_row(&connection, ROOT, "notes/clear.md", "ntxt:aaaa");
        create_excerpt_rows(
            &mut connection,
            ROOT,
            sample_excerpt_draft("ex-clear", "notes/clear.md"),
            Some("keep after rollback".to_owned()),
            1_000,
        )
        .expect("capture");
        let before =
            list_document_annotation_rows(&connection, ROOT, "notes/clear.md").expect("before");
        connection
            .execute_batch(
                "CREATE TRIGGER fail_clear_reflection BEFORE DELETE ON reflections BEGIN
                     SELECT RAISE(ABORT, 'blocked clear');
                 END;",
            )
            .expect("failure trigger");

        let error = clear_annotation_rows(&mut connection, ROOT, "notes/clear.md")
            .expect_err("clear must fail");
        assert!(error.contains("reflections"), "unexpected error: {error}");
        assert_eq!(
            list_document_annotation_rows(&connection, ROOT, "notes/clear.md").expect("after"),
            before
        );
    }

    #[test]
    fn upsert_annotation_mirrors_v6_anchor_and_refreshes_source_revision() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        insert_document_row(&connection, ROOT, "notes/a.md", "ntxt:aaaa");
        let mut draft = sample_excerpt_draft("ex-1", "notes/a.md");
        draft.appearance.tone = ExcerptTone::Sage;
        persist_excerpt(&connection, draft, 1_000);
        connection
            .execute(
                "UPDATE documents SET content_hash = 'ntxt:bbbb'
                 WHERE library_root = ?1 AND relative_path = 'notes/a.md'",
                params![ROOT],
            )
            .expect("rotate fingerprint");

        let mut annotation = list_annotation_rows(&connection, ROOT, Some("notes/a.md"))
            .expect("list")
            .into_iter()
            .next()
            .expect("legacy row");
        annotation.locator = AnnotationLocator::Markdown {
            quote: "relocated quote".to_owned(),
            prefix: "fresh ".to_owned(),
            suffix: " context".to_owned(),
            heading_id: Some("later".to_owned()),
            start: Some(4_242),
            end: Some(4_258),
        };
        annotation.selected_text = Some("relocated quote".to_owned());
        annotation.sort_index = derive_sort_index(&annotation.locator);
        annotation.updated_at = 9_000;
        let annotation = sanitize_annotation(annotation).expect("sanitize relocated");
        upsert_annotation_row_legacy(&connection, ROOT, &annotation).expect("legacy relocate");
        mirror_legacy_annotation_into_v6(&connection, ROOT, &annotation).expect("mirror relocate");

        let stored = read_excerpt_row(&connection, ROOT, "ex-1")
            .expect("read")
            .expect("excerpt");
        assert_eq!(stored.appearance.tone, ExcerptTone::Sage);
        assert_eq!(stored.legacy_color, Some(AnnotationColor::Green));
        assert_eq!(stored.created_at, 1_000);
        assert_eq!(stored.updated_at, 9_000);
        match stored.anchor {
            SourceAnchor::Markdown {
                start,
                heading_id,
                quote,
                ..
            } => {
                assert_eq!(start, Some(4_242));
                assert_eq!(heading_id.as_deref(), Some("later"));
                assert_eq!(quote.exact, "relocated quote");
            }
            other => panic!("unexpected anchor {other:?}"),
        }
        let revision = stored.source_revision.expect("revision");
        assert_eq!(revision.content_hash, "ntxt:bbbb");
        assert_eq!(revision.observed_at, 9_000);
        assert_eq!(revision.basis, SourceRevisionBasis::Capture);
    }

    #[test]
    fn v6_appearance_update_remaps_color_but_keeps_pink_when_tone_stays_sand() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let mut excerpt = persist_excerpt(
            &connection,
            sample_excerpt_draft("ex-pink", "notes/a.md"),
            1_000,
        );
        excerpt.legacy_color = Some(AnnotationColor::Pink);
        excerpt.updated_at = 1_100;
        upsert_excerpt_row(&connection, ROOT, &excerpt, None).expect("keep pink");
        upsert_annotation_row_legacy(
            &connection,
            ROOT,
            &excerpt_to_legacy_annotation(&excerpt, None),
        )
        .expect("legacy pink");
        refresh_v6_migration_ledger(&connection, ROOT, 1_100).expect("ledger");

        excerpt.appearance.style = ExcerptStyle::Underline;
        excerpt.legacy_kind = Some(ExcerptStyle::Underline);
        excerpt.updated_at = 1_200;
        upsert_excerpt_row(&connection, ROOT, &excerpt, None).expect("style only");
        upsert_annotation_row_legacy(
            &connection,
            ROOT,
            &excerpt_to_legacy_annotation(&excerpt, None),
        )
        .expect("legacy underline");
        refresh_v6_migration_ledger(&connection, ROOT, 1_200).expect("ledger");
        let stored = read_excerpt_row(&connection, ROOT, "ex-pink")
            .expect("read")
            .expect("present");
        assert_eq!(stored.legacy_color, Some(AnnotationColor::Pink));
        assert_eq!(stored.appearance.style, ExcerptStyle::Underline);

        stored_tone_change(&connection, &mut excerpt);
        let remapped = read_excerpt_row(&connection, ROOT, "ex-pink")
            .expect("read")
            .expect("present");
        assert_eq!(remapped.appearance.tone, ExcerptTone::Sage);
        assert_eq!(remapped.legacy_color, Some(AnnotationColor::Green));
    }

    fn stored_tone_change(connection: &Connection, excerpt: &mut Excerpt) {
        excerpt.appearance.tone = ExcerptTone::Sage;
        excerpt.legacy_color = Some(tone_to_legacy_color(&excerpt.appearance.tone));
        excerpt.updated_at = 1_300;
        upsert_excerpt_row(connection, ROOT, excerpt, None).expect("tone change");
        upsert_annotation_row_legacy(
            connection,
            ROOT,
            &excerpt_to_legacy_annotation(excerpt, None),
        )
        .expect("legacy sage");
        refresh_v6_migration_ledger(connection, ROOT, 1_300).expect("ledger");
    }

    #[test]
    fn legacy_upsert_recolor_updates_v6_appearance() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let excerpt = persist_excerpt(
            &connection,
            sample_excerpt_draft("ex-recolor", "notes/a.md"),
            1_000,
        );
        upsert_annotation_row(
            &connection,
            ROOT,
            &excerpt_to_legacy_annotation(&excerpt, None),
        )
        .expect("legacy insert");
        refresh_v6_migration_ledger(&connection, ROOT, 1_000).expect("ledger");

        let mut recolored = excerpt_to_legacy_annotation(&excerpt, None);
        recolored.color = Some(AnnotationColor::Blue);
        recolored.updated_at = 1_100;
        upsert_annotation_row(&connection, ROOT, &recolored).expect("legacy recolor");
        refresh_v6_migration_ledger(&connection, ROOT, 1_100).expect("ledger");

        let stored = read_excerpt_row(&connection, ROOT, "ex-recolor")
            .expect("read")
            .expect("present");
        assert_eq!(stored.appearance.tone, ExcerptTone::Slate);
        assert_eq!(stored.legacy_color, Some(AnnotationColor::Blue));
    }

    #[test]
    fn v6_reading_place_reflection_delete_restore_and_enrollment_dual_write() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        persist_excerpt(
            &connection,
            sample_excerpt_draft("ex-2", "notes/a.md"),
            1_000,
        );
        persist_reading_place(
            &connection,
            ReadingPlaceDraft {
                id: "place-2".to_owned(),
                relative_path: "notes/a.md".to_owned(),
                title: Some("here".to_owned()),
                target: BookmarkTarget::Markdown {
                    heading_id: None,
                    scroll_ratio: 0.25,
                },
                sort_index: derive_sort_index(&AnnotationLocator::Bookmark {
                    target: BookmarkTarget::Markdown {
                        heading_id: None,
                        scroll_ratio: 0.25,
                    },
                }),
            },
            1_000,
        );
        let reflection = Reflection {
            entry_id: "ex-2".to_owned(),
            entry_kind: AnnotationEntryKind::Excerpt,
            body: "我的感悟".to_owned(),
            created_at: 1_500,
            updated_at: 1_500,
            deleted_at: None,
        };
        upsert_reflection_row(&connection, ROOT, &reflection).expect("reflection");
        sync_reflection_to_entry(&connection, ROOT, &reflection).expect("sync note");
        refresh_v6_migration_ledger(&connection, ROOT, 1_500).expect("ledger");
        let projected = list_annotation_rows(&connection, ROOT, Some("notes/a.md")).expect("list");
        let note = projected
            .iter()
            .find(|item| item.id == "ex-2")
            .and_then(|item| item.note.clone());
        assert_eq!(note.as_deref(), Some("我的感悟"));

        let mut deleted = reflection.clone();
        deleted.deleted_at = Some(1_600);
        deleted.updated_at = 1_600;
        upsert_reflection_row(&connection, ROOT, &deleted).expect("tombstone reflection");
        sync_reflection_to_entry(&connection, ROOT, &deleted).expect("clear note");
        refresh_v6_migration_ledger(&connection, ROOT, 1_600).expect("ledger");
        let projected =
            list_annotation_rows(&connection, ROOT, Some("notes/a.md")).expect("list after clear");
        let cleared = projected
            .iter()
            .find(|item| item.id == "ex-2")
            .and_then(|item| item.note.clone());
        assert_eq!(cleared, None);

        set_annotation_entry_deleted_row(
            &connection,
            ROOT,
            "ex-2",
            &AnnotationEntryKind::Excerpt,
            true,
            1_700,
        )
        .expect("delete excerpt");
        refresh_v6_migration_ledger(&connection, ROOT, 1_700).expect("ledger");
        let listed = list_annotation_rows(&connection, ROOT, Some("notes/a.md")).expect("live");
        assert!(listed.iter().all(|item| item.id != "ex-2"));
        set_annotation_entry_deleted_row(
            &connection,
            ROOT,
            "ex-2",
            &AnnotationEntryKind::Excerpt,
            false,
            1_800,
        )
        .expect("restore excerpt");
        refresh_v6_migration_ledger(&connection, ROOT, 1_800).expect("ledger");
        assert_eq!(
            list_document_annotation_rows(&connection, ROOT, "notes/a.md")
                .expect("bundle")
                .excerpts
                .len(),
            1
        );

        let enrollment = ReviewEnrollment {
            excerpt_id: "ex-2".to_owned(),
            enrolled_at: 1_900,
            box_level: 0,
            due_at: 1_900 + REVIEW_IMPLICIT_DUE_OFFSET_MS,
            last_reviewed_at: None,
            total_reviews: 0,
            suspended: false,
            updated_at: 1_900,
            deleted_at: None,
        };
        upsert_review_enrollment_row(&connection, ROOT, &enrollment).expect("enroll");
        sync_enrollment_to_legacy_review(&connection, ROOT, &enrollment).expect("legacy enroll");
        refresh_v6_migration_ledger(&connection, ROOT, 1_900).expect("ledger");
        let (suspended, total): (i64, i64) = connection
            .query_row(
                "SELECT suspended, total_reviews FROM review_enrollments WHERE excerpt_id = 'ex-2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("enrolled review");
        assert_eq!((suspended, total), (0, 0));
    }

    #[test]
    fn v6_ledger_refresh_rejects_divergent_dual_write() {
        let state = UserState::in_memory().expect("state");
        let connection = locked(&state);
        let draft = sanitize_excerpt_draft(sample_excerpt_draft("ex-div", "notes/a.md")).unwrap();
        let excerpt = Excerpt {
            id: draft.id,
            relative_path: draft.relative_path,
            source_text: draft.source_text.clone(),
            anchor: draft.anchor,
            source_revision: None,
            appearance: draft.appearance.clone(),
            sort_index: draft.sort_index,
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
            legacy_kind: Some(draft.appearance.style),
            legacy_color: Some(tone_to_legacy_color(&draft.appearance.tone)),
            legacy_title: None,
            legacy_selected_text: Some(draft.source_text),
        };
        upsert_excerpt_row(&connection, ROOT, &excerpt, None).expect("v6 only");
        refresh_v6_migration_ledger(&connection, ROOT, 1).expect("v6-only ledger");
        assert!(v6_ledger_ready(&connection, ROOT).expect("ready"));
        assert_eq!(
            count_rows(&connection, "SELECT count(*) FROM annotations"),
            0,
            "v6-only writes must not touch legacy annotations"
        );
    }

    // ---- D04: 位置迁移（缓存目录 → 数据目录） ----

    /// 旧缓存目录里有一个 v7 用户库（含一条摘录 + 文档指纹），数据目录为空：
    /// 首次启动把库无损搬到数据目录，旧文件原地保留，迁移记录可复核。
    #[test]
    fn migrates_a_cache_resident_user_database_to_the_durable_location() {
        let cache_dir = tempdir().expect("cache dir");
        let data_dir = tempdir().expect("data dir");
        let legacy = cache_dir.path().join(USER_DB_FILE);
        {
            let connection = open_user_database(&legacy, None).expect("seed legacy db");
            insert_document_row(&connection, ROOT, "notes/a.md", "hash-1");
            let draft = sample_excerpt_draft("ex-migrate", "notes/a.md");
            persist_excerpt(&connection, draft, 1_000);
        }

        let state = UserState::new(
            data_dir.path().to_path_buf(),
            cache_dir.path().to_path_buf(),
        )
        .expect("migrate on first launch");
        {
            let connection = locked(&state);
            let excerpt = read_excerpt_row(&connection, ROOT, "ex-migrate")
                .expect("read")
                .expect("migrated excerpt");
            assert_eq!(
                excerpt.source_text,
                sample_excerpt_draft("ex-migrate", "notes/a.md").source_text
            );
        }

        // 旧文件原地保留（迁移不删除旧数据），迁移记录存在且指向旧库。
        assert!(legacy.is_file(), "the old database must stay in place");
        let record = data_dir.path().join("reade-user-location.json");
        let record_text = fs::read_to_string(&record).expect("migration record");
        assert!(record_text.contains(USER_DB_FILE));
        assert!(!data_dir
            .path()
            .join("reade-user.sqlite3.migrating")
            .exists());
        assert!(!cache_dir.path().join("reade-user-migrate.lock").exists());
    }

    /// 第二次启动：旧文件仍在但未变化 → 直接使用新库，不重搬。
    #[test]
    fn second_launch_uses_the_durable_database_without_remigrating() {
        let cache_dir = tempdir().expect("cache dir");
        let data_dir = tempdir().expect("data dir");
        {
            let connection =
                open_user_database(&cache_dir.path().join(USER_DB_FILE), None).expect("legacy");
            insert_document_row(&connection, ROOT, "notes/a.md", "hash-1");
        }
        let first = UserState::new(
            data_dir.path().to_path_buf(),
            cache_dir.path().to_path_buf(),
        )
        .expect("first launch");
        drop(first);
        let record_before =
            fs::read(data_dir.path().join("reade-user-location.json")).expect("migration record");

        let second = UserState::new(
            data_dir.path().to_path_buf(),
            cache_dir.path().to_path_buf(),
        )
        .expect("second launch");
        drop(second);
        let record_after =
            fs::read(data_dir.path().join("reade-user-location.json")).expect("migration record");
        assert_eq!(
            record_before, record_after,
            "a second launch must not rewrite (or redo) the migration"
        );
        assert!(
            !data_dir
                .path()
                .join("reade-user.sqlite3.migrating")
                .exists(),
            "no temp file may survive a completed migration"
        );
    }

    /// 迁移后旧库又被（旧版本程序）写入 → 拒绝启动，不自动择优。
    #[test]
    fn refuses_to_start_when_the_old_database_changed_after_migration() {
        let cache_dir = tempdir().expect("cache dir");
        let data_dir = tempdir().expect("data dir");
        let legacy_path = cache_dir.path().join(USER_DB_FILE);
        {
            let connection = open_user_database(&legacy_path, None).expect("legacy");
            insert_document_row(&connection, ROOT, "notes/a.md", "hash-1");
        }
        let state = UserState::new(
            data_dir.path().to_path_buf(),
            cache_dir.path().to_path_buf(),
        )
        .expect("migrate");
        drop(state);

        // 旧库获得新写入（模拟回退到旧版本继续使用）。
        {
            let connection = Connection::open(&legacy_path).expect("reopen old");
            insert_document_row(&connection, ROOT, "notes/b.md", "hash-2");
        }

        let error = UserState::new(
            data_dir.path().to_path_buf(),
            cache_dir.path().to_path_buf(),
        )
        .expect_err("conflict must refuse to open");
        assert!(
            error.contains("changed after it was migrated"),
            "unexpected error: {error}"
        );
    }

    /// 两库都在但没有可信迁移记录（手工拷贝）→ 拒绝，保护两份数据。
    #[test]
    fn refuses_to_open_when_both_databases_exist_without_a_record() {
        let cache_dir = tempdir().expect("cache dir");
        let data_dir = tempdir().expect("data dir");
        {
            let connection =
                open_user_database(&cache_dir.path().join(USER_DB_FILE), None).expect("legacy");
            insert_document_row(&connection, ROOT, "notes/a.md", "hash-1");
        }
        // 模拟用户手工把旧库拷到数据目录（没有迁移记录）。
        fs::copy(
            cache_dir.path().join(USER_DB_FILE),
            data_dir.path().join(USER_DB_FILE),
        )
        .expect("manual copy");

        let error = UserState::new(
            data_dir.path().to_path_buf(),
            cache_dir.path().to_path_buf(),
        )
        .expect_err("must refuse");
        assert!(error.contains("without a trusted migration record"));
    }

    /// 迁移中断留下的临时文件与陈旧锁 → 下次启动幂等地重做迁移。
    #[test]
    fn interrupted_migration_is_redone_on_the_next_start() {
        let cache_dir = tempdir().expect("cache dir");
        let data_dir = tempdir().expect("data dir");
        {
            let connection =
                open_user_database(&cache_dir.path().join(USER_DB_FILE), None).expect("legacy");
            let draft = sample_excerpt_draft("ex-stale", "notes/a.md");
            insert_document_row(&connection, ROOT, "notes/a.md", "hash-1");
            persist_excerpt(&connection, draft, 1_000);
        }
        // 伪造一次中断：残留临时文件 + 内容已过期的锁文件。
        fs::write(
            data_dir.path().join("reade-user.sqlite3.migrating"),
            b"junk",
        )
        .expect("stale temp");
        fs::write(data_dir.path().join("reade-user-migrate.lock"), b"1").expect("stale lock");

        let state = UserState::new(
            data_dir.path().to_path_buf(),
            cache_dir.path().to_path_buf(),
        )
        .expect("redo migration");
        {
            let connection = locked(&state);
            let excerpt = read_excerpt_row(&connection, ROOT, "ex-stale")
                .expect("read")
                .expect("migrated after redo");
            assert_eq!(excerpt.id, "ex-stale");
        }
        assert!(!data_dir
            .path()
            .join("reade-user.sqlite3.migrating")
            .exists());
        assert!(!data_dir.path().join("reade-user-migrate.lock").exists());
    }

    /// 旧库写入留在 WAL 未 checkpoint 时，VACUUM INTO 快照必须包含它们。
    #[test]
    fn migration_snapshot_includes_uncheckpointed_wal_commits() {
        let cache_dir = tempdir().expect("cache dir");
        let data_dir = tempdir().expect("data dir");
        let legacy_path = cache_dir.path().join(USER_DB_FILE);
        // 打开连接、关掉自动 checkpoint、写入后保持连接打开（WAL 不落主文件）。
        let source = open_user_database(&legacy_path, None).expect("legacy");
        source
            .execute_batch("PRAGMA wal_autocheckpoint = 0;")
            .expect("disable autocheckpoint");
        insert_document_row(&source, ROOT, "notes/wal.md", "hash-wal");
        let draft = sample_excerpt_draft("ex-wal", "notes/wal.md");
        persist_excerpt(&source, draft, 1_000);

        let state = UserState::new(
            data_dir.path().to_path_buf(),
            cache_dir.path().to_path_buf(),
        )
        .expect("migrate with live source");
        {
            let connection = locked(&state);
            let excerpt = read_excerpt_row(&connection, ROOT, "ex-wal")
                .expect("read")
                .expect("WAL-committed excerpt must migrate");
            assert_eq!(excerpt.id, "ex-wal");
        }
        drop(source);
    }

    /// 数据目录只读（目标不可写）→ 失败且源库完好，不产生半成品。
    #[test]
    fn read_only_destination_leaves_the_source_untouched() {
        let cache_dir = tempdir().expect("cache dir");
        let data_dir = tempdir().expect("data dir");
        let legacy_path = cache_dir.path().join(USER_DB_FILE);
        {
            let connection = open_user_database(&legacy_path, None).expect("legacy");
            insert_document_row(&connection, ROOT, "notes/a.md", "hash-1");
        }
        let digest_before =
            crate::storage_migration::tests_digest_for(&legacy_path).expect("digest before");

        // 只读目录：Windows 上设置 FILE_ATTRIBUTE_READONLY 目录属性并不能
        // 阻止创建文件，所以这里改为把"数据目录"指向一个普通文件路径，
        // create_dir_all 必然失败。
        let blocker = data_dir.path().join("occupied");
        fs::write(&blocker, b"not a directory").expect("blocker file");

        let error = UserState::new(blocker.clone(), cache_dir.path().to_path_buf())
            .expect_err("read-only destination must fail");
        assert!(
            error.contains("Cannot create application data directory")
                || error.contains("Not a directory")
                || error.contains("Cannot"),
            "unexpected error: {error}"
        );
        let digest_after =
            crate::storage_migration::tests_digest_for(&legacy_path).expect("digest after");
        assert_eq!(digest_before, digest_after, "source must stay untouched");
        assert!(fs::read_dir(&blocker).is_err());
    }

    /// 没有旧用户库但转换缓存里有 v0 时代标注：救援链路必须在新位置正常
    /// 运行。按 v7 既定语义（用户 2026-08-25 确认"升级清空标注"），救援
    /// 数据最终被清空，v6-only 库以空状态落地；转换缓存文件本身不动。
    #[test]
    fn fresh_durable_location_runs_the_rescue_chain_and_lands_empty() {
        let cache_dir = tempdir().expect("cache dir");
        let data_dir = tempdir().expect("data dir");
        build_legacy_cache(cache_dir.path());

        let state = UserState::new(
            data_dir.path().to_path_buf(),
            cache_dir.path().to_path_buf(),
        )
        .expect("fresh durable with rescue chain");
        {
            let connection = locked(&state);
            assert_eq!(user_version(&connection), USER_SCHEMA_VERSION);
            // v1 救援 → v6 镜像 → v7 清空：现行链路的既定终点是空 v6-only。
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM annotations"),
                0,
                "v7 wipe clears rescued legacy rows"
            );
            assert_eq!(
                count_rows(&connection, "SELECT count(*) FROM excerpts"),
                0,
                "v7 wipe clears v6 excerpts"
            );
            assert!(list_annotation_rows(&connection, ROOT, None)
                .expect("list")
                .is_empty());
        }
        // 转换缓存文件保持原样（它不是迁移的删除对象）。
        assert!(cache_dir.path().join(LEGACY_CACHE_DB_FILE).is_file());
    }

    /// 数据目录与缓存目录解析为同一文件（目录重合）→ 不迁移不复制。
    #[test]
    fn same_resolved_file_is_used_directly_without_migration() {
        let shared = tempdir().expect("shared dir");
        {
            let connection =
                open_user_database(&shared.path().join(USER_DB_FILE), None).expect("db");
            insert_document_row(&connection, ROOT, "notes/a.md", "hash-1");
        }
        let state = UserState::new(shared.path().to_path_buf(), shared.path().to_path_buf())
            .expect("same-dir layout opens directly");
        {
            let connection = locked(&state);
            let documents = count_rows(&connection, "SELECT count(*) FROM documents");
            assert_eq!(documents, 1, "existing rows must still be there");
        }
        assert!(!shared.path().join("reade-user-location.json").exists());
    }
}
