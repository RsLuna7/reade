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

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function sanitizeUpdatedAt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 10_000_000_000 ? value * 1000 : value;
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
  const updatedAt = sanitizeUpdatedAt(entry.updatedAt);
  if (updatedAt === null) return null;
  const slots = sanitizePdfPagePinSlots(entry.slots);
  if (!slots || pinsAreEmpty(slots)) return null;
  return { slots, updatedAt };
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
  const empty: PinsEnvelope = { version: PDF_PAGE_PINS_VERSION, libraries: {} };
  const store = storage();
  if (!store) return empty;

  let parsed: unknown;
  try {
    const raw = store.getItem(PDF_PAGE_PINS_STORAGE_KEY);
    if (!raw) return empty;
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const envelope = parsed as Partial<PinsEnvelope>;
  if (envelope.version !== PDF_PAGE_PINS_VERSION) return empty;
  if (!envelope.libraries || typeof envelope.libraries !== "object") return empty;

  const libraries: Record<string, LibraryPins> = {};
  for (const [root, entries] of Object.entries(envelope.libraries)) {
    if (!entries || typeof entries !== "object") continue;
    const sanitized: LibraryPins = {};
    for (const [path, entry] of Object.entries(entries)) {
      const pins = sanitizePdfPagePinsEntry(entry);
      if (pins) sanitized[path] = pins;
    }
    if (Object.keys(sanitized).length > 0) libraries[root] = sanitized;
  }
  return { version: PDF_PAGE_PINS_VERSION, libraries };
}

function saveEnvelope(envelope: PinsEnvelope): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PDF_PAGE_PINS_STORAGE_KEY, JSON.stringify(envelope));
    notifyPinListeners();
  } catch {
    // Quota / private-mode: lose only the pin hint.
  }
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
  return loadEnvelope().libraries[libraryRoot]?.[relativePath]?.slots ?? emptyPdfPagePins();
}

export function listLibraryPdfPagePins(libraryRoot: string): Record<string, PdfPagePinsEntry> {
  return loadEnvelope().libraries[libraryRoot] ?? {};
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

  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryRoot] ?? {};
  const entry: PdfPagePinsEntry = { slots: sanitized, updatedAt: now };
  library[relativePath] = entry;
  evictOverLimit(library, PDF_PAGE_PINS_LIBRARY_LIMIT);
  envelope.libraries[libraryRoot] = library;
  saveEnvelope(envelope);
  return entry;
}

export function deletePdfPagePins(libraryRoot: string, relativePath: string): void {
  if (!libraryRoot || !relativePath) return;
  const envelope = loadEnvelope();
  const library = envelope.libraries[libraryRoot];
  if (!library || !(relativePath in library)) return;
  delete library[relativePath];
  if (Object.keys(library).length === 0) delete envelope.libraries[libraryRoot];
  else envelope.libraries[libraryRoot] = library;
  saveEnvelope(envelope);
}
