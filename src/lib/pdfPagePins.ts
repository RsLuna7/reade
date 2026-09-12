/**
 * PDF page pins (plan-pdf-page-pins B1).
 *
 * Five per-document slots holding file (physical) pages — muscle-memory
 * dog-ears, not Ctrl+B annotation bookmarks. Display may show a printed
 * number via pdfPageOffset; locators and jumps always use the file page.
 *
 * Persistence is a dedicated localStorage envelope (same stance as
 * reade-pdf-page-offsets): not readingPositions, not the annotation store.
 */

import { displayPageNumber } from "./pdfPageOffset";
import { loadLibraryEnvelope, saveLibraryEnvelope, sanitizeEpochMs } from "./localEnvelope";
import { normalizeLibraryKey } from "./libraryKey";

export const PDF_PAGE_PINS_STORAGE_KEY = "reade-pdf-page-pins";
export const PDF_PAGE_PINS_VERSION = 1;
export const PDF_PAGE_PIN_SLOTS = 5;
export const PDF_PAGE_PINS_LIBRARY_LIMIT = 200;

export type PdfPagePinSlots = [
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
];

export interface PdfPagePinsEntry {
  slots: PdfPagePinSlots;
  updatedAt: number;
}

type LibraryPins = Record<string, PdfPagePinsEntry>;

interface PinsEnvelope {
  version: number;
  libraries: Record<string, LibraryPins>;
}

type PinListener = () => void;

const listeners = new Set<PinListener>();

/** In-tab fan-out so a remount / second reader re-reads after a write. */
export function subscribePdfPagePins(listener: PinListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyPinListeners(): void {
  for (const listener of listeners) listener();
}

function isPage(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function emptyPdfPagePins(): PdfPagePinSlots {
  return [null, null, null, null, null];
}

export function pinsAreEmpty(slots: PdfPagePinSlots): boolean {
  return slots.every((slot) => slot == null);
}

/** `Digit1`/`Numpad1` → 0 … `Digit5`/`Numpad5` → 4; otherwise null. */
export function digitSlotIndex(code: string): number | null {
  const digit = /^Digit([1-5])$/.exec(code);
  if (digit) return Number(digit[1]) - 1;
  const numpad = /^Numpad([1-5])$/.exec(code);
  if (numpad) return Number(numpad[1]) - 1;
  return null;
}

export function sanitizePdfPagePinSlots(value: unknown): PdfPagePinSlots | null {
  if (!Array.isArray(value)) return null;
  const slots = emptyPdfPagePins();
  for (let index = 0; index < PDF_PAGE_PIN_SLOTS; index += 1) {
    const item = value[index];
    if (item == null) {
      slots[index] = null;
      continue;
    }
    if (!isPage(item)) return null;
    slots[index] = item;
  }
  return slots;
}

export function sanitizePdfPagePinsEntry(value: unknown): PdfPagePinsEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const updatedAt = sanitizeEpochMs(entry.updatedAt);
  if (updatedAt === null) return null;
  const slots = sanitizePdfPagePinSlots(entry.slots);
  if (!slots || pinsAreEmpty(slots)) return null;
  return { slots, updatedAt };
}

function sanitizeLibraryPins(raw: unknown): LibraryPins | null {
  if (!raw || typeof raw !== "object") return null;
  const sanitized: LibraryPins = {};
  for (const [path, entry] of Object.entries(raw as Record<string, unknown>)) {
    const pins = sanitizePdfPagePinsEntry(entry);
    if (pins) sanitized[path] = pins;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

/** Two buckets for the same library union their documents; newest pin set wins. */
function mergeLibraryPins(existing: LibraryPins, incoming: LibraryPins): LibraryPins {
  const merged: LibraryPins = { ...existing };
  for (const [path, entry] of Object.entries(incoming)) {
    const current = merged[path];
    if (!current || entry.updatedAt >= current.updatedAt) merged[path] = entry;
  }
  return merged;
}

export function togglePinSlot(
  slots: PdfPagePinSlots,
  index: number,
  page: number,
): PdfPagePinSlots {
  if (index < 0 || index >= PDF_PAGE_PIN_SLOTS || !isPage(page)) return slots;
  const next = emptyPdfPagePins();
  for (let slot = 0; slot < PDF_PAGE_PIN_SLOTS; slot += 1) {
    next[slot] = slot === index ? (slots[index] === page ? null : page) : slots[slot];
  }
  return next;
}

export function clearPinSlot(slots: PdfPagePinSlots, index: number): PdfPagePinSlots {
  if (index < 0 || index >= PDF_PAGE_PIN_SLOTS) return slots;
  const next = emptyPdfPagePins();
  for (let slot = 0; slot < PDF_PAGE_PIN_SLOTS; slot += 1) {
    next[slot] = slot === index ? null : slots[slot];
  }
  return next;
}

export function pinChipLabel(page: number | null, offset: number, index: number): string {
  if (page == null) return String(index + 1);
  return String(displayPageNumber(page, offset));
}

export function pinChipTitle(index: number, page: number | null, offset: number): string {
  const slot = index + 1;
  if (page == null) {
    return `页钉 ${slot}：空。Ctrl+${slot} 将当前页写入，按 ${slot} 跳转`;
  }
  const printed = displayPageNumber(page, offset);
  const where =
    offset !== 0 && printed !== page
      ? `印刷第 ${printed} 页（文件第 ${page} 页）`
      : `第 ${page} 页`;
  return `页钉 ${slot}：${where}。按 ${slot} 跳转，Ctrl+${slot} 或 Ctrl+点击清除`;
}

function loadEnvelope(): PinsEnvelope {
  return loadLibraryEnvelope<LibraryPins>({
    storageKey: PDF_PAGE_PINS_STORAGE_KEY,
    version: PDF_PAGE_PINS_VERSION,
    sanitizeLibrary: sanitizeLibraryPins,
    mergeLibrary: mergeLibraryPins,
  });
}

function saveEnvelope(envelope: PinsEnvelope): void {
  saveLibraryEnvelope(PDF_PAGE_PINS_STORAGE_KEY, envelope);
  notifyPinListeners();
}

function evictOverLimit(library: LibraryPins, limit: number): void {
  const paths = Object.keys(library);
  if (paths.length <= limit) return;
  paths
    .sort((a, b) => library[a].updatedAt - library[b].updatedAt)
    .slice(0, paths.length - limit)
    .forEach((path) => delete library[path]);
}

export function readPdfPagePins(libraryRoot: string, relativePath: string): PdfPagePinSlots {
  return (
    loadEnvelope().libraries[normalizeLibraryKey(libraryRoot)]?.[relativePath]?.slots ??
    emptyPdfPagePins()
  );
}

export function listLibraryPdfPagePins(libraryRoot: string): Record<string, PdfPagePinsEntry> {
  return loadEnvelope().libraries[normalizeLibraryKey(libraryRoot)] ?? {};
}

export function writePdfPagePins(
  libraryRoot: string,
  relativePath: string,
  slots: PdfPagePinSlots,
  now: number = Date.now(),
): PdfPagePinsEntry | null {
  if (!libraryRoot || !relativePath) return null;
  if (typeof now !== "number" || !Number.isFinite(now) || now <= 0) return null;
  const sanitized = sanitizePdfPagePinSlots(slots);
  if (!sanitized) return null;
  if (pinsAreEmpty(sanitized)) {
    deletePdfPagePins(libraryRoot, relativePath);
    return null;
  }

  const libraryKey = normalizeLibraryKey(libraryRoot);
  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryKey] ?? {};
  const entry: PdfPagePinsEntry = { slots: sanitized, updatedAt: now };
  library[relativePath] = entry;
  evictOverLimit(library, PDF_PAGE_PINS_LIBRARY_LIMIT);
  envelope.libraries[libraryKey] = library;
  saveEnvelope(envelope);
  return entry;
}

export function deletePdfPagePins(libraryRoot: string, relativePath: string): void {
  if (!libraryRoot || !relativePath) return;
  const libraryKey = normalizeLibraryKey(libraryRoot);
  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryKey];
  if (!library || !(relativePath in library)) return;
  delete library[relativePath];
  if (Object.keys(library).length === 0) delete envelope.libraries[libraryKey];
  else envelope.libraries[libraryKey] = library;
  saveEnvelope(envelope);
}
