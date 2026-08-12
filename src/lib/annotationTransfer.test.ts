import { describe, expect, it } from "vitest";
import type { Annotation } from "./backend";
import {
  annotationContentFingerprint,
  buildAnnotationEnvelope,
  buildReadwiseCsv,
  DEVICE_ID_STORAGE_KEY,
  getOrCreateDeviceId,
  MAX_TRANSFER_ANNOTATIONS,
  parseAnnotationEnvelope,
  planAnnotationImport,
  READWISE_CSV_HEADER,
  serializeAnnotationEnvelope,
  summarizeImportPlan,
  TRANSFER_FORMAT_VERSION,
  TRANSFER_TYPE,
  type AnnotationTransferEnvelope,
} from "./annotationTransfer";

const DEVICE_ID = "3f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const HASH_A = `ntxt:${"a".repeat(64)}`;
const HASH_B = `pmd5:${"b".repeat(32)}`;

function makeAnnotation(id: string, relativePath: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    relativePath,
    kind: "highlight",
    color: "yellow",
    note: null,
    selectedText: "hello world",
    title: "hello world",
    locator: {
      kind: "markdown",
      quote: "hello world",
      prefix: "say ",
      suffix: " today",
      headingId: null,
      start: 1024,
      end: 1035,
    },
    sortIndex: "M|00000|00001024",
    createdAt: 100,
    updatedAt: 100,
    deletedAt: null,
    ...overrides,
  };
}

function makeBookmark(id: string, relativePath: string, overrides: Partial<Annotation> = {}): Annotation {
  return makeAnnotation(id, relativePath, {
    kind: "bookmark",
    color: null,
    selectedText: null,
    title: "书签",
    locator: { kind: "bookmark", target: { format: "markdown", headingId: null, scrollRatio: 0.5 } },
    sortIndex: "M|00000|50000000",
    ...overrides,
  });
}

function buildEnvelope(
  annotations: Annotation[],
  options: { contentHashes?: ReadonlyMap<string, string>; includeDeleted?: boolean } = {},
): AnnotationTransferEnvelope {
  return buildAnnotationEnvelope(annotations, {
    deviceId: DEVICE_ID,
    generator: "reade/0.1.0",
    now: 1_765_500_000_000,
    ...options,
  });
}

describe("buildAnnotationEnvelope", () => {
  it("groups by document, sorts by position and stamps the metadata", () => {
    const annotations = [
      makeAnnotation("b-later", "notes/b.md", { sortIndex: "M|00000|00002000" }),
      makeAnnotation("b-early", "notes/b.md", { sortIndex: "M|00000|00000005" }),
      makeAnnotation("a-only", "notes/a.md"),
    ];
    const envelope = buildEnvelope(annotations, {
      contentHashes: new Map([["notes/a.md", HASH_A]]),
    });
    expect(envelope.formatVersion).toBe(TRANSFER_FORMAT_VERSION);
    expect(envelope.type).toBe(TRANSFER_TYPE);
    expect(envelope.generator).toBe("reade/0.1.0");
    expect(envelope.deviceId).toBe(DEVICE_ID);
    expect(envelope.includeDeleted).toBe(true);
    expect(envelope.documents.map((doc) => doc.relativePath)).toEqual([
      "notes/a.md",
      "notes/b.md",
    ]);
    expect(envelope.documents[0].contentHash).toBe(HASH_A);
    expect(envelope.documents[1].contentHash).toBeUndefined();
    expect(envelope.documents[1].annotations.map((item) => item.id)).toEqual([
      "b-early",
      "b-later",
    ]);
  });

  it("filters tombstones when includeDeleted is false", () => {
    const annotations = [
      makeAnnotation("live", "notes/a.md"),
      makeAnnotation("dead", "notes/a.md", { deletedAt: 500 }),
    ];
    const excluded = buildEnvelope(annotations, { includeDeleted: false });
    expect(excluded.includeDeleted).toBe(false);
    expect(excluded.documents[0].annotations.map((item) => item.id)).toEqual(["live"]);
    const included = buildEnvelope(annotations);
    expect(included.documents[0].annotations).toHaveLength(2);
  });

  it("drops unknown fields from exported records", () => {
    const dirty = {
      ...makeAnnotation("clean-me", "notes/a.md"),
      $orphan: true,
      extra: "junk",
    } as unknown as Annotation;
    const envelope = buildEnvelope([dirty]);
    const record = envelope.documents[0].annotations[0] as unknown as Record<string, unknown>;
    expect(record.$orphan).toBeUndefined();
    expect(record.extra).toBeUndefined();
    expect(record.id).toBe("clean-me");
  });
});

describe("parseAnnotationEnvelope round-trip", () => {
  it("export → parse preserves every record, and re-import is a full no-op", () => {
    const annotations = [
      makeAnnotation("md-1", "notes/a.md", { note: "remember" }),
      makeAnnotation("pdf-1", "paper.pdf", {
        locator: {
          kind: "pdf",
          page: 3,
          view: "original",
          quote: "q",
          prefix: "",
          suffix: "",
          rects: [{ x: 0.1, y: 0.25, w: 0.5, h: 0.02 }],
          pageWidth: 612,
          pageHeight: 792,
        },
        sortIndex: "P|00003|00002500",
      }),
      makeAnnotation("epub-1", "book.epub", {
        kind: "underline",
        locator: {
          kind: "epub",
          chapterId: "OEBPS/ch1.xhtml",
          blockIndex: 2,
          startOffset: 15,
          endOffset: 25,
          quote: "q",
          prefix: "",
          suffix: "",
        },
        sortIndex: "E|00000|00020015",
      }),
      makeBookmark("bm-1", "notes/a.md"),
      makeAnnotation("dead-1", "notes/a.md", { deletedAt: 900, updatedAt: 900 }),
    ];
    const text = serializeAnnotationEnvelope(buildEnvelope(annotations));
    const parsed = parseAnnotationEnvelope(text);
    const roundTripped = parsed.documents.flatMap((doc) => doc.annotations);
    expect(roundTripped).toHaveLength(annotations.length);
    for (const original of annotations) {
      const match = roundTripped.find((item) => item.id === original.id);
      expect(match).toEqual(original);
    }

    // Importing an export of the same store must change nothing.
    const plan = planAnnotationImport(parsed, {
      existing: annotations,
      presentPaths: new Set(["notes/a.md", "paper.pdf", "book.epub"]),
    });
    expect(plan.toUpsert).toEqual([]);
    expect(plan.added).toBe(0);
    expect(plan.updated).toBe(0);
    expect(plan.deletions).toBe(0);
    expect(plan.skipped).toBe(annotations.length);
    expect(plan.rebindSuggestions).toEqual([]);
    expect(plan.fingerprintRows).toEqual([]);
  });
});

describe("parseAnnotationEnvelope validation", () => {
  const validText = () => serializeAnnotationEnvelope(buildEnvelope([makeAnnotation("a1", "notes/a.md")]));

  function mutate(mutator: (raw: Record<string, unknown>) => void): string {
    const raw = JSON.parse(validText()) as Record<string, unknown>;
    mutator(raw);
    return JSON.stringify(raw);
  }

  it("rejects non-JSON and non-envelope payloads", () => {
    expect(() => parseAnnotationEnvelope("not json")).toThrow(/JSON/);
    expect(() => parseAnnotationEnvelope("[1,2,3]")).toThrow(/标注导出文件/);
    expect(() => parseAnnotationEnvelope(JSON.stringify({ type: "other" }))).toThrow(
      /Reade 标注导出文件/,
    );
  });

  it("rejects unknown format versions", () => {
    expect(() =>
      parseAnnotationEnvelope(mutate((raw) => (raw.formatVersion = 2))),
    ).toThrow(/格式版本/);
    expect(() =>
      parseAnnotationEnvelope(mutate((raw) => (raw.formatVersion = "1"))),
    ).toThrow(/格式版本/);
  });

  it("rejects bad top-level fields", () => {
    expect(() => parseAnnotationEnvelope(mutate((raw) => (raw.exportedAt = -5)))).toThrow(
      /exportedAt/,
    );
    expect(() => parseAnnotationEnvelope(mutate((raw) => (raw.deviceId = 42)))).toThrow(
      /deviceId/,
    );
    expect(() =>
      parseAnnotationEnvelope(mutate((raw) => (raw.includeDeleted = "yes"))),
    ).toThrow(/includeDeleted/);
    expect(() => parseAnnotationEnvelope(mutate((raw) => (raw.documents = {})))).toThrow(
      /documents/,
    );
  });

  it("rejects unsafe relative paths", () => {
    for (const path of ["../escape.md", "/abs.md", "a\\b.md", "https://evil"]) {
      expect(() =>
        parseAnnotationEnvelope(
          mutate((raw) => {
            (raw.documents as Array<Record<string, unknown>>)[0].relativePath = path;
          }),
        ),
      ).toThrow(/relativePath/);
    }
  });

  it("rejects field type and length violations", () => {
    const firstAnnotation = (raw: Record<string, unknown>) =>
      ((raw.documents as Array<Record<string, unknown>>)[0].annotations as Array<
        Record<string, unknown>
      >)[0];
    expect(() =>
      parseAnnotationEnvelope(mutate((raw) => (firstAnnotation(raw).id = "bad id!"))),
    ).toThrow(/id 无效/);
    expect(() =>
      parseAnnotationEnvelope(mutate((raw) => (firstAnnotation(raw).kind = "wavy"))),
    ).toThrow(/kind 不受支持/);
    expect(() =>
      parseAnnotationEnvelope(mutate((raw) => (firstAnnotation(raw).color = "red"))),
    ).toThrow(/color 不受支持/);
    expect(() =>
      parseAnnotationEnvelope(mutate((raw) => (firstAnnotation(raw).note = "x".repeat(4001)))),
    ).toThrow(/note/);
    expect(() =>
      parseAnnotationEnvelope(mutate((raw) => (firstAnnotation(raw).createdAt = 1.5))),
    ).toThrow(/createdAt/);
    expect(() =>
      parseAnnotationEnvelope(mutate((raw) => (firstAnnotation(raw).sortIndex = "garbage"))),
    ).toThrow(/sortIndex/);
    expect(() =>
      parseAnnotationEnvelope(
        mutate((raw) => {
          (firstAnnotation(raw).locator as Record<string, unknown>).quote = "x".repeat(2001);
        }),
      ),
    ).toThrow(/quote/);
    expect(() =>
      parseAnnotationEnvelope(
        mutate((raw) => {
          (firstAnnotation(raw).locator as Record<string, unknown>).kind = "xpath";
        }),
      ),
    ).toThrow(/locator.kind/);
  });

  it("rejects kind/locator/color mismatches", () => {
    expect(() =>
      parseAnnotationEnvelope(
        mutate((raw) => {
          const record = ((raw.documents as Array<Record<string, unknown>>)[0]
            .annotations as Array<Record<string, unknown>>)[0];
          record.kind = "bookmark";
        }),
      ),
    ).toThrow(/书签/);
    expect(() =>
      parseAnnotationEnvelope(
        mutate((raw) => {
          const record = ((raw.documents as Array<Record<string, unknown>>)[0]
            .annotations as Array<Record<string, unknown>>)[0];
          record.color = null;
        }),
      ),
    ).toThrow(/颜色/);
  });

  it("rejects duplicate ids and duplicate document paths", () => {
    const twoDocs = buildEnvelope([
      makeAnnotation("dup", "notes/a.md"),
      makeAnnotation("other", "notes/b.md"),
    ]);
    const raw = JSON.parse(serializeAnnotationEnvelope(twoDocs)) as {
      documents: Array<{ relativePath: string; annotations: Array<{ id: string }> }>;
    };
    raw.documents[1].annotations[0].id = "dup";
    expect(() => parseAnnotationEnvelope(JSON.stringify(raw))).toThrow(/重复的标注 id/);

    const rawPaths = JSON.parse(serializeAnnotationEnvelope(twoDocs)) as {
      documents: Array<{ relativePath: string }>;
    };
    rawPaths.documents[1].relativePath = "notes/a.md";
    expect(() => parseAnnotationEnvelope(JSON.stringify(rawPaths))).toThrow(/重复的文档路径/);
  });

  it("rejects envelopes above the annotation cap without partial results", () => {
    const raw = JSON.parse(validText()) as {
      documents: Array<{ annotations: unknown[] }>;
    };
    const template = raw.documents[0].annotations[0] as Record<string, unknown>;
    raw.documents[0].annotations = Array.from(
      { length: MAX_TRANSFER_ANNOTATIONS + 1 },
      (_, index) => ({ ...template, id: `ann-${index}` }),
    );
    expect(() => parseAnnotationEnvelope(JSON.stringify(raw))).toThrow(/上限/);
  });

  it("rejects tombstones inside includeDeleted:false envelopes", () => {
    const text = mutate((raw) => {
      raw.includeDeleted = false;
      const record = ((raw.documents as Array<Record<string, unknown>>)[0]
        .annotations as Array<Record<string, unknown>>)[0];
      record.deletedAt = 999;
    });
    expect(() => parseAnnotationEnvelope(text)).toThrow(/墓碑/);
  });

  it("rejects malformed content hashes and ignores unknown fields", () => {
    expect(() =>
      parseAnnotationEnvelope(
        mutate((raw) => {
          (raw.documents as Array<Record<string, unknown>>)[0].contentHash = "md5:abc";
        }),
      ),
    ).toThrow(/contentHash/);
    // `__proto__` must be spliced in as JSON text: assigning it on a live JS
    // object would set the prototype instead of an own key.
    const dirty = mutate((raw) => {
      raw.unknownTopLevel = { nested: true };
      const record = ((raw.documents as Array<Record<string, unknown>>)[0]
        .annotations as Array<Record<string, unknown>>)[0];
      record.customField = "junk";
    }).replace('"customField":"junk"', '"customField":"junk","__proto__":{"polluted":true}');
    const parsed = parseAnnotationEnvelope(dirty);
    const record = parsed.documents[0].annotations[0] as unknown as Record<string, unknown>;
    expect(record.customField).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(record, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("derives a missing sortIndex instead of failing", () => {
    const parsed = parseAnnotationEnvelope(
      mutate((raw) => {
        const record = ((raw.documents as Array<Record<string, unknown>>)[0]
          .annotations as Array<Record<string, unknown>>)[0];
        delete record.sortIndex;
      }),
    );
    expect(parsed.documents[0].annotations[0].sortIndex).toBe("M|00000|00001024");
  });
});

describe("planAnnotationImport (Q6 branches)", () => {
  const present = new Set(["notes/a.md", "notes/b.md"]);

  it("adds brand-new annotations", () => {
    const envelope = buildEnvelope([makeAnnotation("new-1", "notes/a.md")]);
    const plan = planAnnotationImport(envelope, { existing: [], presentPaths: present });
    expect(plan.added).toBe(1);
    expect(plan.toUpsert.map((item) => item.id)).toEqual(["new-1"]);
    expect(plan.skipped + plan.updated + plan.deletions).toBe(0);
  });

  it("skips content-fingerprint duplicates under different ids", () => {
    const local = makeAnnotation("local-id", "notes/a.md");
    const incoming = makeAnnotation("other-id", "notes/a.md", { note: "different note" });
    const plan = planAnnotationImport(buildEnvelope([incoming]), {
      existing: [local],
      presentPaths: present,
    });
    expect(plan.skipped).toBe(1);
    expect(plan.toUpsert).toEqual([]);
  });

  it("skips duplicate fingerprints inside one envelope", () => {
    const first = makeAnnotation("dup-1", "notes/a.md");
    const second = makeAnnotation("dup-2", "notes/a.md", { note: "same quote+start" });
    const plan = planAnnotationImport(buildEnvelope([first, second]), {
      existing: [],
      presentPaths: present,
    });
    expect(plan.added).toBe(1);
    expect(plan.skipped).toBe(1);
    expect(plan.toUpsert.map((item) => item.id)).toEqual(["dup-1"]);
  });

  it("applies updatedAt LWW on id conflicts in both directions", () => {
    const local = makeAnnotation("shared", "notes/a.md", { updatedAt: 500, note: "local" });
    const newer = makeAnnotation("shared", "notes/a.md", { updatedAt: 900, note: "newer" });
    const older = makeAnnotation("shared", "notes/a.md", { updatedAt: 200, note: "older" });

    const win = planAnnotationImport(buildEnvelope([newer]), {
      existing: [local],
      presentPaths: present,
    });
    expect(win.updated).toBe(1);
    expect(win.toUpsert[0].note).toBe("newer");

    const lose = planAnnotationImport(buildEnvelope([older]), {
      existing: [local],
      presentPaths: present,
    });
    expect(lose.skipped).toBe(1);
    expect(lose.toUpsert).toEqual([]);

    const tie = planAnnotationImport(buildEnvelope([makeAnnotation("shared", "notes/a.md", { updatedAt: 500 })]), {
      existing: [local],
      presentPaths: present,
    });
    expect(tie.skipped).toBe(1);
    expect(tie.toUpsert).toEqual([]);
  });

  it("propagates tombstones over older live records, local newer edits win", () => {
    const localLive = makeAnnotation("gone", "notes/a.md", { updatedAt: 500 });
    const tombstone = makeAnnotation("gone", "notes/a.md", { updatedAt: 900, deletedAt: 900 });
    const plan = planAnnotationImport(buildEnvelope([tombstone]), {
      existing: [localLive],
      presentPaths: present,
    });
    expect(plan.deletions).toBe(1);
    expect(plan.toUpsert[0].deletedAt).toBe(900);

    // The local record was edited after the remote deletion: local wins.
    const editedLocal = makeAnnotation("gone", "notes/a.md", { updatedAt: 1200 });
    const keep = planAnnotationImport(buildEnvelope([tombstone]), {
      existing: [editedLocal],
      presentPaths: present,
    });
    expect(keep.skipped).toBe(1);
    expect(keep.deletions).toBe(0);
  });

  it("keeps unknown-id tombstones so older live copies cannot resurrect later", () => {
    const tombstone = makeAnnotation("never-seen", "notes/a.md", {
      updatedAt: 900,
      deletedAt: 900,
    });
    const plan = planAnnotationImport(buildEnvelope([tombstone]), {
      existing: [],
      presentPaths: present,
    });
    expect(plan.deletions).toBe(1);
    expect(plan.toUpsert.map((item) => item.id)).toEqual(["never-seen"]);
  });

  it("excludes tombstones from the fingerprint set (deliberate resurrection)", () => {
    const localTombstone = makeAnnotation("was-deleted", "notes/a.md", {
      updatedAt: 800,
      deletedAt: 800,
    });
    const recreated = makeAnnotation("fresh-id", "notes/a.md", { updatedAt: 900 });
    const plan = planAnnotationImport(buildEnvelope([recreated]), {
      existing: [localTombstone],
      presentPaths: present,
    });
    expect(plan.added).toBe(1);
    expect(plan.toUpsert.map((item) => item.id)).toEqual(["fresh-id"]);
  });

  it("suggests rebinding when the content hash matches a different present path", () => {
    const moved = makeAnnotation("moved-1", "old/location.md");
    const envelope = buildEnvelope([moved], {
      contentHashes: new Map([["old/location.md", HASH_A]]),
    });
    const plan = planAnnotationImport(envelope, {
      existing: [],
      presentPaths: present,
      presentHashes: new Map([
        ["notes/a.md", HASH_A],
        ["notes/b.md", HASH_B],
      ]),
    });
    // The record still imports under its original path; only a suggestion
    // plus the fingerprint row for the move-detection chain are added.
    expect(plan.added).toBe(1);
    expect(plan.toUpsert[0].relativePath).toBe("old/location.md");
    expect(plan.rebindSuggestions).toEqual([
      { oldPath: "old/location.md", candidates: ["notes/a.md"], annotationCount: 1 },
    ]);
    expect(plan.fingerprintRows).toEqual([
      { relativePath: "old/location.md", contentHash: HASH_A },
    ]);
  });

  it("records fingerprint rows for missing paths even without a hash match", () => {
    const lost = makeAnnotation("lost-1", "gone/doc.md");
    const envelope = buildEnvelope([lost], {
      contentHashes: new Map([["gone/doc.md", HASH_B]]),
    });
    const plan = planAnnotationImport(envelope, {
      existing: [],
      presentPaths: present,
      presentHashes: new Map([["notes/a.md", HASH_A]]),
    });
    expect(plan.rebindSuggestions).toEqual([]);
    expect(plan.fingerprintRows).toEqual([
      { relativePath: "gone/doc.md", contentHash: HASH_B },
    ]);
  });

  it("summarizes the five counters", () => {
    const plan = {
      toUpsert: [],
      fingerprintRows: [],
      added: 3,
      skipped: 2,
      updated: 1,
      deletions: 4,
      rebindSuggestions: [{ oldPath: "a", candidates: ["b"], annotationCount: 1 }],
    };
    expect(summarizeImportPlan(plan)).toBe("新增 3、跳过 2、更新 1、删除传播 4；1 个文档建议重绑");
  });
});

describe("annotationContentFingerprint", () => {
  it("distinguishes kinds, quotes and positions but ignores notes and colors", () => {
    const base = makeAnnotation("x", "notes/a.md");
    expect(annotationContentFingerprint(base)).toBe(
      annotationContentFingerprint(makeAnnotation("y", "notes/a.md", { note: "different", color: "blue" })),
    );
    expect(annotationContentFingerprint(base)).not.toBe(
      annotationContentFingerprint(makeAnnotation("y", "notes/a.md", { kind: "underline" })),
    );
    expect(annotationContentFingerprint(base)).not.toBe(
      annotationContentFingerprint(
        makeAnnotation("y", "notes/a.md", {
          locator: { ...base.locator, start: 99 } as Annotation["locator"],
        }),
      ),
    );
    // Two bookmarks at different targets must not collide.
    expect(annotationContentFingerprint(makeBookmark("b1", "notes/a.md"))).not.toBe(
      annotationContentFingerprint(
        makeBookmark("b2", "notes/a.md", {
          locator: {
            kind: "bookmark",
            target: { format: "markdown", headingId: null, scrollRatio: 0.9 },
          },
        }),
      ),
    );
  });
});

describe("buildReadwiseCsv", () => {
  it("writes the Readwise import columns and per-document ordinals", () => {
    const annotations = [
      makeAnnotation("m2", "notes/a.md", {
        sortIndex: "M|00000|00002000",
        selectedText: "second",
        createdAt: 1_700_000_000_000,
      }),
      makeAnnotation("m1", "notes/a.md", {
        sortIndex: "M|00000|00000005",
        selectedText: "first",
        note: "note one",
        createdAt: 1_700_000_000_000,
      }),
      makeAnnotation("p1", "paper.pdf", {
        selectedText: "pdf text",
        createdAt: 1_700_000_000_000,
        locator: {
          kind: "pdf",
          page: 7,
          view: "original",
          quote: "pdf text",
          prefix: "",
          suffix: "",
          rects: [],
        },
        sortIndex: "P|00007|00000000",
      }),
    ];
    const { csv, rows } = buildReadwiseCsv(annotations, {
      documentTitles: new Map([["notes/a.md", "A 文档"]]),
    });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(READWISE_CSV_HEADER);
    expect(rows).toBe(3);
    expect(lines[1]).toBe("first,A 文档,,,note one,1,2023-11-14T22:13:20.000Z");
    expect(lines[2]).toBe("second,A 文档,,,,2,2023-11-14T22:13:20.000Z");
    // PDF rows carry the page number, and the missing title falls back to the file name.
    expect(lines[3]).toBe("pdf text,paper.pdf,,,,7,2023-11-14T22:13:20.000Z");
    expect(lines[4]).toBe("");
  });

  it("excludes bookmarks and tombstones", () => {
    const { csv, rows } = buildReadwiseCsv([
      makeBookmark("bm", "notes/a.md"),
      makeAnnotation("dead", "notes/a.md", { deletedAt: 100 }),
      makeAnnotation("blank", "notes/a.md", { selectedText: "   " }),
    ]);
    expect(rows).toBe(0);
    expect(csv).toBe(`${READWISE_CSV_HEADER}\r\n`);
  });

  it("escapes quotes, separators and newlines per RFC 4180", () => {
    const { csv } = buildReadwiseCsv([
      makeAnnotation("tricky", "notes/a.md", {
        selectedText: 'He said "hi", then\nleft',
        note: "простой, note",
        createdAt: 1_700_000_000_000,
      }),
    ]);
    const body = csv.split("\r\n")[1];
    expect(body).toBe(
      '"He said ""hi"", then\nleft",a.md,,,"простой, note",1,2023-11-14T22:13:20.000Z',
    );
  });

  it("neutralizes leading formula characters (CSV injection)", () => {
    const dangerous = ["=SUM(A1:A9)", "+1234", "-cmd", "@import", "\tleading-tab"];
    for (const text of dangerous) {
      const { csv } = buildReadwiseCsv([
        makeAnnotation("inj", "notes/a.md", { selectedText: text, createdAt: 1 }),
      ]);
      const firstField = csv.split("\r\n")[1];
      expect(firstField.startsWith("'") || firstField.startsWith("\"'")).toBe(true);
    }
  });
});

describe("getOrCreateDeviceId", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      data,
    };
  }

  it("generates a UUID once and returns the same id afterwards", () => {
    const storage = fakeStorage();
    const first = getOrCreateDeviceId(storage);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(storage.data.get(DEVICE_ID_STORAGE_KEY)).toBe(first);
    expect(getOrCreateDeviceId(storage)).toBe(first);
  });

  it("replaces invalid stored values", () => {
    const storage = fakeStorage({ [DEVICE_ID_STORAGE_KEY]: "not-a-uuid" });
    const id = getOrCreateDeviceId(storage);
    expect(id).not.toBe("not-a-uuid");
    expect(storage.data.get(DEVICE_ID_STORAGE_KEY)).toBe(id);
  });

  it("degrades to an ephemeral id when storage is unavailable", () => {
    expect(getOrCreateDeviceId(null)).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
