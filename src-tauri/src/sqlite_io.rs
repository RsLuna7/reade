use std::path::Path;

use rusqlite::Connection;

use crate::library::CommandResult;

pub(crate) fn quote_sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Consistent snapshot of a live SQLite connection, including committed WAL.
pub(crate) fn vacuum_into(connection: &Connection, dest: &Path) -> CommandResult<()> {
    if dest.exists() {
        std::fs::remove_file(dest)
            .map_err(|error| format!("Cannot replace snapshot file: {error}"))?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create snapshot directory: {error}"))?;
    }
    let quoted = quote_sql_string(&dest.to_string_lossy());
    connection
        .execute_batch(&format!("VACUUM INTO {quoted}"))
        .map_err(|error| format!("Cannot snapshot database: {error}"))
}

pub(crate) fn integrity_ok(connection: &Connection) -> CommandResult<bool> {
    let result: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("Cannot check database integrity: {error}"))?;
    Ok(result.eq_ignore_ascii_case("ok"))
}

pub(crate) fn user_version(connection: &Connection) -> CommandResult<i64> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("Cannot read schema version: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{integrity_ok, vacuum_into};
    use rusqlite::Connection;
    use tempfile::tempdir;

    #[test]
    fn vacuum_into_copies_rows_and_passes_integrity() {
        let dir = tempdir().expect("temp");
        let source_path = dir.path().join("source.sqlite3");
        let dest_path = dir.path().join("dest.sqlite3");
        let source = Connection::open(&source_path).expect("source");
        source
            .execute_batch("CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (7);")
            .expect("seed");
        vacuum_into(&source, &dest_path).expect("snapshot");
        let dest = Connection::open(&dest_path).expect("dest");
        let count: i64 = dest
            .query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 1);
        assert!(integrity_ok(&dest).expect("integrity"));
    }
}
