// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backend", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/backend")>();
  return {
    ...original,
    listCollections: vi.fn(async () => []),
    createCollection: vi.fn(),
    renameCollection: vi.fn(async () => undefined),
    deleteCollection: vi.fn(async () => undefined),
    listCollectionItems: vi.fn(async () => []),
    addCollectionItem: vi.fn(),
    removeCollectionItem: vi.fn(async () => undefined),
    reorderCollectionItems: vi.fn(async () => undefined),
  };
});

import {
  addCollectionItem,
  createCollection,
  deleteCollection,
  listCollectionItems,
  listCollections,
  removeCollectionItem,
  reorderCollectionItems,
  type CollectionItem,
  type CollectionSummary,
  type DocumentInfo,
} from "../lib/backend";
import { writeReadingPosition } from "../lib/readingPositions";
import {
  collectionProgressLabel,
  CollectionMembershipPopover,
  CollectionsSection,
} from "./CollectionsSection";

const ROOT = "D:\\library";

function summary(overrides: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id: "col-1",
    name: "考研数学",
    createdAt: 1_000,
    updatedAt: 1_000,
    itemCount: 2,
    presentCount: 1,
    ...overrides,
  };
}

function item(overrides: Partial<CollectionItem> = {}): CollectionItem {
  return {
    relativePath: "math/notes.md",
    position: 0,
    addedAt: 1_000,
    present: true,
    ...overrides,
  };
}

function documentInfo(relativePath: string, overrides: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    relativePath,
    title: relativePath.split("/").pop() ?? relativePath,
    size: 100,
    modified: 1,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
    ...overrides,
  };
}

const documents = [
  documentInfo("math/notes.md", { title: "数学笔记" }),
  documentInfo("papers/exam.pdf", { title: "真题卷", format: "pdf" }),
];

function renderSection(overrides: Partial<Parameters<typeof CollectionsSection>[0]> = {}) {
  return render(
    <CollectionsSection
      rootPath={ROOT}
      documents={documents}
      refreshToken={0}
      onNotice={vi.fn()}
      onSelectDocument={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(listCollections).mockReset().mockResolvedValue([]);
  vi.mocked(createCollection)
    .mockReset()
    .mockImplementation(async (id, name) => ({
      id,
      name,
      createdAt: 1,
      updatedAt: 1,
    }));
  vi.mocked(deleteCollection).mockReset().mockResolvedValue(undefined);
  vi.mocked(listCollectionItems).mockReset().mockResolvedValue([]);
  vi.mocked(addCollectionItem)
    .mockReset()
    .mockImplementation(async (_collectionId, relativePath) => ({
      relativePath,
      position: 0,
      addedAt: 1,
      present: true,
    }));
  vi.mocked(removeCollectionItem).mockReset().mockResolvedValue(undefined);
  vi.mocked(reorderCollectionItems).mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("collectionProgressLabel", () => {
  it("maps positions to percent / page labels and hides empty ones", () => {
    expect(
      collectionProgressLabel({
        kind: "scroll",
        scrollRatio: 0.31,
        maxScrollRatio: 0.62,
        updatedAt: 1,
      }),
    ).toBe("62%");
    expect(
      collectionProgressLabel({ kind: "pdf", page: 3, offsetRatio: 0, maxPage: 12, updatedAt: 1 }),
    ).toBe("第 12 页");
    expect(collectionProgressLabel(null)).toBeNull();
    expect(
      collectionProgressLabel({
        kind: "scroll",
        scrollRatio: 0,
        maxScrollRatio: 0,
        updatedAt: 1,
      }),
    ).toBeNull();
  });
});

describe("CollectionsSection", () => {
  it("loads lazily on expand and creates a collection inline", async () => {
    renderSection();
    expect(listCollections).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "合集" }));
    await screen.findByText("还没有合集。点「+」新建一个跨文件夹的阅读清单。");

    vi.mocked(listCollections).mockResolvedValue([summary({ name: "组会论文" })]);
    fireEvent.click(screen.getByRole("button", { name: "新建合集" }));
    fireEvent.change(screen.getByRole("textbox", { name: "合集名称" }), {
      target: { value: "组会论文" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "合集名称" }), { key: "Enter" });

    await waitFor(() => {
      expect(createCollection).toHaveBeenCalledWith(expect.any(String), "组会论文");
    });
    expect(await screen.findByText("组会论文")).toBeInTheDocument();
  });

  it("expands a collection with items, progress badges and greyed missing entries", async () => {
    vi.mocked(listCollections).mockResolvedValue([summary()]);
    vi.mocked(listCollectionItems).mockResolvedValue([
      item(),
      item({ relativePath: "gone/lost.md", position: 1, present: false }),
    ]);
    writeReadingPosition(ROOT, "math/notes.md", { kind: "scroll", scrollRatio: 0.62 });
    const onSelectDocument = vi.fn();
    renderSection({ onSelectDocument });

    fireEvent.click(screen.getByRole("button", { name: "合集" }));
    // 健康度徽标 presentCount/itemCount。
    expect(await screen.findByText("1/2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /考研数学/ }));
    await waitFor(() => {
      expect(listCollectionItems).toHaveBeenCalledWith("col-1");
    });

    const openButton = await screen.findByTitle("math/notes.md");
    expect(screen.getByText("62%")).toBeInTheDocument();
    fireEvent.click(openButton);
    expect(onSelectDocument).toHaveBeenCalledWith("math/notes.md");

    // 失联条目:回退文件名、灰显、不可点。
    const missing = screen.getByTitle(/gone\/lost\.md（文档已移动或删除）/);
    expect(missing).toBeDisabled();
    expect(missing.closest(".collection-item")).toHaveClass("collection-item--missing");
  });

  it("expands the section and the target collection on a reveal request (CP-D2)", async () => {
    vi.mocked(listCollections).mockResolvedValue([summary()]);
    vi.mocked(listCollectionItems).mockResolvedValue([item()]);
    const view = renderSection();
    expect(listCollections).not.toHaveBeenCalled();

    // 命令面板执行"切换到合集":无需任何点击,分区与目标合集直接展开。
    view.rerender(
      <CollectionsSection
        rootPath={ROOT}
        documents={documents}
        refreshToken={0}
        reveal={{ id: "col-1", token: 1 }}
        onNotice={vi.fn()}
        onSelectDocument={vi.fn()}
      />,
    );

    expect(await screen.findByTitle("math/notes.md")).toBeInTheDocument();
    expect(listCollectionItems).toHaveBeenCalledWith("col-1");
  });

  it("reorders through the move buttons with a full-order commit (CO-D4)", async () => {
    vi.mocked(listCollections).mockResolvedValue([summary()]);
    vi.mocked(listCollectionItems).mockResolvedValue([
      item(),
      item({ relativePath: "papers/exam.pdf", position: 1 }),
    ]);
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "合集" }));
    fireEvent.click(await screen.findByRole("button", { name: /考研数学/ }));
    await screen.findByTitle("math/notes.md");

    fireEvent.click(screen.getByRole("button", { name: "下移 数学笔记" }));
    await waitFor(() => {
      expect(reorderCollectionItems).toHaveBeenCalledWith("col-1", [
        "papers/exam.pdf",
        "math/notes.md",
      ]);
    });
    // 乐观更新后顺序立即翻转。
    const titles = Array.from(
      document.querySelectorAll(".collection-item-title"),
    ).map((node) => node.textContent);
    expect(titles).toEqual(["真题卷", "数学笔记"]);
  });

  it("deletes only after the docs-are-safe confirm wording", async () => {
    vi.mocked(listCollections).mockResolvedValue([summary()]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      renderSection();
      fireEvent.click(screen.getByRole("button", { name: "合集" }));
      fireEvent.click(await screen.findByRole("button", { name: /考研数学/ }));
      fireEvent.click(await screen.findByRole("button", { name: "删除" }));

      expect(confirmSpy).toHaveBeenCalledWith(
        "删除合集「考研数学」？清单内 2 篇文档本身不会被删除。",
      );
      expect(deleteCollection).not.toHaveBeenCalled();

      confirmSpy.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "删除" }));
      await waitFor(() => {
        expect(deleteCollection).toHaveBeenCalledWith("col-1");
      });
    } finally {
      confirmSpy.mockRestore();
    }
  });
});

describe("CollectionMembershipPopover", () => {
  it("checks membership per collection and toggles add/remove", async () => {
    vi.mocked(listCollections).mockResolvedValue([
      summary(),
      summary({ id: "col-2", name: "组会论文", itemCount: 0, presentCount: 0 }),
    ]);
    vi.mocked(listCollectionItems).mockImplementation(async (collectionId: string) =>
      collectionId === "col-1" ? [item({ relativePath: "math/notes.md" })] : [],
    );
    const onChanged = vi.fn();
    render(
      <CollectionMembershipPopover
        currentPath="math/notes.md"
        onClose={vi.fn()}
        onChanged={onChanged}
        onNotice={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "加入合集" });
    const inCollection = await within(dialog).findByRole("checkbox", { name: /考研数学/ });
    const notInCollection = within(dialog).getByRole("checkbox", { name: /组会论文/ });
    expect(inCollection).toBeChecked();
    expect(notInCollection).not.toBeChecked();

    fireEvent.click(notInCollection);
    await waitFor(() => {
      expect(addCollectionItem).toHaveBeenCalledWith("col-2", "math/notes.md");
    });
    expect(onChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(inCollection);
    await waitFor(() => {
      expect(removeCollectionItem).toHaveBeenCalledWith("col-1", "math/notes.md");
    });
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("creates a collection and adds the current document in one step", async () => {
    vi.mocked(listCollections).mockResolvedValue([]);
    const onChanged = vi.fn();
    const onNotice = vi.fn();
    render(
      <CollectionMembershipPopover
        currentPath="papers/exam.pdf"
        onClose={vi.fn()}
        onChanged={onChanged}
        onNotice={onNotice}
      />,
    );

    await screen.findByText("还没有合集，在下方直接新建并加入。");
    fireEvent.change(screen.getByRole("textbox", { name: "新建合集并加入" }), {
      target: { value: "本周精读" },
    });
    fireEvent.click(screen.getByRole("button", { name: "新建并加入" }));

    await waitFor(() => {
      expect(createCollection).toHaveBeenCalledWith(expect.any(String), "本周精读");
    });
    const createdId = vi.mocked(createCollection).mock.calls[0][0];
    expect(addCollectionItem).toHaveBeenCalledWith(createdId, "papers/exam.pdf");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith("已加入新合集「本周精读」");
  });
});
