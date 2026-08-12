import type {
  Annotation,
  AnnotationColor,
  AnnotationKind,
  AnnotationLocator,
  AnnotationRect,
  BookmarkTarget,
} from "./backend";
import { deriveAnnotationSortIndex, isValidSortIndex } from "./annotations";
import { validateLibraryRelativePath } from "./webLibrary";

/**
 * Annotation transfer: the JSON envelope (export + import) and the
 * Readwise-compatible CSV export (research report §5.7, Q5/Q6 rulings).
 *
 * Everything in this module is a pure function shared by the desktop and web
 * builds; file IO lives in the backends. The import side treats the file as
 * hostile input: `parseAnnotationEnvelope` whitelist-copies every field and
 * enforces the same limits as the Rust `sanitize_annotation`, so a rejected
 * file never writes anything ("明确报错不部分写入").
 *
 * This module is unrelated to `annotationExport.ts` (the Markdown excerpt
 * clipboard export); the name "transfer" was chosen to avoid the clash.
 */

export const TRANSFER_FORMAT_VERSION = 1;
export const TRANSFER_TYPE = "reade_annotation_collection";
/** Hard cap on annotations per envelope (import DoS guard). */
export const MAX_TRANSFER_ANNOTATIONS = 10_000;
/** Hard cap on document groups per envelope. */
export const MAX_TRANSFER_DOCUMENTS = 2_000;
/** Parse refuses texts above this many chars before touching JSON.parse. */
export const MAX_TRANSFER_TEXT_CHARS = 32 * 1024 * 1024;

// Field limits mirroring `sanitize_annotation` in src-tauri/src/user_store.rs.
const MAX_ID_CHARS = 64;
const MAX_NOTE_CHARS = 4_000;
const MAX_TITLE_CHARS = 200;
const MAX_TEXT_CHARS = 2_000;
const MAX_RECTS = 64;
const MAX_PATH_CHARS = 1_024;
const MAX_GENERATOR_CHARS = 200;
const MAX_DEVICE_ID_CHARS = 128;
/** Locator integer fields are u32 on the Rust side. */
const MAX_U32 = 0xffff_ffff;
/** Timestamps must be positive ms values representable as a Date. */
const MAX_TIMESTAMP_MS = 8.64e15;

const ANNOTATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** `pmd5:` partial MD5 (pdf/epub) or `ntxt:` normalized-text SHA-256 (markdown). */
const CONTENT_HASH_PATTERN = /^(pmd5:[0-9a-f]{32}|ntxt:[0-9a-f]{64})$/;
const ANNOTATION_KINDS: readonly AnnotationKind[] = ["highlight", "underline", "bookmark"];
const ANNOTATION_COLOR_VALUES: readonly AnnotationColor[] = ["yellow", "green", "blue", "pink"];

export interface AnnotationTransferDocument {
  relativePath: string;
  /** Content fingerprint of the document, omitted when unknown. */
  contentHash?: string;
  /** Full records (with `relativePath` re-attached after parsing). */
  annotations: Annotation[];
}

export interface AnnotationTransferEnvelope {
  formatVersion: typeof TRANSFER_FORMAT_VERSION;
  type: typeof TRANSFER_TYPE;
  generator: string;
  exportedAt: number;
  /** Random UUID identifying the exporting install; only ever written into export files. */
  deviceId: string;
  includeDeleted: boolean;
  documents: AnnotationTransferDocument[];
}

// ---------------------------------------------------------------------------
// Device id
// ---------------------------------------------------------------------------

export const DEVICE_ID_STORAGE_KEY = "reade-device-id";
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function randomUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Stable per-install device id (KOReader's export `device_id` field): a
 * random UUID persisted on first use. It carries no hardware or user
 * information, never leaves the machine except inside export files the user
 * explicitly writes, and both runtimes share the same localStorage-backed
 * storage. A storage failure (e.g. blocked storage) degrades to an
 * ephemeral id rather than an error.
 */
export function getOrCreateDeviceId(
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
): string {
  const store =
    storage !== undefined
      ? storage
      : typeof localStorage === "undefined"
        ? null
        : localStorage;
  try {
    const existing = store?.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing && DEVICE_ID_PATTERN.test(existing)) return existing;
  } catch {
    // Unreadable storage: fall through to a fresh id.
  }
  const created = randomUuid();
  try {
    store?.setItem(DEVICE_ID_STORAGE_KEY, created);
  } catch {
    // Unwritable storage: the id is ephemeral for this session.
  }
  return created;
}

// ---------------------------------------------------------------------------
// Envelope build (export)
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePosition(a: Annotation, b: Annotation): number {
  return (
    compareStrings(a.sortIndex, b.sortIndex) ||
    a.createdAt - b.createdAt ||
    compareStrings(a.id, b.id)
  );
}

/** Whitelist copy of a locator so exports never carry unknown fields. */
function cloneLocator(locator: AnnotationLocator): AnnotationLocator {
  if (locator.kind === "markdown") {
    return {
      kind: "markdown",
      quote: locator.quote,
      prefix: locator.prefix,
      suffix: locator.suffix,
      headingId: locator.headingId,
      ...(locator.start !== undefined ? { start: locator.start } : {}),
      ...(locator.end !== undefined ? { end: locator.end } : {}),
    };
  }
  if (locator.kind === "pdf") {
    return {
      kind: "pdf",
      page: locator.page,
      view: locator.view,
      quote: locator.quote,
      prefix: locator.prefix,
      suffix: locator.suffix,
      rects: locator.rects.map((rect) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })),
      ...(locator.pageWidth !== undefined ? { pageWidth: locator.pageWidth } : {}),
      ...(locator.pageHeight !== undefined ? { pageHeight: locator.pageHeight } : {}),
    };
  }
  if (locator.kind === "epub") {
    return {
      kind: "epub",
      chapterId: locator.chapterId,
      blockIndex: locator.blockIndex,
      startOffset: locator.startOffset,
      endOffset: locator.endOffset,
      quote: locator.quote,
      prefix: locator.prefix,
      suffix: locator.suffix,
      ...(locator.start !== undefined ? { start: locator.start } : {}),
      ...(locator.end !== undefined ? { end: locator.end } : {}),
    };
  }
  const target = locator.target;
  if (target.format === "markdown") {
    return {
      kind: "bookmark",
      target: {
        format: "markdown",
        headingId: target.headingId,
        scrollRatio: target.scrollRatio,
      },
    };
  }
  if (target.format === "pdf") {
    return {
      kind: "bookmark",
      target: { format: "pdf", page: target.page, offsetRatio: target.offsetRatio },
    };
  }
  return {
    kind: "bookmark",
    target: {
      format: "epub",
      chapterId: target.chapterId,
      headingId: target.headingId,
      scrollRatio: target.scrollRatio,
    },
  };
}

function cloneAnnotationForTransfer(annotation: Annotation): Annotation {
  return {
    id: annotation.id,
    relativePath: annotation.relativePath,
    kind: annotation.kind,
    color: annotation.color ?? null,
    note: annotation.note ?? null,
    selectedText: annotation.selectedText ?? null,
    title: annotation.title ?? null,
    locator: cloneLocator(annotation.locator),
    sortIndex: annotation.sortIndex,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    deletedAt: annotation.deletedAt ?? null,
  };
}

export interface BuildAnnotationEnvelopeOptions {
  deviceId: string;
  /** Tombstones are included (sync semantics) unless explicitly disabled. */
  includeDeleted?: boolean;
  /** relativePath → content fingerprint; missing entries omit `contentHash`. */
  contentHashes?: ReadonlyMap<string, string>;
  /** Defaults to `reade/<app version>`. */
  generator?: string;
  now?: number;
}

/** `reade/<version>`; `__READE_VERSION__` is a Vite define fed from package.json. */
export function defaultTransferGenerator(): string {
  const version = typeof __READE_VERSION__ === "string" ? __READE_VERSION__ : "0.0.0";
  return `reade/${version}`;
}

/**
 * Builds the §5.7 JSON envelope: documents sorted by path, annotations in
 * position order, every record whitelist-copied. The caller serializes with
 * `serializeAnnotationEnvelope`.
 */
export function buildAnnotationEnvelope(
  annotations: readonly Annotation[],
  options: BuildAnnotationEnvelopeOptions,
): AnnotationTransferEnvelope {
  const includeDeleted = options.includeDeleted ?? true;
  const byPath = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    if (!includeDeleted && annotation.deletedAt != null) continue;
    const group = byPath.get(annotation.relativePath);
    if (group) group.push(annotation);
    else byPath.set(annotation.relativePath, [annotation]);
  }
  const documents: AnnotationTransferDocument[] = [...byPath.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([relativePath, group]) => {
      const contentHash = options.contentHashes?.get(relativePath);
      return {
        relativePath,
        ...(contentHash ? { contentHash } : {}),
        annotations: group.sort(comparePosition).map(cloneAnnotationForTransfer),
      };
    });
  return {
    formatVersion: TRANSFER_FORMAT_VERSION,
    type: TRANSFER_TYPE,
    generator: options.generator ?? defaultTransferGenerator(),
    exportedAt: options.now ?? Date.now(),
    deviceId: options.deviceId,
    includeDeleted,
    documents,
  };
}

export function serializeAnnotationEnvelope(envelope: AnnotationTransferEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

// ---------------------------------------------------------------------------
// Envelope parse (import, hostile input)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function charCount(value: string): number {
  return [...value].length;
}

function fail(message: string): never {
  throw new Error(message);
}

function readBoundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") fail(`${label}必须是字符串`);
  if (charCount(value) > maxChars) fail(`${label}超出 ${maxChars} 字符上限`);
  return value;
}

/** Optional text field: trims, empties collapse to null (mirrors Rust). */
function readOptionalText(value: unknown, label: string, maxChars: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${label}必须是字符串或 null`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (charCount(trimmed) > maxChars) fail(`${label}超出 ${maxChars} 字符上限`);
  return trimmed;
}

function readInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function readOptionalOffset(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return readInteger(value, label, 0, MAX_U32);
}

function readFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label}必须是有限数值`);
  return value;
}

function readRatio(value: unknown, label: string): number {
  const ratio = readFiniteNumber(value, label);
  if (ratio < 0) fail(`${label}不能为负`);
  return ratio;
}

function readTimestamp(value: unknown, label: string): number {
  return readInteger(value, label, 1, MAX_TIMESTAMP_MS);
}

function readRelativePath(value: unknown, label: string): string {
  const path = readBoundedString(value, label, MAX_PATH_CHARS);
  try {
    validateLibraryRelativePath(path);
  } catch (cause) {
    fail(`${label}无效：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return path;
}

function parseRects(value: unknown, label: string): AnnotationRect[] {
  if (!Array.isArray(value)) fail(`${label}必须是数组`);
  if (value.length > MAX_RECTS) fail(`${label}超出 ${MAX_RECTS} 个矩形上限`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) fail(`${label}[${index}] 必须是对象`);
    return {
      x: readFiniteNumber(entry.x, `${label}[${index}].x`),
      y: readFiniteNumber(entry.y, `${label}[${index}].y`),
      w: readFiniteNumber(entry.w, `${label}[${index}].w`),
      h: readFiniteNumber(entry.h, `${label}[${index}].h`),
    };
  });
}

function parseQuoteContext(
  record: Record<string, unknown>,
  label: string,
): { quote: string; prefix: string; suffix: string } {
  return {
    quote: readBoundedString(record.quote, `${label}.quote`, MAX_TEXT_CHARS),
    prefix: readBoundedString(record.prefix, `${label}.prefix`, MAX_TEXT_CHARS),
    suffix: readBoundedString(record.suffix, `${label}.suffix`, MAX_TEXT_CHARS),
  };
}

function parseStartEnd(
  record: Record<string, unknown>,
  label: string,
): { start?: number; end?: number } {
  const start = readOptionalOffset(record.start, `${label}.start`);
  const end = readOptionalOffset(record.end, `${label}.end`);
  if (start !== undefined && end !== undefined && end < start) {
    fail(`${label} 的位置提示区间无效`);
  }
  return { ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) };
}

function parseBookmarkTarget(value: unknown, label: string): BookmarkTarget {
  if (!isRecord(value)) fail(`${label}必须是对象`);
  const format = value.format;
  if (format === "markdown") {
    return {
      format: "markdown",
      headingId: readOptionalText(value.headingId, `${label}.headingId`, MAX_TEXT_CHARS),
      scrollRatio: readRatio(value.scrollRatio, `${label}.scrollRatio`),
    };
  }
  if (format === "pdf") {
    return {
      format: "pdf",
      page: readInteger(value.page, `${label}.page`, 0, MAX_U32),
      offsetRatio: readRatio(value.offsetRatio, `${label}.offsetRatio`),
    };
  }
  if (format === "epub") {
    return {
      format: "epub",
      chapterId: readBoundedString(value.chapterId, `${label}.chapterId`, MAX_TEXT_CHARS),
      headingId: readOptionalText(value.headingId, `${label}.headingId`, MAX_TEXT_CHARS),
      scrollRatio: readRatio(value.scrollRatio, `${label}.scrollRatio`),
    };
  }
  fail(`${label}.format 不受支持`);
}

function parseLocator(value: unknown, label: string): AnnotationLocator {
  if (!isRecord(value)) fail(`${label}必须是对象`);
  const kind = value.kind;
  if (kind === "markdown") {
    return {
      kind: "markdown",
      ...parseQuoteContext(value, label),
      headingId: readOptionalText(value.headingId, `${label}.headingId`, MAX_TEXT_CHARS),
      ...parseStartEnd(value, label),
    };
  }
  if (kind === "pdf") {
    const view = value.view;
    if (view !== "original" && view !== "reading") {
      fail(`${label}.view 必须是 original 或 reading`);
    }
    const pageWidth = value.pageWidth;
    const pageHeight = value.pageHeight;
    for (const [dimension, name] of [
      [pageWidth, "pageWidth"],
      [pageHeight, "pageHeight"],
    ] as const) {
      if (dimension === undefined || dimension === null) continue;
      const size = readFiniteNumber(dimension, `${label}.${name}`);
      if (size <= 0) fail(`${label}.${name} 必须为正数`);
    }
    return {
      kind: "pdf",
      page: readInteger(value.page, `${label}.page`, 0, MAX_U32),
      view,
      ...parseQuoteContext(value, label),
      rects: parseRects(value.rects, `${label}.rects`),
      ...(typeof pageWidth === "number" ? { pageWidth } : {}),
      ...(typeof pageHeight === "number" ? { pageHeight } : {}),
    };
  }
  if (kind === "epub") {
    return {
      kind: "epub",
      chapterId: readBoundedString(value.chapterId, `${label}.chapterId`, MAX_TEXT_CHARS),
      blockIndex: readInteger(value.blockIndex, `${label}.blockIndex`, 0, MAX_U32),
      startOffset: readInteger(value.startOffset, `${label}.startOffset`, 0, MAX_U32),
      endOffset: readInteger(value.endOffset, `${label}.endOffset`, 0, MAX_U32),
      ...parseQuoteContext(value, label),
      ...parseStartEnd(value, label),
    };
  }
  if (kind === "bookmark") {
    return { kind: "bookmark", target: parseBookmarkTarget(value.target, `${label}.target`) };
  }
  fail(`${label}.kind 不受支持`);
}

function parseTransferAnnotation(
  value: unknown,
  relativePath: string,
  label: string,
): Annotation {
  if (!isRecord(value)) fail(`${label}必须是对象`);
  const id = value.id;
  if (typeof id !== "string" || !ANNOTATION_ID_PATTERN.test(id)) {
    fail(`${label}.id 无效（1-${MAX_ID_CHARS} 位字母数字、连字符或下划线）`);
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !ANNOTATION_KINDS.includes(kind as AnnotationKind)) {
    fail(`${label}.kind 不受支持`);
  }
  const color = value.color ?? null;
  if (color !== null && !ANNOTATION_COLOR_VALUES.includes(color as AnnotationColor)) {
    fail(`${label}.color 不受支持`);
  }
  const locator = parseLocator(value.locator, `${label}.locator`);
  if (kind === "bookmark") {
    if (locator.kind !== "bookmark") fail(`${label} 书签必须使用书签定位器`);
    if (color !== null) fail(`${label} 书签不能携带颜色`);
  } else {
    if (locator.kind === "bookmark") fail(`${label} 高亮/下划线不能使用书签定位器`);
    if (color === null) fail(`${label} 高亮/下划线必须携带颜色`);
  }
  const createdAt = readTimestamp(value.createdAt, `${label}.createdAt`);
  let updatedAt = readTimestamp(value.updatedAt, `${label}.updatedAt`);
  if (updatedAt < createdAt) updatedAt = createdAt;
  const deletedAtRaw = value.deletedAt ?? null;
  const deletedAt =
    deletedAtRaw === null ? null : readTimestamp(deletedAtRaw, `${label}.deletedAt`);
  const sortIndexRaw = value.sortIndex;
  let sortIndex: string;
  if (sortIndexRaw === undefined || sortIndexRaw === null) {
    sortIndex = deriveAnnotationSortIndex(locator);
  } else if (typeof sortIndexRaw === "string" && isValidSortIndex(sortIndexRaw)) {
    sortIndex = sortIndexRaw;
  } else {
    fail(`${label}.sortIndex 格式无效`);
  }
  return {
    id,
    relativePath,
    kind: kind as AnnotationKind,
    color: color as AnnotationColor | null,
    note: readOptionalText(value.note, `${label}.note`, MAX_NOTE_CHARS),
    selectedText: readOptionalText(value.selectedText, `${label}.selectedText`, MAX_TEXT_CHARS),
    title: readOptionalText(value.title, `${label}.title`, MAX_TITLE_CHARS),
    locator,
    sortIndex,
    createdAt,
    updatedAt,
    deletedAt,
  };
}

/**
 * Strict parser for an untrusted envelope text. Throws a descriptive error
 * on the first violation; on success every annotation is a freshly built,
 * fully validated record (unknown fields dropped, limits identical to the
 * Rust sanitizer) with the document's `relativePath` attached.
 */
export function parseAnnotationEnvelope(text: string): AnnotationTransferEnvelope {
  if (text.length > MAX_TRANSFER_TEXT_CHARS) fail("导入文件过大");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("导入文件不是有效的 JSON");
  }
  if (!isRecord(raw)) fail("导入文件不是标注导出文件");
  if (raw.type !== TRANSFER_TYPE) fail("导入文件不是 Reade 标注导出文件");
  if (raw.formatVersion !== TRANSFER_FORMAT_VERSION) {
    fail(
      `不支持的导出格式版本（${String(raw.formatVersion)}）；` +
        "该文件可能来自更新版本的 Reade",
    );
  }
  const generator = readBoundedString(raw.generator, "generator", MAX_GENERATOR_CHARS);
  const exportedAt = readTimestamp(raw.exportedAt, "exportedAt");
  const deviceId = readBoundedString(raw.deviceId, "deviceId", MAX_DEVICE_ID_CHARS);
  if (!deviceId) fail("deviceId 不能为空");
  if (typeof raw.includeDeleted !== "boolean") fail("includeDeleted 必须是布尔值");
  const includeDeleted = raw.includeDeleted;
  if (!Array.isArray(raw.documents)) fail("documents 必须是数组");
  if (raw.documents.length > MAX_TRANSFER_DOCUMENTS) {
    fail(`documents 超出 ${MAX_TRANSFER_DOCUMENTS} 个文档上限`);
  }

  const seenPaths = new Set<string>();
  const seenIds = new Set<string>();
  let totalAnnotations = 0;
  const documents: AnnotationTransferDocument[] = raw.documents.map((entry, docIndex) => {
    if (!isRecord(entry)) fail(`documents[${docIndex}] 必须是对象`);
    const relativePath = readRelativePath(entry.relativePath, `documents[${docIndex}].relativePath`);
    if (seenPaths.has(relativePath)) fail(`文件包含重复的文档路径：${relativePath}`);
    seenPaths.add(relativePath);
    const contentHashRaw = entry.contentHash;
    let contentHash: string | undefined;
    if (contentHashRaw !== undefined && contentHashRaw !== null) {
      if (typeof contentHashRaw !== "string" || !CONTENT_HASH_PATTERN.test(contentHashRaw)) {
        fail(`documents[${docIndex}].contentHash 格式无效`);
      }
      contentHash = contentHashRaw;
    }
    if (!Array.isArray(entry.annotations)) fail(`documents[${docIndex}].annotations 必须是数组`);
    totalAnnotations += entry.annotations.length;
    if (totalAnnotations > MAX_TRANSFER_ANNOTATIONS) {
      fail(`标注数量超出 ${MAX_TRANSFER_ANNOTATIONS} 条上限`);
    }
    const annotations = entry.annotations.map((record, index) => {
      const annotation = parseTransferAnnotation(
        record,
        relativePath,
        `documents[${docIndex}].annotations[${index}]`,
      );
      if (seenIds.has(annotation.id)) fail(`文件包含重复的标注 id：${annotation.id}`);
      seenIds.add(annotation.id);
      if (!includeDeleted && annotation.deletedAt != null) {
        fail("文件声明不含已删除标注，却包含墓碑记录");
      }
      return annotation;
    });
    return { relativePath, ...(contentHash ? { contentHash } : {}), annotations };
  });

  return {
    formatVersion: TRANSFER_FORMAT_VERSION,
    type: TRANSFER_TYPE,
    generator,
    exportedAt,
    deviceId,
    includeDeleted,
    documents,
  };
}

// ---------------------------------------------------------------------------
// Import plan (Q6 rulings)
// ---------------------------------------------------------------------------

const FINGERPRINT_SEPARATOR = "\u001f";

/**
 * Deterministic content fingerprint (Q6):
 * `relativePath + kind + quote + start`, where "start" is the locator's best
 * position discriminator per kind (markdown/epub start hint, pdf page,
 * bookmark target slots via the derived sort key). Identity for dedupe only —
 * the UUID stays the primary key.
 */
export function annotationContentFingerprint(annotation: Annotation): string {
  const locator = annotation.locator;
  let quote = "";
  let position = "";
  if (locator.kind === "markdown") {
    quote = locator.quote;
    position = locator.start !== undefined ? String(locator.start) : "";
  } else if (locator.kind === "epub") {
    quote = locator.quote;
    position =
      locator.start !== undefined
        ? String(locator.start)
        : `${locator.blockIndex}:${locator.startOffset}`;
  } else if (locator.kind === "pdf") {
    quote = locator.quote;
    position = `p${locator.page}`;
  } else {
    // Bookmarks have no quote; the derived sort key is a deterministic
    // stand-in for the target position.
    position = deriveAnnotationSortIndex(locator);
  }
  return [annotation.relativePath, annotation.kind, quote, position].join(
    FINGERPRINT_SEPARATOR,
  );
}

export interface DocumentFingerprintEntry {
  relativePath: string;
  contentHash: string;
}

/** One "document moved elsewhere" hint derived from envelope content hashes. */
export interface RebindSuggestion {
  /** Envelope path that is missing from the current library. */
  oldPath: string;
  /** Present documents whose content fingerprint matches, sorted. */
  candidates: string[];
  /** Live annotations the envelope holds for `oldPath`. */
  annotationCount: number;
}

export interface AnnotationImportPlan {
  /** Records to write, in envelope order (adds, LWW updates, tombstones). */
  toUpsert: Annotation[];
  /**
   * Envelope content hashes for paths missing from the current scan. Stored
   * into the fingerprint table so the existing §5.5 move-detection chain can
   * propose rebinds; rows for present paths are never touched.
   */
  fingerprintRows: DocumentFingerprintEntry[];
  /** Brand-new annotations. */
  added: number;
  /** No-ops: content-fingerprint hits and older-or-equal same-id records. */
  skipped: number;
  /** Same-id records where the envelope won the updatedAt LWW. */
  updated: number;
  /** Tombstones taking effect locally (propagated or anti-zombie inserts). */
  deletions: number;
  rebindSuggestions: RebindSuggestion[];
}

export interface PlanAnnotationImportOptions {
  /** Every local record for the current root, tombstones included. */
  existing: readonly Annotation[];
  /** Paths present in the current scan. */
  presentPaths: ReadonlySet<string>;
  /** Content hashes of *present* documents (for rebind suggestions). */
  presentHashes?: ReadonlyMap<string, string>;
}

/**
 * Pure import decision core (Q6 rulings, shared by both runtimes):
 * 1. content fingerprint hits a live local annotation → no-op skip
 *    (tombstones are excluded from the fingerprint set, so deliberately
 *    re-creating something deleted earlier stays possible);
 * 2. same id → updatedAt LWW, local newer-or-equal edits win;
 * 3. envelope tombstones propagate deletions; unmatched tombstones are
 *    inserted so a later import of an older live copy cannot resurrect the
 *    record (Readwise "zombie highlight" reasoning);
 * 4. envelope documents whose path vanished but whose contentHash matches a
 *    present document become rebind *suggestions* — records still import
 *    under their original path and the existing rebind chain moves them
 *    after user confirmation; paths are never rewritten here.
 */
export function planAnnotationImport(
  envelope: AnnotationTransferEnvelope,
  options: PlanAnnotationImportOptions,
): AnnotationImportPlan {
  const byId = new Map<string, Annotation>();
  const liveFingerprints = new Set<string>();
  for (const annotation of options.existing) {
    byId.set(annotation.id, annotation);
    if (annotation.deletedAt == null) {
      liveFingerprints.add(annotationContentFingerprint(annotation));
    }
  }
  const hashToPresentPaths = new Map<string, string[]>();
  if (options.presentHashes) {
    for (const [path, hash] of options.presentHashes) {
      if (!options.presentPaths.has(path)) continue;
      const bucket = hashToPresentPaths.get(hash);
      if (bucket) bucket.push(path);
      else hashToPresentPaths.set(hash, [path]);
    }
  }

  const plan: AnnotationImportPlan = {
    toUpsert: [],
    fingerprintRows: [],
    added: 0,
    skipped: 0,
    updated: 0,
    deletions: 0,
    rebindSuggestions: [],
  };
  const plannedFingerprints = new Set<string>();

  for (const document of envelope.documents) {
    const missing = !options.presentPaths.has(document.relativePath);
    if (missing && document.contentHash) {
      plan.fingerprintRows.push({
        relativePath: document.relativePath,
        contentHash: document.contentHash,
      });
      const candidates = hashToPresentPaths.get(document.contentHash);
      if (candidates?.length) {
        plan.rebindSuggestions.push({
          oldPath: document.relativePath,
          candidates: [...candidates].sort(compareStrings),
          annotationCount: document.annotations.filter(
            (annotation) => annotation.deletedAt == null,
          ).length,
        });
      }
    }
    for (const incoming of document.annotations) {
      const local = byId.get(incoming.id);
      if (local) {
        if (incoming.updatedAt <= local.updatedAt) {
          plan.skipped += 1;
          continue;
        }
        if (incoming.deletedAt != null && local.deletedAt == null) plan.deletions += 1;
        else plan.updated += 1;
        plan.toUpsert.push(incoming);
        continue;
      }
      if (incoming.deletedAt != null) {
        // Unknown-id tombstone: keep it so this deletion cannot be undone by
        // importing an older file later.
        plan.deletions += 1;
        plan.toUpsert.push(incoming);
        continue;
      }
      const fingerprint = annotationContentFingerprint(incoming);
      if (liveFingerprints.has(fingerprint) || plannedFingerprints.has(fingerprint)) {
        plan.skipped += 1;
        continue;
      }
      plannedFingerprints.add(fingerprint);
      plan.added += 1;
      plan.toUpsert.push(incoming);
    }
  }
  return plan;
}

/** Dry-run summary line for the confirmation dialog. */
export function summarizeImportPlan(plan: AnnotationImportPlan): string {
  const parts = [
    `新增 ${plan.added}`,
    `跳过 ${plan.skipped}`,
    `更新 ${plan.updated}`,
    `删除传播 ${plan.deletions}`,
  ];
  const summary = parts.join("、");
  return plan.rebindSuggestions.length
    ? `${summary}；${plan.rebindSuggestions.length} 个文档建议重绑`
    : summary;
}

// ---------------------------------------------------------------------------
// Readwise-compatible CSV export (Q5 ruling)
// ---------------------------------------------------------------------------

/** Readwise CSV import columns, exactly in its documented order. */
export const READWISE_CSV_HEADER = "Highlight,Title,Author,URL,Note,Location,Date";

function csvField(raw: string): string {
  let value = raw;
  // Formula-injection guard: neutralize leading =, +, -, @, tab or CR so a
  // spreadsheet never interprets a cell as a formula (OWASP CSV injection).
  if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
  if (/[",\r\n]/.test(value)) value = `"${value.replace(/"/g, '""')}"`;
  return value;
}

function transferFileName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

export interface BuildReadwiseCsvOptions {
  /** relativePath → document title; missing entries fall back to the file name. */
  documentTitles?: ReadonlyMap<string, string>;
}

export interface ReadwiseCsvResult {
  csv: string;
  /** Exported highlight rows (excluding the header). */
  rows: number;
}

/**
 * Readwise import CSV (`Highlight,Title,Author,URL,Note,Location,Date`).
 * Only live highlight/underline annotations with selected text are exported:
 * bookmarks have no highlight body (Readwise requires one), and tombstones
 * are local bookkeeping. Location is the 1-based position ordinal per
 * document (sortIndex order) for markdown/epub and the page number for PDF;
 * Date is the creation time in ISO 8601.
 */
export function buildReadwiseCsv(
  annotations: readonly Annotation[],
  options: BuildReadwiseCsvOptions = {},
): ReadwiseCsvResult {
  const byPath = new Map<string, Annotation[]>();
  for (const annotation of annotations) {
    if (annotation.deletedAt != null) continue;
    if (annotation.kind !== "highlight" && annotation.kind !== "underline") continue;
    if (annotation.locator.kind === "bookmark") continue;
    if (!annotation.selectedText?.trim()) continue;
    const group = byPath.get(annotation.relativePath);
    if (group) group.push(annotation);
    else byPath.set(annotation.relativePath, [annotation]);
  }
  const lines = [READWISE_CSV_HEADER];
  let rows = 0;
  for (const [path, group] of [...byPath.entries()].sort(([a], [b]) => compareStrings(a, b))) {
    const title = options.documentTitles?.get(path) ?? transferFileName(path);
    const sorted = group.sort(comparePosition);
    let ordinal = 0;
    for (const annotation of sorted) {
      ordinal += 1;
      const location =
        annotation.locator.kind === "pdf" ? annotation.locator.page : ordinal;
      const date = new Date(annotation.createdAt).toISOString();
      lines.push(
        [
          csvField(annotation.selectedText ?? ""),
          csvField(title),
          "",
          "",
          csvField(annotation.note ?? ""),
          String(location),
          date,
        ].join(","),
      );
      rows += 1;
    }
  }
  return { csv: `${lines.join("\r\n")}\r\n`, rows };
}
