/**
 * The single definition of "same library" for persisted state.
 *
 * Every localStorage envelope groups entries by library root, so the grouping
 * key must not depend on how the path was spelled at open time. The same
 * physical library reaches the frontend as several strings: the folder
 * picker's raw `D:\books`, a Rust `rootKey` normalized to forward slashes
 * (`library_paths::normalize_root`), and `std::fs::canonicalize` output that
 * carries a `\\?\` verbatim prefix. Keying on the raw string fragments one
 * library into several buckets, so reading-position memory, vertical-writing
 * flags, PDF pins and calibration, and the home baseline silently reset
 * depending on which path opened the library.
 *
 * This module is intentionally dependency-free: every store imports it, and
 * it imports nothing, so the key rule cannot drift per module again.
 */

/**
 * Drop the Windows extended-length / device prefix that
 * `std::fs::canonicalize` stamps onto canonical paths:
 * `\\?\C:\foo` → `C:\foo`, `//?/unc/server/share` → `//server/share`.
 */
export function stripWindowsVerbatimPrefix(path: string): string {
  const head = path.slice(0, 8).toLowerCase();
  if (head === "//?/unc/" || head === "//./unc/") {
    return `//${path.slice(8)}`;
  }
  const short = path.slice(0, 4);
  if (short === "//?/" || short === "//./") {
    return path.slice(4);
  }
  return path;
}

/**
 * Canonical comparison key for a library root. Case-insensitive, separator-
 * insensitive, trailing-separator-insensitive, and verbatim-prefix-insensitive,
 * so `D:\lib`, `d:/lib/`, and `\\?\D:\lib` collapse onto one key.
 *
 * An all-separator input (such as `\\`) collapses to an empty string after
 * trailing-slash removal; the un-trimmed string is returned instead so distinct
 * degenerate inputs never collide on the empty key.
 */
export function normalizeLibraryKey(path: string): string {
  const canonical = canonicalizeLibraryPath(path);
  // Windows drive roots and UNC roots are case-insensitive. POSIX paths are
  // not: `/home/A` and `/home/a` must remain distinct persisted libraries.
  return /^[A-Za-z]:(?:\/|$)/.test(canonical) || canonical.startsWith("//")
    ? canonical.toLowerCase()
    : canonical;
}

/**
 * Case-preserving counterpart of `normalizeLibraryKey`: same separator, trailing
 * separator, and verbatim-prefix handling, but the original casing is kept for
 * display (for example a source-folder label in stats).
 */
export function canonicalizeLibraryPath(path: string): string {
  // Recognize the verbatim prefix after both `\\?\C:\…` and `//?/C:/…`
  // have been converted to one forward-slash spelling. Keeping that spelling
  // also preserves ordinary POSIX path semantics (`/home/A` stays distinct
  // from `/home/a`) instead of forcing every path through Windows backslashes.
  const unified = stripWindowsVerbatimPrefix(path.trim().replace(/\\/g, "/"));
  const trimmed = unified.replace(/\/+$/, "");
  return trimmed || unified;
}
