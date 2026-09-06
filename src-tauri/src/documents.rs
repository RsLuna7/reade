use std::collections::HashMap;
use std::io::{Cursor, Read};

use anydoc::model::{
    Block, CellSlot, Document, ImageSource, Inline, LinkTarget, MarkerKind, NoteKind, TableKind,
};
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

pub const MAX_CONVERTIBLE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocumentFormat {
    Markdown,
    Mdx,
    Pdf,
    Epub,
}

impl DocumentFormat {
    pub fn from_path(path: &std::path::Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?;
        if extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown") {
            Some(Self::Markdown)
        } else if extension.eq_ignore_ascii_case("mdx") {
            Some(Self::Mdx)
        } else if extension.eq_ignore_ascii_case("pdf") {
            Some(Self::Pdf)
        } else if extension.eq_ignore_ascii_case("epub") {
            Some(Self::Epub)
        } else {
            None
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Markdown => "markdown",
            Self::Mdx => "mdx",
            Self::Pdf => "pdf",
            Self::Epub => "epub",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IndexStatus {
    Pending,
    Indexing,
    Ready,
    Partial,
    Unsupported,
    Failed,
}

impl IndexStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Indexing => "indexing",
            Self::Ready => "ready",
            Self::Partial => "partial",
            Self::Unsupported => "unsupported",
            Self::Failed => "failed",
        }
    }

    pub fn from_str(value: &str) -> Self {
        match value {
            "indexing" => Self::Indexing,
            "ready" => Self::Ready,
            "partial" => Self::Partial,
            "unsupported" => Self::Unsupported,
            "failed" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPageContent {
    pub page: u32,
    pub markdown: String,
    pub needs_ocr: bool,
    pub ocr_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfReadingMode {
    pub relative_path: String,
    pub status: IndexStatus,
    pub pages: Vec<PdfPageContent>,
    pub missing_pages: Vec<u32>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubDocument {
    pub title: String,
    pub chapters: Vec<EpubChapter>,
    pub assets: Vec<EpubAsset>,
    pub notes: Vec<EpubNote>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapter {
    pub id: String,
    pub title: String,
    /// Outline depth for the right-hand TOC, 1-based. Prefer EPUB nav/ncx nesting
    /// when present; otherwise fall back to the first heading level in the chapter.
    pub level: u8,
    pub blocks: Vec<EpubBlock>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubAsset {
    pub id: usize,
    pub media_type: String,
    pub allowed: bool,
    pub alt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubNote {
    pub id: String,
    pub kind: String,
    pub blocks: Vec<EpubBlock>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EpubBlock {
    Heading {
        level: u8,
        anchor: Option<String>,
        content: Vec<EpubInline>,
    },
    Paragraph {
        content: Vec<EpubInline>,
    },
    List {
        ordered: bool,
        marker: String,
        start: u64,
        items: Vec<EpubListItem>,
    },
    Table {
        header_rows: usize,
        layout: bool,
        rows: Vec<Vec<EpubTableSlot>>,
    },
    BlockQuote {
        blocks: Vec<EpubBlock>,
    },
    CodeBlock {
        language: Option<String>,
        text: String,
    },
    Rule,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubListItem {
    pub blocks: Vec<EpubBlock>,
    pub checked: Option<bool>,
    pub marker_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EpubTableSlot {
    Cell {
        blocks: Vec<EpubBlock>,
        col_span: u32,
        row_span: u32,
    },
    Covered,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EpubInline {
    Text {
        text: String,
        bold: bool,
        italic: bool,
        strike: bool,
        code: bool,
    },
    Link {
        content: Vec<EpubInline>,
        target: EpubLinkTarget,
    },
    Image {
        alt: String,
        source: EpubImageSource,
    },
    Anchor {
        id: String,
    },
    NoteRef {
        id: String,
    },
    LineBreak,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum EpubLinkTarget {
    External(String),
    Relative(String),
    Anchor(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum EpubImageSource {
    Asset(usize),
    ExternalBlocked(String),
    Unavailable,
}

#[derive(Debug)]
pub struct ParsedEpub {
    pub payload: EpubDocument,
    pub asset_bytes: Vec<(String, Vec<u8>)>,
    pub search_segments: Vec<(String, String, String)>,
}

pub fn parse_epub(bytes: &[u8], fallback_title: &str) -> Result<ParsedEpub, String> {
    inspect_epub_container(bytes)?;
    let document =
        anydoc::to_document(bytes, anydoc::Format::Epub).map_err(|error| match error {
            // D08: anydoc 的硬限额（条目数/单条目与总量解压/XML 深度与节点/
            // 资产总额）被触发时给出可识别的稳定文案；预算细节见
            // anydoc::package::limits（不可配置，正常书籍远低于其下限）。
            anydoc::ConvertError::ResourceLimit { limit, detail } => {
                format!("EPUB 超出解析预算（RESOURCE_LIMIT）：{limit} — {detail}")
            }
            other => format!("EPUB 解析失败：{other}"),
        })?;
    let mut parsed = convert_epub_document(document, fallback_title);
    apply_epub_nav_levels(bytes, &mut parsed.payload.chapters);
    Ok(parsed)
}

/// D08: 本包装层自己直接读取的 XML（container.xml/OPF/nav/ncx）的硬上限。
/// anydoc 的限额只保护它内部的读取，这些直读必须自设上限，不能只依赖
/// ZIP 元数据声明。
const MAX_EPUB_XML_BYTES: u64 = 4 * 1024 * 1024;

/// Bounded copy used by the container pre-check: reads at most
/// `MAX_EPUB_XML_BYTES + 1` bytes so an oversized entry is detectable
/// without ever materializing it fully. `missing_error` is returned when
/// the entry does not exist.
fn read_bounded_xml_entry(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    path: &str,
    missing_error: &str,
) -> Result<String, String> {
    let entry = archive
        .by_name(path)
        .map_err(|_| missing_error.to_owned())?;
    let mut bytes = Vec::new();
    entry
        .take(MAX_EPUB_XML_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 EPUB {path}：{error}"))?;
    if bytes.len() as u64 > MAX_EPUB_XML_BYTES {
        return Err(format!(
            "EPUB 超出解析预算（RESOURCE_LIMIT）：{path} 超过单文件 XML 上限（{MAX_EPUB_XML_BYTES} 字节）"
        ));
    }
    String::from_utf8(bytes).map_err(|error| format!("无法解码 EPUB {path}：{error}"))
}

fn inspect_epub_container(bytes: &[u8]) -> Result<(), String> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("EPUB 容器无效：{error}"))?;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("无法检查 EPUB 条目：{error}"))?;
        if entry.encrypted() {
            return Err("暂不支持受保护的 EPUB".to_owned());
        }
    }

    let container = read_bounded_xml_entry(
        &mut archive,
        "META-INF/container.xml",
        "EPUB 缺少 META-INF/container.xml",
    )?;
    let opf_path = attribute_value(&container, "full-path")
        .ok_or_else(|| "EPUB container.xml 未声明 OPF 路径".to_owned())?;
    let opf = read_bounded_xml_entry(&mut archive, &opf_path, "EPUB 缺少 OPF 包描述")?;
    let normalized = opf.to_ascii_lowercase();
    if normalized.contains("rendition:layout") && normalized.contains("pre-paginated") {
        return Err("暂不支持 fixed-layout EPUB".to_owned());
    }

    if let Ok(mut encryption) = archive.by_name("META-INF/encryption.xml") {
        let mut xml = String::new();
        encryption
            .read_to_string(&mut xml)
            .map_err(|error| format!("无法读取 EPUB 加密描述：{error}"))?;
        let algorithms = attribute_values(&xml, "algorithm");
        let font_only = !algorithms.is_empty()
            && algorithms.iter().all(|algorithm| {
                let lower = algorithm.to_ascii_lowercase();
                lower.contains("www.idpf.org/2008/embedding")
                    || lower.contains("ns.adobe.com/pdf/enc#rc")
            });
        if !font_only {
            return Err("暂不支持 DRM EPUB".to_owned());
        }
    }
    Ok(())
}

fn attribute_value(xml: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"{name}\s*=\s*[\"']([^\"']+)[\"']"#);
    let regex = regex::Regex::new(&pattern).ok()?;
    regex
        .captures(xml)
        .and_then(|capture| capture.get(1))
        .map(|value| value.as_str().to_owned())
}

fn attribute_values(xml: &str, name: &str) -> Vec<String> {
    let pattern = format!(r#"(?i){name}\s*=\s*["']([^"']+)["']"#);
    let Ok(regex) = regex::Regex::new(&pattern) else {
        return Vec::new();
    };
    regex
        .captures_iter(xml)
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_owned()))
        .collect()
}

fn convert_epub_document(document: Document, fallback_title: &str) -> ParsedEpub {
    let title = document
        .blocks
        .iter()
        .find_map(|block| match block {
            Block::Heading {
                level: 1, content, ..
            } => non_empty(inlines_plain(content)),
            _ => None,
        })
        .unwrap_or_else(|| fallback_title.to_owned());

    let mut chapters = Vec::new();
    let mut prelude = Vec::new();
    let mut current_id: Option<String> = None;
    let mut current_blocks = Vec::new();
    for block in document.blocks {
        if let Some(id) = chapter_start(&block) {
            if let Some(previous_id) = current_id.replace(id) {
                chapters.push(build_chapter(
                    previous_id,
                    std::mem::take(&mut current_blocks),
                ));
            }
            continue;
        }
        if current_id.is_some() {
            current_blocks.push(block);
        } else {
            prelude.push(block);
        }
    }
    if let Some(id) = current_id {
        chapters.push(build_chapter(id, current_blocks));
    }
    if chapters.is_empty() {
        chapters.push(build_chapter("epub-start".to_owned(), prelude));
    }

    let search_segments = chapters
        .iter()
        .map(|chapter| {
            (
                chapter.id.clone(),
                chapter.title.clone(),
                blocks_plain(&chapter.blocks),
            )
        })
        .collect();

    let assets = document
        .assets
        .iter()
        .map(|asset| EpubAsset {
            id: asset.id.0,
            media_type: asset.media_type.clone(),
            allowed: allowed_epub_asset(&asset.media_type),
            alt: asset.origin_part.clone(),
        })
        .collect();
    let asset_bytes = document
        .assets
        .into_iter()
        .map(|asset| (asset.media_type, asset.bytes))
        .collect();
    let notes = document
        .notes
        .into_iter()
        .map(|note| EpubNote {
            id: note.id,
            kind: match note.kind {
                NoteKind::Footnote => "footnote",
                NoteKind::Endnote => "endnote",
            }
            .to_owned(),
            blocks: note.blocks.iter().map(convert_block).collect(),
        })
        .collect();

    ParsedEpub {
        payload: EpubDocument {
            title,
            chapters,
            assets,
            notes,
        },
        asset_bytes,
        search_segments,
    }
}

fn chapter_start(block: &Block) -> Option<String> {
    match block {
        Block::Paragraph(inlines) if inlines.len() == 1 => match &inlines[0] {
            Inline::Anchor(id) => Some(id.clone()),
            _ => None,
        },
        _ => None,
    }
}

fn build_chapter(id: String, blocks: Vec<Block>) -> EpubChapter {
    let (title, level) = blocks
        .iter()
        .find_map(|block| match block {
            Block::Heading { level, content, .. } => {
                non_empty(inlines_plain(content)).map(|title| (title, (*level).clamp(1, 6)))
            }
            _ => None,
        })
        .unwrap_or_else(|| (chapter_fallback_title(&id), 1));
    EpubChapter {
        id,
        title,
        level,
        blocks: blocks.iter().map(convert_block).collect(),
    }
}

fn chapter_fallback_title(id: &str) -> String {
    let path = id.split('#').next().unwrap_or(id);
    let file = path.rsplit('/').next().unwrap_or(path);
    file.rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file)
        .to_owned()
}

fn apply_epub_nav_levels(bytes: &[u8], chapters: &mut [EpubChapter]) {
    let Some(levels) = read_epub_nav_levels(bytes) else {
        return;
    };
    if levels.is_empty() {
        return;
    }
    for chapter in chapters {
        let chapter_path = chapter.id.split('#').next().unwrap_or(&chapter.id);
        if let Some(level) = lookup_nav_level(&levels, chapter_path) {
            chapter.level = level;
        }
    }
}

fn lookup_nav_level(levels: &HashMap<String, u8>, chapter_path: &str) -> Option<u8> {
    if let Some(level) = levels.get(chapter_path) {
        return Some(*level);
    }
    levels.iter().find_map(|(path, level)| {
        if path.eq_ignore_ascii_case(chapter_path)
            || path.ends_with(chapter_path)
            || chapter_path.ends_with(path.as_str())
        {
            Some(*level)
        } else {
            None
        }
    })
}

fn read_epub_nav_levels(bytes: &[u8]) -> Option<HashMap<String, u8>> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).ok()?;
    let container = read_zip_entry(&mut archive, "META-INF/container.xml")?;
    let opf_path = attribute_value(&container, "full-path")?;
    let opf = read_zip_entry(&mut archive, &opf_path)?;
    let opf_dir = opf_path
        .rsplit_once('/')
        .map(|(dir, _)| dir.to_owned())
        .unwrap_or_default();

    let mut nav_href: Option<String> = None;
    let mut ncx_href: Option<String> = None;
    for capture in regex::Regex::new(r#"(?is)<item\b[^>]*>"#)
        .ok()?
        .captures_iter(&opf)
    {
        let tag = capture.get(0)?.as_str();
        let href = attribute_value(tag, "href");
        let media = attribute_value(tag, "media-type")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let properties = attribute_value(tag, "properties").unwrap_or_default();
        let Some(href) = href else { continue };
        if properties
            .split_whitespace()
            .any(|property| property.eq_ignore_ascii_case("nav"))
        {
            nav_href = Some(href);
        } else if media == "application/x-dtbncx+xml" {
            ncx_href = Some(href);
        }
    }

    if let Some(href) = nav_href {
        let nav_path = join_epub_path(&opf_dir, &href);
        if let Some(nav) = read_zip_entry(&mut archive, &nav_path) {
            let levels = parse_epub3_nav_levels(&nav, &nav_path);
            if !levels.is_empty() {
                return Some(levels);
            }
        }
    }
    if let Some(href) = ncx_href {
        let ncx_path = join_epub_path(&opf_dir, &href);
        if let Some(ncx) = read_zip_entry(&mut archive, &ncx_path) {
            let levels = parse_epub2_ncx_levels(&ncx, &ncx_path);
            if !levels.is_empty() {
                return Some(levels);
            }
        }
    }
    None
}

fn read_zip_entry(archive: &mut ZipArchive<Cursor<&[u8]>>, path: &str) -> Option<String> {
    let mut entry = archive.by_name(path).ok()?;
    // D08：nav/ncx 是可选元数据，同样按 XML 上限有界读取；超限时视为
    // 不存在（优雅降级到无层级目录），绝不完整解压超大条目。
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let read = entry.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > MAX_EPUB_XML_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8(bytes).ok()
}

fn join_epub_path(base_dir: &str, href: &str) -> String {
    let href = href.split(['#', '?']).next().unwrap_or(href);
    if href.starts_with('/') {
        return href.trim_start_matches('/').replace('\\', "/");
    }
    let mut parts = Vec::new();
    if !base_dir.is_empty() {
        parts.extend(
            base_dir
                .replace('\\', "/")
                .split('/')
                .filter(|part| !part.is_empty())
                .map(str::to_owned),
        );
    }
    for part in href.replace('\\', "/").split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_owned()),
        }
    }
    parts.join("/")
}

fn parse_epub3_nav_levels(nav: &str, nav_path: &str) -> HashMap<String, u8> {
    let toc = extract_epub_toc_nav(nav).unwrap_or(nav);
    let mut levels = HashMap::new();
    let mut depth = 0u8;
    let tag_regex = regex::Regex::new(r"(?is)</?ol\b[^>]*>|<a\b[^>]*>").expect("nav tag regex");
    for capture in tag_regex.captures_iter(toc) {
        let tag = capture
            .get(0)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with("<ol") {
            depth = depth.saturating_add(1).min(6);
        } else if lower.starts_with("</ol") {
            depth = depth.saturating_sub(1);
        } else if let Some(href) = attribute_value(tag, "href") {
            if depth == 0 {
                continue;
            }
            let path = join_epub_path(
                nav_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or(""),
                &href,
            );
            levels
                .entry(path)
                .and_modify(|current: &mut u8| *current = (*current).min(depth))
                .or_insert(depth);
        }
    }
    levels
}

fn extract_epub_toc_nav(nav: &str) -> Option<&str> {
    let lower = nav.to_ascii_lowercase();
    let markers = [
        "epub:type=\"toc\"",
        "epub:type='toc'",
        "role=\"doc-toc\"",
        "role='doc-toc'",
    ];
    let start = markers.iter().find_map(|marker| lower.find(marker))?;
    let nav_start = lower[..start].rfind("<nav")?;
    let after = &nav[nav_start..];
    let after_lower = after.to_ascii_lowercase();
    let end = after_lower.find("</nav>")? + "</nav>".len();
    Some(&after[..end])
}

fn parse_epub2_ncx_levels(ncx: &str, ncx_path: &str) -> HashMap<String, u8> {
    let mut levels = HashMap::new();
    let mut depth = 0u8;
    let tag_regex =
        regex::Regex::new(r"(?is)</?navpoint\b[^>]*>|<content\b[^>]*>").expect("ncx tag regex");
    for capture in tag_regex.captures_iter(ncx) {
        let tag = capture
            .get(0)
            .map(|value| value.as_str())
            .unwrap_or_default();
        let lower = tag.to_ascii_lowercase();
        if lower.starts_with("<navpoint") {
            depth = depth.saturating_add(1).min(6);
        } else if lower.starts_with("</navpoint") {
            depth = depth.saturating_sub(1);
        } else if let Some(src) = attribute_value(tag, "src") {
            if depth == 0 {
                continue;
            }
            let path = join_epub_path(
                ncx_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or(""),
                &src,
            );
            levels
                .entry(path)
                .and_modify(|current: &mut u8| *current = (*current).min(depth))
                .or_insert(depth);
        }
    }
    levels
}

fn convert_block(block: &Block) -> EpubBlock {
    match block {
        Block::Heading {
            level,
            anchor,
            content,
        } => EpubBlock::Heading {
            level: *level,
            anchor: anchor.clone(),
            content: content.iter().map(convert_inline).collect(),
        },
        Block::Paragraph(content) => EpubBlock::Paragraph {
            content: content.iter().map(convert_inline).collect(),
        },
        Block::List(list) => EpubBlock::List {
            ordered: list.ordered(),
            marker: match list.marker {
                MarkerKind::Bullet => "bullet",
                MarkerKind::Decimal => "decimal",
                MarkerKind::LowerAlpha => "lowerAlpha",
                MarkerKind::UpperAlpha => "upperAlpha",
                MarkerKind::LowerRoman => "lowerRoman",
                MarkerKind::UpperRoman => "upperRoman",
            }
            .to_owned(),
            start: list.start,
            items: list
                .items
                .iter()
                .map(|item| EpubListItem {
                    blocks: item.blocks.iter().map(convert_block).collect(),
                    checked: item.checked,
                    marker_label: item.marker_label.clone(),
                })
                .collect(),
        },
        Block::Table(table) => EpubBlock::Table {
            header_rows: table.header_rows,
            layout: matches!(table.kind, TableKind::Layout),
            rows: table
                .grid
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|slot| match slot {
                            CellSlot::Origin(cell) => EpubTableSlot::Cell {
                                blocks: cell.blocks.iter().map(convert_block).collect(),
                                col_span: cell.col_span,
                                row_span: cell.row_span,
                            },
                            CellSlot::Covered { .. } => EpubTableSlot::Covered,
                        })
                        .collect()
                })
                .collect(),
        },
        Block::BlockQuote(blocks) => EpubBlock::BlockQuote {
            blocks: blocks.iter().map(convert_block).collect(),
        },
        Block::CodeBlock { lang, text } => EpubBlock::CodeBlock {
            language: lang.clone(),
            text: text.clone(),
        },
        Block::Rule => EpubBlock::Rule,
    }
}

fn convert_inline(inline: &Inline) -> EpubInline {
    match inline {
        Inline::Text { text, style } => EpubInline::Text {
            text: text.clone(),
            bold: style.bold,
            italic: style.italic,
            strike: style.strike,
            code: style.code,
        },
        Inline::Link { content, target } => EpubInline::Link {
            content: content.iter().map(convert_inline).collect(),
            target: match target {
                LinkTarget::External(value) => EpubLinkTarget::External(value.clone()),
                LinkTarget::Relative(value) => EpubLinkTarget::Relative(value.clone()),
                LinkTarget::Anchor(value) => EpubLinkTarget::Anchor(value.clone()),
            },
        },
        Inline::Image { alt, source } => EpubInline::Image {
            alt: alt.clone(),
            source: match source {
                ImageSource::Asset(id) => EpubImageSource::Asset(id.0),
                ImageSource::External(url) => EpubImageSource::ExternalBlocked(url.clone()),
                ImageSource::Unavailable => EpubImageSource::Unavailable,
            },
        },
        Inline::Anchor(id) => EpubInline::Anchor { id: id.clone() },
        Inline::NoteRef(id) => EpubInline::NoteRef { id: id.clone() },
        Inline::LineBreak => EpubInline::LineBreak,
    }
}

fn inlines_plain(inlines: &[Inline]) -> String {
    anydoc::model::inlines_to_plain_text(inlines)
        .trim()
        .to_owned()
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn blocks_plain(blocks: &[EpubBlock]) -> String {
    let mut output = String::new();
    for block in blocks {
        collect_block_plain(block, &mut output);
        output.push('\n');
    }
    output
}

fn collect_block_plain(block: &EpubBlock, output: &mut String) {
    match block {
        EpubBlock::Heading { content, .. } | EpubBlock::Paragraph { content } => {
            collect_inlines_plain(content, output)
        }
        EpubBlock::List { items, .. } => {
            for item in items {
                for block in &item.blocks {
                    collect_block_plain(block, output);
                    output.push('\n');
                }
            }
        }
        EpubBlock::Table { rows, .. } => {
            for row in rows {
                for slot in row {
                    if let EpubTableSlot::Cell { blocks, .. } = slot {
                        for block in blocks {
                            collect_block_plain(block, output);
                            output.push(' ');
                        }
                    }
                }
                output.push('\n');
            }
        }
        EpubBlock::BlockQuote { blocks } => {
            for block in blocks {
                collect_block_plain(block, output);
                output.push('\n');
            }
        }
        EpubBlock::CodeBlock { text, .. } => output.push_str(text),
        EpubBlock::Rule => {}
    }
}

fn collect_inlines_plain(inlines: &[EpubInline], output: &mut String) {
    for inline in inlines {
        match inline {
            EpubInline::Text { text, .. } => output.push_str(text),
            EpubInline::Link { content, .. } => collect_inlines_plain(content, output),
            EpubInline::Image { alt, .. } => output.push_str(alt),
            EpubInline::LineBreak => output.push('\n'),
            EpubInline::Anchor { .. } | EpubInline::NoteRef { .. } => {}
        }
    }
}

pub fn allowed_epub_asset(media_type: &str) -> bool {
    matches!(
        media_type.to_ascii_lowercase().as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
    )
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use super::*;

    fn minimal_epub(opf_metadata: &str) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        let entries = vec![
            ("mimetype", "application/epub+zip".to_owned()),
            ("META-INF/container.xml", r#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#.to_owned()),
            ("OPS/content.opf", format!(r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试书籍</dc:title>{opf_metadata}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>"#)),
            ("OPS/chapter.xhtml", r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>安全正文 <strong>重点</strong></p><script>alert('blocked')</script><iframe src="https://evil.invalid"/></body></html>"#.to_owned()),
        ];
        for (name, content) in entries {
            writer.start_file(name, options).expect("start epub entry");
            writer
                .write_all(content.as_bytes())
                .expect("write epub entry");
        }
        writer.finish().expect("finish epub").into_inner()
    }

    fn hierarchical_epub() -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        let entries = vec![
            ("mimetype", "application/epub+zip".to_owned()),
            ("META-INF/container.xml", r#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#.to_owned()),
            ("OPS/content.opf", r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">reade-test</dc:identifier><dc:title>层级书</dc:title><dc:language>zh</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="vol1" href="vol1.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="cover"/><itemref idref="vol1"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#.to_owned()),
            ("OPS/nav.xhtml", r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="cover.xhtml">Cover</a></li><li><a href="vol1.xhtml">第一卷</a><ol><li><a href="c1.xhtml">第一章</a></li><li><a href="c2.xhtml">第二章</a></li></ol></li></ol></nav></body></html>"#.to_owned()),
            ("OPS/cover.xhtml", r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Cover</h1></body></html>"#.to_owned()),
            ("OPS/vol1.xhtml", r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一卷</h1></body></html>"#.to_owned()),
            ("OPS/c1.xhtml", r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>正文一</p></body></html>"#.to_owned()),
            ("OPS/c2.xhtml", r#"<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第二章</h1><p>正文二</p></body></html>"#.to_owned()),
        ];
        for (name, content) in entries {
            writer.start_file(name, options).expect("start epub entry");
            writer
                .write_all(content.as_bytes())
                .expect("write epub entry");
        }
        writer.finish().expect("finish epub").into_inner()
    }

    #[test]
    fn only_safe_raster_epub_assets_are_allowed() {
        assert!(allowed_epub_asset("image/png"));
        assert!(allowed_epub_asset("image/jpeg"));
        assert!(!allowed_epub_asset("image/svg+xml"));
        assert!(!allowed_epub_asset("text/html"));
    }

    #[test]
    fn detects_fixed_layout_metadata() {
        assert!("<meta property=\"rendition:layout\">pre-paginated</meta>"
            .to_ascii_lowercase()
            .contains("pre-paginated"));
    }

    #[test]
    fn maps_reflowable_epub_to_safe_chapter_dto() {
        let parsed = parse_epub(&minimal_epub(""), "Fallback").expect("parse epub");
        assert_eq!(parsed.payload.title, "测试书籍");
        assert_eq!(parsed.payload.chapters.len(), 1);
        assert_eq!(parsed.payload.chapters[0].title, "第一章");
        assert_eq!(parsed.payload.chapters[0].level, 1);
        assert!(parsed.search_segments[0].2.contains("安全正文"));
        let json = serde_json::to_string(&parsed.payload).expect("serialize DTO");
        assert!(!json.contains("iframe"));
        assert!(!json.contains("evil.invalid"));
    }

    #[test]
    fn assigns_toc_levels_from_epub3_nav_nesting() {
        let parsed = parse_epub(&hierarchical_epub(), "Fallback").expect("parse epub");
        let levels: Vec<(&str, u8)> = parsed
            .payload
            .chapters
            .iter()
            .map(|chapter| (chapter.title.as_str(), chapter.level))
            .collect();
        assert!(
            levels.contains(&("Cover", 1)),
            "cover should be top-level: {levels:?}"
        );
        assert!(
            levels.contains(&("第一卷", 1)),
            "volume should be top-level: {levels:?}"
        );
        assert!(
            levels.contains(&("第一章", 2)),
            "nested chapter should be indented: {levels:?}"
        );
        assert!(
            levels.contains(&("第二章", 2)),
            "nested chapter should be indented: {levels:?}"
        );
    }

    #[test]
    fn rejects_fixed_layout_epub_before_conversion() {
        let bytes = minimal_epub(r#"<meta property="rendition:layout">pre-paginated</meta>"#);
        let error = parse_epub(&bytes, "Fixed").expect_err("fixed layout must fail");
        assert!(error.contains("fixed-layout"));
    }

    // ---- D08: 容器与解析资源预算 ----

    /// OPF 超过单文件 XML 上限时，包装层的有界读取必须拒绝并给出稳定
    /// 预算文案——绝不把超大条目完整解压进内存（anydoc 的限额只保护
    /// 它内部的读取，container/OPF 的直读由本层自设上限）。
    #[test]
    fn rejects_an_oversized_opf_with_the_budget_error() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        let entries: Vec<(&str, Vec<u8>)> = vec![
            ("mimetype", b"application/epub+zip".to_vec()),
            (
                "META-INF/container.xml",
                br#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#.to_vec(),
            ),
            // 真实解压 5 MiB 的 OPF（超过 4 MiB 上限）。
            ("OPS/content.opf", {
                let mut opf = br#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest/><spine/></package><!-- "#.to_vec();
                opf.extend(std::iter::repeat_n(b'A', 5 * 1024 * 1024));
                opf.extend_from_slice(b" -->");
                opf
            }),
        ];
        for (name, content) in entries {
            writer.start_file(name, options).expect("start entry");
            writer.write_all(&content).expect("write entry");
        }
        let bytes = writer.finish().expect("finish zip").into_inner();

        let error = parse_epub(&bytes, "Bomb").expect_err("oversized OPF must fail");
        assert!(error.contains("超出解析预算"), "unexpected error: {error}");
        assert!(error.contains("RESOURCE_LIMIT"));
    }

    /// 正常图文 EPUB 在预算内照常解析（防"预算误拒正常书"）。
    #[test]
    fn normal_epub_still_parses_within_budgets() {
        let parsed = parse_epub(&minimal_epub(""), "Normal").expect("parse");
        assert_eq!(parsed.payload.chapters.len(), 1);
    }
}
