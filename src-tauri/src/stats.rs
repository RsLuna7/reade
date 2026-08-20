//! Reading time statistics storage.
//!
//! Sessions live in their own durable SQLite database under `app_data_dir`,
//! deliberately isolated from the conversion cache: the cache database is
//! deleted and rebuilt on schema mismatch, while reading history must never
//! be wiped. Schema upgrades here are additive-only.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::library::{
    current_root, normalize_relative_path, normalize_root, validate_relative_library_path,
    AppState, CommandResult,
};

const STATS_SCHEMA_VERSION: i64 = 1;
const MAX_SESSION_ID_CHARS: usize = 64;
const MAX_SESSION_TITLE_CHARS: usize = 200;
/// Sanity cap for a single session row (two days of active reading).
const MAX_SESSION_ACTIVE_SECONDS: u64 = 48 * 60 * 60;
const ALLOWED_SESSION_FORMATS: &[&str] = &["markdown", "mdx", "pdf", "epub"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSession {
    pub id: String,
    /// Present on list responses. Ignored on write: the open library is stamped
    /// from `current_root` instead of trusting the client.
    #[serde(default)]
    pub library_root: String,
    pub relative_path: String,
    pub format: String,
    pub title: Option<String>,
    pub started_at: u64,
    pub ended_at: u64,
    pub active_seconds: u64,
}

#[derive(Clone)]
pub struct StatsState {
    connection: Arc<Mutex<Connection>>,
}

impl StatsState {
    pub fn new(data_directory: PathBuf) -> CommandResult<Self> {
        fs::create_dir_all(&data_directory)
            .map_err(|error| format!("Cannot create application data directory: {error}"))?;
        let connection = open_stats_connection(&data_directory.join("reade-stats.sqlite3"))?;
        Self::from_connection(connection)
    }

    fn from_connection(connection: Connection) -> CommandResult<Self> {
        initialize_stats(&connection)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    #[cfg(test)]
    fn in_memory() -> CommandResult<Self> {
        Self::from_connection(
            Connection::open_in_memory()
                .map_err(|error| format!("Cannot create test stats database: {error}"))?,
        )
    }
}

#[tauri::command]
pub fn record_reading_session(
    session: ReadingSession,
    library: State<'_, AppState>,
    stats: State<'_, StatsState>,
) -> CommandResult<()> {
    let root = current_root(&library)?;
    let sanitized = sanitize_session(session)?;
    let connection = lock_stats(&stats)?;
    upsert_session(&connection, &normalize_root(&root), &sanitized)
}

#[tauri::command]
pub fn list_reading_sessions(
    from_ms: u64,
    to_ms: u64,
    library: State<'_, AppState>,
    stats: State<'_, StatsState>,
) -> CommandResult<Vec<ReadingSession>> {
    if from_ms > to_ms {
        return Err("The statistics range start must not exceed its end".to_owned());
    }
    // A library must be open (same gate as other user-data commands), but the
    // list itself is personal: every stored library_root is returned.
    current_root(&library)?;
    let connection = lock_stats(&stats)?;
    list_sessions(&connection, from_ms, to_ms)
}

fn open_stats_connection(path: &Path) -> CommandResult<Connection> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Cannot open reading statistics database: {error}"))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Cannot enable statistics WAL mode: {error}"))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| format!("Cannot tune statistics durability: {error}"))?;
    Ok(connection)
}

fn initialize_stats(connection: &Connection) -> CommandResult<()> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Cannot read statistics schema version: {error}"))?;
    if version > STATS_SCHEMA_VERSION {
        // Never wipe reading history: refuse to touch databases written by a
        // newer application version instead of rebuilding them.
        return Err(format!(
            "Reading statistics were written by a newer Reade version \
             (schema {version} > {STATS_SCHEMA_VERSION}); update the app to keep them"
        ));
    }
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS reading_sessions (
                 id TEXT PRIMARY KEY,
                 library_root TEXT NOT NULL,
                 relative_path TEXT NOT NULL,
                 format TEXT NOT NULL,
                 title TEXT,
                 started_at INTEGER NOT NULL,
                 ended_at INTEGER NOT NULL,
                 active_seconds INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS sessions_by_time
                 ON reading_sessions(library_root, started_at);
             CREATE INDEX IF NOT EXISTS sessions_by_doc
                 ON reading_sessions(library_root, relative_path);
             CREATE INDEX IF NOT EXISTS sessions_by_time_global
                 ON reading_sessions(started_at);",
        )
        .map_err(|error| format!("Cannot create statistics schema: {error}"))?;
    if version < STATS_SCHEMA_VERSION {
        // Future versions must add `if version < N` migration steps here;
        // dropping or recreating this file loses irreplaceable history.
        connection
            .pragma_update(None, "user_version", STATS_SCHEMA_VERSION)
            .map_err(|error| format!("Cannot store statistics schema version: {error}"))?;
    }
    Ok(())
}

fn lock_stats<'a>(state: &'a State<'_, StatsState>) -> CommandResult<MutexGuard<'a, Connection>> {
    state
        .connection
        .lock()
        .map_err(|_| "Statistics state lock was poisoned".to_owned())
}

fn sanitize_session(mut session: ReadingSession) -> CommandResult<ReadingSession> {
    validate_session_id(&session.id)?;
    validate_relative_library_path(&session.relative_path)?;
    session.relative_path = normalize_relative_path(Path::new(&session.relative_path));
    if !ALLOWED_SESSION_FORMATS.contains(&session.format.as_str()) {
        return Err(format!(
            "Unknown reading session format: {}",
            session.format
        ));
    }
    session.title = match session.title {
        None => None,
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else if trimmed.chars().count() > MAX_SESSION_TITLE_CHARS {
                return Err(format!(
                    "Reading session title exceeds {MAX_SESSION_TITLE_CHARS} characters"
                ));
            } else {
                Some(trimmed.to_owned())
            }
        }
    };
    if session.started_at == 0 {
        return Err("Reading session timestamps are required".to_owned());
    }
    if session.ended_at < session.started_at {
        return Err("Reading session cannot end before it starts".to_owned());
    }
    if session.active_seconds == 0 {
        return Err("Reading session must contain active time".to_owned());
    }
    if session.active_seconds > MAX_SESSION_ACTIVE_SECONDS {
        return Err("Reading session active time is implausibly long".to_owned());
    }
    Ok(session)
}

fn validate_session_id(id: &str) -> CommandResult<()> {
    if id.is_empty() || id.chars().count() > MAX_SESSION_ID_CHARS {
        return Err("Reading session id is invalid".to_owned());
    }
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("Reading session id contains unsupported characters".to_owned());
    }
    Ok(())
}

fn upsert_session(
    connection: &Connection,
    root: &str,
    session: &ReadingSession,
) -> CommandResult<()> {
    connection
        .execute(
            "INSERT INTO reading_sessions(
                 id, library_root, relative_path, format, title,
                 started_at, ended_at, active_seconds
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                 relative_path = excluded.relative_path,
                 format = excluded.format,
                 title = excluded.title,
                 started_at = excluded.started_at,
                 ended_at = excluded.ended_at,
                 active_seconds = excluded.active_seconds
             WHERE reading_sessions.library_root = excluded.library_root",
            params![
                session.id,
                root,
                session.relative_path,
                session.format,
                session.title,
                session.started_at as i64,
                session.ended_at as i64,
                session.active_seconds as i64,
            ],
        )
        .map_err(|error| format!("Cannot save reading session: {error}"))?;
    let owned: i64 = connection
        .query_row(
            "SELECT count(*) FROM reading_sessions WHERE id = ?1 AND library_root = ?2",
            params![session.id, root],
            |row| row.get(0),
        )
        .map_err(|error| format!("Cannot verify reading session ownership: {error}"))?;
    if owned == 0 {
        return Err("Reading session id belongs to another library".to_owned());
    }
    Ok(())
}

fn list_sessions(
    connection: &Connection,
    from_ms: u64,
    to_ms: u64,
) -> CommandResult<Vec<ReadingSession>> {
    // Timestamps are stored as i64; clamp instead of wrapping to negatives.
    let from = from_ms.min(i64::MAX as u64) as i64;
    let to = to_ms.min(i64::MAX as u64) as i64;
    let mut statement = connection
        .prepare(
            "SELECT id, library_root, relative_path, format, title,
                    started_at, ended_at, active_seconds
             FROM reading_sessions
             WHERE started_at <= ?1 AND ended_at >= ?2
             ORDER BY started_at ASC, id ASC",
        )
        .map_err(|error| format!("Cannot prepare reading session list: {error}"))?;
    let mapped = statement
        .query_map(params![to, from], |row| {
            Ok(ReadingSession {
                id: row.get(0)?,
                library_root: row.get(1)?,
                relative_path: row.get(2)?,
                format: row.get(3)?,
                title: row.get(4)?,
                started_at: row.get::<_, i64>(5)? as u64,
                ended_at: row.get::<_, i64>(6)? as u64,
                active_seconds: row.get::<_, i64>(7)? as u64,
            })
        })
        .map_err(|error| format!("Cannot list reading sessions: {error}"))?;
    let mut sessions = Vec::new();
    for row in mapped {
        sessions.push(row.map_err(|error| format!("Cannot decode reading session: {error}"))?);
    }
    Ok(sessions)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn sample_session(id: &str) -> ReadingSession {
        ReadingSession {
            id: id.to_owned(),
            library_root: String::new(),
            relative_path: "notes/alpha.md".to_owned(),
            format: "markdown".to_owned(),
            title: Some("Alpha".to_owned()),
            started_at: 1_700_000_000_000,
            ended_at: 1_700_000_060_000,
            active_seconds: 45,
        }
    }

    fn with_root(mut session: ReadingSession, root: &str) -> ReadingSession {
        session.library_root = root.to_owned();
        session
    }

    fn locked(state: &StatsState) -> MutexGuard<'_, Connection> {
        state.connection.lock().expect("lock stats connection")
    }

    #[test]
    fn creates_schema_with_version() {
        let state = StatsState::in_memory().expect("state");
        let connection = locked(&state);
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read version");
        assert_eq!(version, STATS_SCHEMA_VERSION);
        let tables: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'reading_sessions'",
                [],
                |row| row.get(0),
            )
            .expect("inspect schema");
        assert_eq!(tables, 1);
        let global_index: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'sessions_by_time_global'",
                [],
                |row| row.get(0),
            )
            .expect("inspect global time index");
        assert_eq!(global_index, 1);
    }

    #[test]
    fn upsert_extends_an_existing_session_row() {
        let state = StatsState::in_memory().expect("state");
        let connection = locked(&state);
        let root = "C:/library";
        let mut session = sanitize_session(sample_session("session-1")).expect("sanitize");
        upsert_session(&connection, root, &session).expect("insert");

        session.ended_at += 120_000;
        session.active_seconds = 150;
        upsert_session(&connection, root, &session).expect("extend");

        let listed = list_sessions(&connection, 0, u64::MAX).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0], with_root(session, root));
    }

    #[test]
    fn list_filters_by_time_range_and_returns_every_library() {
        let state = StatsState::in_memory().expect("state");
        let connection = locked(&state);
        let mut early = sample_session("early");
        early.started_at = 1_000;
        early.ended_at = 2_000;
        let mut late = sample_session("late");
        late.started_at = 10_000;
        late.ended_at = 12_000;
        upsert_session(&connection, "C:/one", &early).expect("insert early");
        upsert_session(&connection, "C:/one", &late).expect("insert late");
        upsert_session(&connection, "C:/two", &sample_session("other-root"))
            .expect("insert other library");

        let in_range = list_sessions(&connection, 1_500, 3_000).expect("list overlap");
        assert_eq!(in_range.len(), 1);
        assert_eq!(in_range[0].id, "early");
        assert_eq!(in_range[0].library_root, "C:/one");

        let everything = list_sessions(&connection, 0, u64::MAX).expect("list all");
        assert_eq!(everything.len(), 3);
        assert_eq!(everything[0].id, "early");
        assert_eq!(everything[1].id, "late");
        assert_eq!(everything[2].id, "other-root");
        assert_eq!(everything[2].library_root, "C:/two");
    }

    #[test]
    fn same_relative_path_in_different_libraries_stays_two_rows() {
        let state = StatsState::in_memory().expect("state");
        let connection = locked(&state);
        upsert_session(&connection, "C:/one", &sample_session("one-alpha")).expect("insert one");
        upsert_session(&connection, "C:/two", &sample_session("two-alpha")).expect("insert two");

        let listed = list_sessions(&connection, 0, u64::MAX).expect("list");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].relative_path, listed[1].relative_path);
        assert_ne!(listed[0].library_root, listed[1].library_root);
    }

    #[test]
    fn session_id_cannot_be_captured_by_another_library() {
        let state = StatsState::in_memory().expect("state");
        let connection = locked(&state);
        let session = sample_session("shared-id");
        upsert_session(&connection, "C:/one", &session).expect("insert");
        let error = upsert_session(&connection, "C:/two", &session)
            .expect_err("cross-library upsert must fail");
        assert!(
            error.contains("another library"),
            "unexpected error: {error}"
        );
        let listed = list_sessions(&connection, 0, u64::MAX).expect("list");
        assert_eq!(listed[0], with_root(session, "C:/one"));
    }

    #[test]
    fn rejects_invalid_sessions() {
        let traversal = ReadingSession {
            relative_path: "../outside.md".to_owned(),
            ..sample_session("bad-path")
        };
        assert!(sanitize_session(traversal).is_err());

        let absolute = ReadingSession {
            relative_path: "C:/library/inside.md".to_owned(),
            ..sample_session("abs-path")
        };
        assert!(sanitize_session(absolute).is_err());

        let bad_id = ReadingSession {
            id: "bad id!".to_owned(),
            ..sample_session("ignored")
        };
        assert!(sanitize_session(bad_id).is_err());

        let bad_format = ReadingSession {
            format: "docx".to_owned(),
            ..sample_session("bad-format")
        };
        assert!(sanitize_session(bad_format).is_err());

        let zero_start = ReadingSession {
            started_at: 0,
            ..sample_session("zero-start")
        };
        assert!(sanitize_session(zero_start).is_err());

        let inverted = ReadingSession {
            ended_at: 1,
            ..sample_session("inverted")
        };
        assert!(sanitize_session(inverted).is_err());

        let idle = ReadingSession {
            active_seconds: 0,
            ..sample_session("idle")
        };
        assert!(sanitize_session(idle).is_err());

        let implausible = ReadingSession {
            active_seconds: MAX_SESSION_ACTIVE_SECONDS + 1,
            ..sample_session("implausible")
        };
        assert!(sanitize_session(implausible).is_err());

        let long_title = ReadingSession {
            title: Some("标".repeat(MAX_SESSION_TITLE_CHARS + 1)),
            ..sample_session("long-title")
        };
        assert!(sanitize_session(long_title).is_err());

        let blank_title = sanitize_session(ReadingSession {
            title: Some("   ".to_owned()),
            ..sample_session("blank-title")
        })
        .expect("blank title collapses to none");
        assert_eq!(blank_title.title, None);
    }

    #[test]
    fn data_survives_reopen_and_newer_schema_is_refused_without_wipe() {
        let data_directory = tempdir().expect("temp data dir");
        let session = sample_session("durable");
        {
            let state = StatsState::new(data_directory.path().to_path_buf()).expect("create");
            let connection = locked(&state);
            upsert_session(&connection, "C:/one", &session).expect("insert");
        }
        {
            let state = StatsState::new(data_directory.path().to_path_buf()).expect("reopen");
            let connection = locked(&state);
            let listed = list_sessions(&connection, 0, u64::MAX).expect("list");
            assert_eq!(listed, vec![with_root(session.clone(), "C:/one")]);
            connection
                .pragma_update(None, "user_version", 99)
                .expect("simulate newer schema");
        }
        let error = match StatsState::new(data_directory.path().to_path_buf()) {
            Ok(_) => panic!("newer schema must be refused"),
            Err(error) => error,
        };
        assert!(error.contains("newer"), "unexpected error: {error}");
        let connection = open_stats_connection(&data_directory.path().join("reade-stats.sqlite3"))
            .expect("reopen raw");
        let listed = list_sessions(&connection, 0, u64::MAX).expect("data kept");
        assert_eq!(listed, vec![with_root(session, "C:/one")]);
    }
}
