//! D04: the durable user database lives in `app_data_dir`; the conversion
//! cache stays in `app_cache_dir`. Historically the user database was
//! cache-resident, so on first launch after this change the old file is
//! moved to the durable location exactly once:
//!
//! 1. a consistent `VACUUM INTO` snapshot of the old database (WAL-committed
//!    data included) is written into the durable directory,
//! 2. the snapshot passes `PRAGMA integrity_check` and a per-table row
//!    digest comparison against the source,
//! 3. it is initialized through the regular migration chain, a migration
//!    record is written next to it, and only then is it published by rename,
//! 4. the old file is never deleted or modified by the migration.
//!
//! Later launches use the record to detect post-migration writes to the
//! abandoned file; such conflicts are refused instead of silently picking a
//! winner. Digests are data-based (row counts + max updated_at), never
//! mtime-based.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::library::CommandResult;
use crate::user_store::{open_user_database, USER_DB_FILE};

const MIGRATION_TEMP_SUFFIX: &str = "reade-user.sqlite3.migrating";
const MIGRATION_RECORD_FILE: &str = "reade-user-location.json";
const MIGRATION_LOCK_FILE: &str = "reade-user-migrate.lock";
/// A lock older than this is treated as a crashed process and broken.
const LOCK_STALE_AFTER: Duration = Duration::from_secs(10);

/// Business tables whose row identity the digest covers. Checked at the
/// digest site only; a table missing from an older schema contributes a
/// stable "missing" marker instead of an error.
const DIGEST_TABLES: &[&str] = &[
    "annotations",
    "documents",
    "annotation_reviews",
    "collections",
    "collection_items",
    "excerpts",
    "reading_places",
    "reflections",
    "review_enrollments",
    "annotation_v6_migration",
];

#[derive(Debug, Serialize, Deserialize)]
struct MigrationRecord {
    /// Record format version, for future evolution.
    format: u32,
    source_path: String,
    source_digest: String,
    migrated_at_ms: u64,
    /// True once the snapshot passed integrity check and digest comparison.
    verified: bool,
}

fn quote_sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Row-identity digest of a user database: per-table count and, where the
/// column exists, the max `updated_at`. Missing tables contribute a stable
/// marker so old-schema databases digest deterministically.
fn user_database_digest(path: &Path) -> CommandResult<String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Cannot open user database for digest: {error}"))?;
    let mut digest = String::new();
    for table in DIGEST_TABLES {
        let exists: bool = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get::<_, i64>(0).map(|count| count > 0),
            )
            .map_err(|error| format!("Cannot inspect user database schema: {error}"))?;
        if !exists {
            digest.push_str(&format!("{table}:missing;"));
            continue;
        }
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .map_err(|error| format!("Cannot count user table {table}: {error}"))?;
        let has_updated_at = table_has_updated_at(&connection, table)?;
        if has_updated_at {
            let max_updated: i64 = connection
                .query_row(
                    &format!("SELECT COALESCE(MAX(updated_at), 0) FROM {table}"),
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Cannot read max updated_at for {table}: {error}"))?;
            digest.push_str(&format!("{table}:{count}:{max_updated};"));
        } else {
            digest.push_str(&format!("{table}:{count};"));
        }
    }
    Ok(digest)
}

fn table_has_updated_at(connection: &Connection, table: &str) -> CommandResult<bool> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("Cannot read columns of {table}: {error}"))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Cannot read columns of {table}: {error}"))?;
    for name in names {
        let name = name.map_err(|error| format!("Cannot read column name: {error}"))?;
        if name == "updated_at" {
            return Ok(true);
        }
    }
    Ok(false)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn read_migration_record(durable_directory: &Path) -> Option<MigrationRecord> {
    let text = fs::read_to_string(durable_directory.join(MIGRATION_RECORD_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_migration_record(durable_directory: &Path, record: &MigrationRecord) -> CommandResult<()> {
    let text = serde_json::to_string_pretty(record)
        .map_err(|error| format!("Cannot encode migration record: {error}"))?;
    fs::write(durable_directory.join(MIGRATION_RECORD_FILE), text)
        .map_err(|error| format!("Cannot write migration record: {error}"))
}

/// Content-stamped lock so tests (and crashed runs) can age it without
/// touching file mtimes. Creating the file with `create_new` makes the
/// two-instance race fail closed.
struct MigrationLock {
    path: PathBuf,
}

impl Drop for MigrationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_migration_lock(durable_directory: &Path) -> CommandResult<MigrationLock> {
    let path = durable_directory.join(MIGRATION_LOCK_FILE);
    for attempt in 0..2 {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                let _ = write!(file, "{}", now_millis());
                return Ok(MigrationLock { path });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| text.trim().parse::<u64>().ok())
                    .map(|stamp| {
                        let now = now_millis();
                        now > stamp && Duration::from_millis(now - stamp) > LOCK_STALE_AFTER
                    })
                    .unwrap_or(false);
                if stale && attempt == 0 {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                return Err(
                    "Another Reade instance is migrating the user database; retry shortly"
                        .to_owned(),
                );
            }
            Err(error) => {
                return Err(format!("Cannot create migration lock: {error}"));
            }
        }
    }
    unreachable!("the loop returns on every path")
}

fn canonical_same_file(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Resolves where the durable user database lives, migrating a
/// cache-resident copy exactly once when needed. Returns the durable path.
/// The source database is never modified or deleted; every failure mode
/// leaves no half-written file at the durable location.
pub(crate) fn prepare_durable_user_database(
    durable_directory: &Path,
    cache_directory: &Path,
) -> CommandResult<PathBuf> {
    fs::create_dir_all(durable_directory)
        .map_err(|error| format!("Cannot create application data directory: {error}"))?;
    let durable = durable_directory.join(USER_DB_FILE);
    let legacy_resident = cache_directory.join(USER_DB_FILE);

    let durable_exists = durable.is_file();
    let legacy_exists = legacy_resident.is_file();

    if durable_exists && legacy_exists && canonical_same_file(&durable, &legacy_resident) {
        // Degenerate layouts (joined directories): same file, nothing to move.
        return Ok(durable);
    }

    if durable_exists && legacy_exists {
        match read_migration_record(durable_directory) {
            Some(record) if record.verified => {
                let current_digest = user_database_digest(&legacy_resident)?;
                if current_digest == record.source_digest {
                    return Ok(durable);
                }
                return Err(format!(
                    "User annotation data is present in both {durable:?} and {legacy_resident:?}, \
                     and the old copy changed after it was migrated. Reade refuses to pick a \
                     winner automatically; keep one file and rename the other aside, then restart."
                ));
            }
            Some(_) | None => {
                return Err(format!(
                    "User annotation data is present in both {durable:?} and {legacy_resident:?} \
                     without a trusted migration record. Reade refuses to pick a winner \
                     automatically; keep one file and rename the other aside, then restart."
                ));
            }
        }
    }

    if durable_exists || !legacy_exists {
        // Fresh install, or the migration already completed and the old file
        // was removed by hand. The regular open path handles both.
        return Ok(durable);
    }

    // !durable && legacy: migrate the cache-resident database now.
    let _lock = acquire_migration_lock(durable_directory)?;
    let temp = durable_directory.join(MIGRATION_TEMP_SUFFIX);
    let _ = fs::remove_file(&temp);

    let source_digest = user_database_digest(&legacy_resident)?;
    {
        let source =
            Connection::open_with_flags(&legacy_resident, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|error| {
                    format!("Cannot open the old user database for migration: {error}")
                })?;
        let target = quote_sql_string(&temp.to_string_lossy());
        source
            .execute(&format!("VACUUM INTO {target}"), [])
            .map_err(|error| {
                format!("Cannot snapshot the old user database (is another Reade instance running?): {error}")
            })?;
    }

    // Verify the snapshot before anything touches the durable location.
    let integrity: String = {
        let snapshot = Connection::open_with_flags(&temp, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Cannot open the migration snapshot: {error}"))?;
        snapshot
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|error| format!("Cannot run integrity check: {error}"))?
    };
    if integrity != "ok" {
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "The migrated user database snapshot failed its integrity check ({integrity}); \
             the original data is untouched."
        ));
    }
    let snapshot_digest = user_database_digest(&temp)?;
    if snapshot_digest != source_digest {
        let _ = fs::remove_file(&temp);
        return Err(
            "The migrated user database snapshot did not match the source row digest; \
             the original data is untouched. Migration will be retried on the next start."
                .to_owned(),
        );
    }

    // Bring the snapshot through the regular migration chain (including the
    // legacy conversion-cache rescue, which is the same source the old
    // database used) so the published file is at the current schema version.
    let legacy_conversion_cache = cache_directory.join(crate::user_store::LEGACY_CACHE_DB_FILE);
    let legacy_rescue = if legacy_conversion_cache.is_file() {
        Some(legacy_conversion_cache.as_path())
    } else {
        None
    };
    open_user_database(&temp, legacy_rescue).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Cannot initialize the migrated user database: {error}")
    })?;

    write_migration_record(
        durable_directory,
        &MigrationRecord {
            format: 1,
            source_path: legacy_resident.to_string_lossy().to_string(),
            source_digest,
            migrated_at_ms: now_millis(),
            verified: true,
        },
    )?;

    // Same-directory rename: atomic on both platforms. Crash before this
    // leaves the temp file and an unverified record; the next start redoes
    // the migration from the untouched source.
    fs::rename(&temp, &durable).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Cannot publish the migrated user database: {error}")
    })?;
    Ok(durable)
}

/// Test-only bridge: user_store's integration tests assert that the
/// source database digest is unchanged across a failed migration.
#[cfg(test)]
pub(crate) fn tests_digest_for(path: &Path) -> CommandResult<String> {
    user_database_digest(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_stable_and_covers_row_counts() {
        let directory = tempfile::tempdir().expect("temp dir");
        let path = directory.path().join("user.sqlite3");
        let connection = Connection::open(&path).expect("open");
        connection
            .execute_batch(
                "CREATE TABLE annotations (id TEXT PRIMARY KEY, updated_at INTEGER);
                 INSERT INTO annotations VALUES ('a', 5);",
            )
            .expect("seed");
        let first = user_database_digest(&path).expect("digest");
        let second = user_database_digest(&path).expect("digest");
        assert_eq!(first, second);
        assert!(first.starts_with("annotations:1:5;"));
        // A table the schema does not have yet digests as missing.
        connection
            .execute_batch("DROP TABLE annotations;")
            .expect("drop");
        let after_drop = user_database_digest(&path).expect("digest");
        assert!(after_drop.starts_with("annotations:missing;"));
    }

    #[test]
    fn sql_string_quoting_is_safe() {
        assert_eq!(quote_sql_string("it's"), "'it''s'");
    }
}
