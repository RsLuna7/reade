// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentInfo } from "../lib/backend";
import { FolderDocsPanel } from "./FolderDocsPanel";

function doc(relativePath: string, title: string, modified = 1_704_067_200_000): DocumentInfo {
  return {
    relativePath,
    title,
    size: 1,
    modified,
    format: "markdown",
    indexStatus: "ready",
    indexError: null,
  };
}

const libraryDocuments = [
  doc("zh/agents/long.md", "面向企业各业务线的代理方案完整标题"),
  doc("zh/short.md", "短名"),
];

function renderPanel(
  overrides: Partial<ComponentProps<typeof FolderDocsPanel>> = {},
) {
  const onSelect = vi.fn();
  const onNavigateFolder = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <FolderDocsPanel
      open
      folderPath="zh"
      libraryLabel="Demo"
      documents={libraryDocuments}
      currentPath="zh/short.md"
      onSelect={onSelect}
      onNavigateFolder={onNavigateFolder}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { ...view, onSelect, onNavigateFolder, onClose };
}

describe("FolderDocsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows this-level titles in full and hides nested documents until the subfolder is opened", () => {
    const { onSelect } = renderPanel();
    const dialog = screen.getByRole("dialog", { name: "本夹目录：zh" });

    expect(within(dialog).getByText("短名")).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "agents" })).toBeInTheDocument();
    expect(
      within(dialog).queryByText("面向企业各业务线的代理方案完整标题"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("zh/short.md")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByText("短名"));
    expect(onSelect).toHaveBeenCalledWith("zh/short.md");
  });

  it("navigates folders from crumbs, the rail, and a folder row", () => {
    const { onNavigateFolder } = renderPanel();
    const dialog = screen.getByRole("dialog", { name: "本夹目录：zh" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Demo" }));
    expect(onNavigateFolder).toHaveBeenCalledWith(null);

    fireEvent.click(within(dialog).getByRole("treeitem", { name: "agents" }));
    expect(onNavigateFolder).toHaveBeenCalledWith("zh/agents");

    fireEvent.click(within(dialog).getByRole("option", { name: "agents" }));
    expect(onNavigateFolder).toHaveBeenCalledWith("zh/agents");
  });

  it("filters descendant titles and closes on Escape from the input", () => {
    const { onClose } = renderPanel();

    fireEvent.change(screen.getByLabelText("过滤本夹文档"), {
      target: { value: "企业" },
    });
    expect(screen.getByText("面向企业各业务线的代理方案完整标题")).toBeInTheDocument();
    expect(screen.queryByText("短名")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText("过滤本夹文档"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
