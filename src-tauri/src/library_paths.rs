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

pub(crate) fn normalize_root(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::{normalize_relative_path, normalize_root, validate_relative_library_path};
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
}
