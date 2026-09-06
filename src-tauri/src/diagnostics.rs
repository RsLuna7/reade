//! D15: local diagnostics, backup snapshots, and pending restore-on-launch.
//!
//! Backups never pack the original library files or the regenerable conversion
//! cache. Restore is staged into `restore-pending` and applied at the next
//! process start so live SQLite connections are not swapped out from under
//! the UI.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::library::{AppState, CommandResult};
use crate::sqlite_io::integrity_ok;
use crate::stats::StatsState;
use crate::user_store::UserState;

pub(crate) const BACKUP_FORMAT: u32 = 1;
const BACKUPS_DIR: &str = "backups";
const RESTORE_PENDING_DIR: &str = "restore-pending";
const USER_DB_FILE: &str = "reade-user.sqlite3";
const STATS_DB_FILE: &str = "reade-stats.sqlite3";
const CACHE_DB_FILE: &str = "reade-cache.sqlite3";
const MANIFEST_FILE: &str = "manifest.json";
const PREFERENCES_FILE: &str = "preferences.json";
const MAX_PREFERENCES_BYTES: usize = 1024 * 1024;
const ALLOWED_BACKUP_FILES: &[&str] =
    &[MANIFEST_FILE, USER_DB_FILE, STATS_DB_FILE, PREFERENCES_FILE];

/// D15: opening the durable stores must not panic the process. Diagnostics
/// and restore stay available; annotation/stats commands refuse with these
/// errors until a backup is restored.
pub struct DataOpenHealth {
    user_error: Mutex<Option<String>>,
    stats_error: Mutex<Option<String>>,
}

impl DataOpenHealth {
    pub fn new(user_error: Option<String>, stats_error: Option<String>) -> Self {
        Self {
            user_error: Mutex::new(user_error),
            stats_error: Mutex::new(stats_error),
        }
    }

    fn user_error(&self) -> Option<String> {
        self.user_error.lock().ok().and_then(|guard| guard.clone())
    }

    fn stats_error(&self) -> Option<String> {
        self.stats_error.lock().ok().and_then(|guard| guard.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalDataStatus {
    pub app_version: String,
    pub user_db_path: String,
    pub stats_db_path: String,
    pub cache_db_path: String,
    pub user_db_ok: bool,
    pub stats_db_ok: bool,
    pub user_schema_version: Option<i64>,
    pub cache_bytes: u64,
    pub failed_index_count: u32,
    pub last_backup_at_ms: Option<u64>,
    pub last_backup_path: Option<String>,
    pub pending_bound_sessions: u32,
    pub restore_pending: bool,
    pub user_open_error: Option<String>,
    pub stats_open_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalBackupResult {
    pub backup_path: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format: u32,
    app_version: String,
    created_at_ms: u64,
    includes: Vec<String>,
    /// SHA-256 of each packed file name → hex digest.
    checksums: Vec<(String, String)>,
}

struct DataPaths {
    user_db: PathBuf,
    stats_db: PathBuf,
    cache_db: PathBuf,
    backups: PathBuf,
    restore_pending: PathBuf,
}

impl DataPaths {
    fn from_dirs(data_dir: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            user_db: data_dir.join(USER_DB_FILE),
            stats_db: data_dir.join(STATS_DB_FILE),
            cache_db: cache_dir.join(CACHE_DB_FILE),
            backups: data_dir.join(BACKUPS_DIR),
            restore_pending: data_dir.join(RESTORE_PENDING_DIR),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn file_bytes(path: &Path) -> u64 {
    fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn sha256_file(path: &Path) -> CommandResult<String> {
    use sha2::{Digest, Sha256};
    let bytes = fs::read(path).map_err(|error| format!("Cannot checksum backup file: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn latest_backup(backups: &Path) -> (Option<u64>, Option<String>) {
    let Ok(entries) = fs::read_dir(backups) else {
        return (None, None);
    };
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join(MANIFEST_FILE);
        let Ok(bytes) = fs::read(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<BackupManifest>(&bytes) else {
            continue;
        };
        if best
            .as_ref()
            .is_none_or(|(created, _)| manifest.created_at_ms >= *created)
        {
            best = Some((manifest.created_at_ms, path));
        }
    }
    match best {
        Some((created, path)) => (Some(created), Some(path.to_string_lossy().into_owned())),
        None => (None, None),
    }
}

pub(crate) fn apply_pending_restore(data_dir: &Path) -> CommandResult<()> {
    let pending = data_dir.join(RESTORE_PENDING_DIR);
    if !pending.exists() {
        return Ok(());
    }
    validate_backup_dir(&pending)?;
    let rollback = data_dir.join(format!("rollback-before-restore-{}", now_ms()));
    fs::create_dir_all(&rollback)
        .map_err(|error| format!("Cannot create rollback directory: {error}"))?;
    for name in [USER_DB_FILE, STATS_DB_FILE] {
        let live = data_dir.join(name);
        if live.exists() {
            fs::copy(&live, rollback.join(name)).map_err(|error| {
                format!("Cannot preserve current {name} before restore: {error}")
            })?;
        }
        let incoming = pending.join(name);
        if incoming.exists() {
            fs::copy(&incoming, &live)
                .map_err(|error| format!("Cannot restore {name}: {error}"))?;
        }
    }
    fs::remove_dir_all(&pending)
        .map_err(|error| format!("Cannot clear restore-pending after applying: {error}"))?;
    Ok(())
}

fn validate_backup_dir(dir: &Path) -> CommandResult<BackupManifest> {
    let canonical = dir
        .canonicalize()
        .map_err(|error| format!("Cannot resolve backup directory: {error}"))?;
    if !canonical.is_dir() {
        return Err("Backup path must be a directory".to_owned());
    }
    for entry in fs::read_dir(&canonical)
        .map_err(|error| format!("Cannot read backup directory: {error}"))?
        .flatten()
    {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "." || name == ".." {
            continue;
        }
        if name.contains("..") || name.contains('/') || name.contains('\\') {
            return Err("Backup contains an unsafe extra path".to_owned());
        }
        if !ALLOWED_BACKUP_FILES.contains(&name.as_ref()) {
            return Err(format!("Backup contains unexpected file {name}"));
        }
        if entry.path().is_symlink() {
            return Err("Backup files must not be symbolic links".to_owned());
        }
    }
    let bytes = fs::read(canonical.join(MANIFEST_FILE))
        .map_err(|error| format!("Backup is missing manifest.json: {error}"))?;
    let manifest: BackupManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Backup manifest is not valid JSON: {error}"))?;
    if manifest.format != BACKUP_FORMAT {
        return Err(format!(
            "Unsupported backup format {} (this build reads {BACKUP_FORMAT})",
            manifest.format
        ));
    }
    for name in [USER_DB_FILE, STATS_DB_FILE] {
        let path = canonical.join(name);
        if !path.exists() {
            return Err(format!("Backup is missing {name}"));
        }
        let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Cannot open backup {name}: {error}"))?;
        if !integrity_ok(&connection)? {
            return Err(format!("Backup {name} failed integrity_check"));
        }
    }
    Ok(manifest)
}

fn write_backup(
    dest: &Path,
    user: &UserState,
    stats: &StatsState,
    preferences_json: &str,
) -> CommandResult<LocalBackupResult> {
    if preferences_json.len() > MAX_PREFERENCES_BYTES {
        return Err("Preferences snapshot is too large to pack".to_owned());
    }
    let parsed: serde_json::Value = serde_json::from_str(preferences_json)
        .map_err(|error| format!("Preferences snapshot must be JSON: {error}"))?;
    if !parsed.is_object() {
        return Err("Preferences snapshot must be a JSON object".to_owned());
    }
    fs::create_dir_all(dest).map_err(|error| format!("Cannot create backup directory: {error}"))?;
    let user_dest = dest.join(USER_DB_FILE);
    let stats_dest = dest.join(STATS_DB_FILE);
    user.snapshot_to(&user_dest)?;
    stats.snapshot_to(&stats_dest)?;
    fs::write(dest.join(PREFERENCES_FILE), preferences_json)
        .map_err(|error| format!("Cannot write preferences snapshot: {error}"))?;
    let created_at_ms = now_ms();
    let checksums = [USER_DB_FILE, STATS_DB_FILE, PREFERENCES_FILE]
        .into_iter()
        .map(|name| sha256_file(&dest.join(name)).map(|digest| (name.to_owned(), digest)))
        .collect::<Result<Vec<_>, _>>()?;
    let manifest = BackupManifest {
        format: BACKUP_FORMAT,
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        created_at_ms,
        includes: vec![
            USER_DB_FILE.to_owned(),
            STATS_DB_FILE.to_owned(),
            PREFERENCES_FILE.to_owned(),
        ],
        checksums,
    };
    fs::write(
        dest.join(MANIFEST_FILE),
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Cannot encode manifest: {error}"))?,
    )
    .map_err(|error| format!("Cannot write backup manifest: {error}"))?;
    Ok(LocalBackupResult {
        backup_path: dest.to_string_lossy().into_owned(),
        created_at_ms,
    })
}

fn paths_from_app(app: &AppHandle) -> CommandResult<DataPaths> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Cannot resolve app data directory: {error}"))?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Cannot resolve app cache directory: {error}"))?;
    Ok(DataPaths::from_dirs(data_dir, cache_dir))
}

#[tauri::command]
pub fn local_data_status(
    app: AppHandle,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
    stats: State<'_, StatsState>,
    health: State<'_, DataOpenHealth>,
) -> CommandResult<LocalDataStatus> {
    let paths = paths_from_app(&app)?;
    let (last_backup_at_ms, last_backup_path) = latest_backup(&paths.backups);
    let user_open_error = health.user_error();
    let stats_open_error = health.stats_error();
    Ok(LocalDataStatus {
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        user_db_path: paths.user_db.to_string_lossy().into_owned(),
        stats_db_path: paths.stats_db.to_string_lossy().into_owned(),
        cache_db_path: paths.cache_db.to_string_lossy().into_owned(),
        user_db_ok: user_open_error.is_none() && user.integrity_ok().unwrap_or(false),
        stats_db_ok: stats_open_error.is_none() && stats.integrity_ok().unwrap_or(false),
        user_schema_version: user.schema_version().ok(),
        cache_bytes: file_bytes(&paths.cache_db),
        failed_index_count: library.failed_index_count(),
        last_backup_at_ms,
        last_backup_path,
        pending_bound_sessions: stats.bound_session_count(),
        restore_pending: paths.restore_pending.exists(),
        user_open_error,
        stats_open_error,
    })
}

#[tauri::command]
pub fn create_local_backup(
    app: AppHandle,
    user: State<'_, UserState>,
    stats: State<'_, StatsState>,
    preferences_json: String,
) -> CommandResult<LocalBackupResult> {
    let paths = paths_from_app(&app)?;
    fs::create_dir_all(&paths.backups)
        .map_err(|error| format!("Cannot create backups directory: {error}"))?;
    let dest = paths.backups.join(format!("reade-backup-{}", now_ms()));
    write_backup(&dest, &user, &stats, &preferences_json)
}

#[tauri::command]
pub fn stage_local_restore(app: AppHandle, backup_dir: String) -> CommandResult<String> {
    let paths = paths_from_app(&app)?;
    let source = PathBuf::from(backup_dir);
    validate_backup_dir(&source)?;
    if paths.restore_pending.exists() {
        fs::remove_dir_all(&paths.restore_pending)
            .map_err(|error| format!("Cannot replace a previous pending restore: {error}"))?;
    }
    copy_dir_whitelisted(&source, &paths.restore_pending)?;
    Ok("Restore is staged and will apply the next time Reade starts.".to_owned())
}

#[tauri::command]
pub fn export_diagnostic_report(
    app: AppHandle,
    library: State<'_, AppState>,
    user: State<'_, UserState>,
    stats: State<'_, StatsState>,
    health: State<'_, DataOpenHealth>,
) -> CommandResult<String> {
    let status = local_data_status(app, library, user, stats, health)?;
    let redacted = serde_json::json!({
        "appVersion": status.app_version,
        "userDbOk": status.user_db_ok,
        "statsDbOk": status.stats_db_ok,
        "userSchemaVersion": status.user_schema_version,
        "cacheBytes": status.cache_bytes,
        "failedIndexCount": status.failed_index_count,
        "lastBackupAtMs": status.last_backup_at_ms,
        "pendingBoundSessions": status.pending_bound_sessions,
        "restorePending": status.restore_pending,
        "userOpenError": status.user_open_error,
        "statsOpenError": status.stats_open_error,
    });
    serde_json::to_string_pretty(&redacted)
        .map_err(|error| format!("Cannot encode diagnostic report: {error}"))
}

fn copy_dir_whitelisted(source: &Path, dest: &Path) -> CommandResult<()> {
    fs::create_dir_all(dest).map_err(|error| format!("Cannot create restore-pending: {error}"))?;
    for name in ALLOWED_BACKUP_FILES {
        let from = source.join(name);
        if from.exists() {
            fs::copy(&from, dest.join(name))
                .map_err(|error| format!("Cannot stage {name}: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        apply_pending_restore, validate_backup_dir, write_backup, BACKUP_FORMAT, MANIFEST_FILE,
        STATS_DB_FILE, USER_DB_FILE,
    };
    use crate::stats::StatsState;
    use crate::user_store::UserState;
    use rusqlite::Connection;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn backup_round_trip_restore_replaces_live_files() {
        let dir = tempdir().expect("temp");
        let data = dir.path().join("data");
        let cache = dir.path().join("cache");
        fs::create_dir_all(&data).expect("data");
        fs::create_dir_all(&cache).expect("cache");
        let user = UserState::new(data.clone(), cache.clone()).expect("user");
        let stats = StatsState::new(data.clone()).expect("stats");
        let backup = dir.path().join("backup");
        write_backup(&backup, &user, &stats, r#"{"theme":"paper-light"}"#).expect("backup");
        validate_backup_dir(&backup).expect("valid");
        drop(user);
        drop(stats);

        let pending = data.join("restore-pending");
        fs::create_dir_all(&pending).expect("pending");
        fs::copy(backup.join(USER_DB_FILE), pending.join(USER_DB_FILE)).expect("user copy");
        fs::copy(backup.join(STATS_DB_FILE), pending.join(STATS_DB_FILE)).expect("stats copy");
        fs::copy(backup.join(MANIFEST_FILE), pending.join(MANIFEST_FILE)).expect("manifest copy");
        apply_pending_restore(&data).expect("apply");
        assert!(!pending.exists());
        assert!(data.join(USER_DB_FILE).exists());
        assert!(data.join(STATS_DB_FILE).exists());
        let rollback = fs::read_dir(&data).expect("list").flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("rollback-before-restore-")
        });
        assert!(rollback);
    }

    #[test]
    fn validate_backup_dir_rejects_escape_and_unknown_files() {
        let dir = tempdir().expect("temp");
        fs::write(dir.path().join("evil.txt"), b"nope").expect("extra");
        let error = validate_backup_dir(dir.path()).expect_err("extra file");
        assert!(error.contains("unexpected file"));
    }

    #[test]
    fn validate_backup_dir_rejects_unsupported_format() {
        let dir = tempdir().expect("temp");
        fs::write(
            dir.path().join(MANIFEST_FILE),
            serde_json::to_vec(&serde_json::json!({
                "format": BACKUP_FORMAT + 1,
                "appVersion": "0",
                "createdAtMs": 1,
                "includes": [],
                "checksums": []
            }))
            .expect("json"),
        )
        .expect("manifest");
        fs::write(dir.path().join(USER_DB_FILE), b"").expect("user");
        let error = validate_backup_dir(dir.path()).expect_err("format");
        assert!(error.contains("Unsupported backup format"));
    }

    #[test]
    fn empty_sqlite_files_are_not_treated_as_valid_backups() {
        let dir = tempdir().expect("temp");
        Connection::open(dir.path().join(USER_DB_FILE))
            .expect("user")
            .execute_batch("PRAGMA user_version = 1;")
            .expect("user init");
        // stats missing
        fs::write(
            dir.path().join(MANIFEST_FILE),
            serde_json::to_vec(&serde_json::json!({
                "format": BACKUP_FORMAT,
                "appVersion": "0",
                "createdAtMs": 1,
                "includes": [],
                "checksums": []
            }))
            .expect("json"),
        )
        .expect("manifest");
        let error = validate_backup_dir(dir.path()).expect_err("missing stats");
        assert!(error.contains("missing"));
    }

    fn json_fixture(name: &str) -> serde_json::Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/lib/ipc-fixtures")
            .join(name);
        serde_json::from_slice(&std::fs::read(path).expect("fixture")).expect("json")
    }

    #[test]
    fn local_data_status_dtos_match_shared_fixtures() {
        use super::{LocalBackupResult, LocalDataStatus};
        let healthy = LocalDataStatus {
            app_version: "0.2.0".into(),
            user_db_path: "C:/Users/测试/AppData/Roaming/reade/reade-user.sqlite3".into(),
            stats_db_path: "C:/Users/测试/AppData/Roaming/reade/reade-stats.sqlite3".into(),
            cache_db_path: "C:/Users/测试/AppData/Local/reade/reade-cache.sqlite3".into(),
            user_db_ok: true,
            stats_db_ok: true,
            user_schema_version: Some(7),
            cache_bytes: 141000000,
            failed_index_count: 0,
            last_backup_at_ms: Some(1_725_600_000_000),
            last_backup_path: Some(
                "C:/Users/测试/AppData/Roaming/reade/backups/reade-backup-1725600000000".into(),
            ),
            pending_bound_sessions: 2,
            restore_pending: false,
            user_open_error: None,
            stats_open_error: None,
        };
        assert_eq!(
            serde_json::to_value(&healthy).expect("serialize"),
            json_fixture("local-data-status.json")
        );
        let decoded: LocalDataStatus =
            serde_json::from_value(json_fixture("local-data-status.json")).expect("decode");
        assert_eq!(decoded, healthy);

        let degraded = LocalDataStatus {
            user_db_ok: false,
            user_schema_version: None,
            cache_bytes: 0,
            last_backup_at_ms: None,
            last_backup_path: None,
            pending_bound_sessions: 0,
            user_open_error: Some("Cannot open user database: locked by another process".into()),
            ..healthy.clone()
        };
        assert_eq!(
            serde_json::to_value(&degraded).expect("serialize"),
            json_fixture("local-data-status-degraded.json")
        );
        let backup = LocalBackupResult {
            backup_path: "C:/Users/测试/AppData/Roaming/reade/backups/reade-backup-1725600000000"
                .into(),
            created_at_ms: 1_725_600_000_000,
        };
        assert_eq!(
            serde_json::to_value(&backup).expect("serialize"),
            json_fixture("local-backup-result.json")
        );
    }
}
