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
});
