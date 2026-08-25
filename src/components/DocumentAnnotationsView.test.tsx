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
});
