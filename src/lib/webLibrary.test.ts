import { describe, expect, it, vi } from "vitest";
import {
  WebLibraryClient,
  WebLibraryRequestError,
  encodeLibraryRelativePath,
  searchWebDocuments,
  validateLibraryRelativePath,
  webLibraryUrl,
  type WebLibraryManifest,
  type WebSearchDocument,
} from "./webLibrary";

function response(options: {
  status?: number;
  json?: unknown;
  text?: string;
  bytes?: number[];
  contentType?: string;
}): Response {
  const status = options.status ?? 200;
  const bytes = new Uint8Array(options.bytes ?? []);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(options.contentType ? { "content-type": options.contentType } : {}),
    json: async () => options.json,
    text: async () => options.text ?? "",
    arrayBuffer: async () => bytes.buffer,
  } as Response;
}

const manifest: WebLibraryManifest = {
  schemaVersion: 2,
  title: "中文文档库",
  generatedAt: "2026-08-09T00:00:00.000Z",
  documents: [
    {
      relativePath: "指南/开始 阅读.md",
      title: "开始阅读",
      size: 10,
      modified: 1,
      format: "markdown",
      indexStatus: "ready",
      indexError: null,
    },
  ],
};

describe("web library paths", () => {
  it("encodes every path segment without losing Chinese characters or spaces", () => {
    expect(encodeLibraryRelativePath("指南/开始 阅读.md")).toBe(
      "%E6%8C%87%E5%8D%97/%E5%BC%80%E5%A7%8B%20%E9%98%85%E8%AF%BB.md",
    );
    expect(webLibraryUrl("指南/开始 阅读.md", "/docs/reade-web")).toBe(
      "/docs/reade-web/library/%E6%8C%87%E5%8D%97/%E5%BC%80%E5%A7%8B%20%E9%98%85%E8%AF%BB.md",
    );
  });

  it.each(["../secret.md", "/absolute.md", "C:/secret.md", "a\\b.md", "a//b.md", "./a.md"])(
    "rejects unsafe path %s",
    (path) => expect(() => validateLibraryRelativePath(path)).toThrow(),
  );
});

describe("WebLibraryClient", () => {
  it("loads and caches a validated manifest", async () => {
    const fetcher = vi.fn(async () => response({ json: manifest }));
    const client = new WebLibraryClient({ baseUrl: "/reade-web", fetcher });

    await expect(client.loadManifest()).resolves.toEqual(manifest);
    await client.loadManifest();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/reade-web/manifest.json", {
      headers: { Accept: "application/json" },
    });
  });

  it("loads UTF-8 documents and base64 assets from encoded URLs", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response({ text: "# 中文" }))
      .mockResolvedValueOnce(response({ bytes: [1, 2, 3], contentType: "image/png; charset=binary" }));
    const client = new WebLibraryClient({ baseUrl: "/reade-web/", fetcher });

    await expect(client.loadDocument("指南/开始 阅读.md")).resolves.toEqual({
      kind: "markdown",
      relativePath: "指南/开始 阅读.md",
      markdown: "# 中文",
    });
    await expect(client.loadAsset("图片/封面 图.png")).resolves.toEqual({
      relativePath: "图片/封面 图.png",
      mimeType: "image/png",
      data: "AQID",
    });
    expect(fetcher.mock.calls[0][0]).toContain("%E6%8C%87%E5%8D%97/%E5%BC%80%E5%A7%8B%20%E9%98%85%E8%AF%BB.md");
  });

  it("reports non-ok and malformed responses with request context", async () => {
    const missing = new WebLibraryClient({
      fetcher: vi.fn(async () => response({ status: 404 })),
    });
    await expect(missing.loadManifest()).rejects.toMatchObject({
      name: "WebLibraryRequestError",
      status: 404,
      url: "./reade-web/manifest.json",
    });

    const malformed = new WebLibraryClient({
      fetcher: vi.fn(async () => response({
        json: { ...manifest, documents: [{ ...manifest.documents[0], relativePath: "../escape.md" }] },
      })),
    });
    await expect(malformed.loadManifest()).rejects.toBeInstanceOf(WebLibraryRequestError);
  });
});

describe("searchWebDocuments", () => {
  const documents: WebSearchDocument[] = [
    { relativePath: "指南/阅读.md", title: "长文阅读", content: "中文长文需要舒适的行高与版心。" },
    { relativePath: "notes/search.md", title: "Search", content: "Search local Markdown files." },
    { relativePath: "指南/混排.md", title: "中英混排", content: "Markdown 长文也可以全文检索。" },
  ];

  it("supports Chinese AND queries, snippets and limits", () => {
    const results = searchWebDocuments(documents, "中文 长文", 1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ relativePath: "指南/阅读.md", title: "长文阅读" });
    expect(results[0].snippet).toContain("中文长文");
  });

  it("is case-insensitive and returns no results for empty or zero-limit searches", () => {
    expect(searchWebDocuments(documents, "MARKDOWN")).toHaveLength(2);
    expect(searchWebDocuments(documents, "  ")).toEqual([]);
    expect(searchWebDocuments(documents, "Markdown", 0)).toEqual([]);
  });
});
