//! Pure link extraction for the read-only backlinks feature
//! (`docs/plan-backlinks.md`). No IO: markdown text goes in, extracted
//! library links come out; storage and queries live in `library.rs`.
//!
//! `resolve_library_path` is a line-by-line port of `resolveLibraryPath`
//! in `src/lib/documentLinks.ts` (itself moved verbatim out of
//! `src/App.tsx`). The numbered contract cases L01.. in
//! `src/lib/documentLinks.test.ts` are mirrored by the tests below; any
//! semantic change must update both ends together (plan §7: extraction
//! drift is the top risk).
//!
//! Deliberately unsupported CommonMark forms (fixed by the contract
//! table, losing an edge never loses safety): reference-style links,
//! autolinks, `<>`-wrapped destinations, nested brackets/parentheses and
//! links spanning multiple source lines.

/// Hard cap per document, so a hand-crafted link bomb cannot bloat the
/// cache or slow indexing (plan §3.1).
pub(crate) const MAX_DOCUMENT_LINKS: usize = 1_000;
const MAX_LINK_TEXT_CHARS: usize = 200;
/// Extensions the scanner discovers as documents (`DocumentFormat` plus
/// `.markdown`); everything else is a library asset.
const DOCUMENT_EXTENSIONS: &[&str] = &["md", "markdown", "mdx", "pdf", "epub"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinkTargetKind {
    Document,
    Asset,
}

impl LinkTargetKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Asset => "asset",
        }
    }
}

/// One extracted library link. Out-of-library targets (`..` escapes,
/// absolute protocols, `//` prefixes, empty paths) are dropped at
/// extraction time and never stored, matching the frontend's "blocked"
/// navigation semantics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ExtractedLink {
    /// Standard `[text](target)` / `![alt](target)` with a resolved
    /// library-relative target path.
    Relative {
        target_path: String,
        target_kind: LinkTargetKind,
        link_text: String,
        fragment: Option<String>,
    },
    /// `[[wiki]]` link: only the normalized stem is stored; resolution
    /// against the live document set happens at query time (BL-D1).
    Wiki {
        stem: String,
        link_text: String,
        fragment: Option<String>,
    },
}

/// `decodeURIComponent` twin including the "invalid input returns the
/// original string" fallback of the frontend `decodePath`.
fn decode_path(value: &str) -> String {
    percent_decode(value).unwrap_or_else(|| value.to_owned())
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_digit(*bytes.get(index + 1)?)?;
            let low = hex_digit(*bytes.get(index + 2)?)?;
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|value| value as u8)
}

/// `/^[a-z][a-z\d+.-]*:/i` without pulling in a regex: an ASCII letter
/// followed by letters/digits/`+`/`.`/`-` up to a `:`.
fn has_absolute_protocol(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    for ch in chars {
        if ch == ':' {
            return true;
        }
        if !(ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-')) {
            return false;
        }
    }
    false
}

/// Rust twin of `resolveLibraryPath(source, documentPath)`:
/// strip `?`/`#` → percent-decode (fall back to the raw text) → trim →
/// `\` → `/` → reject empty / `//` prefixes / absolute protocols →
/// resolve against the document directory (or the library root for a
/// leading `/`), where `.` is skipped and `..` pops — popping past the
/// root means the target escapes the library and resolves to `None`.
pub(crate) fn resolve_library_path(source: &str, document_path: &str) -> Option<String> {
    let raw = source.split(['?', '#']).next().unwrap_or("");
    let decoded = decode_path(raw);
    let path_only = decoded.trim().replace('\\', "/");
    if path_only.is_empty() || path_only.starts_with("//") || has_absolute_protocol(&path_only) {
        return None;
    }

    let mut base: Vec<String> = if path_only.starts_with('/') {
        Vec::new()
    } else {
        let mut segments: Vec<String> = document_path
            .replace('\\', "/")
            .split('/')
            .map(str::to_owned)
            .collect();
        segments.pop();
        segments
    };

    for segment in path_only.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            if base.is_empty() {
                return None;
            }
            base.pop();
        } else {
            base.push(segment.to_owned());
        }
    }

    Some(base.join("/"))
}

/// Lowercased file-name stem (`notes/Note A.md` → `note a`): the BL-D1
/// lookup key for wiki stems without a `/`.
pub(crate) fn wiki_file_stem(path: &str) -> String {
    strip_extension(path.rsplit('/').next().unwrap_or(path)).to_lowercase()
}

/// Lowercased extension-less full path (`notes/Note A.md` →
/// `notes/note a`): the lookup key for wiki stems containing a `/`.
pub(crate) fn wiki_path_stem(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((directory, name)) => format!("{directory}/{}", strip_extension(name)).to_lowercase(),
        None => strip_extension(path).to_lowercase(),
    }
}

/// Cuts the extension off a file name; a leading dot is part of the name
/// (mirrors `Path::file_stem`).
fn strip_extension(name: &str) -> &str {
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    }
}

fn has_document_extension(path: &str) -> bool {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let Some(dot) = file_name.rfind('.') else {
        return false;
    };
    if dot == 0 {
        return false;
    }
    let extension = file_name[dot + 1..].to_ascii_lowercase();
    DOCUMENT_EXTENSIONS.contains(&extension.as_str())
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// Extracts library links from one markdown document. Fenced code blocks
/// (``` / ~~~, the same flip logic as `extract_title`) and inline code
/// spans are skipped; the output is capped at [`MAX_DOCUMENT_LINKS`].
pub(crate) fn extract_document_links(source_path: &str, markdown: &str) -> Vec<ExtractedLink> {
    let mut links = Vec::new();
    let mut in_fence = false;
    for line in markdown.split('\n') {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        extract_line_links(source_path, line, &mut links);
        if links.len() >= MAX_DOCUMENT_LINKS {
            break;
        }
    }
    links.truncate(MAX_DOCUMENT_LINKS);
    links
}

fn extract_line_links(source_path: &str, line: &str, links: &mut Vec<ExtractedLink>) {
    let mut chars: Vec<char> = line.chars().collect();
    mask_code_spans(&mut chars);
    let length = chars.len();
    let mut position = 0;
    while position < length && links.len() < MAX_DOCUMENT_LINKS {
        if chars[position] != '[' {
            position += 1;
            continue;
        }
        let scan = if position + 1 < length && chars[position + 1] == '[' {
            scan_wiki(&chars, position)
        } else {
            scan_inline(source_path, &chars, position)
        };
        match scan {
            LinkScan::NotALink => position += 1,
            LinkScan::Skip(next) => position = next,
            LinkScan::Link(link, next) => {
                links.push(link);
                position = next;
            }
        }
    }
}

/// Blanks inline code spans in place: a backtick run closes at the next
/// run of the same length (CommonMark's core rule); unmatched runs stay
/// literal. Blanking preserves indices so link positions are unaffected.
fn mask_code_spans(chars: &mut [char]) {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '`' {
            let start = index;
            while index < chars.len() && chars[index] == '`' {
                index += 1;
            }
            runs.push((start, index - start));
        } else {
            index += 1;
        }
    }
    let mut run_index = 0;
    while run_index < runs.len() {
        let (start, length) = runs[run_index];
        let closing = runs[run_index + 1..]
            .iter()
            .position(|&(_, candidate)| candidate == length);
        match closing {
            Some(offset) => {
                let (close_start, close_length) = runs[run_index + 1 + offset];
                for slot in chars[start..close_start + close_length].iter_mut() {
                    *slot = ' ';
                }
                run_index += offset + 2;
            }
            None => run_index += 1,
        }
    }
}

enum LinkScan {
    /// Not link syntax at all: advance one character and keep scanning.
    NotALink,
    /// Consumed as syntax but yielded no library link (dropped target).
    Skip(usize),
    Link(ExtractedLink, usize),
}

fn scan_wiki(chars: &[char], open: usize) -> LinkScan {
    let length = chars.len();
    let mut cursor = open + 2;
    let mut close = None;
    while cursor + 1 < length {
        if chars[cursor] == ']' && chars[cursor + 1] == ']' {
            close = Some(cursor);
            break;
        }
        cursor += 1;
    }
    let Some(close) = close else {
        return LinkScan::NotALink;
    };
    let inner: String = chars[open + 2..close].iter().collect();
    if inner.contains('[') || inner.contains(']') {
        return LinkScan::Skip(open + 2);
    }
    let next = close + 2;
    let (target_part, alias_part) = match inner.find('|') {
        Some(pipe) => (&inner[..pipe], Some(&inner[pipe + 1..])),
        None => (inner.as_str(), None),
    };
    let (stem_raw, fragment_raw) = match target_part.find('#') {
        Some(hash) => (&target_part[..hash], Some(&target_part[hash + 1..])),
        None => (target_part, None),
    };
    let stem = stem_raw.trim().replace('\\', "/").to_lowercase();
    if stem.is_empty() {
        return LinkScan::Skip(next);
    }
    let alias = alias_part.map(str::trim).filter(|value| !value.is_empty());
    let link_text = truncate_chars(
        alias.unwrap_or_else(|| target_part.trim()),
        MAX_LINK_TEXT_CHARS,
    );
    let fragment = fragment_raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    LinkScan::Link(
        ExtractedLink::Wiki {
            stem,
            link_text,
            fragment,
        },
        next,
    )
}

fn scan_inline(source_path: &str, chars: &[char], open: usize) -> LinkScan {
    let length = chars.len();
    let mut text_close = None;
    let mut cursor = open + 1;
    while cursor < length {
        if chars[cursor] == ']' {
            text_close = Some(cursor);
            break;
        }
        cursor += 1;
    }
    let Some(text_close) = text_close else {
        return LinkScan::NotALink;
    };
    if text_close + 1 >= length || chars[text_close + 1] != '(' {
        return LinkScan::NotALink;
    }
    let mut destination_close = None;
    cursor = text_close + 2;
    while cursor < length {
        if chars[cursor] == ')' {
            destination_close = Some(cursor);
            break;
        }
        cursor += 1;
    }
    let Some(destination_close) = destination_close else {
        return LinkScan::NotALink;
    };
    let next = destination_close + 1;
    let raw_destination: String = chars[text_close + 2..destination_close].iter().collect();
    let Some(destination) = split_destination(&raw_destination) else {
        return LinkScan::Skip(next);
    };
    // The fragment mirrors handleNavigate: the text between the first and
    // the second `#`, percent-decoded for display and anchor jumps.
    let fragment = destination.find('#').and_then(|hash| {
        let value = destination[hash + 1..].split('#').next().unwrap_or("");
        if value.is_empty() {
            None
        } else {
            Some(decode_path(value))
        }
    });
    let Some(target_path) = resolve_library_path(&destination, source_path) else {
        return LinkScan::Skip(next);
    };
    if target_path.is_empty() {
        return LinkScan::Skip(next);
    }
    let target_kind = if has_document_extension(&target_path) {
        LinkTargetKind::Document
    } else {
        LinkTargetKind::Asset
    };
    let text: String = chars[open + 1..text_close].iter().collect();
    LinkScan::Link(
        ExtractedLink::Relative {
            target_path,
            target_kind,
            link_text: truncate_chars(text.trim(), MAX_LINK_TEXT_CHARS),
            fragment,
        },
        next,
    )
}

/// Trims the destination and cuts an optional quoted title. A destination
/// with embedded whitespace and no quoted title is not a link (CommonMark
/// requires `<>` for such targets, which the extractor does not support).
fn split_destination(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let Some(space) = trimmed.find(char::is_whitespace) else {
        return Some(trimmed.to_owned());
    };
    let head = &trimmed[..space];
    let rest = trimmed[space..].trim_start();
    if rest.starts_with('"') || rest.starts_with('\'') {
        Some(head.to_owned())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- resolve_library_path: contract cases L01..L15 shared with
    // src/lib/documentLinks.test.ts (both ends must stay in sync). ----

    const DOC: &str = "notes/sub/page.md";

    #[test]
    fn resolves_relative_targets_like_the_frontend() {
        // L01 same directory, explicit `./`
        assert_eq!(
            resolve_library_path("./a.md", DOC).as_deref(),
            Some("notes/sub/a.md")
        );
        // L02 same directory, implicit
        assert_eq!(
            resolve_library_path("a.md", DOC).as_deref(),
            Some("notes/sub/a.md")
        );
        // L03 subdirectory
        assert_eq!(
            resolve_library_path("deeper/b.md", DOC).as_deref(),
            Some("notes/sub/deeper/b.md")
        );
        // L04 one level up
        assert_eq!(
            resolve_library_path("../c.md", DOC).as_deref(),
            Some("notes/c.md")
        );
        // L05 escaping the library root resolves to None
        assert_eq!(resolve_library_path("../../../out.md", DOC), None);
        assert_eq!(resolve_library_path("../out.md", "page.md"), None);
        // L06 leading slash means library root
        assert_eq!(
            resolve_library_path("/notes/a.md", DOC).as_deref(),
            Some("notes/a.md")
        );
        // L07 backslashes in the target and the document path
        assert_eq!(
            resolve_library_path("sub\\d.md", "notes\\sub\\page.md").as_deref(),
            Some("notes/sub/sub/d.md")
        );
        // L15 `.` segments are skipped; a bare `.` resolves to the (empty)
        // directory and is dropped by the extractor
        assert_eq!(
            resolve_library_path("a/./b.md", DOC).as_deref(),
            Some("notes/sub/a/b.md")
        );
        assert_eq!(resolve_library_path(".", "page.md").as_deref(), Some(""));
    }

    #[test]
    fn decodes_percent_encoding_and_falls_back_on_invalid_sequences() {
        // L08 UTF-8 percent-encoding (Chinese file name)
        assert_eq!(
            resolve_library_path("%E4%B8%AD%E6%96%87.md", DOC).as_deref(),
            Some("notes/sub/中文.md")
        );
        // L09 invalid sequences keep the raw text, like decodeURIComponent's
        // try/catch fallback
        assert_eq!(
            resolve_library_path("bad%zz.md", DOC).as_deref(),
            Some("notes/sub/bad%zz.md")
        );
        assert_eq!(
            resolve_library_path("bad%e4.md", DOC).as_deref(),
            Some("notes/sub/bad%e4.md")
        );
    }

    #[test]
    fn strips_query_and_fragment_before_resolving() {
        // L10 query string
        assert_eq!(
            resolve_library_path("a.md?x=1", DOC).as_deref(),
            Some("notes/sub/a.md")
        );
        // L11 fragment
        assert_eq!(
            resolve_library_path("a.md#sec", DOC).as_deref(),
            Some("notes/sub/a.md")
        );
    }

    #[test]
    fn rejects_protocol_relative_and_absolute_protocols() {
        // L12 protocol-relative URLs
        assert_eq!(resolve_library_path("//host/x.md", DOC), None);
        assert_eq!(resolve_library_path("\\\\host\\x.md", DOC), None);
        // L13 absolute protocols
        for source in [
            "https://example.com/a.md",
            "HTTPS://example.com/a.md",
            "mailto:x@y.example",
            "file:///c:/x.md",
            "data:text/plain,hi",
        ] {
            assert_eq!(resolve_library_path(source, DOC), None, "{source}");
        }
        // L14 empty targets and pure anchors
        assert_eq!(resolve_library_path("", DOC), None);
        assert_eq!(resolve_library_path("   ", DOC), None);
        assert_eq!(resolve_library_path("#sec", DOC), None);
        assert_eq!(resolve_library_path("?query", DOC), None);
    }

    // ---- extract_document_links: contract cases L16..L24. ----

    fn relative(
        target: &str,
        kind: LinkTargetKind,
        text: &str,
        fragment: Option<&str>,
    ) -> ExtractedLink {
        ExtractedLink::Relative {
            target_path: target.to_owned(),
            target_kind: kind,
            link_text: text.to_owned(),
            fragment: fragment.map(str::to_owned),
        }
    }

    #[test]
    fn extracts_standard_links_images_and_wiki_links_in_order() {
        let markdown = "\
# Title

Read [the guide](./guide.md '快速上手') and [spec](../spec/rules.pdf).
![diagram](assets/flow.png) plus [[Wiki Note#设计|别名]] and [[Concepts/Deep Idea]].
External [site](https://example.com) is skipped, so is [broken](../../../nope.md).
Anchor [here](#local) too, and [empty]().";
        let links = extract_document_links("notes/sub/page.md", markdown);
        assert_eq!(
            links,
            vec![
                relative(
                    "notes/sub/guide.md",
                    LinkTargetKind::Document,
                    "the guide",
                    None
                ),
                relative(
                    "notes/spec/rules.pdf",
                    LinkTargetKind::Document,
                    "spec",
                    None
                ),
                // L18 image targets keep their extension-derived kind
                relative(
                    "notes/sub/assets/flow.png",
                    LinkTargetKind::Asset,
                    "diagram",
                    None
                ),
                // L19/L20 wiki alias + anchor split
                ExtractedLink::Wiki {
                    stem: "wiki note".to_owned(),
                    link_text: "别名".to_owned(),
                    fragment: Some("设计".to_owned()),
                },
                // L21 path-form wiki stem
                ExtractedLink::Wiki {
                    stem: "concepts/deep idea".to_owned(),
                    link_text: "Concepts/Deep Idea".to_owned(),
                    fragment: None,
                },
            ]
        );
    }

    #[test]
    fn keeps_the_fragment_of_resolved_targets() {
        // L11 fragment split follows handleNavigate: first `#` up to the
        // second, percent-decoded.
        let links = extract_document_links("page.md", "[a](notes/a.md#%E7%AB%A0%E8%8A%82)");
        assert_eq!(
            links,
            vec![relative(
                "notes/a.md",
                LinkTargetKind::Document,
                "a",
                Some("章节")
            )]
        );
        let trailing = extract_document_links("page.md", "[a](notes/a.md#)");
        assert_eq!(
            trailing,
            vec![relative("notes/a.md", LinkTargetKind::Document, "a", None)]
        );
    }

    #[test]
    fn skips_fenced_code_blocks_and_inline_code_spans() {
        // L16 fenced blocks
        let fenced = "```md\n[hidden](a.md)\n```\n[visible](b.md)\n~~~\n[also hidden](c.md)\n~~~\n";
        let links = extract_document_links("page.md", fenced);
        assert_eq!(
            links,
            vec![relative("b.md", LinkTargetKind::Document, "visible", None)]
        );
        // L17 inline code spans, including double-backtick spans
        let inline = "`[a](x.md)` stays code, ``[b](y.md)`` too, [c](z.md) does not.";
        let links = extract_document_links("page.md", inline);
        assert_eq!(
            links,
            vec![relative("z.md", LinkTargetKind::Document, "c", None)]
        );
        // An unmatched backtick run stays literal and links after it parse.
        let unmatched = "` lone backtick [d](w.md)";
        let links = extract_document_links("page.md", unmatched);
        assert_eq!(
            links,
            vec![relative("w.md", LinkTargetKind::Document, "d", None)]
        );
    }

    #[test]
    fn supports_quoted_titles_and_rejects_unquoted_spaces() {
        let titled = extract_document_links("page.md", "[a](x.md \"标题\") [b](y.md '单引号')");
        assert_eq!(
            titled,
            vec![
                relative("x.md", LinkTargetKind::Document, "a", None),
                relative("y.md", LinkTargetKind::Document, "b", None),
            ]
        );
        // A space inside an unwrapped destination is not a link target.
        assert!(extract_document_links("page.md", "[a](two words.md)").is_empty());
    }

    #[test]
    fn truncates_link_text_and_caps_the_link_count() {
        // L22 link text is capped at 200 characters
        let long_text = "字".repeat(300);
        let markdown = format!("[{long_text}](a.md)");
        let links = extract_document_links("page.md", &markdown);
        match &links[0] {
            ExtractedLink::Relative { link_text, .. } => {
                assert_eq!(link_text.chars().count(), 200);
            }
            other => panic!("unexpected link {other:?}"),
        }
        // L23 the 1,001st link is dropped
        let mut bomb = String::new();
        for index in 0..1_001 {
            bomb.push_str(&format!("[t](file-{index}.md)\n"));
        }
        assert_eq!(
            extract_document_links("page.md", &bomb).len(),
            MAX_DOCUMENT_LINKS
        );
    }

    #[test]
    fn classifies_document_extensions_case_insensitively() {
        // L24 md/markdown/mdx/pdf/epub are documents, everything else assets
        let markdown =
            "[a](a.MD) [b](b.markdown) [c](c.mdx) [d](d.PDF) [e](e.epub) [f](f.png) [g](g.txt)";
        let kinds: Vec<LinkTargetKind> = extract_document_links("page.md", markdown)
            .into_iter()
            .map(|link| match link {
                ExtractedLink::Relative { target_kind, .. } => target_kind,
                other => panic!("unexpected link {other:?}"),
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                LinkTargetKind::Document,
                LinkTargetKind::Document,
                LinkTargetKind::Document,
                LinkTargetKind::Document,
                LinkTargetKind::Document,
                LinkTargetKind::Asset,
                LinkTargetKind::Asset,
            ]
        );
    }

    #[test]
    fn drops_empty_and_bracketed_wiki_stems() {
        assert!(extract_document_links("page.md", "[[]] [[   ]] [[#only-anchor]]").is_empty());
        assert!(extract_document_links("page.md", "[[bad[stem]]]").is_empty());
        // Backslash stems normalize to forward slashes.
        let links = extract_document_links("page.md", "[[Dir\\Sub Note]]");
        assert_eq!(
            links,
            vec![ExtractedLink::Wiki {
                stem: "dir/sub note".to_owned(),
                link_text: "Dir\\Sub Note".to_owned(),
                fragment: None,
            }]
        );
    }

    #[test]
    fn wiki_stem_helpers_match_the_lookup_contract() {
        assert_eq!(wiki_file_stem("notes/Note A.md"), "note a");
        assert_eq!(wiki_file_stem("README.md"), "readme");
        assert_eq!(wiki_file_stem("archive/v1.2/Plan.mdx"), "plan");
        assert_eq!(wiki_path_stem("notes/Note A.md"), "notes/note a");
        assert_eq!(wiki_path_stem("Plan.md"), "plan");
        assert_eq!(wiki_path_stem("a/b.c/Note.pdf"), "a/b.c/note");
    }
}
