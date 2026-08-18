// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  PDF_PAGE_OFFSETS_LIBRARY_LIMIT,
  PDF_PAGE_OFFSETS_STORAGE_KEY,
  PDF_PAGE_OFFSETS_VERSION,
  deletePdfPageOffset,
  displayPageNumber,
  effectiveOffset,
  isValidCalibration,
  listLibraryPdfPageOffsets,
  offsetFromCalibration,
  pageInputAriaLabel,
  physicalFromPrinted,
  printedFromPhysical,
  readPdfPageOffset,
  writePdfPageOffset,
} from "./pdfPageOffset";

const ROOT = "D:\\books";
const NOW = 1_755_000_000_000;

function seedRaw(value: unknown): void {
  localStorage.setItem(
    PDF_PAGE_OFFSETS_STORAGE_KEY,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("page number conversion", () => {
  it("converts with a positive offset (cover pages before printed 1)", () => {
    const offset = offsetFromCalibration(37, 26);
    expect(offset).toBe(11);
    expect(physicalFromPrinted(26, offset)).toBe(37);
    expect(printedFromPhysical(37, offset)).toBe(26);
    expect(physicalFromPrinted(87, offset)).toBe(98);
  });

  it("converts with a negative offset (excerpt that starts mid-book)", () => {
    const offset = offsetFromCalibration(1, 120);
    expect(offset).toBe(-119);
    expect(physicalFromPrinted(120, offset)).toBe(1);
    expect(printedFromPhysical(1, offset)).toBe(120);
  });

  it("falls back to the file page for front-matter printed numbers", () => {
    const offset = 11;
    expect(printedFromPhysical(1, offset)).toBe(-10);
    expect(displayPageNumber(1, offset)).toBe(1);
    expect(displayPageNumber(10, offset)).toBe(10);
    expect(displayPageNumber(11, offset)).toBe(11);
    expect(displayPageNumber(12, offset)).toBe(1);
    expect(displayPageNumber(37, offset)).toBe(26);
  });

  it("never displays 0 or a negative page", () => {
    expect(displayPageNumber(1, 20)).toBe(1);
    expect(displayPageNumber(3, 5)).toBe(3);
    expect(displayPageNumber(5, 0)).toBe(5);
  });
});

describe("calibration validation", () => {
  it("accepts the textbook example and a negative excerpt offset", () => {
    expect(isValidCalibration(37, 26, 580)).toBe(true);
    expect(isValidCalibration(1, 120, 200)).toBe(true);
  });

  it("rejects non-integers, printed < 1, and |offset| >= numPages", () => {
    expect(isValidCalibration(37, 26.5, 580)).toBe(false);
    expect(isValidCalibration(37, 0, 580)).toBe(false);
    expect(isValidCalibration(1, 11, 10)).toBe(false);
    expect(isValidCalibration(1, 1, 10)).toBe(true);
    expect(isValidCalibration(10, 1, 10)).toBe(true);
    expect(isValidCalibration(0, 1, 10)).toBe(false);
    expect(isValidCalibration(11, 1, 10)).toBe(false);
  });

  it("treats an out-of-range stored offset as uncalibrated", () => {
    expect(effectiveOffset(11, 580)).toBe(11);
    expect(effectiveOffset(0, 580)).toBe(0);
    expect(effectiveOffset(580, 580)).toBe(0);
    expect(effectiveOffset(-580, 580)).toBe(0);
  });
});

describe("toolbar copy", () => {
  it("keeps the uncalibrated accessible name and describes both numbers when offset", () => {
    expect(pageInputAriaLabel(37, 0, 580)).toBe("当前页");
    expect(pageInputAriaLabel(37, 11, 580)).toBe("印刷第 26 页，文件第 37 页，共 580 页");
    expect(pageInputAriaLabel(1, 11, 580)).toBe("文件第 1 页，共 580 页");
  });
});

describe("offset round trips", () => {
  it("writes and reads under the versioned envelope", () => {
    const stored = writePdfPageOffset(ROOT, "scan.pdf", { offset: 11, atPhysical: 37 }, NOW);
    expect(stored).toEqual({ offset: 11, atPhysical: 37, updatedAt: NOW });
    expect(readPdfPageOffset(ROOT, "scan.pdf")).toEqual(stored);

    const raw = JSON.parse(localStorage.getItem(PDF_PAGE_OFFSETS_STORAGE_KEY) ?? "{}") as {
      version: number;
      libraries: Record<string, Record<string, unknown>>;
    };
    expect(raw.version).toBe(PDF_PAGE_OFFSETS_VERSION);
    expect(Object.keys(raw.libraries)).toEqual([ROOT]);
  });

  it("keeps libraries isolated and drops a cleared entry", () => {
    writePdfPageOffset(ROOT, "scan.pdf", { offset: 11, atPhysical: 37 }, NOW);
    writePdfPageOffset("E:\\other", "scan.pdf", { offset: -5, atPhysical: 1 }, NOW);
    deletePdfPageOffset(ROOT, "scan.pdf");
    expect(readPdfPageOffset(ROOT, "scan.pdf")).toBeNull();
    expect(readPdfPageOffset("E:\\other", "scan.pdf")).toMatchObject({ offset: -5 });
  });

  it("rejects unusable writes without touching storage", () => {
    expect(writePdfPageOffset(ROOT, "scan.pdf", { offset: 0, atPhysical: 1 }, NOW)).toBeNull();
    expect(writePdfPageOffset(ROOT, "scan.pdf", { offset: 1.5, atPhysical: 1 }, NOW)).toBeNull();
    expect(writePdfPageOffset(ROOT, "scan.pdf", { offset: 2, atPhysical: 0 }, NOW)).toBeNull();
    expect(localStorage.getItem(PDF_PAGE_OFFSETS_STORAGE_KEY)).toBeNull();
  });
});

describe("per-library LRU", () => {
  it("evicts the oldest entry by updatedAt when the 201st document lands", () => {
    for (let index = 0; index < PDF_PAGE_OFFSETS_LIBRARY_LIMIT; index += 1) {
      writePdfPageOffset(ROOT, `doc-${index}.pdf`, { offset: 1, atPhysical: 2 }, NOW + index);
    }
    writePdfPageOffset(ROOT, "doc-0.pdf", { offset: 2, atPhysical: 3 }, NOW + 10_000);
    writePdfPageOffset(ROOT, "overflow.pdf", { offset: 3, atPhysical: 4 }, NOW + 20_000);

    const entries = listLibraryPdfPageOffsets(ROOT);
    expect(Object.keys(entries)).toHaveLength(PDF_PAGE_OFFSETS_LIBRARY_LIMIT);
    expect(entries["doc-1.pdf"]).toBeUndefined();
    expect(entries["doc-0.pdf"]).toBeDefined();
    expect(entries["overflow.pdf"]).toBeDefined();
  });

  it("keeps other libraries untouched by an eviction", () => {
    writePdfPageOffset("E:\\other", "keep.pdf", { offset: 1, atPhysical: 2 }, NOW - 99_999);
    for (let index = 0; index <= PDF_PAGE_OFFSETS_LIBRARY_LIMIT; index += 1) {
      writePdfPageOffset(ROOT, `doc-${index}.pdf`, { offset: 1, atPhysical: 2 }, NOW + index);
    }
    expect(readPdfPageOffset("E:\\other", "keep.pdf")).not.toBeNull();
  });
});

describe("defensive reads", () => {
  it("survives invalid JSON", () => {
    seedRaw("{not json");
    expect(readPdfPageOffset(ROOT, "scan.pdf")).toBeNull();
    writePdfPageOffset(ROOT, "scan.pdf", { offset: 4, atPhysical: 5 }, NOW);
    expect(readPdfPageOffset(ROOT, "scan.pdf")).not.toBeNull();
  });

  it("drops unknown envelope versions wholesale", () => {
    seedRaw({
      version: 99,
      libraries: { [ROOT]: { "scan.pdf": { offset: 4, atPhysical: 5, updatedAt: NOW } } },
    });
    expect(readPdfPageOffset(ROOT, "scan.pdf")).toBeNull();
  });

  it("drops entries with zero offset, bad pages or missing stamps", () => {
    seedRaw({
      version: PDF_PAGE_OFFSETS_VERSION,
      libraries: {
        [ROOT]: {
          "zero.pdf": { offset: 0, atPhysical: 1, updatedAt: NOW },
          "float.pdf": { offset: 1.4, atPhysical: 2, updatedAt: NOW },
          "page-zero.pdf": { offset: 2, atPhysical: 0, updatedAt: NOW },
          "no-stamp.pdf": { offset: 2, atPhysical: 3 },
          "good.pdf": { offset: -8, atPhysical: 1, updatedAt: NOW },
        },
      },
    });
    expect(Object.keys(listLibraryPdfPageOffsets(ROOT))).toEqual(["good.pdf"]);
  });
});
