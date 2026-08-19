// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  PDF_PAGE_PINS_LIBRARY_LIMIT,
  PDF_PAGE_PINS_STORAGE_KEY,
  PDF_PAGE_PINS_VERSION,
  clearPinSlot,
  deletePdfPagePins,
  digitSlotIndex,
  emptyPdfPagePins,
  listLibraryPdfPagePins,
  pinChipLabel,
  pinChipTitle,
  pinsAreEmpty,
  readPdfPagePins,
  sanitizePdfPagePinSlots,
  togglePinSlot,
  writePdfPagePins,
} from "./pdfPagePins";

const ROOT = "D:\\books";
const NOW = 1_755_000_000_000;

function seedRaw(value: unknown): void {
  localStorage.setItem(
    PDF_PAGE_PINS_STORAGE_KEY,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("slot helpers", () => {
  it("maps Digit and Numpad codes 1–5 and rejects the rest", () => {
    expect(digitSlotIndex("Digit1")).toBe(0);
    expect(digitSlotIndex("Digit5")).toBe(4);
    expect(digitSlotIndex("Numpad3")).toBe(2);
    expect(digitSlotIndex("Digit0")).toBeNull();
    expect(digitSlotIndex("Digit6")).toBeNull();
    expect(digitSlotIndex("KeyA")).toBeNull();
  });

  it("toggles the same file page off, and allows the same page in two slots", () => {
    const first = togglePinSlot(emptyPdfPagePins(), 1, 40);
    expect(first).toEqual([null, 40, null, null, null]);
    expect(togglePinSlot(first, 1, 40)).toEqual(emptyPdfPagePins());
    expect(togglePinSlot(first, 3, 40)[3]).toBe(40);
    expect(togglePinSlot(first, 1, 12)[1]).toBe(12);
  });

  it("clears one slot without touching the others", () => {
    const slots = togglePinSlot(togglePinSlot(emptyPdfPagePins(), 0, 2), 4, 9);
    expect(clearPinSlot(slots, 0)).toEqual([null, null, null, null, 9]);
    expect(clearPinSlot(slots, 9)).toEqual(slots);
  });

  it("rejects non-pages and out-of-range indexes", () => {
    const slots = togglePinSlot(emptyPdfPagePins(), 0, 3);
    expect(togglePinSlot(slots, 0, 0)).toEqual(slots);
    expect(togglePinSlot(slots, -1, 4)).toEqual(slots);
    expect(sanitizePdfPagePinSlots([1, 2.5, 3, 4, 5])).toBeNull();
    expect(sanitizePdfPagePinSlots([1, 2, 3])).toEqual([1, 2, 3, null, null]);
  });
});

describe("chip copy", () => {
  it("shows the slot number when empty and the printed page when filled", () => {
    expect(pinChipLabel(null, 11, 1)).toBe("2");
    expect(pinChipLabel(37, 11, 1)).toBe("26");
    expect(pinChipLabel(1, 11, 0)).toBe("1");
    expect(pinChipTitle(1, null, 0)).toContain("Ctrl+2");
    expect(pinChipTitle(1, 37, 11)).toContain("印刷第 26 页（文件第 37 页）");
  });
});

describe("envelope round trips", () => {
  it("writes and reads five slots under the versioned envelope", () => {
    const slots = togglePinSlot(emptyPdfPagePins(), 2, 87);
    const stored = writePdfPagePins(ROOT, "scan.pdf", slots, NOW);
    expect(stored).toEqual({ slots, updatedAt: NOW });
    expect(readPdfPagePins(ROOT, "scan.pdf")).toEqual(slots);

    const raw = JSON.parse(localStorage.getItem(PDF_PAGE_PINS_STORAGE_KEY) ?? "{}") as {
      version: number;
      libraries: Record<string, Record<string, unknown>>;
    };
    expect(raw.version).toBe(PDF_PAGE_PINS_VERSION);
    expect(Object.keys(raw.libraries)).toEqual([ROOT]);
  });

  it("deletes when every slot is cleared", () => {
    writePdfPagePins(ROOT, "scan.pdf", togglePinSlot(emptyPdfPagePins(), 0, 4), NOW);
    expect(writePdfPagePins(ROOT, "scan.pdf", emptyPdfPagePins(), NOW + 1)).toBeNull();
    expect(readPdfPagePins(ROOT, "scan.pdf")).toEqual(emptyPdfPagePins());
    expect(pinsAreEmpty(readPdfPagePins(ROOT, "scan.pdf"))).toBe(true);
    expect(listLibraryPdfPagePins(ROOT)).toEqual({});
  });

  it("keeps libraries isolated", () => {
    writePdfPagePins(ROOT, "scan.pdf", togglePinSlot(emptyPdfPagePins(), 0, 4), NOW);
    writePdfPagePins("E:\\other", "scan.pdf", togglePinSlot(emptyPdfPagePins(), 1, 8), NOW);
    deletePdfPagePins(ROOT, "scan.pdf");
    expect(readPdfPagePins(ROOT, "scan.pdf")).toEqual(emptyPdfPagePins());
    expect(readPdfPagePins("E:\\other", "scan.pdf")[1]).toBe(8);
  });
});

describe("per-library LRU", () => {
  it("evicts the oldest entry by updatedAt when the 201st document lands", () => {
    for (let index = 0; index < PDF_PAGE_PINS_LIBRARY_LIMIT; index += 1) {
      writePdfPagePins(ROOT, `doc-${index}.pdf`, togglePinSlot(emptyPdfPagePins(), 0, 1), NOW + index);
    }
    writePdfPagePins(ROOT, "doc-0.pdf", togglePinSlot(emptyPdfPagePins(), 0, 2), NOW + 10_000);
    writePdfPagePins(ROOT, "overflow.pdf", togglePinSlot(emptyPdfPagePins(), 0, 3), NOW + 20_000);

    const entries = listLibraryPdfPagePins(ROOT);
    expect(Object.keys(entries)).toHaveLength(PDF_PAGE_PINS_LIBRARY_LIMIT);
    expect(entries["doc-1.pdf"]).toBeUndefined();
    expect(entries["doc-0.pdf"]).toBeDefined();
    expect(entries["overflow.pdf"]).toBeDefined();
  });
});

describe("defensive reads", () => {
  it("survives invalid JSON and unknown versions", () => {
    seedRaw("{not json");
    expect(readPdfPagePins(ROOT, "scan.pdf")).toEqual(emptyPdfPagePins());
    seedRaw({
      version: 99,
      libraries: { [ROOT]: { "scan.pdf": { slots: [1, null, null, null, null], updatedAt: NOW } } },
    });
    expect(readPdfPagePins(ROOT, "scan.pdf")).toEqual(emptyPdfPagePins());
  });

  it("drops empty, non-integer or unstamped entries", () => {
    seedRaw({
      version: PDF_PAGE_PINS_VERSION,
      libraries: {
        [ROOT]: {
          "empty.pdf": { slots: [null, null, null, null, null], updatedAt: NOW },
          "float.pdf": { slots: [1.4, null, null, null, null], updatedAt: NOW },
          "no-stamp.pdf": { slots: [2, null, null, null, null] },
          "good.pdf": { slots: [8, null, null, null, 11], updatedAt: NOW },
        },
      },
    });
    expect(Object.keys(listLibraryPdfPagePins(ROOT))).toEqual(["good.pdf"]);
    expect(readPdfPagePins(ROOT, "good.pdf")).toEqual([8, null, null, null, 11]);
  });
});
