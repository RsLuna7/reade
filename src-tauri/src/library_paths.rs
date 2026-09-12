use std::path::{Component, Path, PathBuf};

type CommandResult<T> = Result<T, String>;

pub(crate) fn validate_relative_library_path(relative_path: &str) -> CommandResult<()> {
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
    Ok(())
}

pub(crate) fn canonical_library_root(path: &Path) -> CommandResult<PathBuf> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Cannot open library root: {error}"))?;
    if !canonical.is_dir() {
        return Err("Library root must be a directory".to_owned());
    }
    Ok(canonical)
}

pub(crate) fn resolve_existing_in_root(root: &Path, relative_path: &str) -> CommandResult<PathBuf> {
    validate_relative_library_path(relative_path)?;
    let candidate = root.join(Path::new(relative_path));
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("Cannot resolve library path: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("Resolved path is outside the library root".to_owned());
    }
    Ok(canonical)
}

pub(crate) fn normalize_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Cache and annotation SQLite key: slash-unify only.
///
/// Both write and read go through `canonicalize`, so a Windows `\\?\`
/// prefix is internally consistent. Stripping it here would orphan existing
/// `reade-user.sqlite3` / cache rows. Stats persistence that must match the
/// folder-picker string uses [`normalize_stats_library_root`] instead.
pub(crate) fn normalize_root(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Persistable stats `library_root`: slash-unify and strip Windows verbatim
/// prefixes so the value can be compared with `snapshot.rootPath` (the
/// folder-picker original, which never carries `\\?\` / `\\.\`).
pub(crate) fn normalize_stats_library_root(path: &Path) -> String {
    strip_windows_verbatim_prefix(&normalize_root(path))
}

/// Strip `\\?\` / `\\.\` (including UNC `\\?\UNC\...`) after converting
/// backslashes. Trailing slashes are dropped so picker and canonical forms
/// compare equal. Idempotent.
pub(crate) fn strip_windows_verbatim_prefix(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    let value = if trimmed.is_empty() {
        unified.as_str()
    } else {
        trimmed
    };
    if let Some(head) = value.get(..8) {
        let head = head.to_ascii_lowercase();
        if head == "//?/unc/" || head == "//./unc/" {
            return format!("//{}", &value[8..]);
        }
    }
    if let Some(short) = value.get(..4) {
        if short == "//?/" || short == "//./" {
            return value[4..].to_owned();
        }
    }
    value.to_owned()
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::{
        canonical_library_root, normalize_relative_path, normalize_root,
        normalize_stats_library_root, strip_windows_verbatim_prefix,
        validate_relative_library_path,
    };
    use std::path::Path;

    #[test]
    fn rejects_empty_absolute_and_parent_paths() {
        assert!(validate_relative_library_path("").is_err());
        assert!(validate_relative_library_path("   ").is_err());
        assert!(validate_relative_library_path("/etc/passwd").is_err());
        assert!(validate_relative_library_path("notes/../secret.md").is_err());
        assert!(validate_relative_library_path("notes/guide.md").is_ok());
    }

    #[test]
    fn normalize_relative_path_keeps_normal_segments_with_slashes() {
        assert_eq!(
            normalize_relative_path(Path::new("notes/guide.md")),
            "notes/guide.md"
        );
    }

    #[test]
    fn normalize_root_uses_forward_slashes() {
        assert_eq!(normalize_root(Path::new(r"C:\Books")), "C:/Books");
    }

    #[test]
    fn normalize_root_unifies_windows_separators() {
        assert_eq!(
            normalize_root(Path::new(r"D:\books\papers")),
            "D:/books/papers"
        );
    }

    #[test]
    fn normalize_root_keeps_verbatim_prefix_for_cache_keys() {
        // Cache / user-store keys stay internally consistent with canonicalize.
        assert_eq!(normalize_root(Path::new(r"\\?\D:\books")), "//?/D:/books");
    }

    #[test]
    fn normalize_root_stats_identity_strips_windows_verbatim_prefixes() {
        assert_eq!(
            normalize_stats_library_root(Path::new(r"\\?\D:\books")),
            "D:/books"
        );
        assert_eq!(
            normalize_stats_library_root(Path::new(r"\\.\D:\books")),
            "D:/books"
        );
        assert_eq!(
            normalize_stats_library_root(Path::new(r"\\?\UNC\server\share\lib")),
            "//server/share/lib"
        );
        assert_eq!(strip_windows_verbatim_prefix(r"\\?\D:\books\"), "D:/books");
        assert_eq!(strip_windows_verbatim_prefix("//?/D:/books"), "D:/books");
        assert_eq!(
            strip_windows_verbatim_prefix("//?/UNC/server/share/lib"),
            "//server/share/lib"
        );
        assert_eq!(strip_windows_verbatim_prefix("D:/books"), "D:/books");
    }

    #[test]
    fn normalize_root_stats_identity_strips_real_canonicalize_prefix() {
        let library = tempdir().expect("temp library");
        let canonical = canonical_library_root(library.path()).expect("canonical root");
        let cache_key = normalize_root(&canonical);
        let stats_key = normalize_stats_library_root(&canonical);
        assert!(
            !stats_key.starts_with("//?/") && !stats_key.starts_with("//./"),
            "stats library_root must not keep a verbatim prefix: {stats_key}"
        );
        let display = canonical.to_string_lossy();
        if display.starts_with(r"\\?\") || display.starts_with(r"\\.\") {
            assert!(
                cache_key.starts_with("//?/") || cache_key.starts_with("//./"),
                "cache keys stay internally consistent with canonicalize: {cache_key}"
            );
            assert_eq!(strip_windows_verbatim_prefix(&cache_key), stats_key);
        }
    }
}
