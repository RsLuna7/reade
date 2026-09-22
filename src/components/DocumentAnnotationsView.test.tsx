// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentAnnotationsView } from "./DocumentAnnotationsView";
import type { DocumentAnnotationBundle, Excerpt } from "../lib/annotationModel";

afterEach(() => {
  cleanup();
});

function excerpt(overrides: Partial<Excerpt> = {}): Excerpt {
  return {
    id: "ex-1",
    relativePath: "guide.md",
    sourceText: "Why documents need a map",
    anchor: {
      format: "markdown",
      quote: { exact: "Why documents need a map", prefix: "", suffix: "" },
      headingId: "why",
    },
    sourceRevision: null,
    appearance: { style: "highlight", tone: "sand" },
    sortIndex: "M|00000|00000010",
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    legacyKind: "highlight",
    legacyColor: "yellow",
    legacyTitle: null,
    legacySelectedText: "Why documents need a map",
    ...overrides,
  };
}

const bundle: DocumentAnnotationBundle = {
  excerpts: [
    excerpt(),
    excerpt({
      id: "ex-2",
      sourceText: "Four colors were a mistake",
      anchor: {
        format: "markdown",
        quote: { exact: "Four colors were a mistake", prefix: "", suffix: "" },
        headingId: "colors",
      },
      sortIndex: "M|00000|00000100",
    }),
  ],
  places: [],
  reflections: [
    {
      entryId: "ex-1",
      entryKind: "excerpt",
      body: "This is the part I keep returning to.",
      createdAt: 2,
      updatedAt: 2,
      deletedAt: null,
    },
  ],
  reviewEnrollments: [],
};

describe("DocumentAnnotationsView", () => {
  it("groups excerpts by heading and lets the user write a reflection", async () => {
    const onJump = vi.fn();
    const onSaveReflection = vi.fn(async () => undefined);
    const onSetEnrollment = vi.fn(async () => undefined);
    render(
      <DocumentAnnotationsView
        format="markdown"
        toc={[
          { id: "why", title: "Why a map", level: 1 },
          { id: "colors", title: "Four colors", level: 1 },
        ]}
        currentHeadingId="why"
        bundle={bundle}
        loading={false}
        onJump={onJump}
        onSaveReflection={onSaveReflection}
        onSetEnrollment={onSetEnrollment}
      />,
    );

    expect(screen.getByText(/2 条重点/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Why a map/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "看感悟" }));
    fireEvent.change(screen.getByRole("textbox", { name: "感悟" }), {
      target: { value: "A later thought." },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存感悟" }));
    expect(onSaveReflection).toHaveBeenCalledWith("ex-1", "excerpt", "A later thought.");
    fireEvent.click(screen.getByRole("button", { name: "加入间隔回顾" }));
    expect(onSetEnrollment).toHaveBeenCalledWith("ex-1", true);

    fireEvent.click(screen.getByRole("tab", { name: "我的感悟" }));
    expect(screen.getByText("Why documents need a map")).toBeInTheDocument();
    expect(screen.queryByText("Four colors were a mistake")).not.toBeInTheDocument();
  });

  it("groups PDF excerpts into page bands when outline TOC is empty", () => {
    const pdfBundle: DocumentAnnotationBundle = {
      excerpts: [
        excerpt({
          id: "pdf-1",
          relativePath: "paper.pdf",
          sourceText: "Page three quote",
          anchor: {
            format: "pdfText",
            page: 3,
            view: "original",
            quote: { exact: "Page three quote", prefix: "", suffix: "" },
            rects: [{ x: 0.1, y: 0.1, w: 0.4, h: 0.02 }],
          },
          sortIndex: "P|00003|00000000",
        }),
        excerpt({
          id: "pdf-2",
          relativePath: "paper.pdf",
          sourceText: "Page forty-one quote",
          anchor: {
            format: "pdfText",
            page: 41,
            view: "original",
            quote: { exact: "Page forty-one quote", prefix: "", suffix: "" },
            rects: [{ x: 0.2, y: 0.2, w: 0.3, h: 0.02 }],
          },
          sortIndex: "P|00041|00000000",
        }),
      ],
      places: [],
      reflections: [],
      reviewEnrollments: [],
    };
    render(
      <DocumentAnnotationsView
        format="pdf"
        toc={[]}
        currentHeadingId="pdf-page-41"
        currentPage={41}
        bundle={pdfBundle}
        loading={false}
        onJump={vi.fn()}
        onSaveReflection={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByText(/2 条重点 · 2 个分组/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /第 1–20 页/ })).toBeInTheDocument();
    const currentBand = screen.getByRole("button", { name: /第 41–60 页/ });
    expect(currentBand).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Page forty-one quote")).toBeInTheDocument();
  });

  it("uses PDF discussions instead of reflections and keeps author attribution", async () => {
    const pdfBundle: DocumentAnnotationBundle = {
      excerpts: [
        excerpt({
          id: "pdf-new",
          relativePath: "paper.pdf",
          sourceText: "Needs a first comment",
          anchor: {
            format: "pdfText",
            page: 3,
            view: "original",
            quote: { exact: "Needs a first comment", prefix: "", suffix: "" },
            rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.03 }],
          },
        }),
        excerpt({
          id: "pdf-threaded",
          relativePath: "paper.pdf",
          sourceText: "Already discussed",
          anchor: {
            format: "pdfText",
            page: 3,
            view: "original",
            quote: { exact: "Already discussed", prefix: "", suffix: "" },
            rects: [{ x: 0.1, y: 0.3, w: 0.2, h: 0.03 }],
          },
        }),
      ],
      places: [],
      reflections: [],
      reviewEnrollments: [],
      commentAuthors: [
        {
          id: "local-me",
          name: "我",
          isDefault: true,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ],
      commentThreads: [
        {
          id: "thread-1",
          annotationId: "pdf-threaded",
          createdAt: 2,
          updatedAt: 2,
          deletedAt: null,
        },
      ],
      commentMessages: [
        {
          id: "message-1",
          threadId: "thread-1",
          authorId: "local-me",
          body: "第一条评论",
          createdAt: 2,
          updatedAt: 2,
          deletedAt: null,
        },
      ],
    };
    const onCreatePdfComment = vi.fn(async () => undefined);
    const onReplyPdfComment = vi.fn(async () => undefined);
    const onCreateCommentAuthor = vi.fn(async (name: string) => ({
      id: "author-2",
      name,
      isDefault: true,
      createdAt: 3,
      updatedAt: 3,
      deletedAt: null,
    }));
    render(
      <DocumentAnnotationsView
        format="pdf"
        toc={[]}
        currentHeadingId="pdf-page-3"
        currentPage={3}
        bundle={pdfBundle}
        loading={false}
        onJump={vi.fn()}
        onSaveReflection={vi.fn(async () => undefined)}
        onCreatePdfComment={onCreatePdfComment}
        onReplyPdfComment={onReplyPdfComment}
        onCreateCommentAuthor={onCreateCommentAuthor}
      />,
    );

    expect(screen.getByText(/1 个讨论/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加评论" }));
    fireEvent.change(screen.getByRole("textbox", { name: "添加评论" }), {
      target: { value: "新的讨论" },
    });
    const addCommentButtons = screen.getAllByRole("button", { name: "添加评论" });
    fireEvent.click(addCommentButtons[addCommentButtons.length - 1]!);
    expect(onCreatePdfComment).toHaveBeenCalledWith("pdf-new", "新的讨论", "local-me");

    fireEvent.click(screen.getByRole("button", { name: "查看讨论" }));
    expect(screen.getByText("第一条评论")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "回复讨论" }), {
      target: { value: "继续回复" },
    });
    fireEvent.click(screen.getByRole("button", { name: "回复" }));
    expect(onReplyPdfComment).toHaveBeenCalledWith("thread-1", "继续回复", "local-me");

    fireEvent.change(screen.getByRole("textbox", { name: "新建本地评论身份" }), {
      target: { value: "研究者" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(onCreateCommentAuthor).toHaveBeenCalledWith("研究者");

    fireEvent.click(screen.getByRole("tab", { name: "讨论" }));
    expect(screen.getByText("Already discussed")).toBeInTheDocument();
    expect(screen.queryByText("Needs a first comment")).not.toBeInTheDocument();
  });
});
