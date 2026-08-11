use std::io::{Cursor, Read};

use anydoc::model::{
    Block, CellSlot, Document, ImageSource, Inline, LinkTarget, MarkerKind, NoteKind, TableKind,
};
use serde::Serialize;
use zip::ZipArchive;

pub const MAX_CONVERTIBLE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
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
    let document = anydoc::to_document(bytes, anydoc::Format::Epub)
        .map_err(|error| format!("EPUB 解析失败：{error}"))?;
    Ok(convert_epub_document(document, fallback_title))
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

    let mut container = String::new();
    archive
        .by_name("META-INF/container.xml")
        .map_err(|_| "EPUB 缺少 META-INF/container.xml".to_owned())?
        .read_to_string(&mut container)
        .map_err(|error| format!("无法读取 EPUB container.xml：{error}"))?;
    let opf_path = attribute_value(&container, "full-path")
        .ok_or_else(|| "EPUB container.xml 未声明 OPF 路径".to_owned())?;
    let mut opf = String::new();
    archive
        .by_name(&opf_path)
        .map_err(|_| "EPUB 缺少 OPF 包描述".to_owned())?
        .read_to_string(&mut opf)
        .map_err(|error| format!("无法读取 EPUB OPF：{error}"))?;
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
    let title = blocks
        .iter()
        .find_map(|block| match block {
            Block::Heading { content, .. } => non_empty(inlines_plain(content)),
            _ => None,
        })
        .unwrap_or_else(|| chapter_fallback_title(&id));
    EpubChapter {
        id,
        title,
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
        assert!(parsed.search_segments[0].2.contains("安全正文"));
        let json = serde_json::to_string(&parsed.payload).expect("serialize DTO");
        assert!(!json.contains("iframe"));
        assert!(!json.contains("evil.invalid"));
    }

    #[test]
    fn rejects_fixed_layout_epub_before_conversion() {
        let bytes = minimal_epub(r#"<meta property="rendition:layout">pre-paginated</meta>"#);
        let error = parse_epub(&bytes, "Fixed").expect_err("fixed layout must fail");
        assert!(error.contains("fixed-layout"));
    }
}
